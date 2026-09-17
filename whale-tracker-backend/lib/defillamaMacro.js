/**
 * DeFiLlama 宏观资金沉淀（免费 API，无需 Key）
 * 按偏好币种聚合：公链 TVL / DEX 24h / 链上稳定币 / 相关协议
 */
const axios = require('axios');

const TVL_BASE = 'https://api.llama.fi';
const STABLE_BASE = 'https://stablecoins.llama.fi';
const REFRESH_MS = Math.max(60_000, Number(process.env.DEFILLAMA_REFRESH_MS) || 300_000);
const STALE_AFTER_MS = 15 * 60 * 1000;
const TIMEOUT_MS = 25_000;

const SKIP_PROTOCOL_CATEGORIES = new Set(['CEX', 'Oracle', 'Bridge', 'Canonical Bridge', 'Chain']);

/** 偏好币 → DeFiLlama 主链名 */
const COIN_CHAIN = {
  BTC: 'Bitcoin',
  ETH: 'Ethereum',
  SOL: 'Solana',
  HYPE: 'Hyperliquid L1',
  BNB: 'BSC',
  AVAX: 'Avalanche',
  SUI: 'Sui',
  ARB: 'Arbitrum',
  OP: 'Optimism',
  MATIC: 'Polygon',
  POL: 'Polygon',
  TON: 'TON',
  TRX: 'Tron',
  ATOM: 'Cosmos',
  NEAR: 'Near',
  APT: 'Aptos',
  SEI: 'Sei',
  INJ: 'Injective',
  DOT: 'Polkadot',
  ADA: 'Cardano',
  LINK: 'Ethereum',
  UNI: 'Ethereum',
  AAVE: 'Ethereum',
  MNT: 'Mantle',
  BLAST: 'Blast',
  LINEA: 'Linea',
  SCROLL: 'Scroll',
  ZK: 'zkSync Era',
  STRK: 'Starknet',
  TIA: 'Celestia',
  FIL: 'Filecoin',
  ICP: 'ICP',
};

let started = false;
let timer = null;
/** @type {null | { chains: any[], protocols: any[], stablesByChain: Record<string, number>, overview: any, chainMetrics: Record<string, any>, updatedAt: number }} */
let cache = null;
let lastFetchAt = 0;
let lastSuccessAt = 0;
let lastError = '';
let totalFetches = 0;
let totalFailures = 0;
/** @type {string[]} */
let lastRequestedCoins = ['BTC', 'ETH'];

function pctChange(now, prev) {
  if (!Number.isFinite(now) || !Number.isFinite(prev) || prev === 0) return null;
  return ((now - prev) / Math.abs(prev)) * 100;
}

function httpGet(url, params) {
  return axios.get(url, {
    params,
    timeout: TIMEOUT_MS,
    headers: { Accept: 'application/json' },
    validateStatus: (s) => s >= 200 && s < 300,
  });
}

