/**
 * OKX 跟单公开接口：牛人榜 TopN + 持仓/历史 → 开单时间流
 * 文档：/api/v5/copytrading/public-*
 */
const axios = require('axios');
const https = require('https');
const { readCache, writeCache } = require('./cache');
const { broadcast } = require('./realtimeHub');

const OKX_BASE = String(process.env.OKX_BASE || 'https://www.okx.com').replace(/\/$/, '');
const CACHE_NAME = 'okx-copy-top';
const TOP_N = Math.max(5, Math.min(100, Number(process.env.OKX_TOP_N) || 50));
const INST_TYPE = process.env.OKX_INST_TYPE || 'SWAP';
const SORT_TYPE = process.env.OKX_SORT_TYPE || 'pnl_ratio';
const POLL_MS = Math.max(
  30_000,
  Number(process.env.OKX_POLL_INTERVAL_MS) || 30_000,
);
const REQUEST_GAP_MS = Math.max(80, Number(process.env.OKX_REQUEST_GAP_MS) || 180);
const REQUEST_TIMEOUT_MS = Math.max(
  10_000,
  Number(process.env.OKX_TIMEOUT_MS) || 60_000,
);
const REQUEST_RETRIES = Math.max(0, Math.min(4, Number(process.env.OKX_RETRIES) || 2));
/** 部分云主机 IPv6 访问 OKX 会卡死超时，默认强制 IPv4 */
const FORCE_IPV4 = String(process.env.OKX_FORCE_IPV4 || '1') !== '0';
const httpsAgent = FORCE_IPV4 ? new https.Agent({ family: 4, keepAlive: true }) : undefined;
/** 境内机器常需代理才能访问 OKX，例：http://127.0.0.1:7890 */
const OKX_PROXY = String(process.env.OKX_PROXY || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '').trim();
/**
 * 上游镜像：服务器拉不到 OKX 时，从可访问 OKX 的节点拉已缓存仪表盘
 * 例：本机或香港机 http://x.x.x.x/api/okx
 */
const OKX_UPSTREAM = String(process.env.OKX_UPSTREAM || '').replace(/\/$/, '');
/** OKX 缓存「新鲜」窗口；过期仍继续对外提供，后台再刷（与 HL 一致） */
const OKX_CACHE_FRESH_MS = Math.max(
  60_000,
  Number(process.env.OKX_CACHE_FRESH_MS) || 5 * 60_000,
);

let pollTimer = null;
let refreshBusy = false;
let refreshWaiters = [];
let lastRefresh = null;
/** null = 未播种；用于开单增量告警，避免冷启动刷屏 */
let seenOpenKeys = null;

const OPEN_ALERT_MAX_AGE_MS = Math.max(
  30 * 60_000,
  Number(process.env.OKX_OPEN_ALERT_MAX_AGE_MS) || 6 * 3600_000,
);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function coinFromInst(instId) {
  const raw = String(instId || '').trim();
  if (!raw) return '';
  return raw.split('-')[0] || raw;
}

/** 由累计收益率序列估算最大回撤（0~1+） */
function maxDrawdownFromRatios(pnlRatios) {
  const series = Array.isArray(pnlRatios) ? pnlRatios : [];
  if (series.length < 2) return 0;
  let peak = -Infinity;
  let maxDd = 0;
  for (const point of series) {
    const v = num(point.pnlRatio);
    if (v > peak) peak = v;
    if (peak <= v) continue;
    const base = Math.max(Math.abs(peak), 1e-6);
    const dd = (peak - v) / base;
    if (dd > maxDd) maxDd = dd;
  }
  return maxDd;
}

