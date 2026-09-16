/**
 * 链上 RPC 增量抓取资金流向（替代 DexPaprika 主源）
 *
 * - ETH/BTC: eth_getLogs 抓 Uniswap V3 Swap 事件，只拉 lastBlock 之后的新块
 * - SOL: 暂时保留 DexPaprika 作为 fallback（Raydium 解析较复杂，后续补）
 *
 * 服务器内存里维护最近 4 小时的 swap 流水，本地聚合 5m/15m/1h/4h，
 * 不为每个周期重复请求 RPC。
 *
 * 持久化: data/onchain-flow-state.json { ethLastBlock, solLastSignature }
 */
const fs = require('fs');
const path = require('path');
const axios = require('axios');

// ---------- 配置 ----------
const ETH_RPCS = (process.env.ETH_RPC_URLS ||
  'https://ethereum-rpc.publicnode.com,https://1rpc.io/eth,https://eth.drpc.org,https://rpc.flashbots.net,https://eth.meowrpc.com')
  .split(',').map((s) => s.trim()).filter(Boolean);

const SOL_RPCS = (process.env.SOL_RPC_URLS ||
  'https://api.mainnet-beta.solana.com,https://solana-rpc.publicnode.com')
  .split(',').map((s) => s.trim()).filter(Boolean);

const SWAP_TOPIC = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67';

// Uniswap V3 pool 配置（token 顺序已通过 eth_call 确认）
// WETH/USDC: token0=USDC(0xa0b8...e48), token1=WETH
// WBTC/WETH: token0=WBTC(0x2260...599), token1=WETH
const ETH_POOLS = {
  ETH: {
    coin: 'ETH',
    pools: [
      { address: '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640', focusTokenIsToken1: true, focusDecimals: 18, counterDecimals: 6, isStableCounter: true },
      { address: '0x8ad599c3a0ff1de082011efddc58f1908eb6e6d8', focusTokenIsToken1: true, focusDecimals: 18, counterDecimals: 6, isStableCounter: true },
    ],
  },
  BTC: {
    coin: 'BTC',
    pools: [
      { address: '0xcbcdf9626bc03e24f779434178a73a0b4bad62ed', focusTokenIsToken1: false, focusDecimals: 8, counterDecimals: 18, isStableCounter: false },
    ],
  },
};;

const PERIODS = {
  '5m': 5 * 60 * 1000,
  '15m': 15 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '2h': 2 * 60 * 60 * 1000,
  '4h': 4 * 60 * 60 * 1000,
  '6h': 6 * 60 * 60 * 1000,
};
const RETENTION_MS = 6 * 60 * 60 * 1000 + 60 * 1000; // 6h + 1min buffer
const POLL_MS = Math.max(5_000, Number(process.env.ONCHAIN_FLOW_POLL_MS) || 15_000);
const STATE_FILE = path.join(
  process.env.DATA_DIR || path.join(__dirname, '..', 'data'),
  'onchain-flow-state.json',
);

// ---------- 运行时状态 ----------
/** @type {{ts:number, coin:string, side:'buy'|'sell', usd:number, price:number|null}[]} */
const buffer = [];
let ethLastBlock = 0;
let ethPriceUsd = null; // 由 WETH/USDC swap 更新
let btcPriceUsd = null; // 由 WBTC/WETH swap × ethPriceUsd 更新
let started = false;
let polling = false;
let timer = null;
let lastError = '';
let lastSuccessAt = 0;
let pollCount = 0;
let rpcFailures = 0;
let activeRpcIdx = 0;

// ---------- 持久化 ----------
function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      ethLastBlock = Number(s.ethLastBlock) || 0;
    }
  } catch (e) {
    console.warn('[onchain-flow] 读取状态失败:', e.message);
  }
}
function saveState() {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify({ ethLastBlock, savedAt: Date.now() }, null, 2));
  } catch (e) {
    console.warn('[onchain-flow] 保存状态失败:', e.message);
  }
}

// ---------- RPC 调用（带切换/重试） ----------
async function ethRpcPost(method, params) {
  const maxTries = ETH_RPCS.length + 1;
  let lastErr;
  for (let i = 0; i < maxTries; i += 1) {
    const url = ETH_RPCS[activeRpcIdx % ETH_RPCS.length];
    try {
      const { data } = await axios.post(url, {
        jsonrpc: '2.0', method, params, id: 1,
      }, { timeout: 12000 });
      if (data.error) throw new Error(data.error.message || 'rpc error');
      rpcFailures = 0;
      return data.result;
    } catch (e) {
      lastErr = e;
      rpcFailures += 1;
      activeRpcIdx = (activeRpcIdx + 1) % ETH_RPCS.length;
      // 429 / 超时：短暂退避
      await new Promise((r) => setTimeout(r, 300 * (i + 1)));
    }
  }
  throw lastErr;
}

