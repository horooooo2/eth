const axios = require('axios');
const { hlPost } = require('./hlInfoClient');
const { getActiveWhales } = require('./config');
const { getCatalog } = require('./tradfiMarkets');

const binance = axios.create({ baseURL: 'https://fapi.binance.com', timeout: 9000, proxy: false });
const cache = new Map();
const DEFAULT_SCAN_LIMIT = Math.max(1, Math.min(30, Number(process.env.TRADFI_WHALE_SCAN_LIMIT) || 10));
const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

async function cached(key, ttl, loader) {
  const old = cache.get(key);
  if (old?.expiresAt > Date.now()) return old.value;
  if (old?.promise) return old.promise;
  const promise = loader().then((value) => {
    cache.set(key, { value, expiresAt: Date.now() + ttl });
    return value;
  }).catch((err) => {
    if (old?.value) {
      const stale = Array.isArray(old.value) ? old.value : { ...old.value, stale: true, error: err.message };
      cache.set(key, { value: stale, expiresAt: Date.now() + 10_000 });
      return stale;
    }
    cache.delete(key);
    throw err;
  });
  cache.set(key, { ...old, promise });
  return promise;
}

function underlyingNames(base) {
  if (base === 'XAU') return ['GOLD'];
  if (base === 'XAG') return ['SILVER'];
  if (base === 'XPT') return ['PLATINUM'];
  if (base === 'XPD') return ['PALLADIUM'];
  return [base];
}

async function getDiscoveredMarkets() {
  return cached('dex-markets:all', 10 * 60_000, async () => {
    const dexRows = await hlPost({ type: 'perpDexs' });
    if (!Array.isArray(dexRows)) throw new Error('Hyperliquid DEX 清单格式异常');
    const dexes = dexRows.map((item) => item?.name).filter((name) => typeof name === 'string').slice(0, 25);
    const results = await Promise.allSettled(dexes.map((dex) => hlPost({ type: 'metaAndAssetCtxs', dex })));
    const matches = [];
    let successCount = 0;
    for (let i = 0; i < results.length; i += 1) {
      if (results[i].status !== 'fulfilled') continue;
      successCount += 1;
      const [meta, contexts] = results[i].value || [];
      if (!Array.isArray(meta?.universe)) continue;
      meta.universe.forEach((asset, index) => {
        const coin = String(asset?.name || '');
        const prefix = `${dexes[i]}:`;
        if (!coin.startsWith(prefix) || asset.isDelisted) return;
        const context = contexts?.[index] || {};
        matches.push({ dex: dexes[i], coin, dayNotionalVolume: Number(context.dayNtlVlm) || 0, markPrice: Number(context.markPx) || null });
      });
    }
    if (!successCount) throw new Error('HIP-3 市场元数据暂不可用');
    return { markets: matches, updatedAt: new Date().toISOString(), stale: successCount < dexes.length };
  });
}

async function discoverMarkets(market) {
  const discovered = await getDiscoveredMarkets();
  const targets = new Set(underlyingNames(market.baseAsset));
  return {
    ...discovered,
    markets: discovered.markets.filter((item) => targets.has(item.coin.slice(item.dex.length + 1).toUpperCase()))
      .sort((a, b) => b.dayNotionalVolume - a.dayNotionalVolume),
  };
}

function parseExtraAddresses(input) {
  return [...new Set(String(input || '').split(',').map((item) => item.trim().toLowerCase()).filter((item) => ADDRESS_RE.test(item)))].slice(0, 5);
}

function trackedAddresses(extra) {
  const named = new Map();
  for (const whale of getActiveWhales().slice(0, DEFAULT_SCAN_LIMIT)) {
    const address = String(whale.address || '').toLowerCase();
    if (ADDRESS_RE.test(address)) named.set(address, { address, name: whale.name || '' });
  }
  for (const address of extra) named.set(address, { address, name: named.get(address)?.name || '手动观察地址' });
  return [...named.values()];
}

function numeric(value) { const number = Number(value); return Number.isFinite(number) ? number : null; }
function rowId(type, address, id) { return `${type}:${address}:${id}`; }

function mapFill(fill, owner, selectedMarket) {
  if (fill.coin !== selectedMarket.coin || !Number.isFinite(Number(fill.time)) || Date.now() - Number(fill.time) > DAY_MS) return null;
  const price = numeric(fill.px);
  const size = numeric(fill.sz);
  return {
    id: rowId('fill', owner.address, fill.tid || `${fill.time}:${fill.oid}`),
    type: '成交', address: owner.address, name: owner.name, dex: selectedMarket.dex, coin: selectedMarket.coin,
    time: Number(fill.time), direction: String(fill.dir || (fill.side === 'B' ? 'Buy' : 'Sell')),
    price, size, notionalUsd: price != null && size != null ? price * size : null,
    unrealizedPnlUsd: null, leverage: null, source: 'Hyperliquid userFills',
  };
}