function mapTrader(rank, index) {
  const uniqueCode = String(rank.uniqueCode || '').trim();
  const pnlRatios = Array.isArray(rank.pnlRatios)
    ? rank.pnlRatios
        .map((item) => ({
          beginTs: num(item.beginTs),
          pnlRatio: num(item.pnlRatio),
        }))
        .filter((item) => item.beginTs > 0)
        .sort((a, b) => a.beginTs - b.beginTs)
    : [];
  const copyNum = num(rank.copyTraderNum);
  const maxCopy = num(rank.maxCopyTraderNum);
  const maxDrawdown = maxDrawdownFromRatios(pnlRatios);
  return {
    id: uniqueCode,
    uniqueCode,
    name: String(rank.nickName || uniqueCode || '未知').trim(),
    avatar: String(rank.portLink || '').trim(),
    rank: index + 1,
    pnl: num(rank.pnl),
    pnlRatio: num(rank.pnlRatio),
    winRatio: num(rank.winRatio),
    aum: num(rank.aum),
    copyTraderNum: copyNum,
    maxCopyTraderNum: maxCopy,
    isFull: maxCopy > 0 && copyNum >= maxCopy,
    leadDays: num(rank.leadDays),
    ccy: String(rank.ccy || 'USDT'),
    instruments: Array.isArray(rank.traderInsts)
      ? rank.traderInsts.slice(0, 12).map(String)
      : [],
    pnlRatios,
    maxDrawdown,
    copyPnl: 0,
    lastOpenAt: 0,
  };
}

function parseAxiosProxy(proxyUrl) {
  if (!proxyUrl) return undefined;
  try {
    const u = new URL(proxyUrl);
    const conf = {
      protocol: (u.protocol || 'http:').replace(':', ''),
      host: u.hostname,
      port: Number(u.port) || (u.protocol === 'https:' ? 443 : 80),
    };
    if (u.username) {
      conf.auth = {
        username: decodeURIComponent(u.username),
        password: decodeURIComponent(u.password || ''),
      };
    }
    return conf;
  } catch {
    console.warn('[okx] invalid OKX_PROXY:', proxyUrl);
    return undefined;
  }
}

const axiosProxy = parseAxiosProxy(OKX_PROXY);

function resolveRefreshWaiters(payload, error) {
  const waiters = refreshWaiters;
  refreshWaiters = [];
  for (const w of waiters) {
    if (error) w.reject(error);
    else w.resolve(payload);
  }
}

async function okxGet(path, params = {}) {
  let lastErr = null;
  for (let attempt = 0; attempt <= REQUEST_RETRIES; attempt += 1) {
    try {
      const req = {
        params,
        timeout: REQUEST_TIMEOUT_MS,
        headers: {
          Accept: 'application/json',
          // 不带 zh 时 nickName 常为英文别名（如 King_GG），中文站展示为本地昵称
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.5',
          Referer: `${OKX_BASE}/zh-hans/copy-trading`,
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        },
      };
      if (axiosProxy) {
        req.proxy = axiosProxy;
      } else if (httpsAgent) {
        req.httpsAgent = httpsAgent;
        req.proxy = false;
      }
      const { data } = await axios.get(`${OKX_BASE}${path}`, req);
      if (!data || String(data.code) !== '0') {
        const msg = data?.msg || `OKX error code=${data?.code || '?'}`;
        const err = new Error(msg);
        err.code = data?.code;
        throw err;
      }
      return data.data;
    } catch (err) {
      lastErr = err;
      const retriable =
        err.code === 'ECONNABORTED' ||
        err.code === 'ETIMEDOUT' ||
        err.code === 'ECONNRESET' ||
        err.code === 'ENOTFOUND' ||
        err.code === 'EAI_AGAIN' ||
        /timeout/i.test(err.message || '');
      if (!retriable || attempt >= REQUEST_RETRIES) break;
      await sleep(800 * (attempt + 1));
    }
  }
  throw lastErr || new Error('OKX request failed');
}

async function fetchLeadTraderPage(page = 1) {
  const rows = await okxGet('/api/v5/copytrading/public-lead-traders', {
    instType: INST_TYPE,
    sortType: SORT_TYPE,
    page: String(page),
  });
  const block = Array.isArray(rows) ? rows[0] : null;
  const ranks = Array.isArray(block?.ranks) ? block.ranks : [];
  const totalPage = Math.max(1, num(block?.totalPage, 1));
  return { ranks, totalPage, dataVer: block?.dataVer || '' };
}

