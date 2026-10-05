export type WhaleObservation = {
  id: string; whaleId: string; address: string; coin: string;
  type: 'build' | 'reverse' | 'reduce'; side: 'long' | 'short';
  title: string; text: string; startAt: number; lastAt: number;
  revision: number; publishedAt: number; updatedAt: number; evidenceCount: number;
  metrics: { closedPnl?: number | null };
};
export type ObservationSnapshot = {
  type: 'observationSnapshot'; epoch: string; seq: number; rows: WhaleObservation[];
  error: string; warming: boolean; asOf: number; windowHours: number;
};
export type ObservationEvidence = {
  id: string; revision: number; offset: number; total: number;
  rows: { id: string; time: number; start: number; end: number; size: number; price: number;
    legs: { kind: string; side: string; usd: number }[]; closedPnl: number | null }[];
};
export type ObservationCommit = Omit<ObservationSnapshot, 'type'> & { type: 'observationCommit'; ids: string[] };
