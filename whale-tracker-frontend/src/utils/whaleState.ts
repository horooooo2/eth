import type { WhaleProfile } from '@/types';
import type { WhaleAlert } from '@/utils/whaleAlerts';
import type { WhaleServerSummary } from '@/api';

export type StateCursor = { epoch: string; seq: number };
export type WhaleBootstrap = StateCursor & {
  protocolVersion: 1;
  whales: WhaleProfile[];
  alerts: WhaleAlert[];
  summary: WhaleServerSummary | null;
  updatedAt: number;
};
export type WhaleStateCommit = StateCursor & {
  type: 'stateCommit';
  whales?: WhaleProfile[];
  alerts?: WhaleAlert[];
  removedWhaleIds?: string[];
  removedAlertIds?: string[];
  notifyAlertIds?: string[];
  summary?: WhaleServerSummary | null;
  updatedAt?: number;
};
export type WhaleState = StateCursor & {
  whalesById: Record<string, WhaleProfile>;
  alertsById: Record<string, WhaleAlert>;
  alertRevisions: Record<string, number>;
  pinnedAlertIds: string[];
  minimumAlertQuerySeq: number;
  summary: WhaleServerSummary | null;
  updatedAt: number;
};

export function emptyWhaleState(): WhaleState {
  return { epoch: '', seq: 0, whalesById: {}, alertsById: {}, alertRevisions: {}, pinnedAlertIds: [], minimumAlertQuerySeq: 0, summary: null, updatedAt: 0 };
}

function indexById<T extends { id: string }>(items: T[]): Record<string, T> {
  return Object.fromEntries(items.filter(item => item?.id).map(item => [item.id, item]));
}

export function recentAlerts(items: WhaleAlert[], limit = 100) {
  const eventTime = (alert: WhaleAlert) => Math.max(0, ...(alert.items || []).map(item => Number(item.time) || 0)) || Number(alert.at) || 0;
  return [...items].sort((a, b) => eventTime(b) - eventTime(a)
    || a.id.localeCompare(b.id)).slice(0, limit);
}

export function stateFromBootstrap(payload: WhaleBootstrap): WhaleState {
  if (payload.protocolVersion !== 1 || !payload.epoch || !Number.isSafeInteger(payload.seq) || payload.seq < 0) {
    throw new Error('巨鲸快照协议无效，请稍后重试');
  }
  return {
    epoch: payload.epoch, seq: payload.seq,
    whalesById: indexById(payload.whales || []),
    alertsById: indexById(recentAlerts(payload.alerts || [])),
    alertRevisions: Object.fromEntries((payload.alerts || []).map(alert => [alert.id, payload.seq])),
    pinnedAlertIds: [], minimumAlertQuerySeq: payload.seq,
    summary: payload.summary, updatedAt: payload.updatedAt,
  };
}

/** Only contiguous commits can advance the cursor. Duplicate replay is harmless. */
export function reduceStateCommit(state: WhaleState, commit: WhaleStateCommit):
  { status: 'applied' | 'duplicate' | 'resync'; state: WhaleState } {
  if (!state.epoch || state.epoch !== commit.epoch || !Number.isSafeInteger(commit.seq)) {
    return { status: 'resync', state };
  }
  if (commit.seq <= state.seq) return { status: 'duplicate', state };
  if (commit.seq !== state.seq + 1) return { status: 'resync', state };
  const whalesById = { ...state.whalesById, ...indexById(commit.whales || []) };
  for (const id of commit.removedWhaleIds || []) delete whalesById[id];
  const alertsById = { ...state.alertsById, ...indexById(commit.alerts || []) };
  const alertRevisions = { ...state.alertRevisions };
  for (const alert of commit.alerts || []) alertRevisions[alert.id] = commit.seq;
  for (const id of commit.removedAlertIds || []) alertRevisions[id] = commit.seq;
  for (const id of commit.removedAlertIds || []) delete alertsById[id];
  return { status: 'applied', state: boundAlertState({
    epoch: state.epoch, seq: commit.seq, whalesById,
    alertsById, alertRevisions,
    pinnedAlertIds: state.pinnedAlertIds, minimumAlertQuerySeq: state.minimumAlertQuerySeq,
    summary: commit.summary === undefined ? state.summary : commit.summary,
    updatedAt: commit.updatedAt ?? state.updatedAt,
  }) };
}

/** Bound long-lived sessions. A discarded tombstone advances the allowed HTTP watermark. */
function boundAlertState(state: WhaleState): WhaleState {
  const keep = new Set([...recentAlerts(Object.values(state.alertsById), 3000).map(alert => alert.id), ...state.pinnedAlertIds]);
  const alertsById = Object.fromEntries(Object.entries(state.alertsById).filter(([id]) => keep.has(id)));
  const entries = Object.entries(state.alertRevisions).sort((a, b) => b[1] - a[1]);
  const alertRevisions: Record<string, number> = {};
  let minimumAlertQuerySeq = state.minimumAlertQuerySeq;
  entries.forEach(([id, seq], index) => {
    if (index < 6000 || keep.has(id)) alertRevisions[id] = seq;
    else minimumAlertQuerySeq = Math.max(minimumAlertQuerySeq, seq);
  });
  return { ...state, alertsById, alertRevisions, minimumAlertQuerySeq };
}

/** Detail responses may enrich only the exact entity revision they requested. */
export function canApplyDetailResponse(current: WhaleProfile | undefined, requested: WhaleProfile | undefined) {
  return Boolean(current && current === requested);
}

export function notificationIds(state: WhaleState, commit: WhaleStateCommit, synced: boolean, now: number): string[] {
  if (!synced) return [];
  const allowed = new Set(commit.notifyAlertIds || []);
  return (commit.alerts || []).filter(alert => {
    const eventTime = Math.max(0, ...(alert.items || []).map(item => Number(item.time) || 0)) || Number(alert.at) || 0;
    return allowed.has(alert.id) && state.alertRevisions[alert.id] === undefined && eventTime >= now - 120_000 && eventTime <= now + 60_000;
  }).map(alert => alert.id);
}

export function mergeAlertQuery(state: WhaleState, rows: WhaleAlert[], cursor: StateCursor): WhaleState | null {
  if (cursor.epoch !== state.epoch || !Number.isSafeInteger(cursor.seq) || cursor.seq > state.seq || cursor.seq < state.minimumAlertQuerySeq) return null;
  const alertsById = { ...state.alertsById };
  const alertRevisions = { ...state.alertRevisions };
  for (const alert of rows) {
    if (!alert.id || (alertRevisions[alert.id] ?? -1) > cursor.seq) continue;
    alertsById[alert.id] = alert;
    alertRevisions[alert.id] = cursor.seq;
  }
  return boundAlertState({ ...state, alertsById, alertRevisions, pinnedAlertIds: rows.slice(0, 100).map(alert => alert.id) });
}

/** Freeze order during pointer interaction; values continue to update immediately. */
export function stabilizeIds(previous: string[], ranked: string[], paused: boolean): string[] {
  if (!paused) return ranked;
  const next = new Set(ranked);
  const retained = previous.filter(id => next.has(id));
  const known = new Set(retained);
  return [...retained, ...ranked.filter(id => !known.has(id))];
}