async function fetchTopTraders(limit = TOP_N) {
  const traders = [];
  let page = 1;
  let totalPage = 1;
  let dataVer = '';
  while (traders.length < limit && page <= totalPage && page <= 10) {
    const chunk = await fetchLeadTraderPage(page);
    totalPage = chunk.totalPage;
    dataVer = chunk.dataVer || dataVer;
    for (const rank of chunk.ranks) {
      const mapped = mapTrader(rank, traders.length);
      if (!mapped.id) continue;
      traders.push(mapped);
      if (traders.length >= limit) break;
    }
    page += 1;
    if (traders.length < limit) await sleep(REQUEST_GAP_MS);
  }
  return { traders, dataVer };
}

/** 官网跟单仓位（未脱敏），映射为 public-current-subpositions 同形字段 */
function normalizeEcotradePos(pos) {
  const instId = String(pos.instId || pos.displayId || '').trim();
  const posQty = num(pos.pos || pos.subPos);
  const posSideRaw = String(pos.posSide || '').toLowerCase();
  let posSide = 'long';
  if (posSideRaw === 'short') posSide = 'short';
  else if (posSideRaw === 'long') posSide = 'long';
  else if (posQty < 0) posSide = 'short'; // net 模式：数量符号区分多空
  return {
    ccy: String(pos.marginCcy || pos.quoteCcy || 'USDT'),
    instId,
    instType: String(pos.instType || INST_TYPE),
    lever: pos.lever,
    margin: pos.margin,
    markPx: pos.markPx || pos.last || '',
    mgnMode: pos.mgnMode,
    mgnRatio: pos.mgnRatio,
    openAvgPx: pos.avgPx || pos.openAvgPx || '',
    openTime: pos.cTime || pos.openTime || '',
    posSide,
    subPos: String(Math.abs(posQty) || pos.pos || pos.subPos || ''),
    subPosId: String(pos.posId || pos.subPosId || '').trim(),
    uniqueCode: pos.uniqueCode,
    upl: pos.upl,
    uplRatio: pos.uplRatio,
    liqPx: pos.liqPx || '',
    displayName: pos.displayName || '',
  };
}

async function fetchEcotradeCurrentPositions(uniqueCode) {
  const data = await okxGet('/priapi/v5/ecotrade/public/community/user/position-current', {
    uniqueName: uniqueCode,
    instType: INST_TYPE,
  });
  const blocks = Array.isArray(data) ? data : [];
  const rows = [];
  for (const block of blocks) {
    const list = Array.isArray(block?.posData) ? block.posData : [];
    for (const pos of list) {
      rows.push(normalizeEcotradePos(pos));
    }
  }
  return rows;
}

async function fetchCurrentPositions(uniqueCode) {
  // 优先官网 community 仓位接口（含币种/价格）；官方 public API 常脱敏
  try {
    const rich = await fetchEcotradeCurrentPositions(uniqueCode);
    if (rich.length) return rich;
  } catch (err) {
    if (String(err.code) !== '60004') {
      console.warn(`[okx] ecotrade positions ${uniqueCode}:`, err.message);
    }
  }
  try {
    const data = await okxGet('/api/v5/copytrading/public-current-subpositions', {
      instType: INST_TYPE,
      uniqueCode,
    });
    return Array.isArray(data) ? data : [];
  } catch (err) {
    if (String(err.code) === '60004') return [];
    throw err;
  }
}

async function fetchPositionsHistory(uniqueCode) {
  try {
    const data = await okxGet('/api/v5/copytrading/public-subpositions-history', {
      instType: INST_TYPE,
      uniqueCode,
    });
    return Array.isArray(data) ? data : [];
  } catch (err) {
    if (String(err.code) === '60004') return [];
    throw err;
  }
}

/** lastDays: 1=7d 2=30d 3=90d 4=365d */
async function fetchPublicStats(uniqueCode, lastDays = '3') {
  try {
    const data = await okxGet('/api/v5/copytrading/public-stats', {
      instType: INST_TYPE,
      uniqueCode,
      lastDays: String(lastDays),
    });
    const row = Array.isArray(data) ? data[0] : null;
    if (!row) return null;
    return {
      winRatio: num(row.winRatio),
      profitDays: num(row.profitDays),
      lossDays: num(row.lossDays),
      curCopyTraderPnl: num(row.curCopyTraderPnl),
      avgSubPosNotional: num(row.avgSubPosNotional),
      investAmt: num(row.investAmt),
      ccy: String(row.ccy || 'USDT'),
      lastDays: String(lastDays),
    };
  } catch (err) {
    if (String(err.code) === '60004') return null;
    throw err;
  }
}

