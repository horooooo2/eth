<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, toRaw, watch } from 'vue';
import { useRouter } from 'vue-router';
import { ArrowLeft, Download, Upload, VideoPlay, VideoPause, VideoCamera, CaretRight, InfoFilled } from '@element-plus/icons-vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { deleteReplayDataset, getReplayDataset, listReplayDatasets, saveReplayDataset, type ReplayDataset, type ReplayDatasetSummary } from '../tradfi-replay/localHistory';
import core from '@core/tradfiRangeCore.cjs';

type Candle = { t: number; o: number; h: number; l: number; c: number; v: number };
type LogRow = { id: string; time: number; type: string; text: string; [key: string]: any };
type PeakFill = { time: number; price: number; qty: number; margin: number; purpose: 'open' | 'add'; tierStart: number; tierEnd: number; label: string };
type PeakContext = { time: number; price: number; entryPrice: number; margin: number; additions: number; phase: string; deepBudget: number; deepStage: number; fills?: PeakFill[] };
type Snapshot = { index: number; total: number; progress: number; time: number; price: number; state: string; symbol: string; positions: Record<string, any>; orders: Record<string, any>; realized: number; realizedBySide: Record<'long' | 'short', number>; realizedFunding: number; maxLossPeak: Record<'long' | 'short' | 'total', number>; lossPeakContext?: Record<'long' | 'short', PeakContext | null>; totalLossPeakTime?: number; marginPeak: number; special: { placed: number; filled: number; canceled: number; realized: number; margin: Record<'long' | 'short', number> }; losingMinutes: Record<'long' | 'short', number>; maxLosingStreak: Record<'long' | 'short', number>; fees: number; funding: number; unrealized: number; net: number; tradeCount: number; positionDistribution: { large: number; small: number }; recentLogs: LogRow[]; logsTotal: number; candles: Candle[]; paused: boolean; market: any };

const router = useRouter();
const worker = new Worker(new URL('../tradfi-replay/replay.worker.ts', import.meta.url), { type: 'module' });
const symbol = ref('XAUUSDT');
const margin = ref(10); const leverage = ref(10); const makerFeePct = ref(0); const tickSize = ref(0.01); const qtyStep = ref(0.001);
const walletBalance = ref(40000);
const detectorVisible = ref(false); const detectorName = ref(''); const detectorCandles = ref<Candle[]>([]); const detectorError = ref('');
type DetectorSignal = { time: number; watchAt: number; side: 'long' | 'short'; extreme: number; confirmPrice: number; atr: number; gapAtr: number; entryPrice: number; distant: boolean; outcome: '命中' | '失效' | '未决'; outcomeTime: number; outcomePrice: number };
const detectorSignals = ref<DetectorSignal[]>([]);
const detectorHours = ref(0);
const detectorSide = ref<'all' | 'long' | 'short'>('all');
const detectorOutcome = ref<'all' | '命中' | '失效' | '未决'>('all');
const detectorMonth = ref('all');
const detectorRows = computed(() => detectorSignals.value.filter((x) => (detectorSide.value === 'all' || x.side === detectorSide.value)
  && (detectorOutcome.value === 'all' || x.outcome === detectorOutcome.value)
  && (detectorMonth.value === 'all' || new Date(x.time).toISOString().slice(0, 7) === detectorMonth.value)));
const detectorMonths = computed(() => {
  const groups = new Map<string, { month: string; long: number; short: number; hit: number; fail: number; undecided: number }>();
  for (const row of detectorSignals.value) {
    const month = new Date(row.time).toISOString().slice(0, 7);
    const group = groups.get(month) || { month, long: 0, short: 0, hit: 0, fail: 0, undecided: 0 };
    group[row.side] += 1; group[row.outcome === '命中' ? 'hit' : row.outcome === '失效' ? 'fail' : 'undecided'] += 1;
    groups.set(month, group);
  }
  return [...groups.values()];
});
const detectorMonthScale = computed(() => Math.max(1, ...detectorMonths.value.map((x) => x.hit + x.fail + x.undecided)));
const detectorStats = computed(() => ({ total: detectorSignals.value.length,
  hit: detectorSignals.value.filter((x) => x.outcome === '命中').length,
  fail: detectorSignals.value.filter((x) => x.outcome === '失效').length,
  undecided: detectorSignals.value.filter((x) => x.outcome === '未决').length,
  far: detectorSignals.value.filter((x) => x.distant).length }));
const detectorDirection = computed(() => (['short', 'long'] as const).map((side) => {
  const rows = detectorSignals.value.filter((x) => x.side === side);
  const decided = rows.filter((x) => x.outcome !== '未决');
  return { side, total: rows.length, hit: rows.filter((x) => x.outcome === '命中').length, fail: rows.filter((x) => x.outcome === '失效').length,
    rate: decided.length ? rows.filter((x) => x.outcome === '命中').length / decided.length * 100 : 0 };
}));
const candleName = ref(''); const fundingName = ref(''); const candles = ref<Candle[]>([]); const funding = ref<{ t: number; rate: number }[]>([]);
const candleError = ref(''); const fundingError = ref(''); const status = ref('请导入分钟K线数据'); const snapshot = ref<Snapshot | null>(null);
const speed = ref(20); const ready = ref(false); const isPlaying = ref(false); const allLogs = ref<LogRow[]>([]);
watch(speed, (value) => { if (isPlaying.value) worker.postMessage({ type: 'speed', speed: value }); });
const templatesVisible = ref(false);
const peakFillVisible = ref(false); const peakFillContext = ref<PeakContext | null>(null);
function openPeakFills() { peakFillContext.value = null; peakFillVisible.value = true; worker.postMessage({ type: 'peak-fills', side: 'long' }); }
const savedDatasets = ref<ReplayDatasetSummary[]>([]); const historyBusy = ref(false); const loadingHistoryId = ref('');
let candleFile: Blob | null = null; let fundingFile: Blob | null = null; let loadedHistoryId = '';
let saveCandidate: ReplayDataset | null = null; let warmupFailed = false;
const warmupVisible = ref(false); const warmupProgress = ref(0); const warmupStage = ref('准备回放数据…');
let warmupCloseTimer: number | undefined;
let chunkAckTimer: number | undefined;
const transferState = { rows: [] as Candle[], offset: 0, chunkSize: 4_000, settings: null as any, funding: [] as { t: number; rate: number }[] };
const symbolDefaults = computed(() => symbol.value === 'XAUUSDT' ? { margin: 10, leverage: 10, tick: 0.01 } : symbol.value === 'XAGUSDT' ? { margin: 10, leverage: 10, tick: 0.001 } : { margin: 20, leverage: 20, tick: 0.01 });
const maxMargin = computed(() => symbol.value === 'XAUUSDT' ? 100 : 20);
const progress = computed(() => Math.min(100, Math.round((snapshot.value?.progress || 0) * 100)));
const filteredLogs = computed(() => allLogs.value.filter((row) => Number(row.pnl) >= 10));
const chartPath = computed(() => {
  const rows = snapshot.value?.candles || []; if (!rows.length) return '';
  const min = Math.min(...rows.map((x) => x.l)); const max = Math.max(...rows.map((x) => x.h)); const span = max - min || 1;
  return rows.map((row, i) => `${i ? 'L' : 'M'} ${(i / Math.max(1, rows.length - 1)) * 1000} ${250 - ((row.c - min) / span) * 230}`).join(' ');
});
const chartMinMax = computed(() => { const rows = snapshot.value?.candles || []; return rows.length ? { min: Math.min(...rows.map((x) => x.l)), max: Math.max(...rows.map((x) => x.h)) } : null; });

