/**
 * 诊币分析任务 / 版本存储（内存 + 文件 cache）
 */
const crypto = require('crypto');
const { readCache, writeCache } = require('./cache');

const mem = new Map();
const MAX_MEM = 200;

function id(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
}

function newAnalysisId() {
  return id('an');
}

function newContextSnapshotId() {
  return id('ctx');
}

function touch(entry) {
  mem.delete(entry.analysisId);
  mem.set(entry.analysisId, entry);
  while (mem.size > MAX_MEM) {
    const first = mem.keys().next().value;
    mem.delete(first);
  }
  try {
    writeCache(`brief-analysis-${entry.analysisId}`, entry);
  } catch (_) {
    /* ignore */
  }
  return entry;
}

function getAnalysis(analysisId) {
  const idKey = String(analysisId || '');
  if (!idKey) return null;
  if (mem.has(idKey)) return mem.get(idKey);
  const hit = readCache(`brief-analysis-${idKey}`);
  if (hit?.data) {
    mem.set(idKey, hit.data);
    return hit.data;
  }
  return null;
}

function createAnalysis({ coin, userId, forceRefresh = false }) {
  const analysisId = newAnalysisId();
  const entry = {
    analysisId,
    contextSnapshotId: null,
    coin: String(coin || '').toUpperCase(),
    userId: userId || null,
    forceRefresh: Boolean(forceRefresh),
    status: 'pending', // pending|running|done|failed
    createdAt: Date.now(),
    updatedAt: Date.now(),
    version: null,
    result: null,
    analysisMarkdown: null,
    contextSummary: null,
    capability: null,
    contextDiff: null,
    error: null,
    model: null,
  };
  return touch(entry);
}

function updateAnalysis(analysisId, patch) {
  const cur = getAnalysis(analysisId);
  if (!cur) return null;
  const next = { ...cur, ...patch, updatedAt: Date.now() };
  return touch(next);
}

/** 每币版本列表 */
function listVersions(coin, userId) {
  const key = `brief-versions-${userId || 'anon'}-${String(coin || '').toUpperCase()}`;
  const hit = readCache(key);
  const list = Array.isArray(hit?.data) ? hit.data : [];
  return list;
}

function pushVersion(coin, userId, versionRow) {
  const key = `brief-versions-${userId || 'anon'}-${String(coin || '').toUpperCase()}`;
  const prev = listVersions(coin, userId);
  const next = [versionRow, ...prev].slice(0, 40);
  writeCache(key, next);
  return next;
}

function nextVersionLabel(coin, userId) {
  const n = listVersions(coin, userId).length + 1;
  return `V${n}`;
}

function buildContextDiff(prevSnap, nextSnap) {
  if (!prevSnap || !nextSnap) return null;
  const changes = [];
  const p = prevSnap;
  const n = nextSnap;
  const push = (field, before, after, note) => {
    if (before === after) return;
    if (before == null && after == null) return;
    changes.push({ field, before, after, note: note || '' });
  };

  push('price', p.price ?? null, n.price ?? null, '现价');
  push('fundingPct', p.fundingPct ?? null, n.fundingPct ?? null, '资金费率');
  push('takerRatio', p.takerRatio ?? null, n.takerRatio ?? null, 'Taker买卖比');
  push('liqTotalUsd', p.liqTotalUsd ?? null, n.liqTotalUsd ?? null, '24h爆仓');
  push('whaleBias', p.whaleBias ?? null, n.whaleBias ?? null, '大户方向');
  push('techHourStructure', p.techHourStructure ?? null, n.techHourStructure ?? null, '1h结构');
  push('techDayStructure', p.techDayStructure ?? null, n.techDayStructure ?? null, '1d结构');
  push('rsi14Day', p.rsi14Day ?? null, n.rsi14Day ?? null, '日线RSI');

  return {
    changed: changes.length > 0,
    changes,
    summary:
      changes.length === 0
        ? '关键输入与上一版基本一致'
        : changes.map((c) => `${c.note || c.field}: ${c.before ?? '—'} → ${c.after ?? '—'}`).join('；'),
  };
}

function snapshotForDiff(ctx) {
  const ext = ctx.sentiment?.external || {};
  const top = ext.binanceTopAccount;
  let whaleBias = 'flat';
  if (top?.longPct != null && top?.shortPct != null) {
    whaleBias = top.longPct >= top.shortPct + 5 ? 'long' : top.shortPct >= top.longPct + 5 ? 'short' : 'flat';
  } else if ((ctx.whales?.longUsd || 0) !== (ctx.whales?.shortUsd || 0)) {
    whaleBias = (ctx.whales?.longUsd || 0) >= (ctx.whales?.shortUsd || 0) ? 'long' : 'short';
  }
  return {
    price: ctx.market?.price ?? null,
    fundingPct: ctx.market?.fundingPct ?? null,
    takerRatio: ext.binanceTaker?.buySellRatio ?? null,
    liqTotalUsd: ctx.sentiment?.liquidations?.totalUsd ?? null,
    whaleBias,
    techHourStructure: ctx.tech?.hour?.structure ?? null,
    techDayStructure: ctx.tech?.day?.structure ?? null,
    rsi14Day: ctx.tech?.day?.rsi14 ?? null,
  };
}

module.exports = {
  newAnalysisId,
  newContextSnapshotId,
  getAnalysis,
  createAnalysis,
  updateAnalysis,
  listVersions,
  pushVersion,
  nextVersionLabel,
  buildContextDiff,
  snapshotForDiff,
};