function mapPosition(entry, owner, selectedMarket, markPrice) {
  const position = entry?.position;
  if (position?.coin !== selectedMarket.coin) return null;
  const signedSize = numeric(position.szi);
  if (!signedSize) return null;
  const price = numeric(position.entryPx);
  const positionValue = numeric(position.positionValue);
  return {
    id: rowId('position', owner.address, selectedMarket.coin),
    type: '持仓', address: owner.address, name: owner.name, dex: selectedMarket.dex, coin: selectedMarket.coin,
    time: null, direction: signedSize > 0 ? '持有多单' : '持有空单', price, size: Math.abs(signedSize),
    notionalUsd: positionValue != null ? Math.abs(positionValue) : markPrice ? Math.abs(signedSize) * markPrice : null,
    unrealizedPnlUsd: numeric(position.unrealizedPnl), leverage: numeric(position.leverage?.value),
    source: 'Hyperliquid clearinghouseState',
  };
}

function mapOrder(order, owner, selectedMarket) {
  if (order.coin !== selectedMarket.coin) return null;
  const price = numeric(order.limitPx);
  const size = numeric(order.sz);
  if (!size) return null;
  return {
    id: rowId('order', owner.address, order.oid || `${order.timestamp}:${order.limitPx}`),
    type: '挂单', address: owner.address, name: owner.name, dex: selectedMarket.dex, coin: selectedMarket.coin,
    time: numeric(order.timestamp), direction: order.side === 'B' ? '买入挂单' : '卖出挂单', price, size,
    notionalUsd: price != null ? price * size : null, unrealizedPnlUsd: null, leverage: null,
    source: 'Hyperliquid openOrders',
  };
}

async function scanOwner(owner, market) {
  const requests = await Promise.allSettled([
    cached(`fills:${owner.address}`, 60_000, () => hlPost({ type: 'userFills', user: owner.address })),
    cached(`state:${owner.address}:${market.dex}`, 20_000, () => hlPost({ type: 'clearinghouseState', user: owner.address, dex: market.dex })),
    cached(`orders:${owner.address}:${market.dex}`, 20_000, () => hlPost({ type: 'openOrders', user: owner.address, dex: market.dex })),
  ]);
  const [fills, state, orders] = requests.map((item) => item.status === 'fulfilled' ? item.value : null);
  const rows = [
    ...(Array.isArray(fills) ? fills.map((fill) => mapFill(fill, owner, market)) : []),
    ...(Array.isArray(state?.assetPositions) ? state.assetPositions.map((entry) => mapPosition(entry, owner, market, market.markPrice)) : []),
    ...(Array.isArray(orders) ? orders.map((order) => mapOrder(order, owner, market)) : []),
  ].filter(Boolean);
  return { rows, failedRequests: requests.filter((item) => item.status === 'rejected').length, successfulRequests: requests.filter((item) => item.status === 'fulfilled').length };
}

async function binanceRatio(symbol) {
  return cached(`binance-ratio:${symbol}`, 5 * 60_000, async () => {
    const endpoints = ['topLongShortAccountRatio', 'topLongShortPositionRatio'];
    const results = await Promise.allSettled(endpoints.map((name) => binance.get(`/futures/data/${name}`, { params: { symbol, period: '1h', limit: 1 } })));
    const rows = results.map((result) => result.status === 'fulfilled' && Array.isArray(result.value.data) ? result.value.data[0] : null);
    if (!rows.some(Boolean)) return { accountRatio: null, positionRatio: null, asOf: null, period: '1h', source: 'Binance Futures', unavailable: true };
    return {
      accountRatio: numeric(rows[0]?.longShortRatio),
      positionRatio: numeric(rows[1]?.longShortRatio),
      asOf: Math.max(numeric(rows[0]?.timestamp) || 0, numeric(rows[1]?.timestamp) || 0) || null,
      period: '1h', source: 'Binance Futures', unavailable: false,
    };
  });
}

