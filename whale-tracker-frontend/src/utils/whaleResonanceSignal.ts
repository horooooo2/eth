import type { WhaleProfile, WhaleTrade } from '@/types';
import { formatUsd } from '@/utils/format';
import { estimateLiquidationPx } from '@/utils/positionAnalysis';
import { alertEventTime, isTradeOpen, tradeFillSide, type WhaleAlert, type WhaleAlertItem } from '@/utils/whaleAlerts';
import { coinMatchesWatch, readWatchedCoins } from '@/utils/watchedCoins';

const STORAGE_KEY = 'whale-tracker-resonance-window-h';

export const WINDOW_HOUR_OPTIONS = [
  { label: '2小时', value: 2 },
  { label: '4小时', value: 4 },
  { label: '6小时', value: 6 },
  { label: '12小时', value: 12 },
  { label: '24小时', value: 24 },
] as const;

const ALLOWED_WINDOW_HOURS = new Set(WINDOW_HOUR_OPTIONS.map((item) => item.value));

export interface ResonanceConfig {
  windowHours: number;
  minWhales: number;
  minNotionalUsd: number;
  minWinRate: number;
  mergeMinutes: number;
  accumulationWindowHours: number;
  accumulationMinOpens: number;
  accumulationMinTotalUsd: number;
}

export const DEFAULT_RESONANCE_CONFIG: ResonanceConfig = {
  windowHours: 6,
  minWhales: 3,
  minNotionalUsd: 50_000,
  minWinRate: 70,
  mergeMinutes: 5,
  accumulationWindowHours: 6,
  accumulationMinOpens: 3,
  accumulationMinTotalUsd: 500_000,
};

export type ResonanceSignalKind = 'cluster' | 'accumulation';

export interface ResonanceOpenRow {
  whaleId: string;
  whaleName: string;
  address: string;
  coin: string;
  side: 'long' | 'short';
  price: number;
  notionalUsd: number;
  time: number;
  winRate: number;
  leverage: number | null;
  liquidationPx: number | null;
  /** 时间窗内合并的开仓笔数 */
  openCount?: number;
}

export interface ResonanceSignal {
  id: string;
  kind: ResonanceSignalKind;
  coin: string;
  side: 'long' | 'short';
  whaleCount: number;
  tradeCount: number;
  totalUsd: number;
  rows: ResonanceOpenRow[];
  bannerText: string;
  biasLabel: string;
  whaleId?: string;
  whaleName?: string;
}

export interface ResonanceScanResult {
  hit: boolean;
  primary: ResonanceSignal | null;
  signals: ResonanceSignal[];
  emptyText: string;
}

function coinKey(coin: string) {
  return String(coin || '').toUpperCase().replace(/^K/, '');
}

function coinLabel(trade: WhaleTrade) {
  const raw = trade.assetLabel || trade.asset || '';
  return coinKey(raw) || raw || '--';
}

function tradePrice(trade: WhaleTrade) {
  if (Number(trade.price) > 0) return Number(trade.price);
  if (Number(trade.amount) > 0 && Number(trade.amountUsd) > 0) {
    return Number(trade.amountUsd) / Number(trade.amount);
  }
  return 0;
}

function normalizeWindowHours(value: unknown) {
  const n = Number(value);
  if (ALLOWED_WINDOW_HOURS.has(n as (typeof WINDOW_HOUR_OPTIONS)[number]['value'])) return n;
  if (n === 48 || n === 72) return 24;
  return DEFAULT_RESONANCE_CONFIG.windowHours;
}

function shortWhaleLabel(name: string, address: string) {
  const addr = String(address || '').toLowerCase();
  if (addr.startsWith('0x') && addr.length > 10) return `0x…${addr.slice(-4)}`;
  return name || '--';
}

export function readResonanceConfig(): ResonanceConfig {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    const windowHours = normalizeWindowHours(saved);
    if (saved != null && Number(saved) !== windowHours) {
      writeResonanceWindowHours(windowHours);
    }
    return {
      ...DEFAULT_RESONANCE_CONFIG,
      windowHours,
    };
  } catch {
    return { ...DEFAULT_RESONANCE_CONFIG };
  }
}

export function writeResonanceWindowHours(windowHours: number) {
  localStorage.setItem(STORAGE_KEY, String(normalizeWindowHours(windowHours)));
}

