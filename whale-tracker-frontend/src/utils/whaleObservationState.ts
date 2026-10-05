import type { ObservationCommit, ObservationSnapshot } from '@/types/whaleObservation';
export function applyObservationCommit(current: ObservationSnapshot | null, msg: ObservationCommit): ObservationSnapshot | null {
  if (!current || current.epoch !== msg.epoch || !Number.isSafeInteger(msg.seq)) return null;
  if (msg.seq <= current.seq) return current;
  if (msg.seq !== current.seq + 1 || msg.ids.length > 100 || new Set(msg.ids).size !== msg.ids.length) return null;
  const rows = new Map(current.rows.map(row => [row.id, row]));
  for (const row of msg.rows) rows.set(row.id, row);
  if (msg.ids.some(id => !rows.has(id))) return null;
  return { ...msg, type: 'observationSnapshot', rows: msg.ids.map(id => rows.get(id)!) };
}
