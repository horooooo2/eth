/**
 * DexPaprika pool transactions → 币种买入/卖出净流
 * 服务端每 60s 定时拉取并缓存；HTTP 接口只读缓存。
 * https://api.dexpaprika.com/networks/{network}/pools/{pool}/transactions
 */
const axios = require('axios');

const BASE = 'https://api.dexpaprika.com';
const client = axios.create({
  baseURL: BASE,
  timeout: 20000,
  headers: { Accept: 'application/json' },
});

const PERIOD_MS = {
  '1h': 60 * 60 * 1000,
  '4h': 4 * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
};

const PERIODS = Object.keys(PERIOD_MS);

/** 每币种主池（高流动性稳定币/主流对） */
const COIN_POOLS = {
  ETH: {
    coin: 'ETH',
    network: 'ethereum',
    pool: '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640',
    focus: ['WETH', 'ETH'],
    dex: 'Uniswap V3',
    pair: 'WETH/USDC',
  },
  BTC: {
    coin: 'BTC',
    network: 'ethereum',
    pool: '0xcbcdf9626bc03e24f779434178a73a0b4bad62ed',
    focus: ['WBTC', 'BTC'],
    dex: 'Uniswap V3',
    pair: 'WBTC/WETH',
  },
  SOL: {
    coin: 'SOL',
    network: 'solana',
    pool: '7XawhbbxtsRcQA8KTkHT9f9nc6d69UwqCDh6U5EEbEmX',
    focus: ['SOL', 'WSOL'],
    dex: 'Raydium/DEX',
    pair: 'SOL/USDT',
  },
};

const MAX_PAGES = {
  '1h': 4,
  '4h': 6,
  '24h': 8,
  '7d': 10,
};

const REFRESH_MS = Math.max(30_000, Number(process.env.DEX_FLOW_REFRESH_MS) || 60_000);

/** period → { coins, updatedAt, errors? } */
const store = new Map();
let refreshing = false;
let lastRefreshAt = 0;
let lastRefreshError = '';
let timer = null;
let started = false;

function periodMs(period) {
  return PERIOD_MS[String(period || '24h')] || PERIOD_MS['24h'];
}

function parsePeriod(raw) {
  const key = String(raw || '24h');
  return PERIOD_MS[key] ? key : '24h';
}

function usdOfTx(tx) {
  const v0 = Math.abs(Number(tx.volume_0) || 0) * Number(tx.price_0_usd || 0);
  const v1 = Math.abs(Number(tx.volume_1) || 0) * Number(tx.price_1_usd || 0);
  if (v0 > 0 && v1 > 0) return (v0 + v1) / 2;
  return Math.max(v0, v1, 0);
}

function classifySwap(tx, focusSymbols) {
  const focus = new Set(focusSymbols.map((s) => String(s).toUpperCase()));
  const s0 = String(tx.token_0_symbol || '').toUpperCase();
  const s1 = String(tx.token_1_symbol || '').toUpperCase();
  const usd = usdOfTx(tx);
  if (!usd) return null;

  if (focus.has(s0)) {
    return Number(tx.amount_0) < 0 ? { side: 'buy', usd } : { side: 'sell', usd };
  }
  if (focus.has(s1)) {
    return Number(tx.amount_1) < 0 ? { side: 'buy', usd } : { side: 'sell', usd };
  }
  return null;
}

function focusPriceUsd(tx, focusSymbols) {
  const focus = new Set(focusSymbols.map((s) => String(s).toUpperCase()));
  const s0 = String(tx.token_0_symbol || '').toUpperCase();
  const s1 = String(tx.token_1_symbol || '').toUpperCase();
  if (focus.has(s0) && Number(tx.price_0_usd) > 0) return Number(tx.price_0_usd);
  if (focus.has(s1) && Number(tx.price_1_usd) > 0) return Number(tx.price_1_usd);
  return null;
}

async function fetchPoolTransactions(network, pool, fromSec, toSec, maxPages) {
  const all = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const { data } = await client.get(`/networks/${network}/pools/${pool}/transactions`, {
      params: {
        page,
        limit: 100,
        from: fromSec,
        to: toSec,
      },
    });
    const batch = Array.isArray(data?.transactions) ? data.transactions : [];
    all.push(...batch);
    const totalPages = Number(data?.page_info?.total_pages) || page;
    if (!batch.length || page >= totalPages) break;
    const oldest = batch[batch.length - 1];
    const ts = Date.parse(oldest?.created_at || '');
    if (Number.isFinite(ts) && ts / 1000 < fromSec) break;
  }
  return all;
}

function aggregateTxs(txs, focus, fromMs) {
  let buy = 0;
  let sell = 0;
  let count = 0;
  let price = null;
  let oldestPrice = null;
  let newestPrice = null;

  for (const tx of txs) {
    const ts = Date.parse(tx.created_at || '');
    if (Number.isFinite(ts) && ts < fromMs) continue;
    const hit = classifySwap(tx, focus);
    if (!hit) continue;
    count += 1;
    if (hit.side === 'buy') buy += hit.usd;
    else sell += hit.usd;
    const p = focusPriceUsd(tx, focus);
    if (p != null) {
      if (newestPrice == null) newestPrice = p;
      oldestPrice = p;
      if (price == null) price = p;
    }
  }

  let changePct = null;
  if (oldestPrice != null && newestPrice != null && oldestPrice > 0) {
    changePct = ((newestPrice - oldestPrice) / oldestPrice) * 100;
  }

  return { buy, sell, net: buy - sell, count, price, changePct };
}