function mergeOpens(rows: ResonanceOpenRow[], mergeMs: number) {
  const sorted = [...rows].sort((a, b) => a.time - b.time);
  const merged: ResonanceOpenRow[] = [];

  for (const row of sorted) {
    const prev = merged[merged.length - 1];
    if (
      prev &&
      prev.whaleId === row.whaleId &&
      prev.coin === row.coin &&
      prev.side === row.side &&
      row.time - prev.time <= mergeMs
    ) {
      const total = prev.notionalUsd + row.notionalUsd;
      prev.price = total > 0 ? (prev.price * prev.notionalUsd + row.price * row.notionalUsd) / total : prev.price;
      prev.notionalUsd = total;
      prev.time = row.time;
      continue;
    }
    merged.push({ ...row });
  }

  return merged;
}

function buildClusterBannerText(signal: ResonanceSignal, windowHours: number) {
  const sideText = signal.side === 'long' ? '开多' : '开空';
  const bias = signal.side === 'long' ? '短线偏多' : '短线偏空';
  return `【${signal.coin}】${windowHours}h内 ${signal.whaleCount}巨鲸同向${sideText}（总${formatUsd(signal.totalUsd)}）→ ${bias}`;
}

function buildAccumulationBannerText(signal: ResonanceSignal, windowHours: number) {
  const sideText = signal.side === 'long' ? '做多' : '做空';
  const bias = signal.side === 'long' ? '主力吸筹' : '主力派发';
  const label = shortWhaleLabel(signal.whaleName || signal.rows[0]?.whaleName || '', signal.rows[0]?.address || '');
  return `【${signal.coin}】${windowHours}h内 ${label} 持续${sideText}加仓（${signal.tradeCount}笔·总${formatUsd(signal.totalUsd)}）→ ${bias}`;
}

function isOpenAlertKind(kind: string | undefined) {
  return kind === 'open';
}

function alertOpenItems(alert: WhaleAlert): WhaleAlertItem[] {
  if (alert.items?.length) {
    return alert.items.filter((item) => isOpenAlertKind(item.kind));
  }
  if (!isOpenAlertKind(alert.kind)) return [];
  return [
    {
      kind: 'open',
      title: alert.headline || '',
      detail: '',
      coin: '',
      side: undefined,
      usd: 0,
      price: 0,
      time: alert.at,
    },
  ];
}

function rowsFromAlerts(alerts: WhaleAlert[], whaleMap: Map<string, WhaleProfile>, since: number, config: ResonanceConfig) {
  const rows: ResonanceOpenRow[] = [];
  for (const alert of alerts) {
    const whale = whaleMap.get(alert.whaleId);
    if (!whale) continue;
    for (const item of alertOpenItems(alert)) {
      const time = Number(item.time) || alertEventTime(alert);
      if (!time || time < since) continue;
      const notionalUsd = Number(item.usd) || 0;
      if (notionalUsd < config.minNotionalUsd) continue;
      const coin = coinKey(item.coin || '');
      if (!coin) continue;
      rows.push(
        buildOpenRow(whale, {
          whaleId: alert.whaleId,
          whaleName: alert.whaleName || whale.name,
          address: alert.address || whale.address,
          coin,
          side: item.side || 'long',
          price: Number(item.price) || 0,
          notionalUsd,
          time,
          winRate: Number(whale.winRate) || 0,
        }),
      );
    }
  }
  return rows;
}

function dedupeRows(rows: ResonanceOpenRow[]) {
  const map = new Map<string, ResonanceOpenRow>();
  for (const row of rows) {
    const key = `${row.whaleId}|${row.coin}|${row.side}|${Math.floor(row.time / 60_000)}`;
    const prev = map.get(key);
    if (!prev || row.notionalUsd > prev.notionalUsd) map.set(key, row);
  }
  return [...map.values()];
}

function matchWhalePosition(whale: WhaleProfile, coin: string, side: 'long' | 'short') {
  const key = coinKey(coin);
  return (whale.positions || []).find(
    (pos) => coinKey(pos.coinLabel || pos.coin) === key && pos.side === side,
  );
}

function resolveOpenMetrics(whale: WhaleProfile, coin: string, side: 'long' | 'short', price: number) {
  const pos = matchWhalePosition(whale, coin, side);
  const leverage = pos?.leverage && pos.leverage > 0 ? Number(pos.leverage) : null;
  let liquidationPx: number | null = null;
  if (pos?.liquidationPx) {
    const liq = Number(pos.liquidationPx);
    liquidationPx = Number.isFinite(liq) && liq > 0 ? liq : null;
  }
  if (!liquidationPx && leverage && price > 0) {
    liquidationPx = estimateLiquidationPx(side, price, leverage);
  }
  return { leverage, liquidationPx };
}