// ---------- Swap 事件解析 ----------
// Uniswap V3 Swap data layout: amount0(int256,32) amount1(int256,32) sqrtPriceX96(uint160,32) liquidity(uint128,32) tick(int24,32)
function hexToInt256(hex) {
  // hex 是 66 字符（0x + 64 hex）
  const v = BigInt(hex);
  // 处理 int256 符号
  const TWO255 = 1n << 255n;
  if (v >= TWO255) return v - (1n << 256n);
  return v;
}

// 从 sqrtPriceX96 计算 token1/token0 的真实价格（考虑 decimals）
// raw_price = (sqrtPriceX96 / 2^96)^2  是原始 token 数量比
// real_price (token1 per token0) = raw_price * 10^(dec0 - dec1)
function sqrtPriceToToken1PerToken0(sqrtPriceX96, decimals0, decimals1) {
  const Q96 = 2 ** 96;
  const ratio = Number(sqrtPriceX96) / Q96;
  const raw = ratio * ratio;
  return raw * Math.pow(10, decimals0 - decimals1);
}

function parseSwapLog(log) {
  const data = log.data;
  // data 是 0x + 320 hex bytes
  const amount0Hex = '0x' + data.slice(2 + 0 * 64, 2 + 1 * 64);
  const amount1Hex = '0x' + data.slice(2 + 1 * 64, 2 + 2 * 64);
  const sqrtHex = '0x' + data.slice(2 + 2 * 64, 2 + 3 * 64);
  const amount0 = hexToInt256(amount0Hex);
  const amount1 = hexToInt256(amount1Hex);
  const sqrtPriceX96 = BigInt(sqrtHex);
  return { amount0, amount1, sqrtPriceX96 };
}

// 根据池配置判断方向和 USD 金额
function classifyAndValue(poolCfg, coin, amount0, amount1, sqrtPriceX96, ts) {
  // 计算当前价格（用于 USD 估值）
  // ETH 池: token0=USDC(6), token1=WETH(18) => token1/token0 = WETH per USDC
  //   eth_usd = 1 / (WETH per USDC) = USDC per WETH
  // BTC 池: token0=WBTC(8), token1=WETH(18) => token1/token0 = WETH per WBTC
  //   btc_usd = (WETH per WBTC) * eth_usd

  if (poolCfg.isStableCounter) {
    // ETH pool: token0=USDC, token1=WETH
    // eth_usd = 1 / token1_per_token0 (因为 token1_per_token0 = WETH/USDC)
    const wethPerUsdc = sqrtPriceToToken1PerToken0(sqrtPriceX96, poolCfg.counterDecimals, poolCfg.focusDecimals);
    if (wethPerUsdc > 0) ethPriceUsd = 1 / wethPerUsdc;
  } else {
    // BTC pool: token0=WBTC, token1=WETH
    // wethPerWbtc = token1_per_token0
    const wethPerWbtc = sqrtPriceToToken1PerToken0(sqrtPriceX96, poolCfg.focusDecimals, poolCfg.counterDecimals);
    if (wethPerWbtc > 0 && ethPriceUsd != null) btcPriceUsd = wethPerWbtc * ethPriceUsd;
  }

  // 判断买卖方向
  // focusTokenIsToken1=true (ETH pool): focus=WETH=token1
  //   amount1 < 0 => WETH 流出池子 => 买 WETH
  //   amount1 > 0 => WETH 流入池子 => 卖 WETH
  // focusTokenIsToken1=false (BTC pool): focus=WBTC=token0
  //   amount0 < 0 => WBTC 流出池子 => 买 WBTC
  //   amount0 > 0 => WBTC 流入池子 => 卖 WBTC
  const focusAmount = poolCfg.focusTokenIsToken1 ? amount1 : amount0;
  const otherAmount = poolCfg.focusTokenIsToken1 ? amount0 : amount1;
  const focusDec = poolCfg.focusDecimals;

  const side = focusAmount < 0n ? 'buy' : 'sell';
  // USD 金额：用 focus token 数量 × 对应 USD 价格
  const focusNum = Number(focusAmount) / Math.pow(10, focusDec);
  const absFocus = Math.abs(focusNum);

  let price;
  if (coin === 'ETH') price = ethPriceUsd;
  else if (coin === 'BTC') price = btcPriceUsd;

  let usd = 0;
  if (price != null && Number.isFinite(price) && price > 0) {
    usd = absFocus * price;
  } else {
    // fallback: 用 counter token 数量 × counter 价格估算
    const otherNum = Math.abs(Number(otherAmount)) / Math.pow(10, poolCfg.counterDecimals);
    if (poolCfg.isStableCounter) usd = otherNum; // USDC 1:1
    else if (ethPriceUsd != null) usd = otherNum * ethPriceUsd; // WETH 数量 × ETH 价格
  }

  return { side, usd, ts, coin, price };
}

