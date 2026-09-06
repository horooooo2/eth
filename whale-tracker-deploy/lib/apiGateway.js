/**
 * EdgeOne Cloud Function 用的无 Express 路由分发（Web Request -> Response）。
 */
const {
  getWhales,
  getWhalesBatch,
  refreshSingleWhale,
  refreshAlertHistory,
  listTrades,
  getWhaleTrades,
  getWhaleTransfers,
  getWhalePosition,
  invalidateWhaleCache,
  buildActivityFeed,
} = require('./whales');
const { getNews, getNewsDetail } = require('./newsService');
const { getCalendar } = require('./calendar');
const { getMarkets, getQuotes, getLiquidations, lookupCoin, fetchFedOdds } = require('./markets');
const { fetchWhaleAlerts } = require('./onchain');
const { readConfig, writeConfig, setWhaleMode, normalizeAddress, normalizeMode } = require('./config');

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,PUT,OPTIONS',
  'access-control-allow-headers': 'content-type',
};

function json(status, data) {
  return {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...CORS },
    body: JSON.stringify(data),
  };
}

function normalizePath(pathname) {
  let path = String(pathname || '/');
  try {
    path = decodeURIComponent(path);
  } catch {
    // keep raw
  }
  if (path.length > 1) path = path.replace(/\/+$/, '');
  if (path.startsWith('/api/')) path = path.slice(4);
  else if (path === '/api') path = '/';
  if (!path.startsWith('/')) path = `/${path}`;
  return path;
}

