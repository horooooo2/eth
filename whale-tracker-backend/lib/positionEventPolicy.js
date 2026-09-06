/**
 * 仓位事件策略：最小金额、$1k、10s 同向合并、开/加/减/平
 */
const POSITION_EVENT_MIN_USD = Math.max(
  0,
  Number(process.env.POSITION_EVENT_MIN_USD) || 1000,
);
const POSITION_EVENT_MERGE_MS = Math.max(
  1000,
  Number(process.env.POSITION_EVENT_MERGE_MS) || 10_000,
);
const FILL_MAX_PER_WHALE = Math.max(
  50,
  Math.min(2000, Number(process.env.FILL_MAX_PER_WHALE) || 200),
);
/** 已平仓相关事件再留 1 天 */
const CLOSED_POSITION_RETENTION_MS = Math.max(
  60 * 60 * 1000,
  (Number(process.env.CLOSED_POSITION_RETENTION_DAYS) || 1) * 24 * 60 * 60 * 1000,
);

const OPEN_KINDS = new Set(['open', 'increase']);
const CLOSE_KINDS = new Set(['decrease', 'close']);
const ALL_KINDS = new Set(['open', 'increase', 'decrease', 'close']);

function kindGroup(kind) {
  if (OPEN_KINDS.has(kind)) return 'open';
  if (CLOSE_KINDS.has(kind)) return 'close';
  return '';
}

function passesMinUsd(usd, kind) {
  const value = Math.abs(Number(usd) || 0);
  // 开仓即使略低于门槛也保留（便于追开仓点）；其余严格 $1k
  if (kind === 'open') return value >= Math.min(POSITION_EVENT_MIN_USD, 100);
  return value >= POSITION_EVENT_MIN_USD;
}

function preferKind(a, b) {
  const rank = { open: 0, close: 1, increase: 2, decrease: 3 };
  const ra = rank[a] ?? 9;
  const rb = rank[b] ?? 9;
  return ra <= rb ? a : b;
}

function kindLabel(kind) {
  if (kind === 'open') return '开单';
  if (kind === 'increase') return '加仓';
  if (kind === 'decrease') return '减仓';
  if (kind === 'close') return '平仓';
  return kind;
}

/** 事件 → 前端 WhaleAlert */
function alertDocFromEvent(event) {
  if (!event || !ALL_KINDS.has(event.kind)) return null;
  if (!passesMinUsd(event.usd, event.kind)) return null;
  const kl = kindLabel(event.kind);
  const sideLabel = event.side === 'short' ? '空' : '多';
  const mergedN = Math.max(1, Number(event.mergedCount) || 1);
  return {
    id: String(event.id),
    at: Number(event.time) || Date.now(),
    whaleId: event.whaleId ? String(event.whaleId) : '',
    whaleName: event.payload?.whaleName || '',
    address: event.payload?.from || event.payload?.address || '',
    kind: event.kind,
    kindLabel: mergedN > 1 ? `${kl}（多单）` : kl,
    headline:
      mergedN > 1
        ? `${event.title || kl}（${mergedN} 笔）`
        : event.title || `${kl} ${event.coin || ''}`.trim(),
    items: [
      {
        kind: event.kind,
        title: event.title || `${kl}${sideLabel} ${event.coin || ''}`.trim(),
        detail: mergedN > 1 ? `合并 ${mergedN} 笔` : '',
        coin: event.coin || undefined,
        side: event.side === 'short' ? 'short' : 'long',
        usd: Number(event.usd) || 0,
        time: Number(event.time) || 0,
        price: event.payload?.price ?? null,
      },
    ],
    layer: 'position',
    mergedCount: mergedN,
  };
}

module.exports = {
  POSITION_EVENT_MIN_USD,
  POSITION_EVENT_MERGE_MS,
  FILL_MAX_PER_WHALE,
  CLOSED_POSITION_RETENTION_MS,
  OPEN_KINDS,
  CLOSE_KINDS,
  ALL_KINDS,
  kindGroup,
  passesMinUsd,
  preferKind,
  kindLabel,
  alertDocFromEvent,
};
