export type ObservationPosition = {status:'same'|'opposite'|'flat'|'unknown';reason?:string;asOf:number|null;side?:'long'|'short';size?:number};
export type WhaleObservation = {
  latestPosition?:ObservationPosition;
  calculation?:{inputVersion:number;windowAt:number;throughAt:number|null;pendingUpdates:boolean};
  positionCounts?:{same:number;opposite:number;flat:number;unknown:number};
  id: string; whaleId: string; address: string; coin: string;
  type: 'build' | 'reverse' | 'reduce' | 'collective'; side: 'long' | 'short';
  tracking?: {status:string;asOf:number;lastSize:number;addUsd:number;reduceUsd:number;fillCount:number;interruption?:{reason:string;at:number;expectedSize:number;actualSize:number|null}|null};
  timing?: {eventAt:number|null;latestExecutionReceivedAt:number|null;inputsReadyAt:number|null;generatedAt:number};
  members?: {whaleId:string;address:string;addUsd:number;latestPosition?:ObservationPosition}[];
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
  rows: { id: string; whaleId?:string; address?:string; time: number; start: number; end: number; size: number; price: number;
    legs: { kind: string; side: string; usd: number }[]; closedPnl: number | null }[];
};
export type ObservationCommit = Omit<ObservationSnapshot, 'type'> & { type: 'observationCommit'; ids: string[] };
