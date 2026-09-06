import type { WhaleProfile } from '@/types';

/** 列表池子上限（全量筛选排序后再分页） */
export const DISPLAY_TOP_N = 200;
/** 每页条数 */
export const WHALE_PAGE_SIZE = 20;

const MIN_POS_USD = 1000;

export function whaleHasOpenPosition(whale: WhaleProfile | null | undefined) {
  if (!whale) return false;
  const positions = whale.positions || [];
  if (!positions.length) return false;
  const notional = positions.reduce((sum, pos) => sum + (Number(pos.positionValue) || 0), 0);
  return notional >= MIN_POS_USD;
}

/** 近 24h 成交笔数；未写入时用 closedTrades 作活跃度代理 */
export function whaleActivityScore(whale: WhaleProfile) {
  const fills24h = Number((whale as WhaleProfile & { fills24h?: number }).fills24h);
  if (Number.isFinite(fills24h) && fills24h >= 0) return fills24h;
  return Number(whale.closedTrades) || 0;
}

export function whalePriority(whale: WhaleProfile) {
  return Number(whale.priority) || 0;
}

/** 有仓优先 → 成交笔数 → priority */
export function compareWhalesForDisplay(a: WhaleProfile, b: WhaleProfile) {
  const pos = Number(whaleHasOpenPosition(b)) - Number(whaleHasOpenPosition(a));
  if (pos) return pos;
  const fills = whaleActivityScore(b) - whaleActivityScore(a);
  if (fills) return fills;
  const pri = whalePriority(b) - whalePriority(a);
  if (pri) return pri;
  return (Number(b.closedTrades) || 0) - (Number(a.closedTrades) || 0);
}

export function sortWhalesForDisplay(list: WhaleProfile[]) {
  return [...list].sort(compareWhalesForDisplay);
}

/** 从地址池选出展示用 TopN，可排除已在榜 / 刚踢出的 id */
export function pickDisplayWhales(
  pool: WhaleProfile[],
  options: { limit?: number; excludeIds?: Iterable<string>; preferIds?: string[] } = {},
) {
  const limit = Math.max(1, Number(options.limit) || DISPLAY_TOP_N);
  const exclude = new Set([...(options.excludeIds || [])].map(String).filter(Boolean));
  const prefer = (options.preferIds || []).map(String).filter(Boolean);

  const byId = new Map(pool.map((item) => [item.id, item]));
  const picked: WhaleProfile[] = [];
  const seen = new Set<string>();

  for (const id of prefer) {
    if (picked.length >= limit) break;
    if (exclude.has(id) || seen.has(id)) continue;
    const whale = byId.get(id);
    if (!whale || whale.enabled === false) continue;
    picked.push(whale);
    seen.add(id);
  }

  const ranked = sortWhalesForDisplay(
    pool.filter((item) => item.enabled !== false && !exclude.has(item.id) && !seen.has(item.id)),
  );
  for (const whale of ranked) {
    if (picked.length >= limit) break;
    picked.push(whale);
    seen.add(whale.id);
  }
  return picked;
}

/** 踢出一只后，从池子补一只未在榜的 */
export function pickReplacementWhale(
  pool: WhaleProfile[],
  currentIds: string[],
  removeId: string,
) {
  const keep = currentIds.filter((id) => id && id !== removeId);
  const next = pickDisplayWhales(pool, {
    limit: keep.length + 1,
    preferIds: keep,
    excludeIds: [removeId],
  });
  return next.find((item) => !keep.includes(item.id)) || null;
}