async function readBody(request) {
  if (!request || request.method === 'GET' || request.method === 'HEAD') return {};
  try {
    const text = await request.text();
    if (!text) return {};
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function parseCoins(query) {
  const raw = query.coins;
  if (!raw) return [];
  return String(raw)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

async function dispatch(method, pathname, query, body) {
  const path = normalizePath(pathname);

  if (method === 'OPTIONS') {
    return { status: 204, headers: CORS, body: '' };
  }

  if (method === 'GET' && path === '/health') {
    return json(200, { ok: true, service: 'whale-tracker', time: new Date().toISOString() });
  }

  if (method === 'GET' && path === '/news') {
    const data = await getNews(query.refresh === '1');
    return json(200, data);
  }
  if (method === 'GET' && path === '/news/calendar') {
    const force = query.refresh === '1';
    return json(200, await getCalendar(force));
  }
  if (method === 'GET' && path === '/news/detail') {
    const data = await getNewsDetail(query.id, query.url);
    return json(200, data);
  }
  if (method === 'PUT' && path === '/news/keywords') {
    const keywords = body?.keywords;
    if (!Array.isArray(keywords)) return json(400, { error: 'keywords 必须是字符串数组' });
    const current = readConfig();
    const saved = writeConfig({
      ...current,
      keywords: keywords.map((item) => String(item).trim()).filter(Boolean),
    });
    return json(200, { keywords: saved.keywords });
  }

  if (method === 'GET' && path === '/whales') {
    const useBatch =
      query.batch === '1' || query.offset != null || query.limit != null;
    if (useBatch) {
      try {
        const data = await getWhalesBatch(query);
        const { trades, ...rest } = data;
        const config = readConfig();
        return json(200, {
          ...rest,
          mode: rest.mode || config.mode || 'hf',
          activity: rest.activity || buildActivityFeed(trades),
        });
      } catch (err) {
        return json(err.status || 502, { error: err.message || '巨鲸数据获取失败' });
      }
    }
    const data = await getWhales(query.refresh === '1');
    const { trades, ...rest } = data;
    const activity = buildActivityFeed(trades);
    const config = readConfig();
    return json(200, { ...rest, mode: rest.mode || config.mode || 'hf', activity });
  }
  if (method === 'GET' && path === '/whales/config') {
    return json(200, readConfig());
  }
  if (method === 'POST' && path === '/whales/mode') {
    const mode = normalizeMode(body?.mode);
    const saved = setWhaleMode(mode);
    return json(200, {
      mode: saved.mode,
      total: saved.whales.length,
      ok: true,
    });
  }
  if (method === 'POST' && path === '/whales/config') {
    if (!Array.isArray(body?.whales)) return json(400, { error: 'whales 必须是数组' });
    const whales = body.whales.map((item, index) => {
      const name = String(item.name || '').trim();
      const address = String(item.address || '').trim();
      if (!name) throw Object.assign(new Error(`第 ${index + 1} 条缺少名称`), { status: 400 });
      if (address && !normalizeAddress(address) && !address.endsWith('.eth')) {
        if (!/^0x/i.test(address) && !address.includes('.')) {
          throw Object.assign(new Error(`${name} 的地址格式无效`), { status: 400 });
        }
      }
      return {
        id: String(item.id || name).trim(),
        name,
        address,
        description: String(item.description || ''),
        winRate: Number(item.winRate) || 0,
        maxDrawdown: Number(item.maxDrawdown) || 0,
        closedTrades: Number(item.closedTrades) || 0,
        weekVlm: Number(item.weekVlm) || 0,
        priority: Number(item.priority) || 0,
        style: item.style,
        enabled: item.enabled !== false,
      };
    });
    const current = readConfig();
    const saved = writeConfig({
      whales,
      keywordGroups: current.keywordGroups,
      keywords: Array.isArray(body.keywords) ? body.keywords : current.keywords,
    });
    invalidateWhaleCache(saved.mode);
    return json(200, saved);
  }
  if (method === 'GET' && path === '/whales/trades') {
    return json(200, await listTrades(query));
  }
  if (method === 'GET' && path === '/whales/alert-history') {
    try {
      const { loadRecentAlerts, loadPagedAlerts } = require('./sqliteStore');
      if (query.page == null && query.paged == null) {
        const limit = Number(query.limit) || 500;
        const alerts = loadRecentAlerts(limit);
        return json(200, { alerts, total: alerts.length, retentionDays: 7 });
      }
      return json(200, loadPagedAlerts(query));
    } catch (err) {
      return json(500, { error: err.message || '读取异动历史失败', alerts: [] });
    }
  }
  if (method === 'POST' && path === '/whales/alert-history') {
    try {
      const { persistAlerts } = require('./sqliteStore');
      const alerts = Array.isArray(body?.alerts) ? body.alerts : [];
      const result = persistAlerts(alerts);
      return json(200, { ok: true, saved: result.saved, retentionDays: 7 });
    } catch (err) {
      return json(500, { error: err.message || '写入异动历史失败' });
    }
  }
  if (
    (method === 'POST' || method === 'GET') &&
    (path === '/whales/alert-history/refresh' || path === '/whales/history/refresh')
  ) {
    try {
      return json(200, await refreshAlertHistory(query));
    } catch (err) {
      return json(err.status || 502, { error: err.message || '异动历史拉取失败' });
    }
  }
  const positionMatch = path.match(/^\/whales\/([^/]+)\/positions\/([^/]+)$/);
  if (method === 'GET' && positionMatch) {
    return json(200, await getWhalePosition(positionMatch[1], positionMatch[2]));
  }
  const whaleTradesMatch = path.match(/^\/whales\/([^/]+)\/trades$/);
  if (method === 'GET' && whaleTradesMatch) {
    return json(200, await getWhaleTrades(whaleTradesMatch[1], query));
  }
  const whaleTransfersMatch = path.match(/^\/whales\/([^/]+)\/transfers$/);
  if (method === 'GET' && whaleTransfersMatch) {
    try {
      return json(200, await getWhaleTransfers(whaleTransfersMatch[1], query));
    } catch (err) {
      return json(err.status || 502, { error: err.message || '该巨鲸转账记录获取失败' });
    }
  }
  const whaleRefreshMatch = path.match(/^\/whales\/([^/]+)\/refresh$/);
  if (method === 'POST' && whaleRefreshMatch) {
    try {
      return json(200, await refreshSingleWhale(whaleRefreshMatch[1]));
    } catch (err) {
      return json(err.status || 502, { error: err.message || '该巨鲸刷新失败' });
    }
  }

  if (method === 'GET' && (path === '/poly-fed' || path === '/markets/fed')) {
    return json(200, await fetchFedOdds());
  }

  if (method === 'GET' && path === '/markets') {
    return json(200, await getMarkets(query.refresh === '1', parseCoins(query)));
  }
  if (method === 'GET' && path === '/markets/quotes') {
    return json(200, await getQuotes(parseCoins(query)));
  }
  if (method === 'GET' && path === '/markets/liquidations') {
    const coin = query.coin || 'BTC';
    return json(200, await getLiquidations(coin));
  }
  if (method === 'GET' && path === '/markets/lookup') {
    const result = await lookupCoin(query.symbol);
    if (!result.ok) return json(404, { error: result.error || '币种输入错误，请检查后再试' });
    return json(200, result);
  }
  if (method === 'GET' && path === '/markets/whale-alerts') {
    const minUsd = Math.max(0, Number(query.minUsd) || 100_000);
    const limit = Math.min(100, Math.max(1, Number(query.limit) || 50));
    const data = await fetchWhaleAlerts(minUsd, limit);
    return json(200, {
      alerts: (data.alerts || []).slice(0, limit),
      source: data.source || null,
      warning: data.error || data.warning || null,
      minUsd,
      updatedAt: Date.now(),
    });
  }

  return json(404, { error: `未找到接口 ${method} ${path}` });
}

async function handleRequest(context) {
  const request = context.request;
  const url = new URL(request.url);
  try {
    const body = await readBody(request);
    const query = Object.fromEntries(url.searchParams);
    return await dispatch(request.method.toUpperCase(), url.pathname, query, body);
  } catch (err) {
    console.error('[apiGateway]', err);
    return json(err.status || 502, { error: err.message || '请求失败' });
  }
}

async function onRequest(context) {
  const result = await handleRequest(context);
  return new Response(result.body, { status: result.status, headers: result.headers });
}

module.exports = {
  onRequest,
  onRequestGet: onRequest,
  onRequestPost: onRequest,
  onRequestPut: onRequest,
  onRequestDelete: onRequest,
  onRequestOptions: onRequest,
  handleRequest,
  dispatch,
};