function readCsv(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = []; let cell = ''; let quoted = false;
  const normalized = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < normalized.length; i += 1) {
    const ch = normalized[i];
    if (ch === '"') { if (quoted && normalized[i + 1] === '"') { cell += '"'; i += 1; } else quoted = !quoted; }
    else if (!quoted && (ch === ',' || ch === '\t')) { row.push(cell.trim()); cell = ''; }
    else if (!quoted && (ch === '\n' || ch === '\r')) { if (ch === '\r' && normalized[i + 1] === '\n') i += 1; row.push(cell.trim()); if (row.some(Boolean)) rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  row.push(cell.trim()); if (row.some(Boolean)) rows.push(row); return rows;
}
function parseTime(value: string): number {
  const n = Number(value);
  if (value && Number.isFinite(n)) return n < 100_000_000_000 ? n * 1000 : n;
  const parsed = Date.parse(value); if (!Number.isFinite(parsed)) throw new Error(`无法识别时间：${value}`); return parsed;
}
function indexMap(headers: string[], aliases: string[], fallback: number): number { const found = headers.findIndex((h) => aliases.includes(h.trim().toLowerCase())); return found >= 0 ? found : fallback; }
function parseCandles(text: string, intervalMs = 60_000, minimum = 1200): Candle[] {
  const rows = readCsv(text); if (!rows.length) throw new Error('文件没有有效数据');
  const heads = rows[0].map((x) => x.trim().toLowerCase()); const hasHead = ['timestamp', 'time', 'datetime', 'open_time', 'open time', 'open_time_utc', 'open_time_ms'].some((h) => heads.includes(h));
  const data = hasHead ? rows.slice(1) : rows;
  const idx = hasHead ? { t: indexMap(heads, ['timestamp', 'time', 'datetime', 'open_time', 'open time', 'open_time_utc', 'open_time_ms'], 0), o: indexMap(heads, ['open', 'o'], 1), h: indexMap(heads, ['high', 'h'], 2), l: indexMap(heads, ['low', 'l'], 3), c: indexMap(heads, ['close', 'c'], 4), v: indexMap(heads, ['volume', 'vol', 'v'], 5) } : { t: 0, o: 1, h: 2, l: 3, c: 4, v: 5 };
  const out = data.map((r, i) => {
    const c = { t: parseTime(r[idx.t]), o: Number(r[idx.o]), h: Number(r[idx.h]), l: Number(r[idx.l]), c: Number(r[idx.c]), v: Number(r[idx.v] || 0) };
    if (![c.t, c.o, c.h, c.l, c.c, c.v].every(Number.isFinite) || c.o <= 0 || c.h <= 0 || c.l <= 0 || c.c <= 0 || c.v < 0 || c.h < Math.max(c.o, c.c, c.l) || c.l > Math.min(c.o, c.c, c.h)) throw new Error(`第 ${i + (hasHead ? 2 : 1)} 行K线数据无效`);
    return c;
  }).sort((a, b) => a.t - b.t);
  if (out.length < minimum) throw new Error(`${intervalMs === 60_000 ? '分钟' : '小时'}K线至少需要 ${minimum.toLocaleString()} 根`);
  if (out.some((x, i) => i > 0 && x.t === out[i - 1].t)) throw new Error('K线存在重复时间戳，请先清理后重新导入。');
  if (out.some((x, i) => i > 0 && x.t - out[i - 1].t !== intervalMs)) throw new Error(`发现缺失${intervalMs === 60_000 ? '分钟' : '小时'}。请导入连续K线，避免检测结果失真。`);
  return out;
}
function hourlyFromMinutes(rows: Candle[]): Candle[] {
  const result: Candle[] = []; let active: Candle | null = null; let count = 0;
  for (const row of rows) {
    const bucket = Math.floor(row.t / 3_600_000) * 3_600_000;
    if (!active || active.t !== bucket) {
      if (active && count === 60) result.push(active);
      active = { ...row, t: bucket }; count = 1;
    } else { active.h = Math.max(active.h, row.h); active.l = Math.min(active.l, row.l); active.c = row.c; active.v += row.v; count += 1; }
  }
  if (active && count === 60) result.push(active);
  return result;
}
async function pickDetectorFile(event: Event) {
  const input = event.target as HTMLInputElement; const file = input.files?.[0]; if (!file) return;
  try { detectorCandles.value = parseCandles(await file.text(), 3_600_000, 37); detectorName.value = file.name; detectorError.value = ''; detectorSignals.value = []; }
  catch (error) { detectorCandles.value = []; detectorName.value = ''; detectorError.value = error instanceof Error ? error.message : '小时线解析失败'; }
  finally { input.value = ''; }
}
function runDetector() {
  const rows = detectorCandles.value.length ? detectorCandles.value : hourlyFromMinutes(candles.value);
  if (rows.length < 37) { detectorError.value = '请导入至少 37 根连续小时K线，或先载入分钟K线'; return; }
  detectorError.value = ''; detectorHours.value = rows.length;
  let state: any = { phase: 'idle', lastHour: 0 }; const signals: DetectorSignal[] = [];
  for (let index = 24; index < rows.length; index += 1) {
    const now = rows[index]; const before = state;
    state = core.turningPointStep(state, rows.slice(Math.max(0, index - 59), index + 1).map((row) => [row.t, row.o, row.h, row.l, row.c, row.v, row.t + 3_599_999]));
    if (state.phase !== 'confirmed' || before.phase === 'confirmed' || state.confirmedAt !== now.t + 3_599_999) continue;
    const plan = core.turningPointEntryPlan(state, now.c, now.c, now.c);
    const signal: DetectorSignal = { time: state.confirmedAt, watchAt: state.startedAt, side: state.side, extreme: state.extreme,
      confirmPrice: now.c, atr: state.atr, gapAtr: plan.gapAtr || 0, entryPrice: plan.price, distant: plan.distant,
      outcome: '未决', outcomeTime: 0, outcomePrice: 0 };
    // Outcome uses only later candles; it never feeds the signal calculation.
    for (const future of rows.slice(index + 1, index + 13)) {
      const favorable = signal.side === 'short' ? future.l <= now.c - signal.atr : future.h >= now.c + signal.atr;
      const adverse = signal.side === 'short' ? future.h >= now.c + signal.atr : future.l <= now.c - signal.atr;
      if (!favorable && !adverse) continue;
      signal.outcome = favorable && adverse ? '未决' : favorable ? '命中' : '失效';
      signal.outcomeTime = future.t + 3_599_999; signal.outcomePrice = favorable ? (signal.side === 'short' ? future.l : future.h) : (signal.side === 'short' ? future.h : future.l);
      break;
    }
    signals.push(signal);
  }
  detectorSignals.value = signals;
}
function guessSymbol(fileName: string, text: string): string {
  const ignored = new Set(['TRADFI', 'KLINE', 'KLINES', 'CANDLE', 'CANDLES', 'MINUTE', 'MINUTES', 'DATA', 'MARKET', 'PRICE', 'CSV', 'ONE', 'MY', 'RAW', 'HISTORICAL', 'EXPORT', 'REPLAY', 'BINANCE', 'OKX', 'BYBIT', '1M', '1MIN', '1MINUTE']);
  const tokens = fileName.toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean);
  const filenameSymbol = tokens.find((token) => /^[A-Z][A-Z0-9]{1,19}$/.test(token) && !ignored.has(token) && !/^\d{6,8}$/.test(token));
  if (filenameSymbol) return filenameSymbol;
  const firstTwoLines = text.replace(/^\uFEFF/, '').split(/\r?\n/, 2);
  const csvStart = readCsv(firstTwoLines.join('\n'));
  const firstLine = csvStart[0]?.map((value) => value.trim().toLowerCase()) || [];
  const symbolColumn = firstLine.findIndex((value) => ['symbol', 'ticker', 'instrument', 'contract'].includes(value));
  if (symbolColumn >= 0) {
    const row = csvStart[1]; const value = row?.[symbolColumn]?.trim().toUpperCase();
    if (value && /^[A-Z][A-Z0-9._:-]{0,29}$/.test(value)) return value;
  }
  return '';
}
function parseFunding(text: string): { t: number; rate: number }[] {
  const rows = readCsv(text); if (!rows.length) return [];
  const heads = rows[0].map((x) => x.trim().toLowerCase()); const timeAliases = ['timestamp', 'time', 'datetime', 'fundingtime', 'funding_time', 'funding_timestamp', 'fundingtimestamp', 'calctime', 'calc_time'];
  const hasHead = timeAliases.some((h) => heads.includes(h)) || ['fundingrate', 'funding_rate', 'rate'].some((h) => heads.includes(h));
  const data = hasHead ? rows.slice(1) : rows;
  const ti = hasHead ? indexMap(heads, timeAliases, 0) : 0;
  const ri = hasHead ? indexMap(heads, ['fundingrate', 'funding_rate', 'rate'], 1) : 1;
  const parsed = data.map((r, i) => { const t = parseTime(r[ti]); const rate = Number(r[ri]); if (!Number.isFinite(t) || !Number.isFinite(rate)) throw new Error(`第 ${i + (hasHead ? 2 : 1)} 行资金费率无效`); return { t, rate }; }).sort((a, b) => a.t - b.t);
  if (parsed.some((x, i) => i > 0 && x.t === parsed[i - 1].t)) throw new Error('资金费文件存在重复时间戳，请先清理后重新导入。');
  return parsed;
}
async function pickFile(kind: 'candles' | 'funding', event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0]; if (!file) return;
  if (warmupVisible.value) { (event.target as HTMLInputElement).value = ''; return; }
  try {
    const text = await file.text();
    if (kind === 'candles') {
      candleError.value = '';
      try {
        const parsed = parseCandles(text); const detected = guessSymbol(file.name, text);
        worker.postMessage({ type: 'stop' }); isPlaying.value = false;
        candles.value = parsed; candleName.value = file.name; candleFile = file; loadedHistoryId = '';
        if (detected) {
          if (symbol.value !== detected) { funding.value = []; fundingName.value = ''; fundingFile = null; }
          symbol.value = detected; resetDefaults();
        }
        snapshot.value = null; ready.value = false; allLogs.value = [];
        status.value = `已载入 ${parsed.length.toLocaleString()} 根连续分钟K线${detected ? ` · 标的 ${detected}` : ''}`;
      } catch (err) { candles.value = []; candleName.value = ''; candleFile = null; candleError.value = err instanceof Error ? err.message : 'K线文件解析失败'; }
    } else {
      fundingError.value = '';
      try {
        const parsed = parseFunding(text); funding.value = parsed; fundingName.value = file.name; fundingFile = file; loadedHistoryId = '';
        status.value = `已载入资金费：${parsed.length.toLocaleString()} 条`;
      } catch (err) { funding.value = []; fundingName.value = ''; fundingFile = null; fundingError.value = err instanceof Error ? err.message : '资金费文件解析失败'; }
    }
  } catch (err) { ElMessage.error(err instanceof Error ? err.message : '无法读取文件'); }
  finally { (event.target as HTMLInputElement).value = ''; }
}
async function refreshHistory() {
  try { savedDatasets.value = await listReplayDatasets(); }
  catch { ElMessage.warning('无法读取本地数据历史；仍可直接上传文件回放'); }
}
async function saveReadyDataset() {
  const candidate = saveCandidate; saveCandidate = null;
  if (!candidate) return;
  try {
    await saveReplayDataset(candidate);
    loadedHistoryId = candidate.id;
    await refreshHistory();
  } catch { ElMessage.warning('回放已就绪，但浏览器未能保存本地历史；请保留原始 CSV'); }
}
async function loadSavedDataset(item: ReplayDatasetSummary) {
  if (historyBusy.value) return;
  historyBusy.value = true; loadingHistoryId.value = item.id;
  try {
    const record = await getReplayDataset(item.id);
    if (!record) throw new Error('本地数据已不存在，请刷新历史列表');
    const [candleText, fundingText] = await Promise.all([record.candleFile.text(), record.fundingFile?.text() || Promise.resolve('')]);
    // Parse both files before changing the current selection, so a damaged
    // funding CSV cannot leave candles and funding from different sessions.
    const parsedCandles = parseCandles(candleText);
    const parsedFunding = record.fundingFile ? parseFunding(fundingText) : [];
    worker.postMessage({ type: 'stop' }); isPlaying.value = false;
    candles.value = parsedCandles; funding.value = parsedFunding;
    candleName.value = record.candleName; fundingName.value = record.fundingName;
    candleFile = record.candleFile; fundingFile = record.fundingFile; loadedHistoryId = record.id;
    symbol.value = record.symbol; resetDefaults();
    if (record.settings) { margin.value = record.settings.margin; leverage.value = record.settings.leverage; walletBalance.value = record.settings.walletBalance || 40000;
      makerFeePct.value = record.settings.makerFeePct; tickSize.value = record.settings.tickSize; qtyStep.value = record.settings.qtyStep; }
    snapshot.value = null; ready.value = false; allLogs.value = []; candleError.value = ''; fundingError.value = '';
    status.value = `已载入历史回放：${record.symbol} · ${parsedCandles.length.toLocaleString()} 根K线 · ${parsedFunding.length.toLocaleString()} 条资金费`;
    await startReplay();
  } catch (err) { ElMessage.error(err instanceof Error ? err.message : '载入本地文件失败'); }
  finally { historyBusy.value = false; loadingHistoryId.value = ''; }
}
async function removeSavedDataset(item: ReplayDatasetSummary) {
  if (historyBusy.value) return;
  try { await ElMessageBox.confirm(`从当前浏览器删除「${item.symbol} · ${item.candleName}」及配套资金费？请确认你仍保留原始 CSV。`, '删除本地历史', { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' }); }
  catch { return; }
  historyBusy.value = true;
  try { await deleteReplayDataset(item.id); await refreshHistory(); if (loadedHistoryId === item.id) loadedHistoryId = ''; ElMessage.success('已从本地历史删除；当前已载入的数据仍可继续回放'); }
  catch (err) { ElMessage.error(err instanceof Error ? err.message : '删除本地文件失败'); }
  finally { historyBusy.value = false; }
}
function fileSize(bytes: number) { return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`; }
onMounted(() => { void refreshHistory(); });
function resetDefaults() { margin.value = symbolDefaults.value.margin; leverage.value = symbolDefaults.value.leverage; tickSize.value = symbolDefaults.value.tick; }
async function startReplay() {
  symbol.value = symbol.value.trim().toUpperCase();
  if (!symbol.value) { status.value = '请填写回放标的'; return; }
  if (candles.value.length < 1200) { status.value = '请先导入至少 1,200 根连续分钟K线'; return; }
  if (!(margin.value > 0 && margin.value <= maxMargin.value) || !(leverage.value >= 1 && leverage.value <= 50) || !(tickSize.value > 0) || !(qtyStep.value > 0) || !(makerFeePct.value >= 0) || !(walletBalance.value > 0)) { ElMessage.warning(`参数无效：保证金 0–${maxMargin.value}U、杠杆 1–50×，Tick/数量步进和模拟账户权益需大于 0`); return; }
  saveCandidate = candleFile && !loadedHistoryId ? { id: crypto.randomUUID(), symbol: symbol.value, candleName: candleName.value,
    fundingName: fundingFile ? fundingName.value : '', candleRows: candles.value.length, fundingRows: fundingFile ? funding.value.length : 0,
    start: candles.value[0].t, end: candles.value.at(-1)!.t, size: candleFile.size + (fundingFile?.size || 0), savedAt: Date.now(),
    settings: { margin: margin.value, leverage: leverage.value, makerFeePct: makerFeePct.value, tickSize: tickSize.value, qtyStep: qtyStep.value, walletBalance: walletBalance.value },
    candleFile, fundingFile } : null;
  allLogs.value = []; ready.value = false; isPlaying.value = false; warmupFailed = false;
  if (warmupCloseTimer) window.clearTimeout(warmupCloseTimer);
  warmupVisible.value = true; warmupProgress.value = 1; warmupStage.value = '准备回放参数…'; status.value = '正在准备策略回放…';
  try {
    const rows = toRaw(candles.value);
    transferState.rows = rows; transferState.offset = 0; transferState.settings = { symbol: symbol.value.trim().toUpperCase(), marginUsdt: margin.value, leverage: leverage.value, makerFee: makerFeePct.value / 100, tickSize: tickSize.value, qtyStep: qtyStep.value, walletBalance: walletBalance.value, orderTtlMs: 90_000 }; transferState.funding = toRaw(funding.value);
    warmupProgress.value = 4; warmupStage.value = `检查完成 · ${rows.length.toLocaleString()} 根 K 线、${transferState.funding.length.toLocaleString()} 条资金费`;
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    worker.postMessage({ type: 'init-start', candleCount: rows.length, funding: transferState.funding, settings: transferState.settings });
    sendNextChunk();
  } catch (err) {
    saveCandidate = null; warmupFailed = true;
    warmupVisible.value = false; ready.value = false;
    status.value = err instanceof Error ? `回放初始化失败：${err.message}` : '回放初始化失败';
  }
}
function sendNextChunk() {
  const { rows, offset, chunkSize } = transferState;
  if (offset >= rows.length) { worker.postMessage({ type: 'init-complete' }); warmupProgress.value = 80; warmupStage.value = '全部数据已送达 · 预热策略指标…'; return; }
  const end = Math.min(rows.length, offset + chunkSize); const buffer = new ArrayBuffer((end - offset) * 6 * Float64Array.BYTES_PER_ELEMENT); const flat = new Float64Array(buffer);
  for (let row = offset; row < end; row += 1) { const item = rows[row]; const at = (row - offset) * 6; flat[at] = item.t; flat[at + 1] = item.o; flat[at + 2] = item.h; flat[at + 3] = item.l; flat[at + 4] = item.c; flat[at + 5] = item.v; }
  transferState.offset = end;
  const ratio = end / rows.length; warmupProgress.value = 8 + Math.floor(ratio * 68);
  warmupStage.value = `传送 K 线数据 · ${end.toLocaleString()} / ${rows.length.toLocaleString()} 根（${Math.floor(ratio * 100)}%）`;
  worker.postMessage({ type: 'init-chunk', buffer, start: offset, count: end - offset }, [buffer]);
  if (chunkAckTimer) window.clearTimeout(chunkAckTimer);
  chunkAckTimer = window.setTimeout(() => {
    saveCandidate = null; warmupFailed = true;
    warmupVisible.value = false; ready.value = false;
    status.value = `回放数据传输超时：引擎未确认 ${end.toLocaleString()} / ${rows.length.toLocaleString()} 根，请重试`;
  }, 15_000);
}
function send(type: string) { worker.postMessage({ type, speed: speed.value }); if (type === 'play') isPlaying.value = true; if (type === 'pause' || type === 'step') isPlaying.value = false; }
function onWorker(event: MessageEvent) {
  if (event.data.type === 'chunk-ack') { if (chunkAckTimer) window.clearTimeout(chunkAckTimer); chunkAckTimer = undefined; sendNextChunk(); }
  if (event.data.type === 'warmup-progress') {
    warmupProgress.value = Math.max(warmupProgress.value, Number(event.data.progress) || 0);
    warmupStage.value = event.data.stage || '正在预热策略指标…';
  }
  if (event.data.type === 'ready') {
    if (warmupFailed) return;
    snapshot.value = event.data.payload; ready.value = true; status.value = '回放已就绪';
    warmupProgress.value = 100; warmupStage.value = '准备完成';
    warmupCloseTimer = window.setTimeout(() => { warmupVisible.value = false; }, 450);
    void saveReadyDataset();
  }
  if (event.data.type === 'tick') {
    snapshot.value = event.data.payload; isPlaying.value = !event.data.payload.paused && event.data.payload.index < event.data.payload.total;
    allLogs.value.push(...(event.data.newLogs || []));
    if (event.data.payload.index >= event.data.payload.total) { isPlaying.value = false; status.value = '回放完成'; }
  }
  if (event.data.type === 'export') allLogs.value = event.data.payload;
  if (event.data.type === 'peak-fills' && event.data.side === 'long') peakFillContext.value = event.data.payload;
}
worker.addEventListener('message', onWorker);
worker.addEventListener('error', (event) => {
  saveCandidate = null; warmupFailed = true;
  if (chunkAckTimer) window.clearTimeout(chunkAckTimer); chunkAckTimer = undefined;
  warmupVisible.value = false; ready.value = false; isPlaying.value = false;
  status.value = `回放引擎启动失败：${event.message || event.filename || 'Worker 模块加载异常（请刷新页面重试）'}`;
});
worker.addEventListener('message', (event) => {
  if (event.data.type !== 'replay-error') return;
  saveCandidate = null; warmupFailed = true;
  if (chunkAckTimer) window.clearTimeout(chunkAckTimer); chunkAckTimer = undefined;
  warmupVisible.value = false; ready.value = false; isPlaying.value = false;
  status.value = `回放准备失败：${event.data.message || '数据传输异常'}`;
});
function downloadLogs() {
  const esc = (s: unknown) => `"${String(s ?? '').replaceAll('"', '""')}"`;
  const lines = [['开仓时间', '平仓时间', '方向', '标的', '开仓均价', '平仓价格', '平仓净盈亏', '资金费', '手续费'].map(esc).join(',')];
  for (const row of allLogs.value) lines.push([new Date(row.openedAt).toISOString(), new Date(row.closedAt).toISOString(), row.side === 'long' ? '多' : '空', row.symbol, row.openPrice, row.closePrice, row.pnl, row.funding, row.fee].map(esc).join(','));
  const blob = new Blob(['\uFEFF' + lines.join('\n')], { type: 'text/csv;charset=utf-8' }); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = `tradfi-replay-${symbol.value}-${Date.now()}.csv`; a.click(); URL.revokeObjectURL(url);
}
function clock(value: number) { return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—'; }
function rangePhaseName(phase: string) { return ({ overheat: '上涨过热', bottom_watch: '回落观察', bottom_confirmed: '底部确认', normal: '常规' } as Record<string, string>)[phase] || phase; }
function number(value: number | null | undefined, digits = 2) { return Number(value || 0).toLocaleString('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits }); }
function pnlClass(value: number) { return value >= 0 ? 'positive' : 'negative'; }
onBeforeUnmount(() => { if (warmupCloseTimer) window.clearTimeout(warmupCloseTimer); if (chunkAckTimer) window.clearTimeout(chunkAckTimer); worker.postMessage({ type: 'stop' }); worker.removeEventListener('message', onWorker); worker.terminate(); });
</script>

<template>
  <main class="replay-page">
    <div v-if="warmupVisible" class="warmup-backdrop" role="presentation">
      <section class="warmup-dialog" role="dialog" aria-modal="true" aria-labelledby="warmup-title">
        <div class="warmup-icon"><i></i></div>
        <h2 id="warmup-title">正在准备策略回放</h2>
        <p>{{ warmupStage }}</p>
        <div class="warmup-progress-meta"><span>回放准备进度</span><b>{{ warmupProgress }}%</b></div>
        <div class="warmup-progress-track"><i :style="{ width: `${warmupProgress}%` }"></i></div>
        <small>整理导入数据并初始化指标；不会连接交易所或提交订单。</small>
      </section>
    </div>
    <div v-if="templatesVisible" class="template-backdrop" role="presentation" @click.self="templatesVisible = false">
      <section class="template-dialog" role="dialog" aria-modal="true" aria-labelledby="template-title">
        <header><h2 id="template-title">K 线与资金费 CSV 格式</h2><button class="template-close" aria-label="关闭" @click="templatesVisible = false">×</button></header>
        <div class="template-content">
          <p>文件使用 UTF-8 编码，第一行可以是列名。时间支持带时区的 ISO 时间或 Unix 毫秒时间戳。</p>
          <article class="template-block">
            <h3>1 分钟 K 线 · 标准 CSV 列顺序</h3>
            <pre>open_time_utc,open_time_bjt,open_time_ms,open,high,low,close,volume,close_time_ms,quote_volume,trade_count,taker_buy_volume,taker_buy_quote_volume
2026-03-01T00:00:00Z,2026-03-01T08:00:00+08:00,1772323200000,30.10,30.20,30.00,30.15,1200,1772323259999,36180.00,86,640.00,19296.00
2026-03-01T00:01:00Z,2026-03-01T08:01:00+08:00,1772323260000,30.15,30.25,30.10,30.20,980,1772323319999,29596.00,72,510.00,15402.00</pre>
            <small>本项目实际读取时间、open、high、low、close、volume 六个字段，其余 Binance 列可保留。也可使用简化表头：timestamp,open,high,low,close,volume。时间可填 ISO 时间（需带时区）或 Unix 毫秒；按时间升序，每行一根 1 分钟 K 线，时间不可重复或缺失，至少 1,200 行。</small>
          </article>
          <article class="template-block">
            <h3>资金费率 CSV</h3>
            <pre>timestamp,fundingRate
2026-03-01T00:00:00.001+08:00,0.0001
2026-03-01T08:00:00.001+08:00,-0.00005
2026-03-01T16:00:00.001+08:00,0.00008</pre>
            <small>每行一笔结算记录，按时间升序。费率填小数而非百分数：0.0001 表示 0.01%，-0.00005 表示 -0.005%。正费率时多头付、空头收；负费率相反。资金费文件可选。</small>
          </article>
          <article class="template-block">
            <h3>生成文件前请检查</h3>
            <small>CSV 建议使用 UTF-8 编码，保留表头；价格和成交量使用数字，不要加千分位逗号或货币符号。每根 K 线的 high 应不低于 open、close、low；low 应不高于 open、close、high。时间统一用带时区 ISO 格式或毫秒时间戳，避免混用秒和毫秒。</small>
          </article>
        </div>
      </section>
    </div>
    <div v-if="detectorVisible" class="template-backdrop" role="presentation" @click.self="detectorVisible = false">
      <section class="template-dialog detector-dialog" role="dialog" aria-modal="true" aria-labelledby="detector-title">
        <header><div><small class="detector-eyebrow">HOURLY SIGNAL REVIEW</small><h2 id="detector-title">急涨补空 / 急跌补多 · 策略检测</h2></div><button class="template-close" aria-label="关闭" @click="detectorVisible = false">×</button></header>
        <div class="template-content">
          <div class="detector-intro"><div><b>识别 · 确认 · 等待成交</b><p>用已收盘小时线检测急涨或急跌，经过回撤和下一根结构确认。每段趋势只给一次机会，重新进入震荡后才重置。</p></div><div class="detector-source-panel"><label class="file-drop compact"><input type="file" accept=".csv,.txt" @change="pickDetectorFile"><el-icon><Upload /></el-icon><b>{{ detectorName || '导入小时线 CSV' }}</b><small>或使用当前分钟线聚合</small></label><button v-if="detectorCandles.length && candles.length" class="detector-source-button" type="button" @click="detectorCandles = []; detectorName = ''; detectorSignals = []; detectorHours = 0">改用分钟 K 线</button><button class="start-button" type="button" @click="runDetector">运行信号检测</button></div></div>
          <p v-if="detectorError" class="error">{{ detectorError }}</p>
          <div v-if="detectorHours" class="detector-results">
            <section class="detector-panel detector-performance"><div class="detector-panel-head"><b>收益与风险 · 分钟回放</b><small>{{ snapshot ? `${clock(snapshot.time)} · ${progress}%` : '需要先运行分钟回放' }}</small></div><div v-if="snapshot" class="detector-performance-grid"><div><span>策略已实现净盈亏</span><b :class="pnlClass(snapshot.realized)">{{ number(snapshot.realized) }} U</b></div><div><span>特殊补仓成交率</span><b>{{ snapshot.special.placed ? `${(snapshot.special.filled / snapshot.special.placed * 100).toFixed(1)}%` : '—' }}</b><small>{{ snapshot.special.filled }} / {{ snapshot.special.placed }} 笔</small></div><div><span>单侧最大浮亏</span><b class="negative">{{ number(snapshot.maxLossPeak.long) }} / {{ number(snapshot.maxLossPeak.short) }} U</b></div><div><span>保证金峰值</span><b>{{ number(snapshot.marginPeak) }} U</b></div><div><span>最长连续亏损持仓</span><b>{{ Math.round(snapshot.maxLosingStreak.long / 60) }} / {{ Math.round(snapshot.maxLosingStreak.short / 60) }} 小时</b></div></div><p v-else>小时线无法确定 Maker 是否成交，也无法计算完整仓位盈亏。载入同区间分钟线并完成回放后，这里展示实际成交率、净盈亏和风险峰值。</p></section>
            <div class="detector-metrics"><article><span>覆盖样本</span><strong>{{ detectorHours.toLocaleString() }}</strong><small>小时线</small></article><article><span>确认机会</span><strong>{{ detectorStats.total }}</strong><small>趋势内去重</small></article><article><span>远端等待</span><strong>{{ detectorStats.far }}</strong><small>价差 ≥ 2 ATR</small></article><article><span>命中 / 失效</span><strong><em class="positive">{{ detectorStats.hit }}</em> / <em class="negative">{{ detectorStats.fail }}</em></strong><small>未决 {{ detectorStats.undecided }}</small></article><article><span>信号命中率</span><strong>{{ detectorStats.hit + detectorStats.fail ? `${(detectorStats.hit / (detectorStats.hit + detectorStats.fail) * 100).toFixed(1)}%` : '—' }}</strong><small>仅已判定样本</small></article></div>
            <div class="detector-visual-grid"><section class="detector-panel"><div class="detector-panel-head"><b>逐月信号</b><small>绿色命中 · 红色失效 · 灰色未决</small></div><div v-for="month in detectorMonths" :key="month.month" class="detector-month"><span>{{ month.month }}</span><div class="detector-month-track"><i class="hit" :style="{ width: `${month.hit / detectorMonthScale * 100}%` }"></i><i class="fail" :style="{ width: `${month.fail / detectorMonthScale * 100}%` }"></i><i class="undecided" :style="{ width: `${month.undecided / detectorMonthScale * 100}%` }"></i></div><b>{{ month.hit + month.fail + month.undecided }}</b></div><p v-if="!detectorMonths.length">当前样本没有确认机会</p></section><section class="detector-panel"><div class="detector-panel-head"><b>方向拆分</b><small>已判定信号的命中率</small></div><div v-for="direction in detectorDirection" :key="direction.side" class="detector-direction"><div><b :class="direction.side === 'long' ? 'positive' : 'negative'">{{ direction.side === 'long' ? '急跌补多' : '急涨补空' }}</b><strong>{{ direction.rate.toFixed(1) }}%</strong></div><div class="detector-rate-track"><i :style="{ width: `${direction.rate}%` }"></i></div><small>{{ direction.total }} 次确认 · {{ direction.hit }} 命中 · {{ direction.fail }} 失效</small></div><div class="detector-note">小时线仅能评估确认时机。Maker 是否成交、净收益、浮亏峰值和资金占用，以分钟回放为准。</div></section></div>
            <div class="detector-panel detector-table-panel"><div class="detector-panel-head"><div><b>完整信号明细</b><small>显示 {{ detectorRows.length }} / {{ detectorStats.total }} 条</small></div><div class="detector-filters"><select v-model="detectorMonth"><option value="all">全部月份</option><option v-for="month in detectorMonths" :key="month.month" :value="month.month">{{ month.month }}</option></select><select v-model="detectorSide"><option value="all">全部方向</option><option value="long">急跌补多</option><option value="short">急涨补空</option></select><select v-model="detectorOutcome"><option value="all">全部结果</option><option value="命中">命中</option><option value="失效">失效</option><option value="未决">未决</option></select></div></div><div class="detector-list"><div class="detector-row detector-row-head"><span>预警 / 确认</span><span>方向</span><span>确认价 / 极值</span><span>ATR / 偏离</span><span>Maker 参考价</span><span>12h 结果</span></div><div v-for="(item, i) in detectorRows" :key="`${item.time}-${i}`" class="detector-row"><span>{{ clock(item.watchAt) }}<small>{{ clock(item.time) }}</small></span><b :class="item.side === 'long' ? 'positive' : 'negative'">{{ item.side === 'long' ? '急跌补多' : '急涨补空' }}</b><span>{{ number(item.confirmPrice, 3) }}<small>极值 {{ number(item.extreme, 3) }}</small></span><span>{{ number(item.atr, 3) }}<small>{{ item.gapAtr.toFixed(1) }} ATR</small></span><span>{{ number(item.entryPrice, 3) }}<small>{{ item.distant ? '远端限时等待' : '近价 Maker' }}</small></span><strong :class="item.outcome === '命中' ? 'positive' : item.outcome === '失效' ? 'negative' : ''">{{ item.outcome }}<small>{{ item.outcomeTime ? clock(item.outcomeTime) : '12 小时未决' }}</small></strong></div><div v-if="!detectorRows.length" class="log-empty">当前筛选没有信号</div></div></div>
            <div class="detector-footnote">判定口径：从确认价开始，后续 12 小时先触及顺向 1 ATR 为“命中”，先触及逆向 1 ATR 为“失效”；同一根小时线两边均触及或均未触及为“未决”。这不是交易收益判定。</div>
          </div>
        </div>
      </section>
    </div>
    <div v-if="peakFillVisible" class="template-backdrop" role="presentation" @click.self="peakFillVisible = false">
      <section class="template-dialog peak-fill-dialog" role="dialog" aria-modal="true" aria-labelledby="peak-fill-title">
        <header><h2 id="peak-fill-title">多头亏损峰值 · 仓位成交明细</h2><button class="template-close" aria-label="关闭" @click="peakFillVisible = false">×</button></header>
        <div class="template-content">
          <p v-if="peakFillContext">截至 {{ clock(peakFillContext.time) }} · 已补 {{ peakFillContext.additions }} 档 · 已投入本金 {{ number(peakFillContext.margin) }} U · 实际成交 {{ peakFillContext.fills?.length || 0 }} 笔</p>
          <p v-else>正在读取峰值时刻的成交明细…</p>
          <div v-if="peakFillContext?.fills?.length" class="peak-fill-table">
            <div class="peak-fill-row peak-fill-head"><span>类型 / 档位</span><span>成交时间</span><span>成交价</span><span>数量</span><span>本金</span></div>
            <div v-for="(fill, i) in peakFillContext.fills" :key="`${fill.time}-${i}`" class="peak-fill-row">
              <span>{{ fill.purpose === 'open' ? '底仓' : fill.tierStart === fill.tierEnd ? `第 ${fill.tierStart} 档` : `第 ${fill.tierStart}–${fill.tierEnd} 档` }}<small>{{ fill.label }}</small></span>
              <time>{{ clock(fill.time) }}</time><span>{{ number(fill.price, 3) }}</span><span>{{ number(fill.qty, 4) }}</span><b>{{ number(fill.margin) }} U</b>
            </div>
          </div>
        </div>
      </section>
    </div>
    <header class="topbar">
      <button class="back" @click="router.push('/')"><el-icon><ArrowLeft /></el-icon> 返回 TradFi</button>
      <div class="brand"><span class="brand-dot"></span><div><strong>TradFi 策略回放</strong><small>本地历史模拟 · 不连接实盘</small></div></div>
      <div class="status-pill" :class="{ live: isPlaying }"><i></i>{{ status }}</div>
    </header>
    <div class="layout">
      <aside class="sidebar">
        <section class="import-card">
          <div class="sidebar-section">
          <div class="section-title"><span>01</span> 数据与参数 <button class="help-button" type="button" aria-label="查看数据模板格式" title="查看数据模板格式" @click="templatesVisible = true"><el-icon><InfoFilled /></el-icon></button></div>
          <label class="field-label">回放标的 <span>可自动识别，也可修改</span></label>
          <div class="input-row"><input v-model="symbol" type="text" maxlength="30" placeholder="例如 XAUUSDT、SNDK、AAPL"><button class="inline-action" @click="resetDefaults">应用默认参数</button></div>
          <label class="field-label">分钟 K 线 CSV <span>必填</span></label>
          <label class="file-drop"><input type="file" accept=".csv,.txt" @change="pickFile('candles', $event)"><el-icon><Upload /></el-icon><b>{{ candleName || '导入 1 分钟 K 线' }}</b><small>timestamp, open, high, low, close, volume</small></label>
          <p v-if="candleError" class="error">{{ candleError }}</p>
          <div class="file-ok" v-else-if="candles.length">{{ candles.length.toLocaleString() }} 根 · {{ clock(candles[0].t) }} — {{ clock(candles.at(-1)!.t) }}</div>
          <label class="field-label">资金费 CSV <span>可选</span></label>
          <label class="file-drop compact"><input type="file" accept=".csv,.txt" @change="pickFile('funding', $event)"><el-icon><Upload /></el-icon><b>{{ fundingName || '导入历史资金费' }}</b><small>timestamp, fundingRate（小数）</small></label>
          <p v-if="fundingError" class="error">{{ fundingError }}</p>
          </div>
          <div class="sidebar-section">
          <div class="section-title"><span>02</span> 策略参数</div>
          <label class="field-label">单笔保证金 <small>U · 上限 20</small></label>
          <div class="input-row"><input v-model.number="margin" type="number" min="0.1" :max="maxMargin" step="0.5"><span>USDT（上限 {{ maxMargin }}）</span></div>
          <label class="field-label">杠杆</label>
          <div class="input-row"><input v-model.number="leverage" type="number" min="1" max="50" step="1"><span>×</span></div>
          <div class="two-inputs"><div><label class="field-label">Maker 费率</label><div class="input-row"><input v-model.number="makerFeePct" type="number" min="0" step="0.001"><span>%</span></div></div><div><label class="field-label">价格 Tick</label><div class="input-row"><input v-model.number="tickSize" type="number" min="0.000001" step="0.01"></div></div></div>
          <div class="two-inputs"><div><label class="field-label">数量步进</label><div class="input-row"><input v-model.number="qtyStep" type="number" min="0.000001" step="0.001"></div></div><div><label class="field-label">撮合约定</label><div class="fixed-value">穿价 1 Tick</div></div></div>
          </div>
          <div class="sidebar-section">
          <div class="section-title"><span>03</span> 模拟账户</div>
          <label class="field-label">模拟账户权益 <small>用于特殊补仓风险检查</small></label>
          <div class="input-row"><input v-model.number="walletBalance" type="number" min="1" step="100"><span>USDT</span></div>
          <div class="start-actions"><button class="start-button" :disabled="!candles.length || warmupVisible" @click="startReplay"><el-icon><VideoCamera /></el-icon> {{ ready ? '重新开始回放' : '载入并开始' }}</button><button class="detector-button" type="button" @click="detectorVisible = true">策略检测</button></div>
          </div>
          <div class="sidebar-section history-section">
          <div class="history-box">
            <div class="history-heading"><b><span class="section-number">04</span> 本地数据历史</b><span>{{ savedDatasets.length }} 组回放</span></div>
            <p v-if="!savedDatasets.length" class="history-empty">回放准备成功后，K 线与资金费会合并保存为一条记录。</p>
            <div v-for="item in savedDatasets" :key="item.id" class="history-item">
              <div class="history-detail"><strong :title="item.candleName">{{ item.symbol }} · {{ item.candleName }}</strong><small :title="item.fundingName">资金费：{{ item.fundingName || '未导入' }}（{{ item.fundingRows.toLocaleString() }} 条）</small><small>K 线 {{ item.candleRows.toLocaleString() }} 根 · {{ fileSize(item.size) }}</small><small>{{ clock(item.start) }} — {{ clock(item.end) }}</small><small>保存于 {{ clock(item.savedAt) }}</small></div>
              <div class="history-actions"><button type="button" :disabled="historyBusy || warmupVisible" @click="loadSavedDataset(item)">{{ loadingHistoryId === item.id ? '载入中' : '载入并开始' }}</button><button type="button" class="danger" :disabled="historyBusy || warmupVisible" :aria-label="`删除 ${item.symbol} 回放`" @click="removeSavedDataset(item)">删除</button></div>
            </div>
            <small class="history-note">仅保存在当前浏览器；清除网站数据可能删除记录，请保留原始 CSV。</small>
          </div>
          <div class="import-hint">支持任意标的分钟线；文件名或 CSV 标的列可自动识别。XAU/XAG 使用预设参数，其他标的请核对价格 Tick、数量步进、费率和保证金参数。回放仅在当前浏览器运行。</div>
          </div>
        </section>
        <section class="card rules-card">
          <div class="section-title"><span>05</span> 策略规则快照</div>
          <div class="rule-line"><b>底仓</b><span>震荡确认后双向 Maker 建仓；连续上涨过热时暂缓多头补仓与重建，高位回落确认后有限补空</span></div>
          <div class="rule-line"><b>补仓</b><span>常规档距为 15m ATR × 0.6。黄金深跌补多以最近 30 根完整日线高点计算回撤：12% 首档需小时线止跌确认；22%、25% 后续档要求完整小时线收在对应深度，且形成比上一档更低的低点。总预算为初始单笔本金 × 当时剩余多头补仓档位，依次使用 22%、35%、43%，每笔均需风险检查。深跌期间暂停普通多头阶梯补仓。</span></div>
          <div class="rule-line"><b>稀疏</b><span>趋势与 ATR 距离确认后，挂在约 5 倍稀疏间距的远端；每笔只投入 1 档本金。纽约周末暂停自动补仓并撤销未成交补仓单。</span></div>
          <div class="rule-line"><b>止盈</b><span>普通模式达标 Maker 平仓；多头恢复模式达标后追踪盈利峰值，回撤触线才尝试平仓；10 秒后重建</span></div>
          <div class="rule-line"><b>上限</b><span>多头 100 档 · 空头 20 档；到顶后继续管理已有仓位</span></div>
          <div class="rule-warning">指标预热需要 20 小时数据。实盘与回放共用小时线信号和风险决策函数；回放用输入的模拟账户权益估算可用保证金，实盘读取交易所余额。分钟线无法还原分钟内成交顺序。</div>
        </section>
      </aside>
      <section class="workspace">
        <div class="summary-row">
          <article class="metric-card"><span>当前价格</span><strong>{{ snapshot ? number(snapshot.price) : '—' }}</strong><small>{{ symbol }}</small></article>
          <article class="metric-card"><span>已实现盈亏</span><strong class="realized-amount"><span class="realized-main" :class="pnlClass(snapshot?.realized || 0)">{{ snapshot ? number(snapshot.realized) : '—' }} U</span><em class="funding-inline" :class="pnlClass(snapshot?.realizedFunding || 0)">（{{ snapshot && snapshot.realizedFunding > 0 ? '+' : '' }}{{ snapshot ? number(snapshot.realizedFunding) : '—' }} U）</em></strong><div class="realized-sides"><span>多 <b :class="pnlClass(snapshot?.realizedBySide?.long || 0)">{{ snapshot ? number(snapshot.realizedBySide.long) : '—' }} U</b></span><span>空 <b :class="pnlClass(snapshot?.realizedBySide?.short || 0)">{{ snapshot ? number(snapshot.realizedBySide.short) : '—' }} U</b></span></div><small>已平仓净盈亏（括号内为资金费）</small></article>
          <article class="metric-card floating-pnl-card"><span>当前浮动盈亏</span><strong :class="pnlClass(snapshot?.unrealized || 0)">{{ snapshot ? number(snapshot.unrealized) : '—' }} <em>U</em></strong><small>多空合计</small></article>
          <article class="metric-card loss-peak-card"><span>亏损峰值（多 / 空 / 总）</span><div><b>多 {{ snapshot ? `-${number(snapshot.maxLossPeak.long)}` : '—' }} U</b><b>空 {{ snapshot ? `-${number(snapshot.maxLossPeak.short)}` : '—' }} U</b><b class="total">总 {{ snapshot ? `-${number(snapshot.maxLossPeak.total)}` : '—' }} U</b></div><small>总亏损为同一时点多空合计浮亏峰值</small><div v-if="snapshot" class="peak-times"><span>多 {{ clock(snapshot.lossPeakContext?.long?.time || 0) }}</span><span>空 {{ clock(snapshot.lossPeakContext?.short?.time || 0) }}</span><span>总 {{ clock(snapshot.totalLossPeakTime || 0) }}</span></div><details v-if="snapshot?.lossPeakContext?.long" class="peak-detail"><summary>查看多头峰值发生时的状态</summary><p>时间 {{ clock(snapshot.lossPeakContext.long.time) }} · 价格 {{ number(snapshot.lossPeakContext.long.price, 3) }} · 均价 {{ number(snapshot.lossPeakContext.long.entryPrice, 3) }} <button type="button" class="peak-fill-link" @click="openPeakFills">详情</button></p><p>{{ rangePhaseName(snapshot.lossPeakContext.long.phase) }} · 已补 {{ snapshot.lossPeakContext.long.additions }} 档 · 仓位保证金 {{ number(snapshot.lossPeakContext.long.margin) }} U</p><p>深跌分级补多已成交 {{ snapshot.lossPeakContext.long.deepStage }}/3 档 · 锁定预算 {{ number(snapshot.lossPeakContext.long.deepBudget) }} U</p></details></article>
          <article class="metric-card distribution-card"><span>平仓收益分布</span><strong>≥10U {{ snapshot?.positionDistribution.large ?? '—' }} <em>/</em> 0–10U {{ snapshot?.positionDistribution.small ?? '—' }}</strong><small>按每笔盈利平仓的净盈亏计数；不代表累计收益</small></article>
        </div>
        <section class="card special-review"><div class="panel-heading"><div class="section-title">特殊补仓 · 成交与风险</div><small>实际分钟回放统计；峰值补仓按成交数量单独核算</small></div><div class="special-review-grid"><div><span>峰值大额补仓</span><b>多 {{ snapshot ? number(snapshot.special.margin.long) : '—' }} U / 空 {{ snapshot ? number(snapshot.special.margin.short) : '—' }} U</b><small>已成交保证金 · 成交 {{ snapshot?.special.filled ?? '—' }} / 委托 {{ snapshot?.special.placed ?? '—' }} / 撤销 {{ snapshot?.special.canceled ?? '—' }}</small></div><div><span>特殊仓位已实现净盈亏</span><b :class="pnlClass(snapshot?.special.realized || 0)">{{ snapshot ? `${number(snapshot.special.realized)} U` : '—' }}</b><small>峰值大额补仓对应份额，含分摊资金费与手续费</small></div><div><span>保证金峰值</span><b>{{ snapshot ? `${number(snapshot.marginPeak)} U` : '—' }}</b><small>多空持仓保证金合计</small></div><div><span>亏损持仓时长（多 / 空）</span><b>{{ snapshot ? `${Math.round(snapshot.losingMinutes.long / 60)} / ${Math.round(snapshot.losingMinutes.short / 60)} 小时` : '—' }}</b><small>最长连续 {{ snapshot ? `${Math.round(snapshot.maxLosingStreak.long / 60)} / ${Math.round(snapshot.maxLosingStreak.short / 60)}` : '—' }} 小时</small></div></div></section>
        <section class="card chart-card">
          <div class="panel-heading"><div><div class="section-title"><span>03</span> 分钟走势与策略状态</div><div class="subheading">{{ snapshot ? clock(snapshot.time) : '导入数据后开始回放' }} <i v-if="snapshot">·</i> {{ snapshot?.state || '等待数据' }}</div></div><div class="chart-meta" v-if="chartMinMax"><span>H {{ number(chartMinMax.max) }}</span><span>L {{ number(chartMinMax.min) }}</span></div></div>
          <div class="chart-wrap"><svg viewBox="0 0 1000 260" preserveAspectRatio="none" aria-label="分钟收盘价走势"><defs><linearGradient id="chart-fill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#27c99b" stop-opacity=".2"/><stop offset="1" stop-color="#27c99b" stop-opacity="0"/></linearGradient></defs><path v-if="chartPath" :d="`${chartPath} L 1000 260 L 0 260 Z`" fill="url(#chart-fill)"/><path v-if="chartPath" :d="chartPath" fill="none" stroke="#26c99a" stroke-width="2.2" vector-effect="non-scaling-stroke"/><text v-if="!chartPath" x="500" y="132" text-anchor="middle" fill="#69798c" font-size="14">导入连续的分钟 K 线后查看回放图表</text></svg><div class="chart-grid"><i></i><i></i><i></i><i></i></div></div>
          <div class="progress-meta"><span>{{ snapshot ? `${snapshot.index.toLocaleString()} / ${snapshot.total.toLocaleString()} 分钟` : '回放进度' }}</span><span>{{ progress }}%</span></div><div class="progress-track"><i :style="{ width: `${progress}%` }"></i></div>
          <div class="player"><button class="icon-button" :disabled="!ready || isPlaying" title="单步前进一分钟" @click="send('step')"><el-icon><CaretRight /></el-icon><span>单步</span></button><button class="play-button" :disabled="!ready" @click="send(isPlaying ? 'pause' : 'play')"><el-icon><component :is="isPlaying ? VideoPause : VideoPlay" /></el-icon>{{ isPlaying ? '暂停' : '播放' }}</button><button class="icon-button" :disabled="!ready || !isPlaying" @click="send('pause')">停止</button><label>速度<select v-model.number="speed"><option :value="10">10×</option><option :value="20">20×</option><option :value="50">50×</option><option :value="100">100×</option><option :value="200">200×</option><option :value="500">500×</option></select><small>每秒 {{ speed * 20 }} 分钟</small></label><span class="player-spacer"></span><button class="export-button" :disabled="!allLogs.length" @click="downloadLogs"><el-icon><Download /></el-icon> 导出平仓记录</button></div>
        </section>
        <section class="position-grid">
          <article v-for="side in (['long', 'short'] as const)" :key="side" class="card position-card" :class="side"><header><div><i></i><b>{{ side === 'long' ? '多头仓位' : '空头仓位' }}</b></div><span>{{ snapshot?.positions[side]?.adds ?? 0 }} / {{ side === 'long' ? 100 : 20 }} 补仓</span></header><div v-if="snapshot?.positions[side]" class="position-data"><strong :class="pnlClass(snapshot.positions[side].pnl)">{{ number(snapshot.positions[side].pnl) }} U</strong><div class="position-opened-at"><small>开仓时间</small><b>{{ clock(snapshot.positions[side].openedAt) }}</b></div><div class="position-cols"><div><small>持仓均价</small><b>{{ number(snapshot.positions[side].avg, 3) }}</b></div><div><small>名义价值</small><b>{{ number(snapshot.positions[side].notional) }} U</b></div><div><small>保证金</small><b>{{ number(snapshot.positions[side].margin) }} U</b></div><div><small>持仓数量</small><b>{{ number(snapshot.positions[side].qty, 4) }}</b></div></div></div><div v-else class="position-empty">当前无{{ side === 'long' ? '多头' : '空头' }}仓位</div><div v-if="snapshot?.orders[side]" class="pending-order">委托中 · {{ snapshot.orders[side].purpose === 'close' ? '止盈' : snapshot.orders[side].purpose === 'add' ? '补仓' : '开仓' }} {{ number(snapshot.orders[side].price, 3) }} <small>{{ snapshot.orders[side].label }}</small></div></article>
        </section>
        <section class="card logs-card">
          <div class="panel-heading"><div><div class="section-title"><span>04</span> 仓位盈亏记录</div><div class="subheading">仅显示平仓净盈亏不低于 10U 的仓位</div></div><div class="log-toolbar"><span>{{ filteredLogs.length }} 条（筛选前 {{ allLogs.length }} 条）</span></div></div>
          <div class="log-head position-log-head"><span>开仓时间</span><span>开仓均价</span><span>平仓时间</span><span>平仓均价</span><span>平仓净盈亏</span><span>资金费</span></div>
          <div class="log-list"><article v-for="row in [...filteredLogs].reverse()" :key="row.id" class="log-row position-log"><time>{{ clock(row.openedAt) }}</time><span class="position-price">{{ number(row.openPrice, 3) }}</span><time>{{ clock(row.closedAt) }}</time><span class="position-price">{{ number(row.closePrice, 3) }}</span><b :class="pnlClass(row.pnl)">{{ number(row.pnl) }} U</b><span :class="pnlClass(row.funding)">{{ number(row.funding) }} U</span></article><div v-if="!filteredLogs.length" class="log-empty">仓位平仓后会在这里显示盈亏汇总</div></div>
        </section>
      </section>
    </div>
  </main>
</template>

<style scoped>
.replay-page{--bg:#0b1017;--panel:#111821;--panel2:#151e29;--border:#202c39;--muted:#7f91a7;--text:#e3ebf5;--green:#20c997;--red:#ff596d;--gold:#e6ad18;min-height:100vh;background:var(--bg);color:var(--text);font:13px/1.5 Inter,"Microsoft YaHei",sans-serif;padding:0 22px 28px}.warmup-backdrop{position:fixed;inset:0;z-index:10000;display:grid;place-items:center;padding:20px;background:#05080dc9;backdrop-filter:blur(4px)}.warmup-dialog{width:min(420px,100%);padding:27px 25px 24px;border:1px solid #4a4127;border-radius:13px;background:#111821;box-shadow:0 20px 70px #0009;text-align:center}.warmup-icon{width:38px;height:38px;border:1px solid #64501d;background:#282518;border-radius:11px;display:grid;place-items:center;margin:0 auto 13px}.warmup-icon i{width:12px;height:12px;border:2px solid #dfb12a;border-right-color:transparent;border-radius:50%;animation:warmup-spin .8s linear infinite}.warmup-dialog h2{margin:0;font-size:16px;color:#e8edf5}.warmup-dialog>p{min-height:19px;margin:6px 0 20px;font-size:11px;color:#8e9eb1}.warmup-progress-meta{display:flex;justify-content:space-between;margin-bottom:7px;color:#94a3b6;font-size:10px}.warmup-progress-meta b{color:#edbd35;font:600 11px ui-monospace,Consolas,monospace}.warmup-progress-track{height:7px;border-radius:8px;background:#26313d;overflow:hidden}.warmup-progress-track i{display:block;height:100%;border-radius:inherit;background:linear-gradient(90deg,#b98916,#f3c843);transition:width .16s ease}.warmup-dialog>small{display:block;margin-top:15px;color:#708198;font-size:9px}@keyframes warmup-spin{to{transform:rotate(360deg)}}.topbar{height:66px;display:flex;align-items:center;gap:24px;border-bottom:1px solid var(--border);margin-bottom:18px}.back,.icon-button,.export-button{border:0;background:transparent;color:#9cafc5;display:inline-flex;align-items:center;gap:7px;cursor:pointer}.back:hover,.export-button:hover{color:#fff}.brand{display:flex;align-items:center;gap:10px;margin-right:auto}.brand-dot{width:10px;height:10px;border-radius:50%;background:var(--gold);box-shadow:0 0 15px #e6ad1866}.brand strong,.brand small{display:block}.brand strong{font-size:15px}.brand small{color:var(--muted);font-size:11px}.status-pill{display:flex;align-items:center;gap:8px;color:#9aabc0}.status-pill i{width:7px;height:7px;border-radius:50%;background:#728298}.status-pill.live i{background:var(--green);box-shadow:0 0 10px #20c997}.layout{display:grid;grid-template-columns:290px minmax(0,1fr);gap:16px;max-width:1680px;margin:auto}.sidebar,.workspace{min-width:0;display:flex;flex-direction:column;gap:14px}.card,.metric-card{background:var(--panel);border:1px solid var(--border);border-radius:10px}.import-card,.rules-card{padding:16px}.section-title{font-weight:700;font-size:14px;display:flex;align-items:center;gap:9px}.section-title>span{font:700 10px/1 monospace;color:#8fa0b6;background:#1b2632;border-radius:4px;padding:5px}.field-label{display:flex;align-items:center;justify-content:space-between;color:#a8b7c9;font-size:11px;margin:13px 0 6px}.field-label>span{font-size:10px;color:#97a9be}.field-label small{color:var(--muted)}.segmented{display:flex;padding:3px;background:#0b1118;border:1px solid var(--border);border-radius:7px}.segmented button{flex:1;border:0;color:#91a3b9;background:transparent;padding:7px 5px;border-radius:5px;font-size:12px;cursor:pointer}.segmented button.selected{background:#2a281c;color:var(--gold);box-shadow:inset 0 0 0 1px #a47a15}.file-drop{min-height:72px;position:relative;border:1px dashed #344557;border-radius:7px;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:2px;color:#90a5bd;background:#0e151d;cursor:pointer}.file-drop:hover{border-color:#9a7414;background:#171b1d}.file-drop input{position:absolute;inset:0;opacity:0;cursor:pointer}.file-drop b{font-size:11px;font-weight:600;max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.file-drop small{font-size:9px;color:#66798e}.file-drop.compact{min-height:57px}.file-ok{font-size:10px;color:var(--green);padding:5px 1px 0}.error{font-size:10px;color:var(--red);margin:5px 0}.input-row{height:34px;border:1px solid var(--border);border-radius:6px;background:#0c1219;display:flex;align-items:center;padding:0 9px;gap:6px}.input-row input{min-width:0;width:100%;height:100%;background:transparent;border:0;outline:0;color:#e9f0f8;font-size:12px}.input-row span{font-size:10px;color:var(--muted);white-space:nowrap}.two-inputs{display:grid;grid-template-columns:1fr 1fr;gap:9px}.two-inputs .field-label{margin-top:11px}.fixed-value{font-size:11px;color:#b8c5d2;background:#0c1219;border:1px solid var(--border);height:34px;border-radius:6px;display:flex;align-items:center;padding:0 8px}.start-button{width:100%;height:38px;border:1px solid #ba8d17;border-radius:7px;background:#292719;color:#f2c54e;font-weight:700;margin-top:17px;cursor:pointer;display:flex;justify-content:center;align-items:center;gap:8px}.start-button:disabled{opacity:.5;cursor:not-allowed}.import-hint{font-size:10px;color:#718399;line-height:1.55;margin-top:9px}.rule-line{display:grid;grid-template-columns:45px 1fr;gap:8px;margin:12px 0;font-size:10px}.rule-line b{color:#d3a92a}.rule-line span{color:#91a2b6}.rule-warning{border-top:1px solid var(--border);padding-top:10px;color:#d1a83c;font-size:10px;line-height:1.6}.summary-row{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:10px}.metric-card{padding:12px 14px;min-width:0}.metric-card>span,.metric-card>small{display:block;color:#8799ae;font-size:10px}.metric-card strong{display:block;font:600 21px/1.35 ui-monospace,Consolas,monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin:4px 0}.metric-card strong em{font:11px sans-serif;color:#93a2b4}.metric-card small{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:9px}.positive{color:var(--green)!important}.negative{color:var(--red)!important}.cost{color:#e9bf50}.panel-heading{display:flex;justify-content:space-between;align-items:center;gap:12px}.chart-card,.logs-card{padding:15px 17px}.subheading{color:#778ba2;font-size:10px;margin-top:5px}.chart-meta{display:flex;gap:12px;font:10px monospace;color:#8498ae}.chart-meta span:first-child{color:#ef7785}.chart-meta span:last-child{color:#26c99a}.chart-wrap{height:245px;margin-top:11px;position:relative;background:linear-gradient(180deg,#0d151d,#101923);border-radius:7px;overflow:hidden}.chart-wrap svg{position:absolute;inset:0;width:100%;height:100%;z-index:1}.chart-grid{position:absolute;inset:0;display:flex;flex-direction:column;justify-content:space-evenly;padding:0 12px}.chart-grid i{border-top:1px dashed #293543}.progress-meta{display:flex;justify-content:space-between;color:#8597ad;font-size:10px;margin:13px 0 5px}.progress-meta span:last-child{color:var(--gold);font-variant-numeric:tabular-nums}.progress-track{height:4px;border-radius:4px;background:#26313d;overflow:hidden}.progress-track i{height:100%;display:block;background:linear-gradient(90deg,#c39114,#f0c947);transition:width .12s}.player{display:flex;align-items:center;gap:13px;padding-top:12px}.player button{font-size:11px}.player button:disabled{opacity:.4;cursor:not-allowed}.icon-button{padding:5px}.play-button{height:32px;border:1px solid #178e6e;background:#123329;color:#42d9ac;border-radius:6px;padding:0 12px;display:flex;align-items:center;gap:6px;cursor:pointer}.player label{display:flex;align-items:center;gap:7px;font-size:10px;color:#8d9db0}.player select,.log-toolbar select{background:#0c1219;border:1px solid var(--border);border-radius:5px;color:#cbd6e2;padding:5px 7px;font-size:10px}.player label small{color:#65778c}.player-spacer{flex:1}.export-button{font-size:10px}.position-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}.position-card{padding:13px 15px;min-height:120px}.position-card header{display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid var(--border);padding-bottom:10px;font-size:11px;color:#98aabd}.position-card header>div{display:flex;align-items:center;gap:7px}.position-card header i{width:7px;height:7px;border-radius:50%;background:var(--green)}.position-card.short header i{background:var(--red)}.position-card header span{font-size:10px;color:#7f91a6}.position-data>strong{font:600 18px monospace;display:block;margin-top:8px}.position-cols{display:grid;grid-template-columns:repeat(4,1fr);margin-top:6px;gap:6px}.position-cols small,.position-cols b{display:block;font-size:9px}.position-cols small{color:#718399}.position-cols b{color:#c0cddd;font-weight:500;margin-top:3px}.position-empty{color:#65778b;font-size:11px;padding:16px 0 5px}.pending-order{font-size:10px;color:#d2a83b;margin-top:6px}.pending-order small{color:#8395aa;margin-left:5px}.log-toolbar{display:flex;align-items:center;gap:10px;color:#8193a9;font-size:10px}.log-head,.log-row{display:grid;grid-template-columns:150px minmax(0,1fr) 110px 80px;gap:12px;align-items:center}.log-head{font-size:9px;color:#778ba1;padding:10px 8px 8px;border-bottom:1px solid var(--border);margin-top:10px}.log-list{height:270px;overflow:auto}.log-row{min-height:32px;border-bottom:1px solid #1b2530;padding:5px 8px;font-size:10px}.log-row time,.log-row>span{color:#8497ad;font-variant-numeric:tabular-nums}.log-row>b{font-weight:500;color:#c1cedd;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.log-row>i{font-style:normal;font-size:9px;color:#8497ad}.log-row>i.type-close-fill{color:var(--green)}.log-row>i.type-expired{color:#e0ae31}.log-row>i.type-add-fill{color:#a88be2}.log-empty{height:200px;display:grid;place-items:center;color:#697b90;font-size:11px}
@media(max-width:1150px){.layout{grid-template-columns:260px minmax(0,1fr)}.summary-row{grid-template-columns:repeat(3,1fr)}.log-head,.log-row{grid-template-columns:125px minmax(0,1fr) 90px 65px}}@media(max-width:850px){.replay-page{padding:0 12px 20px}.layout{grid-template-columns:1fr}.sidebar{display:grid;grid-template-columns:1fr 1fr}.summary-row{grid-template-columns:repeat(2,1fr)}.brand{margin-right:0}.status-pill{margin-left:auto}.chart-wrap{height:210px}}@media(max-width:560px){.topbar{gap:10px}.back{font-size:0}.back .el-icon{font-size:15px}.brand{margin-right:auto}.status-pill{font-size:0}.sidebar,.position-grid{grid-template-columns:1fr}.summary-row{grid-template-columns:repeat(2,1fr)}.player{gap:5px;flex-wrap:wrap}.player-spacer{display:none}.player label{margin-left:auto}.log-head,.log-row{grid-template-columns:90px minmax(0,1fr) 65px 45px;gap:5px}.log-row{font-size:9px}.log-list{height:240px}}
.inline-action{height:25px;padding:0 7px;border:1px solid #2b3948;border-radius:5px;background:#18222d;color:#a9bbcf;font-size:9px;white-space:nowrap;cursor:pointer}.inline-action:hover{border-color:#9a7414;color:#f0c54c}.metric-card strong .funding-inline{font:500 11px ui-monospace,Consolas,monospace;color:#98aabd}.loss-peak-card>div:first-of-type{display:grid;grid-template-columns:1fr 1fr;gap:4px 8px;margin:6px 0;color:var(--red);font:600 12px ui-monospace,Consolas,monospace}.loss-peak-card>div:first-of-type b{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.loss-peak-card>div:first-of-type b.total{grid-column:1/-1;padding-top:4px;border-top:1px solid #27313b;color:#f0c54c}.position-opened-at{display:flex;justify-content:space-between;gap:8px;margin-top:5px;padding:5px 7px;border-radius:5px;background:#0c1219}.position-opened-at small{color:#718399;font-size:9px}.position-opened-at b{color:#9eafc2;font-size:9px;font-weight:500}.position-log-head,.position-log{grid-template-columns:repeat(6,minmax(0,1fr));align-items:center;text-align:center}.position-log time,.position-price{color:#8497ad;font-variant-numeric:tabular-nums;white-space:nowrap}.position-log>b{font-variant-numeric:tabular-nums}.position-log>span{text-align:center;font-variant-numeric:tabular-nums}.position-log .position-price{text-align:center;color:#c1cedd}@media(max-width:850px){.position-log-head,.position-log{gap:5px}.position-log{font-size:9px}}@media(max-width:560px){.position-log-head,.position-log{gap:4px}.position-log{font-size:8px}.position-log-head{font-size:8px;padding-left:5px;padding-right:5px}.position-log{padding-left:5px;padding-right:5px}}
.help-button{display:inline-flex;align-items:center;justify-content:center;width:19px;height:19px;margin-left:1px;padding:0;border:0;border-radius:50%;background:transparent;color:#8ea2b9;cursor:pointer}.help-button:hover{background:#242b31;color:#f0c54c}.help-button .el-icon{font-size:15px}.template-backdrop{position:fixed;inset:0;z-index:1400;display:flex;align-items:center;justify-content:center;padding:16px;background:#05080dcc}.template-dialog{width:min(620px,100%);max-height:min(760px,92vh);display:flex;flex-direction:column;overflow:hidden;border:1px solid #344352;border-radius:12px;background:#111820;box-shadow:0 24px 70px #0009}.template-dialog>header{display:flex;align-items:center;justify-content:space-between;padding:15px 18px;border-bottom:1px solid #26323e}.template-dialog h2{margin:0;color:#e7edf5;font-size:15px}.template-close{width:28px;height:28px;border:0;border-radius:6px;background:transparent;color:#9badc0;font-size:22px;cursor:pointer}.template-close:hover{background:#202a34;color:#fff}.template-content{overflow:auto;padding:16px 18px 20px}.template-content>p{margin:0 0 14px;color:#9aabbd;font-size:11px;line-height:1.6}.template-block{margin-top:12px;padding:13px;border:1px solid #283542;border-radius:8px;background:#0d141c}.template-block h3{margin:0 0 9px;color:#e1bd53;font-size:12px}.template-block pre{overflow:auto;margin:0 0 9px;padding:10px;border-radius:5px;background:#080d12;color:#c6d4e3;font:11px/1.6 ui-monospace,Consolas,monospace;white-space:pre}.template-block small{display:block;color:#8395a9;font-size:10px;line-height:1.6}
.metric-card strong.realized-amount{display:flex;align-items:baseline;gap:2px;font-size:20px;overflow:hidden;text-overflow:clip}.realized-main{min-width:0;overflow:hidden;text-overflow:ellipsis;font:600 20px/1.35 ui-monospace,Consolas,monospace}.floating-pnl-card strong{font-size:20px}.metric-card strong .funding-inline{flex:0 0 auto;font:500 11px/1.35 ui-monospace,Consolas,monospace}.metric-card strong .funding-inline.positive{color:var(--green)!important}.metric-card strong .funding-inline.negative{color:var(--red)!important}@media(max-width:560px){.realized-main,.floating-pnl-card strong{font-size:18px}.metric-card strong .funding-inline{font-size:10px}}
.history-box{max-height:320px;overflow:auto;margin-top:13px;padding:10px;border:1px solid #293848;border-radius:8px;background:#0d141c}.history-heading{display:flex;align-items:center;justify-content:space-between;color:#d4dfeb;font-size:11px}.history-heading span,.history-empty,.history-note{color:#7f91a7;font-size:9px}.history-empty{margin:9px 0}.history-group-title{margin:11px 0 5px;color:#b89a4c;font-size:10px}.history-item{display:flex;align-items:center;gap:6px;padding:8px 0;border-top:1px solid #22303c}.history-detail{min-width:0;flex:1}.history-detail strong,.history-detail small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.history-detail strong{color:#d5e0ec;font-size:10px;font-weight:600}.history-detail small{color:#8295aa;font-size:9px}.history-actions{display:flex;flex-direction:column;gap:4px}.history-actions button{padding:3px 6px;border:1px solid #35465a;border-radius:4px;background:#172330;color:#bfd0e2;font-size:9px;cursor:pointer}.history-actions button:hover{border-color:#ad8727;color:#f4cd5a}.history-actions button.danger:hover{border-color:#ab4e57;color:#ff7f8a}.history-actions button:disabled{opacity:.45;cursor:not-allowed}.history-note{display:block;margin-top:9px;line-height:1.5}
.start-actions{display:flex;align-items:stretch;gap:7px;margin-top:17px}.start-actions .start-button{flex:1;min-width:0;margin-top:0}.detector-button{padding:0 10px;border:1px solid #3a5365;border-radius:7px;background:#182532;color:#b9d0df;font-size:11px;font-weight:600;white-space:nowrap;cursor:pointer}.detector-button:hover{border-color:#6e9cba;color:#e4f1fa}.detector-dialog{width:min(1180px,100%);max-height:94vh}.detector-dialog .template-content{padding:20px 24px 25px}.detector-eyebrow{display:block;margin-bottom:5px;color:#d6a83d;font:600 9px ui-monospace,Consolas,monospace;letter-spacing:.15em}.detector-dialog h2{font-size:17px}.detector-source-button{width:100%;margin-top:6px;padding:6px 8px;border:1px solid #354c60;border-radius:5px;background:#172532;color:#b5cada;font-size:10px;cursor:pointer}.detector-intro{display:grid;grid-template-columns:1fr 250px;gap:22px;align-items:center;padding:17px 19px;border:1px solid #3d3930;border-radius:9px;background:linear-gradient(105deg,#211f19,#131c25 65%)}.detector-intro b{color:#edca70;font-size:15px}.detector-intro p{max-width:680px;color:#aebcc9;font-size:11px;line-height:1.7}.detector-source-panel .start-button{margin-top:7px}.detector-results{margin-top:16px}.detector-metrics{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:9px;margin-top:10px}.detector-metrics article,.detector-panel{border:1px solid #283b4c;border-radius:9px;background:#111d29}.detector-metrics article{padding:13px}.detector-metrics article span,.detector-metrics article small{display:block;color:#8fa4b7;font-size:10px}.detector-metrics article strong{display:block;margin:7px 0;color:#e5eef6;font:600 23px ui-monospace,Consolas,monospace}.detector-metrics article strong em{font-style:normal}.detector-performance{border-color:#7a602c;background:linear-gradient(105deg,#211e17,#14202b)}.detector-performance>p{margin:0;color:#9cadbc;font-size:10px}.detector-performance-grid{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:8px}.detector-performance-grid>div{padding:8px;border-left:1px solid #4b4634}.detector-performance-grid span,.detector-performance-grid small{display:block;color:#93a5b4;font-size:9px}.detector-performance-grid b{display:block;margin:6px 0;color:#f0e7cf;font:600 15px ui-monospace,Consolas,monospace}.detector-visual-grid{display:grid;grid-template-columns:1.2fr 1fr;gap:10px;margin-top:11px}.detector-panel{min-width:0;padding:14px}.detector-panel-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:13px}.detector-panel-head b{color:#e7eef6;font-size:12px}.detector-panel-head small{color:#8498ac;font-size:9px}.detector-month{display:grid;grid-template-columns:58px minmax(0,1fr) 24px;align-items:center;gap:9px;margin:7px 0;color:#a8b9c8;font:10px ui-monospace,Consolas,monospace}.detector-month-track,.detector-rate-track{display:flex;height:10px;overflow:hidden;border-radius:3px;background:#23313d}.detector-month-track i{display:block;height:100%}.detector-month-track .hit{background:#24b68b}.detector-month-track .fail{background:#e66672}.detector-month-track .undecided{background:#77889c}.detector-direction{margin:13px 0}.detector-direction>div:first-child{display:flex;justify-content:space-between;color:#dce8f3;font-size:11px}.detector-rate-track{height:7px;margin:7px 0}.detector-rate-track i{background:#d7b04d}.detector-direction small,.detector-note,.detector-footnote{color:#91a4b5;font-size:10px;line-height:1.65}.detector-note{margin-top:15px;padding-top:11px;border-top:1px solid #293846}.detector-table-panel{margin-top:11px}.detector-filters{display:flex;gap:6px}.detector-filters select{padding:6px;border:1px solid #364d61;border-radius:5px;background:#0c1721;color:#bfd0dd;font-size:10px}.detector-list{max-height:335px;overflow:auto}.detector-row{display:grid;grid-template-columns:1.6fr 1fr 1.15fr .85fr 1.15fr .85fr;gap:10px;align-items:center;min-width:800px;padding:10px 5px;border-bottom:1px solid #253543;color:#c4d1dc;font:10px ui-monospace,Consolas,monospace}.detector-row-head{position:sticky;top:0;z-index:1;background:#162330;color:#8298aa;font-family:inherit}.detector-row small{display:block;margin-top:4px;color:#8497a8;font-size:9px}.detector-footnote{margin-top:12px}.special-review{padding:14px 16px}.special-review .panel-heading>small{color:#8195a9;font-size:10px}.special-review-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;margin-top:12px}.special-review-grid>div{padding:9px 11px;border-radius:7px;background:#0d1720}.special-review-grid span,.special-review-grid small{display:block;color:#8496a8;font-size:9px}.special-review-grid b{display:block;margin:5px 0;color:#dce7f1;font:600 14px ui-monospace,Consolas,monospace}.special-review-grid b.positive{color:var(--green)}.special-review-grid b.negative{color:var(--red)}@media(max-width:850px){.detector-visual-grid,.detector-intro{grid-template-columns:1fr}.detector-metrics{grid-template-columns:repeat(3,1fr)}.detector-performance-grid{grid-template-columns:repeat(2,1fr)}.special-review-grid{grid-template-columns:repeat(2,1fr)}}@media(max-width:560px){.detector-dialog .template-content{padding:12px}.detector-metrics{grid-template-columns:repeat(2,1fr)}.detector-panel-head{align-items:flex-start;flex-direction:column}.detector-filters{flex-wrap:wrap}.special-review-grid{grid-template-columns:1fr 1fr}}
/* Reference-inspired replay layout. The selectors below only change presentation. */
.replay-page {
  --bg: #0b0e14;
  --panel: #131823;
  --panel2: #1a202c;
  --border: #2d3748;
  --muted: #94a3b8;
  --text: #e2e8f0;
  --green: #10b981;
  --red: #ef4444;
  --gold: #f59e0b;
  height: 100vh;
  min-height: 0;
  overflow: hidden;
  padding: 0;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Microsoft YaHei', sans-serif;
  font-size: 13px;
}
.replay-page :is(.sidebar, .workspace, .log-list, .history-box, .template-content)::-webkit-scrollbar { width: 6px; height: 6px; }
.replay-page :is(.sidebar, .workspace, .log-list, .history-box, .template-content)::-webkit-scrollbar-track { background: var(--bg); }
.replay-page :is(.sidebar, .workspace, .log-list, .history-box, .template-content)::-webkit-scrollbar-thumb { background: var(--border); border-radius: 4px; }
.topbar {
  height: 60px;
  margin: 0;
  padding: 0 24px;
  gap: 14px;
  background: var(--panel);
  border-bottom: 1px solid var(--border);
}
.back { padding: 8px 0; color: var(--text); font-size: 13px; font-weight: 600; }
.back::after { content: '|'; margin-left: 14px; color: #64748b; font-weight: 400; }
.brand { display: flex; align-items: center; gap: 9px; }
.brand-dot { width: 8px; height: 8px; background: #3b82f6; box-shadow: 0 0 11px #3b82f688; }
.brand>div { display: flex; align-items: center; gap: 10px; }
.brand strong { font-size: 16px; color: var(--text); }
.brand small { padding: 4px 8px; border-radius: 4px; background: var(--panel2); color: #64748b; font-size: 11px; }
.status-pill { margin-left: auto; color: var(--green); font-size: 12px; white-space: nowrap; }
.status-pill i { width: 8px; height: 8px; background: var(--green); box-shadow: 0 0 8px #10b98177; }
.layout { grid-template-columns: 320px minmax(0, 1fr); gap: 0; height: calc(100vh - 60px); max-width: none; margin: 0; }
.sidebar { display: flex; flex-direction: column; gap: 15px; overflow: auto; padding: 0; background: var(--panel); border-right: 1px solid var(--border); }
.workspace { display: flex; flex-direction: column; gap: 18px; overflow: auto; padding: 20px 24px 32px; min-width: 0; }
.import-card { display: flex; flex-direction: column; gap: 14px; }
.sidebar-section, .rules-card { padding: 16px; border: 1px solid var(--border); border-radius: 8px; background: var(--panel2); }
.section-title { gap: 8px; color: var(--text); font-size: 13px; font-weight: 600; }
.sidebar-section>.section-title, .rules-card>.section-title { margin-bottom: 12px; }
.section-title>span, .section-number { padding: 0; background: none; color: #3b82f6; font: 700 12px/1.2 ui-monospace, Consolas, monospace; }
.field-label { margin: 13px 0 6px; color: var(--muted); font-size: 11px; }
.field-label>span, .field-label small { color: #64748b; font-size: 10px; }
.input-row, .fixed-value { height: 36px; padding: 0 10px; border-color: var(--border); background: var(--bg); }
.input-row:focus-within { border-color: #3b82f6; }
.input-row input { color: var(--text); font: 12px ui-monospace, Consolas, monospace; }
.input-row span { font-size: 10px; }
.two-inputs { gap: 10px; }
.file-drop { min-height: 70px; border-color: #475569; background: #ffffff05; color: var(--muted); }
.file-drop.compact { min-height: 62px; }
.file-drop:hover { border-color: #3b82f6; background: #3b82f60d; color: #60a5fa; }
.file-drop b { max-width: 260px; font-size: 11px; }
.file-drop small { color: #64748b; }
.file-ok { overflow-wrap: anywhere; line-height: 1.5; font-size: 10px; }
.inline-action { flex: 0 0 auto; height: 27px; border-color: var(--border); background: var(--panel2); color: var(--text); }
.inline-action:hover { border-color: #3b82f6; color: #60a5fa; }
.start-actions { gap: 8px; margin-top: 16px; }
.start-button { height: 38px; margin: 0; border: 0; border-radius: 6px; background: var(--gold); color: #111; font-size: 12px; }
.start-button:hover:not(:disabled) { background: #d97706; }
.detector-button { flex: 0 0 auto; border-color: var(--border); border-radius: 6px; background: transparent; color: var(--text); font-size: 11px; }
.detector-button:hover { border-color: #64748b; background: #242c3d; color: var(--text); }
.history-section { padding: 14px 16px; }
.history-box { max-height: 315px; margin: 0; padding: 0; border: 0; background: transparent; }
.history-heading { color: var(--text); }
.history-heading b { display: flex; align-items: center; gap: 8px; font-size: 12px; }
.history-heading span, .history-note { color: #64748b; }
.history-heading .section-number { color: #3b82f6; }
.history-item { border-color: var(--border); }
.import-hint { margin-top: 10px; color: #7f91a7; }
.rules-card { flex: 0 0 auto; }
.rule-line { grid-template-columns: 40px 1fr; gap: 7px; margin: 10px 0; }
.rule-line b { color: #f59e0b; }
.rule-warning { color: #a6b4c6; }
.summary-row { gap: 16px; }
.metric-card, .card:not(.rules-card) { border-color: var(--border); border-radius: 8px; background: var(--panel2); }
.metric-card { position: relative; box-sizing: border-box; min-height: 94px; padding: 10px 13px; overflow: hidden; }
.metric-card::before { content: ''; position: absolute; inset: 0 auto 0 0; width: 4px; background: var(--border); }
.metric-card:nth-child(1)::before { background: #3b82f6; }
.metric-card:nth-child(2)::before { background: var(--green); }
.metric-card:nth-child(3)::before { background: var(--red); }
.metric-card>span { font-size: 11px; color: var(--muted); }
.metric-card>strong, .metric-card strong.realized-amount, .floating-pnl-card strong { margin: 5px 0; font-size: 19px; line-height: 1.2; }
.metric-card small { font-size: 10px; color: #64748b; }
.realized-sides { display: flex; gap: 10px; min-width: 0; margin: 1px 0 3px; color: #8ea0b5; font-size: 10px; white-space: nowrap; }
.realized-sides b { font-weight: 600; font-variant-numeric: tabular-nums; }
.realized-main { font-size: 20px; }
.loss-peak-card>div:first-of-type { margin: 5px 0; gap: 2px 8px; }
.distribution-card>strong { white-space: normal; font-size: 14px; line-height: 1.35; }
.loss-peak-card>div:first-of-type b { font-size: 11px; }
.peak-detail { margin-top: 7px; color: #91a5ba; font-size: 10px; line-height: 1.5; }
.peak-detail summary { cursor: pointer; color: #b8c9da; }
.peak-detail p { margin: 4px 0 0; }
.peak-times { display: flex; flex-wrap: wrap; gap: 2px 7px; color: #8397aa; font-size: 9px; line-height: 1.4; }
.peak-fill-link { padding: 0 3px; border: 0; background: transparent; color: #e9b94d; font-size: inherit; text-decoration: underline; cursor: pointer; }
.peak-fill-dialog { width: min(850px, 100%); }
.peak-fill-table { max-height: min(600px, 65vh); overflow: auto; border: 1px solid var(--border); border-radius: 6px; }
.peak-fill-row { display: grid; grid-template-columns: 1.2fr 1.5fr 1fr .8fr 1fr; gap: 10px; align-items: center; min-width: 650px; padding: 9px 12px; border-bottom: 1px solid var(--border); color: #c7d4e1; font: 11px ui-monospace,Consolas,monospace; }
.peak-fill-row:last-child { border-bottom: 0; }
.peak-fill-row small { display: block; margin-top: 3px; color: #7e91a5; font: 9px sans-serif; }
.peak-fill-row b { text-align: right; color: #e9bd5b; }
.peak-fill-head { position: sticky; top: 0; z-index: 1; background: var(--panel); color: #8ca2b7; font: 10px sans-serif; }
.peak-fill-head span:last-child { text-align: right; }
.chart-card { min-height: 380px; display: flex; flex-direction: column; padding: 20px; }
.chart-card .section-title { font-size: 14px; }
.chart-card .section-title>span { color: #64748b; }
.chart-card .subheading { margin-top: 5px; font-size: 11px; }
.chart-wrap { flex: 1 0 200px; height: auto; min-height: 200px; margin-top: 16px; border-bottom: 1px solid var(--border); border-radius: 0; background: linear-gradient(180deg, #10b9810d, transparent); }
.chart-grid i { border-color: #2d374880; }
.chart-meta { font-size: 11px; }
.progress-meta { margin-top: 15px; font-size: 11px; }
.progress-track { background: var(--bg); }
.progress-track i { background: #3b82f6; }
.player { gap: 10px; margin-top: 10px; border-top: 1px solid var(--border); padding-top: 14px; }
.icon-button { min-height: 32px; padding: 0 9px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg); color: var(--text); }
.icon-button:hover:not(:disabled) { border-color: #64748b; background: #242c3d; }
.play-button { min-height: 32px; border: 0; border-radius: 6px; background: var(--gold); color: #111; font-weight: 700; }
.play-button:hover:not(:disabled) { background: #d97706; }
.player select { border-color: var(--border); background: var(--bg); }
.position-grid { gap: 16px; }
.position-card { padding: 16px; min-height: 145px; }
.position-card header { padding-bottom: 12px; border-color: var(--border); font-size: 12px; }
.position-card header i { width: 8px; height: 8px; }
.position-data>strong { font-size: 17px; }
.position-cols { gap: 12px; margin-top: 12px; }
.position-cols small { color: #64748b; font-size: 10px; }
.position-cols b { color: var(--text); font: 500 11px ui-monospace, Consolas, monospace; }
.position-opened-at { margin-top: 10px; background: var(--bg); }
.special-review { padding: 15px 18px; }
.special-review-grid { gap: 10px; }
.special-review-grid>div { background: #131823; border: 1px solid var(--border); }
.logs-card { padding: 16px 20px; }
.log-head { border-color: var(--border); }
.log-row { border-color: #2d374880; }
.template-dialog { border-color: var(--border); background: var(--panel); }
.template-dialog>header { border-color: var(--border); }
@media (max-width: 1100px) {
  .layout { grid-template-columns: 300px minmax(0, 1fr); }
  .summary-row { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .special-review-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 850px) {
  .replay-page { height: auto; min-height: 100vh; overflow: visible; }
  .layout { display: flex; flex-direction: column; height: auto; }
  .sidebar { display: flex; overflow: visible; border-right: 0; border-bottom: 1px solid var(--border); }
  .workspace { overflow: visible; padding: 16px; }
  .summary-row { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .chart-wrap { min-height: 210px; }
}
@media (max-width: 560px) {
  .topbar { padding: 0 12px; gap: 8px; }
  .brand>div { display: block; }
  .brand small { display: none; }
  .brand strong { font-size: 13px; }
  .back::after { margin-left: 5px; }
  .workspace { padding: 12px; }
  .summary-row, .position-grid, .special-review-grid { gap: 10px; }
  .metric-card { min-height: 94px; padding: 12px; }
  .metric-card>strong, .metric-card strong.realized-amount, .floating-pnl-card strong { font-size: 18px; }
  .chart-card { padding: 14px; }
  .player { flex-wrap: wrap; }
}
</style>