function buildOpenRow(
  whale: WhaleProfile,
  base: Omit<ResonanceOpenRow, 'leverage' | 'liquidationPx'>,
): ResonanceOpenRow {
  const metrics = resolveOpenMetrics(whale, base.coin, base.side, base.price);
  return { ...base, ...metrics };
}

/** 明细表：同一巨鲸、同币种同方向的多笔开仓合并为一行，并优先对齐当前持仓 */
export function mergeRowsByWhale(
  rows: ResonanceOpenRow[],
  whaleMap?: Map<string, WhaleProfile>,
): ResonanceOpenRow[] {
  const groups = new Map<string, ResonanceOpenRow[]>();
  for (const row of rows) {
    const key = `${row.whaleId}|${row.coin}|${row.side}`;
    const list = groups.get(key) || [];
    list.push(row);
    groups.set(key, list);
  }

  return [...groups.values()]
    .map((group) => {
      const sorted = [...group].sort((a, b) => b.time - a.time);
      const latest = sorted[0];
      const openCount = group.length;
      const signalNotional = group.reduce((sum, item) => sum + item.notionalUsd, 0);
      const signalPrice =
        signalNotional > 0
          ? group.reduce((sum, item) => sum + item.price * item.notionalUsd, 0) / signalNotional
          : latest.price;

      const whale = whaleMap?.get(latest.whaleId);
      const pos = whale ? matchWhalePosition(whale, latest.coin, latest.side) : null;
      const livePrice = Number(pos?.entryPx) || 0;
      const liveNotional = Math.abs(Number(pos?.positionValue) || 0);
      const price = livePrice > 0 ? livePrice : signalPrice;
      const notionalUsd = liveNotional > 0 ? liveNotional : signalNotional;
      const metrics = whale
        ? resolveOpenMetrics(whale, latest.coin, latest.side, price)
        : { leverage: latest.leverage, liquidationPx: latest.liquidationPx };

      return {
        ...latest,
        price,
        notionalUsd,
        time: latest.time,
        winRate: Number(whale?.winRate) || latest.winRate,
        openCount,
        ...metrics,
      };
    })
    .sort((a, b) => b.notionalUsd - a.notionalUsd);
}

function collectOpenRows(input: {
  activity: WhaleTrade[];
  alerts?: WhaleAlert[];
  whales: WhaleProfile[];
  since: number;
  config: ResonanceConfig;
  watchedCoins?: string[];
}) {
  const whaleMap = new Map(input.whales.map((item) => [item.id, item]));
  const rawRows: ResonanceOpenRow[] = [];

  for (const trade of input.activity) {
    if (!trade.whaleId || !isTradeOpen(trade)) continue;
    if (trade.time < input.since) continue;
    const whale = whaleMap.get(trade.whaleId);
    if (!whale) continue;
    const notionalUsd = Number(trade.amountUsd) || 0;
    if (notionalUsd < input.config.minNotionalUsd) continue;

    rawRows.push(
      buildOpenRow(whale, {
        whaleId: trade.whaleId,
        whaleName: trade.whaleName || whale.name,
        address: whale.address,
        coin: coinLabel(trade),
        side: tradeFillSide(trade),
        price: tradePrice(trade),
        notionalUsd,
        time: trade.time,
        winRate: Number(whale.winRate) || 0,
      }),
    );
  }

  rawRows.push(...rowsFromAlerts(input.alerts || [], whaleMap, input.since, input.config));
  const watched = input.watchedCoins?.length ? input.watchedCoins : readWatchedCoins();
  return dedupeRows(rawRows.filter((row) => coinMatchesWatch(row.coin, watched)));
}