async function fetchWeeklyPnl(uniqueCode) {
  try {
    const data = await okxGet('/api/v5/copytrading/public-weekly-pnl', {
      instType: INST_TYPE,
      uniqueCode,
    });
    return (Array.isArray(data) ? data : [])
      .map((row) => ({
        beginTs: num(row.beginTs),
        pnl: num(row.pnl),
        pnlRatio: num(row.pnlRatio),
      }))
      .sort((a, b) => a.beginTs - b.beginTs);
  } catch (err) {
    if (String(err.code) === '60004') return [];
    throw err;
  }
}

const detailCache = new Map();
const DETAIL_TTL_MS = 60_000;

async function getTraderDetail(uniqueCode, { force = false, lastDays = '3' } = {}) {
  const id = String(uniqueCode || '').trim();
  if (!id) throw new Error('缺少 uniqueCode');
  const cacheKey = `${id}:${lastDays}`;
  const hit = detailCache.get(cacheKey);
  if (!force && hit && Date.now() - hit.at < DETAIL_TTL_MS) {
    return hit.data;
  }

  const dash = getCachedDashboard();
  const trader = (dash?.traders || []).find((t) => t.id === id) || { id, uniqueCode: id, name: id };

  await sleep(REQUEST_GAP_MS);
  const [stats, weekly] = await Promise.all([
    fetchPublicStats(id, lastDays).catch((err) => {
      console.warn(`[okx] stats ${id}:`, err.message);
      return null;
    }),
    fetchWeeklyPnl(id).catch((err) => {
      console.warn(`[okx] weekly ${id}:`, err.message);
      return [];
    }),
  ]);

  const positions = dash?.positionsByTrader?.[id] || [];
  const opens = (dash?.opens || []).filter((item) => item.traderId === id);

  const data = {
    trader,
    stats,
    weekly,
    positions,
    opens,
    rows: buildLeadRows(trader, stats),
    updatedAt: Date.now(),
  };
  detailCache.set(cacheKey, { at: Date.now(), data });
  return data;
}

function buildLeadRows(trader, stats) {
  const rows = [];
  const dd = Number(trader.maxDrawdown) || 0;
  rows.push({
    key: 'maxDrawdown',
    label: '最大回撤',
    value: `${(dd * 100).toFixed(2)}%`,
    tone: dd >= 0.2 ? 'down' : dd > 0 ? 'warn' : 'neutral',
  });
  if (stats) {
    rows.push(
      { key: 'profitDays', label: '盈利天数', value: String(stats.profitDays), tone: 'up' },
      { key: 'lossDays', label: '亏损天数', value: String(stats.lossDays), tone: 'down' },
      {
        key: 'winRatio',
        label: '胜率',
        value: `${(stats.winRatio * 100).toFixed(2)}%`,
        tone: 'neutral',
      },
      {
        key: 'avgSubPosNotional',
        label: '平均仓位价值',
        value: formatUsdPlain(stats.avgSubPosNotional),
        tone: 'neutral',
      },
      {
        key: 'curCopyTraderPnl',
        label: '当前跟单用户收益',
        value: formatUsdSigned(stats.curCopyTraderPnl),
        tone: stats.curCopyTraderPnl >= 0 ? 'up' : 'down',
      },
      {
        key: 'investAmt',
        label: '交易员带单资产',
        value: formatUsdPlain(stats.investAmt),
        tone: 'neutral',
      },
    );
  }
  rows.push(
    {
      key: 'leadDays',
      label: '带单天数',
      value: String(trader.leadDays ?? '—'),
      tone: 'neutral',
    },
    {
      key: 'aum',
      label: '带单规模',
      value: formatUsdPlain(trader.aum),
      tone: 'neutral',
    },
    {
      key: 'copy',
      label: '跟单人数',
      value: `${trader.copyTraderNum ?? 0}/${trader.maxCopyTraderNum || '—'}`,
      tone: trader.isFull ? 'warn' : 'neutral',
    },
    {
      key: 'pnl',
      label: '交易员收益额',
      value: formatUsdSigned(trader.pnl),
      tone: (trader.pnl || 0) >= 0 ? 'up' : 'down',
    },
    {
      key: 'pnlRatio',
      label: '交易员收益率',
      value: `${((trader.pnlRatio || 0) * 100).toFixed(2)}%`,
      tone: (trader.pnlRatio || 0) >= 0 ? 'up' : 'down',
    },
  );
  return rows;
}