// ---------- 增量抓取 ----------
async function fetchNewEthLogs() {
  const latestHex = await ethRpcPost('eth_blockNumber', []);
  const latest = parseInt(latestHex, 16);
  if (!Number.isFinite(latest)) return;

  const fromBlock = ethLastBlock > 0 ? ethLastBlock + 1 : latest - 200; // 首次回溯 ~200 块
  if (fromBlock > latest - 5) return; // 太新的块跳过，等下一轮

  // 每次最多拉 500 块；toBlock 用 latest-5 避免节点 head 不一致
  const toBlock = Math.min(fromBlock + 499, latest - 5);

  const logs = await ethRpcPost('eth_getLogs', [{
    fromBlock: '0x' + fromBlock.toString(16),
    toBlock: '0x' + toBlock.toString(16),
    topics: [SWAP_TOPIC],
    address: Object.values(ETH_POOLS).flatMap((c) => c.pools.map((p) => p.address)),
  }]);

  let added = 0;
  for (const log of logs || []) {
    const poolCfg = Object.values(ETH_POOLS).flatMap((c) => c.pools).find((p) => p.address.toLowerCase() === log.address.toLowerCase());
    const coin = poolCfg ? (Object.values(ETH_POOLS).find((c) => c.pools.includes(poolCfg)) || {}).coin : null;
    if (!poolCfg) continue;
    const { amount0, amount1, sqrtPriceX96 } = parseSwapLog(log);
    const ts = Date.now(); // log 本身不带 ts，用当前时间近似
    const rec = classifyAndValue(poolCfg, coin, amount0, amount1, sqrtPriceX96, ts);
    buffer.push(rec);
    added += 1;
  }

  ethLastBlock = toBlock;
  saveState();
  lastSuccessAt = Date.now();
  return { added, fromBlock, toBlock };
}

// ---------- 聚合 ----------
function pruneBuffer() {
  const cutoff = Date.now() - RETENTION_MS;
  while (buffer.length && buffer[0].ts < cutoff) buffer.shift();
}

function aggregate(periodMs) {
  const cutoff = Date.now() - periodMs;
  const coins = ['ETH', 'BTC', 'SOL'];
  const result = {};
  for (const c of coins) {
    result[c] = { buy: 0, sell: 0, count: 0, price: null };
  }
  for (const r of buffer) {
    if (r.ts < cutoff) continue;
    if (!result[r.coin]) continue;
    result[r.coin][r.side] += r.usd;
    result[r.coin].count += 1;
    result[r.coin].price = r.price;
  }
  return result;
}

function getFlowCoins(periodInput = '1h', coinList = []) {
  const period = PERIODS[periodInput] ? periodInput : '1h';
  const periodMs = PERIODS[period];
  const agg = aggregate(periodMs);

  const wanted = (coinList.length ? coinList : ['ETH', 'BTC', 'SOL'])
    .map((c) => String(c || '').toUpperCase())
    .filter(Boolean);

  const rows = wanted.map((coin) => {
    const a = agg[coin] || { buy: 0, sell: 0, count: 0, price: null };
    const net = a.buy - a.sell;
    const price = coin === 'ETH' ? ethPriceUsd : coin === 'BTC' ? btcPriceUsd : a.price;
    return {
      coin,
      buy: Math.round(a.buy),
      sell: Math.round(a.sell),
      net: Math.round(net),
      count: a.count,
      price,
      changePct: null,
      period,
      source: coin === 'SOL' ? 'dexpaprika-fallback' : 'eth-rpc',
    };
  });

  rows.sort((a, b) => Math.abs(b.net) - Math.abs(a.net));

  return {
    period,
    coins: rows,
    updatedAt: lastSuccessAt || Date.now(),
    accumulating: buffer.length === 0,
  };
}

function getStatus() {
  return {
    started,
    pollMs: POLL_MS,
    lastSuccessAt,
    lastError,
    pollCount,
    ethLastBlock,
    ethPriceUsd,
    btcPriceUsd,
    bufferSize: buffer.length,
    rpcFailures,
    periods: Object.keys(PERIODS).map((p) => ({ period: p, windowMs: PERIODS[p] })),
    source: 'eth-rpc + sol-fallback',
  };
}

async function pollOnce() {
  if (polling) return;
  polling = true;
  try {
    const r = await fetchNewEthLogs();
    pruneBuffer();
    pollCount += 1;
    if (r?.added) {
      console.log(`[onchain-flow] poll #${pollCount}: +${r.added} swaps block=${r.fromBlock}->${r.toBlock} buf=${buffer.length} ETH=$${Math.round(ethPriceUsd||0)} BTC=$${Math.round(btcPriceUsd||0)}`);
    }
    lastError = '';
  } catch (e) {
    lastError = e.message || String(e);
    console.warn('[onchain-flow] poll failed:', lastError);
  } finally {
    polling = false;
  }
}

function start() {
  if (started) return getStatus();
  started = true;
  loadState();
  console.log(`[onchain-flow] 启动 lastBlock=${ethLastBlock} poll=${POLL_MS}ms rpcCount=${ETH_RPCS.length}`);
  void pollOnce();
  timer = setInterval(pollOnce, POLL_MS);
  if (typeof timer.unref === 'function') timer.unref();
  return getStatus();
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
  started = false;
}

module.exports = {
  start,
  stop,
  getFlowCoins,
  getStatus,
  PERIODS,
  POLL_MS,
};