function scanClusterSignals(rows: ResonanceOpenRow[], config: ResonanceConfig): ResonanceSignal[] {
  const groups = new Map<string, ResonanceOpenRow[]>();
  for (const row of rows) {
    const key = `${row.coin}|${row.side}`;
    const list = groups.get(key) || [];
    list.push(row);
    groups.set(key, list);
  }

  const signals: ResonanceSignal[] = [];
  for (const [groupKey, groupRows] of groups) {
    const whaleIds = new Set(groupRows.map((item) => item.whaleId));
    if (whaleIds.size < config.minWhales) continue;
    const coin = groupRows[0].coin;
    const side = groupRows[0].side;
    const totalUsd = groupRows.reduce((sum, item) => sum + item.notionalUsd, 0);
    const signal: ResonanceSignal = {
      id: `cluster|${groupKey}`,
      kind: 'cluster',
      coin,
      side,
      whaleCount: whaleIds.size,
      tradeCount: groupRows.length,
      totalUsd,
      rows: [...groupRows].sort((a, b) => b.time - a.time),
      bannerText: '',
      biasLabel: side === 'long' ? '短线偏多' : '短线偏空',
    };
    signal.bannerText = buildClusterBannerText(signal, config.windowHours);
    signals.push(signal);
  }

  return signals;
}

function scanAccumulationSignals(rows: ResonanceOpenRow[], config: ResonanceConfig, now: number): ResonanceSignal[] {
  const since = now - config.accumulationWindowHours * 3_600_000;
  const recent = rows.filter((row) => row.time >= since);
  const groups = new Map<string, ResonanceOpenRow[]>();

  for (const row of recent) {
    const key = `${row.whaleId}|${row.coin}|${row.side}`;
    const list = groups.get(key) || [];
    list.push(row);
    groups.set(key, list);
  }

  const signals: ResonanceSignal[] = [];
  for (const [groupKey, groupRows] of groups) {
    if (groupRows.length < config.accumulationMinOpens) continue;
    const totalUsd = groupRows.reduce((sum, item) => sum + item.notionalUsd, 0);
    if (totalUsd < config.accumulationMinTotalUsd) continue;

    const sortedRows = [...groupRows].sort((a, b) => b.time - a.time);
    const first = sortedRows[0];
    const signal: ResonanceSignal = {
      id: `accumulation|${groupKey}`,
      kind: 'accumulation',
      coin: first.coin,
      side: first.side,
      whaleCount: 1,
      tradeCount: groupRows.length,
      totalUsd,
      rows: sortedRows,
      bannerText: '',
      biasLabel: first.side === 'long' ? '主力吸筹' : '主力派发',
      whaleId: first.whaleId,
      whaleName: first.whaleName,
    };
    signal.bannerText = buildAccumulationBannerText(signal, config.accumulationWindowHours);
    signals.push(signal);
  }

  return signals;
}

function sortSignals(a: ResonanceSignal, b: ResonanceSignal) {
  if (a.kind !== b.kind) {
    return a.kind === 'accumulation' ? -1 : 1;
  }
  if (b.totalUsd !== a.totalUsd) return b.totalUsd - a.totalUsd;
  if (b.whaleCount !== a.whaleCount) return b.whaleCount - a.whaleCount;
  return b.tradeCount - a.tradeCount;
}

export function scanResonanceSignals(input: {
  activity: WhaleTrade[];
  alerts?: WhaleAlert[];
  whales: WhaleProfile[];
  config?: ResonanceConfig;
  now?: number;
  watchedCoins?: string[];
}): ResonanceScanResult {
  const config = input.config || readResonanceConfig();
  const now = input.now ?? Date.now();
  const watched = input.watchedCoins?.length ? input.watchedCoins : readWatchedCoins();
  const since = now - config.windowHours * 3_600_000;
  const mergeMs = config.mergeMinutes * 60_000;
  const lookbackHours = Math.max(config.windowHours, config.accumulationWindowHours);
  const collectionSince = now - lookbackHours * 3_600_000;

  const dedupedRows = collectOpenRows({
    activity: input.activity,
    alerts: input.alerts || [],
    whales: input.whales,
    since: collectionSince,
    config,
    watchedCoins: watched,
  });

  const clusterRows = mergeOpens(
    dedupedRows.filter((row) => row.time >= since),
    mergeMs,
  );
  const accumulationRows = dedupedRows;

  const signals = [
    ...scanAccumulationSignals(accumulationRows, config, now),
    ...scanClusterSignals(clusterRows, config),
  ].sort(sortSignals);

  const whaleMap = new Map(input.whales.map((item) => [item.id, item]));
  for (const signal of signals) {
    signal.rows = mergeRowsByWhale(signal.rows, whaleMap);
  }

  return {
    hit: signals.length > 0,
    primary: signals[0] || null,
    signals,
    emptyText: watched.length
      ? `暂无 ${watched.join(' / ')} 共振或持续加仓信号`
      : '暂无巨鲸共振或持续加仓信号',
  };
}