function formatUsdPlain(n) {
  const v = Math.abs(Number(n) || 0);
  return v.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

function formatUsdSigned(n) {
  const v = Number(n) || 0;
  const sign = v > 0 ? '+' : v < 0 ? '-' : '';
  return `${sign}${Math.abs(v).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
}

function mapOpenEvent(row, trader, kind) {
  const subPosId = String(row.subPosId || '').trim();
  const openTime = num(row.openTime);
  const closeTime = num(row.closeTime);
  const at =
    kind === 'close'
      ? closeTime || openTime || 0
      : openTime || closeTime || 0;
  const instId = String(row.instId || '').trim();
  const sideRaw = String(row.posSide || '').toLowerCase();
  const side = sideRaw === 'short' ? 'short' : 'long';
  const mgnModeRaw = String(row.mgnMode || '').toLowerCase();
  const mgnMode =
    mgnModeRaw === 'cross' || mgnModeRaw === 'isolated' ? mgnModeRaw : '';
  const coin =
    coinFromInst(instId) ||
    String(row.displayName || row.posCcy || '')
      .trim()
      .toUpperCase();
  return {
    id: `${subPosId || instId || trader.id}:${kind}:${at || subPosId}`,
    at,
    traderId: trader.id,
    traderName: trader.name,
    kind,
    status: kind === 'close' ? 'closed' : 'open',
    coin,
    instId,
    side,
    lever: num(row.lever),
    margin: num(row.margin),
    size: num(row.subPos),
    openAvgPx: num(row.openAvgPx),
    closeAvgPx: num(row.closeAvgPx),
    markPx: num(row.markPx),
    liqPx: num(row.liqPx),
    mgnMode,
    mgnRatio: num(row.mgnRatio),
    pnl: kind === 'close' ? num(row.pnl) : num(row.upl),
    pnlRatio: kind === 'close' ? num(row.pnlRatio) : num(row.uplRatio),
    openTime: openTime || null,
    closeTime: closeTime || null,
    subPosId,
  };
}

function buildEvents(trader, currentRows, historyRows) {
  const events = [];
  const openIds = new Set();

  for (const row of currentRows) {
    const ev = mapOpenEvent(row, trader, 'open');
    if (!ev.subPosId && !ev.instId) continue;
    openIds.add(ev.subPosId || ev.id);
    // 当前持仓常被脱敏（无 instId / openTime），不塞进时间流避免无意义顶置
    if (ev.at > 0 && (ev.instId || ev.openTime)) {
      events.push(ev);
    }
  }

  for (const row of historyRows) {
    const openEv = mapOpenEvent(row, trader, 'open');
    const closeEv = mapOpenEvent(row, trader, 'close');
    if (openEv.openTime && !openIds.has(openEv.subPosId)) {
      events.push({ ...openEv, status: 'closed', kind: 'open' });
    }
    if (closeEv.closeTime) {
      events.push(closeEv);
    }
  }

  return events;
}

function openEventKey(ev) {
  const sub = String(ev?.subPosId || '').trim();
  if (sub) return sub;
  return String(ev?.id || '').trim();
}

function collectOpenKeys(opens) {
  const keys = new Set();
  for (const ev of opens || []) {
    if (ev?.kind !== 'open') continue;
    const key = openEventKey(ev);
    if (key) keys.add(key);
  }
  return keys;
}

function buildOkxOpenAlert(ev) {
  const sideLabel = ev.side === 'short' ? '开空' : '开多';
  const coin = ev.coin || ev.instId || '—';
  const lever = Number(ev.lever) || 0;
  const margin = Number(ev.margin) || 0;
  const parts = [sideLabel, coin];
  if (lever > 0) parts.push(`${lever}x`);
  if (margin > 0) parts.push(`保证金 $${Math.round(margin).toLocaleString('en-US')}`);
  return {
    id: `okx-open-${openEventKey(ev)}`,
    at: Number(ev.openTime) || Number(ev.at) || Date.now(),
    traderId: ev.traderId,
    traderName: ev.traderName || ev.traderId,
    kind: 'open',
    kindLabel: '开单',
    headline: parts.join(' · '),
    coin: ev.coin || '',
    instId: ev.instId || '',
    side: ev.side === 'short' ? 'short' : 'long',
    lever: lever || null,
    margin: margin || null,
    price: Number(ev.openAvgPx) || null,
    subPosId: ev.subPosId || '',
    source: 'okx',
  };
}

/** 对比上一轮，推送新开单；首次只播种不告警 */
function emitNewOkxOpenAlerts(opens) {
  const currentKeys = collectOpenKeys(opens);
  if (seenOpenKeys === null) {
    const cached = getCachedDashboard();
    seenOpenKeys = collectOpenKeys(cached?.opens || []);
    for (const k of currentKeys) seenOpenKeys.add(k);
    console.log(`[okx] alert seed opens=${seenOpenKeys.size}`);
    return 0;
  }

  const now = Date.now();
  const alerts = [];
  for (const ev of opens || []) {
    if (ev?.kind !== 'open') continue;
    const key = openEventKey(ev);
    if (!key || seenOpenKeys.has(key)) continue;
    seenOpenKeys.add(key);
    const openAt = Number(ev.openTime) || Number(ev.at) || 0;
    if (openAt > 0 && now - openAt > OPEN_ALERT_MAX_AGE_MS) continue;
    alerts.push(buildOkxOpenAlert(ev));
  }
  for (const k of currentKeys) seenOpenKeys.add(k);

  if (seenOpenKeys.size > 8000) {
    seenOpenKeys = currentKeys;
  }

  let pushed = 0;
  for (const alert of alerts) {
    try {
      pushed += broadcast({ type: 'okxAlert', alert, at: now }) > 0 ? 1 : 0;
    } catch (err) {
      console.warn('[okx] alert broadcast failed:', err.message);
    }
  }
  if (alerts.length) {
    console.log(`[okx] new open alerts=${alerts.length} delivered=${pushed}`);
  }
  return alerts.length;
}

async function refreshOkxDashboard() {
  if (refreshBusy) {
    return new Promise((resolve, reject) => {
      refreshWaiters.push({ resolve, reject });
    });
  }
  refreshBusy = true;
  const started = Date.now();
  try {
    const payload = await refreshOkxFromNetwork();
    resolveRefreshWaiters(payload, null);
    return payload;
  } catch (err) {
    lastRefresh = {
      ok: false,
      at: Date.now(),
      ms: Date.now() - started,
      error: err.message || String(err),
      payload: lastRefresh?.payload || null,
    };
    console.warn('[okx] refresh failed:', err.message);
    resolveRefreshWaiters(null, err);
    throw err;
  } finally {
    refreshBusy = false;
  }
}

function getCachedDashboard() {
  const cached = readCache(CACHE_NAME);
  if (!cached?.data) return null;
  const updatedAt = Number(cached.updatedAt) || 0;
  const stale = Date.now() - updatedAt > OKX_CACHE_FRESH_MS;
  return {
    ...cached.data,
    updatedAt,
    stale,
  };
}

/** 写入/覆盖 OKX 仪表盘缓存（本机抓取后推送到境内服务器） */
function seedOkxCache(payload, { source = 'seed' } = {}) {
  if (!payload || !Array.isArray(payload.traders) || !payload.traders.length) {
    throw new Error('seed 需要含 traders 的仪表盘数据');
  }
  const data = {
    traders: payload.traders,
    opens: Array.isArray(payload.opens) ? payload.opens : [],
    positions: Array.isArray(payload.positions) ? payload.positions : [],
    positionsByTrader: payload.positionsByTrader && typeof payload.positionsByTrader === 'object'
      ? payload.positionsByTrader
      : {},
    meta: {
      ...(payload.meta && typeof payload.meta === 'object' ? payload.meta : {}),
      source,
      seededAt: Date.now(),
    },
  };
  writeCache(CACHE_NAME, data);
  const updatedAt = Date.now();
  lastRefresh = {
    ok: true,
    at: updatedAt,
    ms: 0,
    error: null,
    payload: data,
  };
  try {
    broadcast({
      type: 'okxUpdate',
      at: updatedAt,
      traders: data.traders,
      opens: data.opens,
      positions: data.positions,
      positionsByTrader: data.positionsByTrader,
      meta: data.meta,
      updatedAt,
    });
  } catch (_) {
    /* ignore */
  }
  return {
    traders: data.traders.length,
    opens: data.opens.length,
    positions: data.positions.length,
    updatedAt,
  };
}

async function fetchFromUpstream() {
  if (!OKX_UPSTREAM) return null;
  const url = OKX_UPSTREAM.includes('/api/okx')
    ? OKX_UPSTREAM
    : `${OKX_UPSTREAM}/api/okx`;
  const { data } = await axios.get(url, {
    timeout: REQUEST_TIMEOUT_MS,
    params: { refresh: 0 },
    headers: { Accept: 'application/json' },
  });
  if (!data || !Array.isArray(data.traders) || !data.traders.length) {
    throw new Error('上游 OKX 无交易员数据');
  }
  return seedOkxCache(data, { source: 'upstream' });
}

async function refreshOkxFromNetwork() {
  // 原 refresh 主体：直接打 OKX；失败再试上游
  const started = Date.now();
  try {
    const { traders, dataVer } = await fetchTopTraders(TOP_N);
    const positionsByTrader = {};
    const allEvents = [];

    for (const trader of traders) {
      await sleep(REQUEST_GAP_MS);
      let current = [];
      let history = [];
      let stats = null;
      try {
        current = await fetchCurrentPositions(trader.id);
      } catch (err) {
        console.warn(`[okx] positions ${trader.id}:`, err.message);
      }
      await sleep(REQUEST_GAP_MS);
      try {
        history = await fetchPositionsHistory(trader.id);
      } catch (err) {
        console.warn(`[okx] history ${trader.id}:`, err.message);
      }
      await sleep(REQUEST_GAP_MS);
      try {
        stats = await fetchPublicStats(trader.id, '3');
      } catch (err) {
        console.warn(`[okx] stats ${trader.id}:`, err.message);
      }

      if (stats) {
        trader.copyPnl = num(stats.curCopyTraderPnl);
        trader.winRatio = num(stats.winRatio) || trader.winRatio;
      }

      const openPositions = current.map((row) => mapOpenEvent(row, trader, 'open'));
      positionsByTrader[trader.id] = openPositions;
      trader.openCount = openPositions.length;
      trader.openMargin = openPositions.reduce((s, p) => s + (Number(p.margin) || 0), 0);
      trader.openUpl = openPositions.reduce((s, p) => s + (Number(p.pnl) || 0), 0);

      const traderEvents = buildEvents(trader, current, history);
      let lastOpenAt = 0;
      for (const pos of openPositions) {
        const t = Number(pos.openTime) || Number(pos.at) || 0;
        if (t > lastOpenAt) lastOpenAt = t;
      }
      for (const ev of traderEvents) {
        if (ev.kind !== 'open') continue;
        const t = Number(ev.openTime) || Number(ev.at) || 0;
        if (t > lastOpenAt) lastOpenAt = t;
      }
      trader.lastOpenAt = lastOpenAt;
      allEvents.push(...traderEvents);
    }

    allEvents.sort((a, b) => (b.at || 0) - (a.at || 0));
    const opens = allEvents.slice(0, 500);

    const positions = [];
    for (const trader of traders) {
      for (const pos of positionsByTrader[trader.id] || []) {
        positions.push(pos);
      }
    }
    positions.sort((a, b) => (b.at || 0) - (a.at || 0) || (b.margin || 0) - (a.margin || 0));

    const payload = {
      traders,
      opens,
      positions,
      positionsByTrader,
      meta: {
        topN: TOP_N,
        instType: INST_TYPE,
        sortType: SORT_TYPE,
        dataVer,
        traderCount: traders.length,
        openEventCount: opens.length,
        positionCount: positions.length,
        refreshedAt: Date.now(),
        durationMs: Date.now() - started,
        source: 'okx',
      },
    };
    emitNewOkxOpenAlerts(opens);
    writeCache(CACHE_NAME, payload);
    const updatedAt = Date.now();
    lastRefresh = { ok: true, at: updatedAt, ms: Date.now() - started, error: null, payload };
    console.log(
      `[okx] refreshed traders=${traders.length} opens=${opens.length} ${lastRefresh.ms}ms`,
    );
    try {
      const n = broadcast({
        type: 'okxUpdate',
        at: updatedAt,
        traders,
        opens,
        positions,
        positionsByTrader,
        meta: payload.meta,
        updatedAt,
      });
      if (n > 0) console.log(`[okx] pushed okxUpdate clients=${n}`);
    } catch (err) {
      console.warn('[okx] broadcast failed:', err.message);
    }
    return payload;
  } catch (directErr) {
    if (OKX_UPSTREAM) {
      console.warn(`[okx] direct failed (${directErr.message}), try upstream ${OKX_UPSTREAM}`);
      try {
        await fetchFromUpstream();
        const cached = getCachedDashboard();
        if (cached?.traders?.length) {
          lastRefresh = {
            ok: true,
            at: cached.updatedAt || Date.now(),
            ms: Date.now() - started,
            error: null,
            payload: {
              traders: cached.traders,
              opens: cached.opens || [],
              positions: cached.positions || [],
              positionsByTrader: cached.positionsByTrader || {},
              meta: cached.meta || {},
            },
          };
          return lastRefresh.payload;
        }
      } catch (upErr) {
        console.warn('[okx] upstream failed:', upErr.message);
      }
    }
    throw directErr;
  }
}

async function getOkxDashboard({ force = false } = {}) {
  const cached = getCachedDashboard();
  if (cached && !force && !cached.stale) {
    return cached;
  }
  if (cached && !force) {
    // 过期仍先返回，后台刷新
    void refreshOkxDashboard().catch(() => null);
    return cached;
  }
  try {
    const fresh = await refreshOkxDashboard();
    if (!fresh || !Array.isArray(fresh.traders)) {
      if (cached) return { ...cached, error: lastRefresh?.error || 'OKX 刷新无数据' };
      throw new Error(lastRefresh?.error || 'OKX 刷新无数据');
    }
    return { ...fresh, updatedAt: Date.now(), stale: false };
  } catch (err) {
    if (cached) return { ...cached, error: err.message };
    throw err;
  }
}

function getOkxStatus() {
  return {
    topN: TOP_N,
    base: OKX_BASE,
    timeoutMs: REQUEST_TIMEOUT_MS,
    retries: REQUEST_RETRIES,
    forceIpv4: FORCE_IPV4,
    proxy: Boolean(OKX_PROXY),
    upstream: OKX_UPSTREAM || null,
    cacheFreshMs: OKX_CACHE_FRESH_MS,
    instType: INST_TYPE,
    sortType: SORT_TYPE,
    pollMs: POLL_MS,
    busy: refreshBusy,
    lastRefresh: lastRefresh
      ? {
          ok: lastRefresh.ok,
          at: lastRefresh.at,
          ms: lastRefresh.ms,
          error: lastRefresh.error,
        }
      : null,
    cache: (() => {
      const c = getCachedDashboard();
      return c
        ? {
            updatedAt: c.updatedAt,
            stale: c.stale,
            traders: Array.isArray(c.traders) ? c.traders.length : 0,
          }
        : null;
    })(),
  };
}

function startOkxPolling() {
  if (pollTimer) return;
  const enabled = String(process.env.OKX_POLL || '1') !== '0';
  if (!enabled) {
    console.log('[okx] polling disabled (OKX_POLL=0)');
    return;
  }
  console.log(`[okx] polling every ${Math.round(POLL_MS / 1000)}s top=${TOP_N}`);
  void refreshOkxDashboard().catch(() => null);
  pollTimer = setInterval(() => {
    void refreshOkxDashboard().catch(() => null);
  }, POLL_MS);
}

module.exports = {
  TOP_N,
  getOkxDashboard,
  refreshOkxDashboard,
  getOkxStatus,
  startOkxPolling,
  getTraderDetail,
  seedOkxCache,
  fetchTopTraders,
  fetchCurrentPositions,
  fetchPositionsHistory,
  fetchPublicStats,
};