function normalizeCoin(raw) {
  return String(raw || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

function parseCoins(raw) {
  if (Array.isArray(raw)) {
    return [...new Set(raw.map(normalizeCoin).filter(Boolean))].slice(0, 12);
  }
  if (!raw) return [];
  return [
    ...new Set(
      String(raw)
        .split(',')
        .map(normalizeCoin)
        .filter(Boolean),
    ),
  ].slice(0, 12);
}

function resolveChainName(coin, chains) {
  const mapped = COIN_CHAIN[coin];
  if (mapped) {
    const hit = chains.find((c) => c.name === mapped);
    if (hit) return hit.name;
  }
  const bySymbol = chains.find((c) => String(c.tokenSymbol || '').toUpperCase() === coin);
  if (bySymbol) return bySymbol.name;
  const byName = chains.find((c) => String(c.name || '').toUpperCase() === coin);
  if (byName) return byName.name;
  return null;
}

async function fetchChainMetric(chainName) {
  const [histRes, dexRes] = await Promise.all([
    httpGet(`${TVL_BASE}/v2/historicalChainTvl/${encodeURIComponent(chainName)}`).catch(() => null),
    httpGet(`${TVL_BASE}/overview/dexs/${encodeURIComponent(chainName)}`).catch(() => null),
  ]);
  const hist = Array.isArray(histRes?.data) ? histRes.data : [];
  const last = hist[hist.length - 1] || null;
  const prev = hist[hist.length - 2] || null;
  const dex = dexRes?.data || {};
  return {
    chain: chainName,
    tvl: Number(last?.tvl) || 0,
    tvlChange1dPct: last && prev ? pctChange(Number(last.tvl), Number(prev.tvl)) : null,
    dexVolume24h: Number(dex.total24h) || 0,
    dexChange1dPct: Number.isFinite(Number(dex.change_1d)) ? Number(dex.change_1d) : null,
  };
}

async function fetchGlobalOverview() {
  const [histRes, dexRes] = await Promise.all([
    httpGet(`${TVL_BASE}/v2/historicalChainTvl`),
    httpGet(`${TVL_BASE}/overview/dexs`),
  ]);
  const hist = Array.isArray(histRes.data) ? histRes.data : [];
  const last = hist[hist.length - 1] || null;
  const prev = hist[hist.length - 2] || null;
  const dex = dexRes.data || {};
  return {
    totalTvl: Number(last?.tvl) || 0,
    tvlChange1dPct: last && prev ? pctChange(Number(last.tvl), Number(prev.tvl)) : null,
    tvlAsOf: last?.date ? Number(last.date) * 1000 : null,
    dexVolume24h: Number(dex.total24h) || 0,
    dexChange1dPct: Number.isFinite(Number(dex.change_1d)) ? Number(dex.change_1d) : null,
  };
}

async function fetchChains() {
  const { data } = await httpGet(`${TVL_BASE}/v2/chains`);
  const list = Array.isArray(data) ? data : [];
  return list
    .map((c) => ({
      name: String(c.name || ''),
      tvl: Number(c.tvl) || 0,
      tokenSymbol: c.tokenSymbol ? String(c.tokenSymbol).toUpperCase() : null,
    }))
    .filter((c) => c.name && c.tvl > 0);
}

async function fetchProtocols() {
  const { data } = await httpGet(`${TVL_BASE}/protocols`);
  const list = Array.isArray(data) ? data : [];
  const rows = [];
  for (const p of list) {
    if (p?.parentProtocol) continue;
    const category = String(p.category || '');
    if (SKIP_PROTOCOL_CATEGORIES.has(category)) continue;
    const tvl = Number(p.tvl) || 0;
    if (tvl <= 0) continue;
    const chainTvls =
      p.chainTvls && typeof p.chainTvls === 'object'
        ? Object.fromEntries(
            Object.entries(p.chainTvls)
              .filter(([, v]) => Number(v) > 0)
              .slice(0, 20)
              .map(([k, v]) => [k, Number(v) || 0]),
          )
        : {};
    rows.push({
      name: String(p.name || p.slug || ''),
      slug: String(p.slug || ''),
      category,
      tvl,
      change1dPct: Number.isFinite(Number(p.change_1d)) ? Number(p.change_1d) : null,
      symbol: p.symbol ? String(p.symbol).toUpperCase() : null,
      chains: Array.isArray(p.chains) ? p.chains.map(String) : [],
      chainTvls,
      logo: p.logo || null,
    });
  }
  rows.sort((a, b) => b.tvl - a.tvl);
  return rows.slice(0, 500);
}

async function fetchStablesByChain() {
  const { data } = await httpGet(`${STABLE_BASE}/stablecoinchains`);
  const list = Array.isArray(data) ? data : [];
  const out = {};
  for (const row of list) {
    const name = String(row.name || '');
    if (!name) continue;
    const circ = row.totalCirculatingUSD;
    const mcap =
      typeof circ === 'number'
        ? circ
        : Number(circ?.peggedUSD) || 0;
    if (mcap > 0) out[name] = mcap;
  }
  return out;
}

function chainsNeededForCoins(coins, chains) {
  const names = new Set();
  for (const coin of coins) {
    const chain = resolveChainName(coin, chains);
    if (chain) names.add(chain);
  }
  // 预热常见链，减少首屏等待
  for (const chain of Object.values(COIN_CHAIN)) names.add(chain);
  return [...names];
}

async function refreshChainMetrics(chainNames, stablesByChain, chains) {
  const chainTvlMap = Object.fromEntries(chains.map((c) => [c.name, c.tvl]));
  const unique = [...new Set(chainNames)].slice(0, 24);
  const results = await Promise.all(
    unique.map(async (name) => {
      try {
        const metric = await fetchChainMetric(name);
        return [
          name,
          {
            ...metric,
            tvl: metric.tvl || chainTvlMap[name] || 0,
            stableMcap: Number(stablesByChain[name]) || 0,
          },
        ];
      } catch {
        return [
          name,
          {
            chain: name,
            tvl: chainTvlMap[name] || 0,
            tvlChange1dPct: null,
            dexVolume24h: 0,
            dexChange1dPct: null,
            stableMcap: Number(stablesByChain[name]) || 0,
          },
        ];
      }
    }),
  );
  return Object.fromEntries(results);
}

function protocolsForChain(protocols, chainName, limit = 8) {
  const scored = [];
  for (const p of protocols) {
    let onChainTvl = 0;
    if (p.chainTvls && Number(p.chainTvls[chainName]) > 0) {
      onChainTvl = Number(p.chainTvls[chainName]);
    } else if (p.chains.includes(chainName)) {
      onChainTvl = p.tvl;
    } else {
      continue;
    }
    scored.push({
      name: p.name,
      slug: p.slug,
      category: p.category,
      tvl: onChainTvl,
      change1dPct: p.change1dPct,
      symbol: p.symbol,
    });
  }
  scored.sort((a, b) => b.tvl - a.tvl);
  return scored.slice(0, limit);
}

function buildCoinRows(coins, snapshot) {
  const { chains, protocols, chainMetrics } = snapshot;
  const rows = [];
  for (const coin of coins) {
    const chain = resolveChainName(coin, chains);
    if (!chain) {
      rows.push({
        coin,
        chain: null,
        unsupported: true,
        chainTvl: 0,
        tvlChange1dPct: null,
        dexVolume24h: 0,
        dexChange1dPct: null,
        stableMcap: 0,
        protocols: [],
      });
      continue;
    }
    const metric = chainMetrics[chain] || {};
    const chainRow = chains.find((c) => c.name === chain);
    rows.push({
      coin,
      chain,
      unsupported: false,
      chainTvl: Number(metric.tvl) || Number(chainRow?.tvl) || 0,
      tvlChange1dPct: metric.tvlChange1dPct ?? null,
      dexVolume24h: Number(metric.dexVolume24h) || 0,
      dexChange1dPct: metric.dexChange1dPct ?? null,
      stableMcap: Number(metric.stableMcap) || 0,
      protocols: protocolsForChain(protocols, chain, 8),
    });
  }
  return rows;
}

async function pollOnce() {
  lastFetchAt = Date.now();
  try {
    const [overview, chains, protocols, stablesByChain] = await Promise.all([
      fetchGlobalOverview(),
      fetchChains(),
      fetchProtocols(),
      fetchStablesByChain(),
    ]);
    const needed = chainsNeededForCoins(lastRequestedCoins, chains);
    const chainMetrics = await refreshChainMetrics(needed, stablesByChain, chains);
    const totalStable = Object.values(stablesByChain).reduce((s, n) => s + (Number(n) || 0), 0);
    cache = {
      overview: {
        ...overview,
        stableMcap: totalStable,
      },
      chains,
      protocols,
      stablesByChain,
      chainMetrics,
      updatedAt: Date.now(),
      source: 'defillama',
    };
    lastSuccessAt = Date.now();
    lastError = '';
    totalFetches += 1;
  } catch (e) {
    lastError = e.message || String(e);
    totalFailures += 1;
    console.warn('[defillama] poll failed:', lastError);
  }
}

async function ensureChainMetrics(coins) {
  if (!cache) return;
  const missing = [];
  for (const coin of coins) {
    const chain = resolveChainName(coin, cache.chains);
    if (chain && !cache.chainMetrics[chain]) missing.push(chain);
  }
  if (!missing.length) return;
  const extra = await refreshChainMetrics(missing, cache.stablesByChain, cache.chains);
  cache.chainMetrics = { ...cache.chainMetrics, ...extra };
  cache.updatedAt = Date.now();
}

async function getSnapshot(coinsInput) {
  const coins = parseCoins(coinsInput);
  const wanted = coins.length ? coins : lastRequestedCoins.length ? lastRequestedCoins : ['BTC', 'ETH'];
  if (coins.length) lastRequestedCoins = wanted;

  const stale = !lastSuccessAt || Date.now() - lastSuccessAt > STALE_AFTER_MS;
  if (!cache) {
    return {
      ok: false,
      accumulating: true,
      stale: true,
      error: lastError || 'DeFiLlama 数据尚未就绪',
      overview: null,
      coins: wanted.map((coin) => ({
        coin,
        chain: null,
        unsupported: true,
        chainTvl: 0,
        tvlChange1dPct: null,
        dexVolume24h: 0,
        dexChange1dPct: null,
        stableMcap: 0,
        protocols: [],
      })),
      updatedAt: null,
      source: 'defillama',
    };
  }

  try {
    await ensureChainMetrics(wanted);
  } catch (e) {
    console.warn('[defillama] ensureChainMetrics:', e.message || e);
  }

  const coinRows = buildCoinRows(wanted, cache);
  const preferredTvl = coinRows.reduce((s, r) => s + (r.chainTvl || 0), 0);
  const preferredDex = coinRows.reduce((s, r) => s + (r.dexVolume24h || 0), 0);
  const preferredStable = coinRows.reduce((s, r) => s + (r.stableMcap || 0), 0);

  return {
    ok: true,
    accumulating: false,
    stale,
    error: stale ? lastError || null : null,
    overview: {
      ...cache.overview,
      preferredTvl,
      preferredDexVolume24h: preferredDex,
      preferredStableMcap: preferredStable,
    },
    coins: coinRows,
    updatedAt: cache.updatedAt,
    source: 'defillama',
  };
}

function getStatus() {
  return {
    started,
    refreshMs: REFRESH_MS,
    lastFetchAt,
    lastSuccessAt,
    lastError,
    totalFetches,
    totalFailures,
    stale: !lastSuccessAt || Date.now() - lastSuccessAt > STALE_AFTER_MS,
    hasCache: !!cache,
    lastRequestedCoins,
    chainMetricsCached: cache ? Object.keys(cache.chainMetrics || {}) : [],
  };
}

function start() {
  if (started) return getStatus();
  started = true;
  console.log(`[defillama] 启动轮询 every ${REFRESH_MS}ms（按币种聚合）`);
  void pollOnce();
  timer = setInterval(pollOnce, REFRESH_MS);
  if (typeof timer.unref === 'function') timer.unref();
  return getStatus();
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
  started = false;
}

module.exports = { start, stop, getSnapshot, getStatus, parseCoins };