async function getWhaleActivity(symbol, dexInput, extraInput) {
  const catalog = await getCatalog();
  const market = catalog.symbols.find((item) => item.symbol === String(symbol || '').toUpperCase());
  if (!market) { const error = new Error('该交易对不是当前可交易的 TradFi 合约'); error.status = 404; throw error; }
  const discovered = await discoverMarkets(market);
  const requestedDex = String(dexInput || '');
  const selectedMarket = discovered.markets.find((item) => item.dex === requestedDex) || discovered.markets[0] || null;
  const extras = parseExtraAddresses(extraInput);
  const owners = trackedAddresses(extras);
  const ratioPromise = binanceRatio(market.symbol).catch(() => ({ accountRatio: null, positionRatio: null, asOf: null, period: '1h', source: 'Binance Futures', unavailable: true }));
  if (!selectedMarket) return {
    symbol: market.symbol, selectedMarket: null, markets: discovered.markets, rows: [], fillCount: 0,
    scannedAddresses: owners.length, configuredAddresses: getActiveWhales().length, failedRequests: 0,
    coverageNote: '未找到名称可核对的 HIP-3 关联市场。', binance: await ratioPromise,
    updatedAt: new Date().toISOString(), stale: Boolean(discovered.stale),
  };
  const extraKey = extras.join(',');
  const activity = await cached(`activity:${market.symbol}:${selectedMarket.dex}:${extraKey}`, 60_000, async () => {
    const scans = await Promise.all(owners.map((owner) => scanOwner(owner, selectedMarket)));
    const allRows = scans.flatMap((result) => result.rows);
    const rows = allRows.sort((a, b) => (b.time || 0) - (a.time || 0)).slice(0, 80);
    const failedRequests = scans.reduce((sum, result) => sum + result.failedRequests, 0);
    const successfulRequests = scans.reduce((sum, result) => sum + result.successfulRequests, 0);
    return {
      rows, fillCount: allRows.filter((row) => row.type === '成交').length,
      scannedAddresses: owners.length, configuredAddresses: getActiveWhales().length,
      failedRequests, successfulRequests,
      coverageNote: '只扫描所列地址及所选 HIP-3 DEX；成交查询为每地址最近最多 2000 笔，再筛选过去 24 小时。',
      updatedAt: new Date().toISOString(), stale: false,
    };
  });
  return { symbol: market.symbol, selectedMarket, markets: discovered.markets, ...activity, stale: Boolean(discovered.stale || activity.stale), binance: await ratioPromise };
}

async function scanOwnerAll(owner, markets) {
  const marketByCoin = new Map(markets.map((market) => [market.coin, market]));
  const dexes = [...new Set(markets.map((market) => market.dex))];
  const requests = await Promise.allSettled([
    cached(`fills:${owner.address}`, 60_000, () => hlPost({ type: 'userFills', user: owner.address })),
    ...dexes.flatMap((dex) => [
      cached(`state:${owner.address}:${dex}`, 20_000, () => hlPost({ type: 'clearinghouseState', user: owner.address, dex })),
      cached(`orders:${owner.address}:${dex}`, 20_000, () => hlPost({ type: 'openOrders', user: owner.address, dex })),
    ]),
  ]);
  const rows = [];
  const fills = requests[0].status === 'fulfilled' ? requests[0].value : null;
  if (Array.isArray(fills)) {
    for (const fill of fills) {
      const market = marketByCoin.get(fill.coin);
      if (market) {
        const row = mapFill(fill, owner, market);
        if (row) rows.push(row);
      }
    }
  }
  dexes.forEach((dex, index) => {
    const stateResult = requests[index * 2 + 1];
    const ordersResult = requests[index * 2 + 2];
    const state = stateResult.status === 'fulfilled' ? stateResult.value : null;
    const orders = ordersResult.status === 'fulfilled' ? ordersResult.value : null;
    for (const entry of state?.assetPositions || []) {
      const market = marketByCoin.get(entry?.position?.coin);
      if (market && market.dex === dex) {
        const row = mapPosition(entry, owner, market, market.markPrice);
        if (row) rows.push(row);
      }
    }
    for (const order of Array.isArray(orders) ? orders : []) {
      const market = marketByCoin.get(order.coin);
      if (market && market.dex === dex) {
        const row = mapOrder(order, owner, market);
        if (row) rows.push(row);
      }
    }
  });
  return {
    rows,
    failedRequests: requests.filter((item) => item.status === 'rejected').length,
    successfulRequests: requests.filter((item) => item.status === 'fulfilled').length,
  };
}

async function getAllWhaleActivity() {
  const [catalog, discovered] = await Promise.all([getCatalog(), getDiscoveredMarkets()]);
  const names = new Set([...catalog.symbols.flatMap((item) => underlyingNames(item.baseAsset)), 'SNDK']);
  const markets = discovered.markets.filter((market) => names.has(market.coin.slice(market.dex.length + 1).toUpperCase()));
  const owners = trackedAddresses([]);
  const activity = await cached('activity:all-tradfi', 60_000, async () => {
    const scans = await Promise.all(owners.map((owner) => scanOwnerAll(owner, markets)));
    const rows = scans.flatMap((result) => result.rows).sort((a, b) => (b.time || 0) - (a.time || 0));
    return {
      rows,
      fillCount: rows.filter((row) => row.type === '成交').length,
      failedRequests: scans.reduce((sum, result) => sum + result.failedRequests, 0),
      successfulRequests: scans.reduce((sum, result) => sum + result.successfulRequests, 0),
      updatedAt: new Date().toISOString(),
      stale: false,
    };
  });
  return {
    ...activity,
    markets: markets.length,
    scannedAddresses: owners.length,
    configuredAddresses: getActiveWhales().length,
    coverageNote: `覆盖 ${markets.length} 个已匹配的 HIP-3 市场；成交为已扫描地址过去 24 小时记录，持仓与挂单为当前状态。`,
    stale: Boolean(discovered.stale || catalog.stale || activity.stale),
  };
}

module.exports = { getWhaleActivity, getAllWhaleActivity, underlyingNames, mapFill, mapPosition, mapOrder, parseExtraAddresses };