async function buildCoinFlow(cfg, period) {
  const ms = periodMs(period);
  const now = Date.now();
  const fromMs = now - ms;
  const fromSec = Math.floor(fromMs / 1000);
  const toSec = Math.floor(now / 1000);
  const maxPages = MAX_PAGES[period] || 6;

  const txs = await fetchPoolTransactions(cfg.network, cfg.pool, fromSec, toSec, maxPages);
  const agg = aggregateTxs(txs, cfg.focus, fromMs);

  return {
    coin: cfg.coin,
    buy: agg.buy,
    sell: agg.sell,
    net: agg.net,
    changePct: agg.changePct == null ? null : Number(agg.changePct.toFixed(2)),
    price: agg.price,
    count: agg.count,
    network: cfg.network,
    pool: cfg.pool,
    dex: cfg.dex,
    pair: cfg.pair,
    period,
    source: 'dexpaprika',
  };
}

async function refreshPeriod(period) {
  const wanted = Object.keys(COIN_POOLS);
  const rows = [];
  const errors = [];
  const prev = store.get(period);

  // 串行拉币种，降低 DexPaprika 突发限流
  for (const coin of wanted) {
    const cfg = COIN_POOLS[coin];
    try {
      rows.push(await buildCoinFlow(cfg, period));
    } catch (err) {
      const msg = err.message || String(err);
      errors.push({ coin, error: msg });
      const prevRow = (prev?.coins || []).find((r) => r.coin === coin);
      if (prevRow) {
        rows.push({ ...prevRow, stale: true, error: msg });
      } else {
        rows.push({
          coin,
          buy: 0,
          sell: 0,
          net: 0,
          changePct: null,
          price: null,
          count: 0,
          period,
          source: 'dexpaprika',
          error: msg,
        });
      }
    }
  }

  rows.sort((a, b) => Math.abs(b.net || 0) - Math.abs(a.net || 0));

  const payload = {
    period,
    coins: rows,
    updatedAt: Date.now(),
    errors: errors.length ? errors : undefined,
  };
  store.set(period, payload);
  return payload;
}

async function refreshDexFlowCache(reason = '定时') {
  if (refreshing) return getDexFlowStatus();
  refreshing = true;
  const startedAt = Date.now();
  try {
    for (const period of PERIODS) {
      await refreshPeriod(period);
    }
    lastRefreshAt = Date.now();
    lastRefreshError = '';
    console.log(
      `[dex-flow] ${reason}完成 periods=${PERIODS.join(',')} coins=${Object.keys(COIN_POOLS).join(',')} ${Date.now() - startedAt}ms`,
    );
  } catch (err) {
    lastRefreshError = err.message || String(err);
    console.error(`[dex-flow] ${reason}失败:`, lastRefreshError);
  } finally {
    refreshing = false;
  }
  return getDexFlowStatus();
}

/**
 * 只读缓存。不触发 DexPaprika 实时请求。
 */
function getDexFlowCoins(periodInput = '24h', coinList = []) {
  const period = parsePeriod(periodInput);
  const snap = store.get(period);
  const wanted = (coinList.length ? coinList : Object.keys(COIN_POOLS))
    .map((c) => String(c || '').toUpperCase())
    .filter(Boolean);

  if (!snap) {
    return {
      period,
      coins: wanted.map((coin) => ({
        coin,
        buy: 0,
        sell: 0,
        net: 0,
        changePct: null,
        price: null,
        count: 0,
        unsupported: !COIN_POOLS[coin],
        period,
        source: 'dexpaprika',
        accumulating: true,
      })),
      updatedAt: null,
      accumulating: true,
    };
  }

  const byCoin = new Map((snap.coins || []).map((row) => [row.coin, row]));
  const rows = wanted.map((coin) => {
    const hit = byCoin.get(coin);
    if (hit) return hit;
    if (!COIN_POOLS[coin]) {
      return {
        coin,
        buy: 0,
        sell: 0,
        net: 0,
        changePct: null,
        price: null,
        count: 0,
        unsupported: true,
        period,
        source: 'dexpaprika',
      };
    }
    return {
      coin,
      buy: 0,
      sell: 0,
      net: 0,
      changePct: null,
      price: null,
      count: 0,
      period,
      source: 'dexpaprika',
      accumulating: true,
    };
  });

  rows.sort((a, b) => Math.abs(b.net || 0) - Math.abs(a.net || 0));

  return {
    period,
    coins: rows,
    updatedAt: snap.updatedAt,
    errors: snap.errors,
    accumulating: false,
  };
}

function getDexFlowStatus() {
  return {
    started,
    refreshing,
    refreshMs: REFRESH_MS,
    lastRefreshAt,
    lastRefreshError: lastRefreshError || null,
    periods: PERIODS.map((p) => ({
      period: p,
      updatedAt: store.get(p)?.updatedAt || null,
      coins: (store.get(p)?.coins || []).length,
    })),
  };
}

function startDexFlowPolling() {
  if (started) return getDexFlowStatus();
  started = true;
  void refreshDexFlowCache('启动预热');
  timer = setInterval(() => {
    void refreshDexFlowCache('定时刷新');
  }, REFRESH_MS);
  if (typeof timer.unref === 'function') timer.unref();
  console.log(`[dex-flow] 定时间隔 ${REFRESH_MS}ms（可用 DEX_FLOW_REFRESH_MS 调整）`);
  return getDexFlowStatus();
}

function stopDexFlowPolling() {
  if (timer) clearInterval(timer);
  timer = null;
  started = false;
}

module.exports = {
  getDexFlowCoins,
  refreshDexFlowCache,
  startDexFlowPolling,
  stopDexFlowPolling,
  getDexFlowStatus,
  parsePeriod,
  COIN_POOLS,
  PERIOD_MS,
};
