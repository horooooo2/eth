<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, toRaw, watch } from 'vue';
import { saveRun, listRuns, getRun, type RunSummary } from '../tradfi-replay/runHistory';
import { parseCandles, guessSymbol, embeddedFunding, parseFunding } from '../tradfi-replay/csv';
import { useRouter } from 'vue-router';
import { LADDER_RULES, DEFAULT_TIERS, validateSettings } from '../tradfi-replay/dailyLadderEngine';
import { goldStrategy, isGoldStrategyReport, createReplayWorker } from '../tradfi-replay/strategies';
import { ArrowLeft, Download, Upload, VideoPlay, VideoPause, VideoCamera, CaretRight, InfoFilled } from '@element-plus/icons-vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { deleteReplayDataset, getReplayDataset, listReplayDatasets, saveReplayDataset, type ReplayDataset, type ReplayDatasetSummary } from '../tradfi-replay/localHistory';

type Candle = { t: number; o: number; h: number; l: number; c: number; v: number };
type LogRow = { id: string; time: number; type: string; text: string; [key: string]: any };
type PeakFill = { time: number; price: number; qty: number; margin: number; purpose: 'open' | 'add'; tierStart: number; tierEnd: number; label: string };
type PeakContext = { time: number; price: number; entryPrice: number; margin: number; additions: number; phase: string; deepBudget: number; deepStage: number; fills?: PeakFill[] };
type Snapshot = { eventStats?: {observations:number;opened:number;additions:number;skipped:number;canceled:number;closed:number}; dailyContext?: {day:number;dayOpen:number;weekPct:number|null;bias:string|null;dailyPct:number|null;completeDays:number}; activeEvent?: any; recentEvents?: any[]; allEvents?: any[]; equity?: number; maxDrawdown?: number; maxDrawdownPct?: number; index: number; total: number; progress: number; time: number; price: number; state: string; symbol: string; positions: Record<string, any>; orders: Record<string, any>; realized: number; realizedBySide: Record<'long' | 'short', number>; realizedFunding: number; maxLossPeak: Record<'long' | 'short' | 'total', number>; lossPeakContext?: Record<'long' | 'short', PeakContext | null>; totalLossPeakTime?: number; marginPeak: number; special: { placed: number; filled: number; canceled: number; realized: number; margin: Record<'long' | 'short', number> }; losingMinutes: Record<'long' | 'short', number>; maxLosingStreak: Record<'long' | 'short', number>; fees: number; funding: number; unrealized: number; net: number; tradeCount: number; positionDistribution: { large: number; small: number }; recentLogs: LogRow[]; logsTotal: number; candles: Candle[]; paused: boolean; market: any };

const props = withDefaults(defineProps<{ embedded?: boolean; active?: boolean }>(), { embedded: false, active: true });
const emit = defineEmits<{ back: [] }>();
const strategyId = ref('gold-range');
const strategy = computed(() => goldStrategy);
const runManifest = ref<any>(null);
const savedRuns = ref<RunSummary[]>([]);
let savedRunId = '';
const newId = () => typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
async function refreshRuns() { try { savedRuns.value = (await listRuns()).filter(isGoldStrategyReport); } catch { /* Direct export remains available. */ } }
function makeReport() { return JSON.parse(JSON.stringify({ ...toRaw(runManifest.value), complete: snapshot.value?.index === snapshot.value?.total, result: toRaw(snapshot.value), trades: toRaw(allLogs.value), events: toRaw(snapshot.value?.allEvents || snapshot.value?.recentEvents || []), eventsComplete: Boolean(snapshot.value?.allEvents) })); }
async function persistCompletedRun() {
  if (!runManifest.value || savedRunId === runManifest.value.id) return;
  const report = makeReport(); savedRunId = report.id;
  try { await saveRun(report); await refreshRuns(); }
  catch { ElMessage.warning('浏览器无法保存回放结果，请使用导出完整报告'); }
}
function exportReport(report: any) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a'); a.href = url; a.download = `${report.strategyId}-${report.settings.symbol}-${report.id}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function exportSavedRun(id: string) { try { const report = await getRun(id); if (report) exportReport(report); else ElMessage.warning('结果不存在'); } catch { ElMessage.error('读取回放结果失败'); } }
const router = useRouter();
function goBack() {
  send('pause');
  if (props.embedded) emit('back');
  else { try { localStorage.setItem('whale-tracker:side-tab', 'strategy'); } catch {} void router.push('/'); }
}
let worker = createReplayWorker();
const symbol = ref('XAUUSDT');
const margin = ref(1000); const leverage = ref(3); const takerFeePct = ref(0.05);
const makerFeePct = ref(0.02), weekMinPct = ref(1), stopPct = ref(30), takeProfitPct = ref(1);
const tiers = ref(DEFAULT_TIERS.map(t=>({...t})));
const riskUsdt = ref(100), slippagePct = ref(0.05), maxHoldHours = ref(24); const tickSize = ref(0.01); const qtyStep = ref(0.001);
const walletBalance = ref(40000);
const candleName = ref(''); const fundingName = ref(''); const candles = ref<Candle[]>([]); const funding = ref<{ t: number; rate: number; price?: number }[]>([]);
const candleError = ref(''); const fundingError = ref(''); const status = ref('请导入分钟K线数据'); const snapshot = ref<Snapshot | null>(null);
const speed = ref(20); const ready = ref(false); const isPlaying = ref(false); const allLogs = ref<LogRow[]>([]);
watch(speed, (value) => { if (isPlaying.value) worker.postMessage({ type: 'speed', speed: value }); });
const templatesVisible = ref(false);
const peakFillVisible = ref(false); const peakFillContext = ref<PeakContext | null>(null);
function openPeakFills() { peakFillContext.value = null; peakFillVisible.value = true; worker.postMessage({ type: 'peak-fills', side: 'long' }); }
const fileBusy = ref(false);
const savedDatasets = ref<ReplayDatasetSummary[]>([]); const historyBusy = ref(false); const loadingHistoryId = ref('');
let candleFile: Blob | null = null; let fundingFile: Blob | null = null; let loadedHistoryId = '';
let saveCandidate: ReplayDataset | null = null; let warmupFailed = false;
const warmupVisible = ref(false); const warmupProgress = ref(0); const warmupStage = ref('准备回放数据…');
let warmupCloseTimer: number | undefined;
let chunkAckTimer: number | undefined;
const transferState = { rows: [] as Candle[], offset: 0, chunkSize: 4_000, settings: null as any, funding: [] as { t: number; rate: number; price?: number }[] };
const symbolDefaults = computed(() => symbol.value === 'XAUUSDT' ? { margin: 1000, leverage: 3, tick: 0.01 } : symbol.value === 'XAGUSDT' ? { margin: 1000, leverage: 3, tick: 0.001 } : { margin: 1000, leverage: 3, tick: 0.01 });
const maxMargin = computed(() => walletBalance.value);
const progress = computed(() => Math.min(100, Math.round((snapshot.value?.progress || 0) * 100)));
const filteredLogs = computed(() => [...allLogs.value].reverse());
const chartPath = computed(() => {
  const rows = snapshot.value?.candles || []; if (!rows.length) return '';
  const min = Math.min(...rows.map((x) => x.l)); const max = Math.max(...rows.map((x) => x.h)); const span = max - min || 1;
  return rows.map((row, i) => `${i ? 'L' : 'M'} ${(i / Math.max(1, rows.length - 1)) * 1000} ${250 - ((row.c - min) / span) * 230}`).join(' ');
});
const chartMinMax = computed(() => { const rows = snapshot.value?.candles || []; return rows.length ? { min: Math.min(...rows.map((x) => x.l)), max: Math.max(...rows.map((x) => x.h)) } : null; });

async function pickFile(kind: 'candles' | 'funding', event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0]; if (!file || fileBusy.value || historyBusy.value) return;
  if (warmupVisible.value) { (event.target as HTMLInputElement).value = ''; return; }
  fileBusy.value = true;
  worker.terminate(); worker = createReplayWorker(); bindWorker();
  isPlaying.value = false; ready.value = false; snapshot.value = null; allLogs.value = []; runManifest.value = null;
  try {
    const text = await file.text();
    if (kind === 'candles') {
      candleError.value = '';
      try {
        const parsed = parseCandles(text); const detected = guessSymbol(file.name, text); const embedded = embeddedFunding(text);
        worker.postMessage({ type: 'stop' }); isPlaying.value = false;
        candles.value = parsed; candleName.value = file.name; candleFile = file; loadedHistoryId = '';
        if (detected) {
          if (symbol.value !== detected) { funding.value = []; fundingName.value = ''; fundingFile = null; }
          symbol.value = detected; resetDefaults();
        }
        funding.value = embedded || []; fundingName.value = embedded ? 'K 线文件内资金费率' : ''; fundingFile = null;
        runManifest.value = null; snapshot.value = null; ready.value = false; allLogs.value = [];
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
  finally { fileBusy.value = false; (event.target as HTMLInputElement).value = ''; }
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
    if (candleFile === candidate.candleFile && fundingFile === candidate.fundingFile) loadedHistoryId = candidate.id;
    await refreshHistory();
  } catch { ElMessage.warning('回放已就绪，但浏览器未能保存本地历史；请保留原始 CSV'); }
}
async function loadSavedDataset(item: ReplayDatasetSummary) {
  if (historyBusy.value || fileBusy.value) return;
  historyBusy.value = true; loadingHistoryId.value = item.id;
  try {
    const record = await getReplayDataset(item.id);
    if (!record) throw new Error('本地数据已不存在，请刷新历史列表');
    const [candleText, fundingText] = await Promise.all([record.candleFile.text(), record.fundingFile?.text() || Promise.resolve('')]);
    // Parse both files before changing the current selection, so a damaged
    // funding CSV cannot leave candles and funding from different sessions.
    const parsedCandles = parseCandles(candleText);
    const parsedFunding = record.fundingFile ? parseFunding(fundingText) : embeddedFunding(candleText) || [];
    worker.postMessage({ type: 'stop' }); isPlaying.value = false;
    candles.value = parsedCandles; funding.value = parsedFunding;
    candleName.value = record.candleName; fundingName.value = record.fundingName;
    candleFile = record.candleFile; fundingFile = record.fundingFile; loadedHistoryId = record.id;
    symbol.value = record.symbol; resetDefaults();
    if (record.settings?.version === strategy.value.version) { margin.value = record.settings.margin; leverage.value = record.settings.leverage; walletBalance.value = record.settings.walletBalance || 40000;
      takerFeePct.value = record.settings.takerFeePct ?? 0.05; makerFeePct.value = record.settings.makerFeePct ?? .02; weekMinPct.value = record.settings.weekMinPct ?? 1; stopPct.value = record.settings.stopPct ?? 30; takeProfitPct.value = record.settings.takeProfitPct ?? 1; tiers.value = (record.settings.tiers || DEFAULT_TIERS).map(t=>({...t})); riskUsdt.value = record.settings.riskUsdt ?? 100; slippagePct.value = record.settings.slippagePct ?? 0.05; maxHoldHours.value = record.settings.maxHoldHours ?? 24; tickSize.value = record.settings.tickSize; qtyStep.value = record.settings.qtyStep;
      }
    snapshot.value = null; ready.value = false; allLogs.value = []; candleError.value = ''; fundingError.value = '';
    status.value = `已载入历史回放：${record.symbol} · ${parsedCandles.length.toLocaleString()} 根K线 · ${parsedFunding.length.toLocaleString()} 条资金费`;
    await startReplay();
  } catch (err) { ElMessage.error(err instanceof Error ? err.message : '载入本地文件失败'); }
  finally { historyBusy.value = false; loadingHistoryId.value = ''; }
}
async function removeSavedDataset(item: ReplayDatasetSummary) {
  if (historyBusy.value || fileBusy.value) return;
  try { await ElMessageBox.confirm(`从当前浏览器删除「${item.symbol} · ${item.candleName}」及配套资金费？请确认你仍保留原始 CSV。`, '删除本地历史', { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' }); }
  catch { return; }
  historyBusy.value = true;
  try { await deleteReplayDataset(item.id); await refreshHistory(); if (loadedHistoryId === item.id) loadedHistoryId = ''; ElMessage.success('已从本地历史删除；当前已载入的数据仍可继续回放'); }
  catch (err) { ElMessage.error(err instanceof Error ? err.message : '删除本地文件失败'); }
  finally { historyBusy.value = false; }
}
function fileSize(bytes: number) { return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`; }
onMounted(() => { void refreshHistory(); void refreshRuns(); });
function resetDefaults() { margin.value = symbolDefaults.value.margin; leverage.value = symbolDefaults.value.leverage; tickSize.value = symbolDefaults.value.tick; takerFeePct.value = .05; slippagePct.value = .05; riskUsdt.value = 100; maxHoldHours.value = 24; makerFeePct.value = .02; weekMinPct.value = 1; stopPct.value = 30; takeProfitPct.value = 1; tiers.value = DEFAULT_TIERS.map(t=>({...t})); }
async function startReplay() {
  symbol.value = symbol.value.trim().toUpperCase();
  if (!symbol.value) { status.value = '请填写回放标的'; return; }
  if (candles.value.length < strategy.value.minimum) { status.value = `该策略至少需要 ${strategy.value.minimum.toLocaleString()} 根连续分钟K线`; return; }
  let runSettings;
  try { runSettings = { symbol:symbol.value, marginUsdt:margin.value, leverage:leverage.value, walletBalance:walletBalance.value,
    makerFee:makerFeePct.value/100, takerFee:takerFeePct.value/100, slippage:slippagePct.value/100, tickSize:tickSize.value, qtyStep:qtyStep.value,
    riskUsdt:riskUsdt.value,maxHoldHours:maxHoldHours.value,weekMinPct:weekMinPct.value,stopPct:stopPct.value,takeProfitPct:takeProfitPct.value,tiers:tiers.value.map(t=>({...t})) };
    validateSettings(runSettings);
  } catch(error) { ElMessage.warning(error instanceof Error ? error.message : '参数无效'); return; }
  saveCandidate = candleFile && !loadedHistoryId ? { id: newId(), symbol: symbol.value, candleName: candleName.value,
    fundingName: fundingName.value, candleRows: candles.value.length, fundingRows: funding.value.length,
    start: candles.value[0].t, end: candles.value.at(-1)!.t, size: candleFile.size + (fundingFile?.size || 0), savedAt: Date.now(),
    settings: { strategyId: strategyId.value, makerFeePct:makerFeePct.value, weekMinPct:weekMinPct.value, stopPct:stopPct.value, takeProfitPct:takeProfitPct.value, tiers:tiers.value.map(t=>({...t})), version: strategy.value.version, riskUsdt: riskUsdt.value, slippagePct: slippagePct.value, maxHoldHours: maxHoldHours.value, margin: margin.value, leverage: leverage.value, takerFeePct: takerFeePct.value, tickSize: tickSize.value, qtyStep: qtyStep.value, walletBalance: walletBalance.value },
    candleFile, fundingFile } : null;
  worker.terminate(); worker = createReplayWorker(); bindWorker();
  snapshot.value = null; allLogs.value = []; ready.value = false; isPlaying.value = false; warmupFailed = false;
  if (warmupCloseTimer) window.clearTimeout(warmupCloseTimer);
  warmupVisible.value = true; warmupProgress.value = 1; warmupStage.value = '准备回放参数…'; status.value = '正在准备策略回放…';
  try {
    const rows = toRaw(candles.value);
    transferState.rows = rows; transferState.offset = 0; transferState.settings = { ...runSettings, rules: { ...LADDER_RULES } }; transferState.funding = toRaw(funding.value);
    runManifest.value = { id: newId(), strategyId: strategy.value.id, strategyName: strategy.value.name, version: strategy.value.version, createdAt: new Date().toISOString(), settings: { ...transferState.settings }, data: { candleName: candleName.value, candleBytes: candleFile?.size || null, fundingName: fundingName.value || null, fundingBytes: fundingFile?.size || null, rows: rows.length, fundingRows: funding.value.length, start: rows[0].t, end: rows.at(-1)!.t }, accounting: { drawdown: '每分钟收盘权益峰谷，非分钟内或清算回撤', funding: funding.value.length ? '结算时标记价优先，缺失时以该分钟开盘价代理；先结算原有仓位再开平仓' : '未提供资金费，不代表真实资金费为零', terminal: '末尾未平仓按收盘价计浮盈，不强平', execution: 'UTC日开盘挂分档限价，穿价1Tick成交；同分钟按不利方向依次补仓再止损，新成交当分钟不止盈；入场Maker费，退出Taker费和滑点', limitations: '没有逐笔路径和交易所维持保证金清算模型；计划风险不保证覆盖跳空或资金费；交易量/最小名义规则需另核对' } };
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
watch(() => props.active, (active) => { if (!active) send('pause'); });
function onWorker(event: MessageEvent) {
  if (event.currentTarget !== worker) return;
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
    if (event.data.payload.index >= event.data.payload.total) { isPlaying.value = false; status.value = '回放完成'; void persistCompletedRun(); }
  }
  if (event.data.type === 'export') allLogs.value = event.data.payload;
  if (event.data.type === 'peak-fills' && event.data.side === 'long') peakFillContext.value = event.data.payload;
}
function bindWorker() {
worker.addEventListener('message', onWorker);
worker.addEventListener('error', (event) => {
  if (event.currentTarget !== worker) return;
  saveCandidate = null; warmupFailed = true;
  if (chunkAckTimer) window.clearTimeout(chunkAckTimer); chunkAckTimer = undefined;
  warmupVisible.value = false; ready.value = false; isPlaying.value = false;
  status.value = `回放引擎启动失败：${event.message || event.filename || 'Worker 模块加载异常（请刷新页面重试）'}`;
});
worker.addEventListener('message', (event) => {
  if (event.currentTarget !== worker || event.data.type !== 'replay-error') return;
  saveCandidate = null; warmupFailed = true;
  if (chunkAckTimer) window.clearTimeout(chunkAckTimer); chunkAckTimer = undefined;
  warmupVisible.value = false; ready.value = false; isPlaying.value = false;
  status.value = `回放失败：${event.data.message || '数据传输异常'}`;
});
}
bindWorker();
function downloadReport() {
  if (!runManifest.value || !snapshot.value) return;
  exportReport(makeReport());
}
function downloadLogs() {
  const esc = (s: unknown) => `"${String(s ?? '').replaceAll('"', '""')}"`;
  const lines = [['开仓时间', '平仓时间', '方向', '标的', '开仓均价', '平仓价格', '平仓净盈亏', '资金费', '手续费', '退出原因', '计划风险', '固定止损', '回归目标', '事件ID'].map(esc).join(',')];
  for (const row of allLogs.value) lines.push([new Date(row.openedAt).toISOString(), new Date(row.closedAt).toISOString(), row.side === 'long' ? '多' : '空', row.symbol, row.openPrice, row.closePrice, row.pnl, row.funding, row.fee, row.reason, row.plannedRisk, row.stop, row.target, row.event?.id].map(esc).join(','));
  const blob = new Blob(['\uFEFF' + lines.join('\n')], { type: 'text/csv;charset=utf-8' }); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = `${runManifest.value?.strategyId || strategyId.value}-${snapshot.value?.symbol || symbol.value}-${Date.now()}.csv`; a.click(); URL.revokeObjectURL(url);
}
function clock(value: number) { return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—'; }
function rangePhaseName(phase: string) { return ({ 'daily-ladder': '日内分档', event: '事件回归', overheat: '上涨过热', bottom_watch: '回落观察', bottom_confirmed: '底部确认', normal: '常规' } as Record<string, string>)[phase] || phase; }
function number(value: number | null | undefined, digits = 2) { return Number(value || 0).toLocaleString('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits }); }
function pnlClass(value: number) { return value >= 0 ? 'positive' : 'negative'; }
onBeforeUnmount(() => { if (warmupCloseTimer) window.clearTimeout(warmupCloseTimer); if (chunkAckTimer) window.clearTimeout(chunkAckTimer); worker.postMessage({ type: 'stop' }); worker.removeEventListener('message', onWorker); worker.terminate(); });
</script>

<template>
  <main class="replay-page" :class="{ embedded: props.embedded }">
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
            <small>读取时间、open、high、low、close、volume；如有 funding_rate 列，也会导入非零资金费记录。资金费优先使用 mark_price，缺失时以该分钟开盘价代理。也可使用简化表头：timestamp,open,high,low,close,volume。时间可填 ISO 时间（需带时区）或 Unix 毫秒；按时间升序，每行一根 1 分钟 K 线，时间不可重复或缺失，至少 10,081 行；须积累此前七根完整 UTC 日线后才挂单，文件开头的不完整日线不计。</small>
          </article>
          <article class="template-block">
            <h3>资金费率 CSV</h3>
            <pre>timestamp,fundingRate
2026-03-01T00:00:00.001+08:00,0.0001
2026-03-01T08:00:00.001+08:00,-0.00005
2026-03-01T16:00:00.001+08:00,0.00008</pre>
            <small>每行一笔结算记录，按时间升序。费率填小数而非百分数：0.0001 表示 0.01%，-0.00005 表示 -0.005%。正费率时多头付、空头收；负费率相反。资金费文件可选；单独导入会覆盖 K 线文件内的资金费。不要把费率前向填充到每一分钟。</small>
          </article>
          <article class="template-block">
            <h3>生成文件前请检查</h3>
            <small>CSV 建议使用 UTF-8 编码，保留表头；价格和成交量使用数字，不要加千分位逗号或货币符号。每根 K 线的 high 应不低于 open、close、low；low 应不高于 open、close、high。时间统一用带时区 ISO 格式或毫秒时间戳，避免混用秒和毫秒。</small>
          </article>
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
              <span>{{ fill.purpose === 'open' ? `首次建仓 · 第 ${fill.tierStart} 档` : fill.tierStart === fill.tierEnd ? `第 ${fill.tierStart} 档` : `第 ${fill.tierStart}–${fill.tierEnd} 档` }}<small>{{ fill.label }}</small></span>
              <time>{{ clock(fill.time) }}</time><span>{{ number(fill.price, 3) }}</span><span>{{ number(fill.qty, 4) }}</span><b>{{ number(fill.margin) }} U</b>
            </div>
          </div>
        </div>
      </section>
    </div>
    <header class="topbar">
      <button class="back" @click="goBack"><el-icon><ArrowLeft /></el-icon> 返回策略</button>
      <div class="brand"><span class="brand-dot"></span><div><strong>{{ strategy.name }} · 回放</strong><small>{{ strategy.subtitle }} · 本地历史模拟</small></div></div>
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
          <label class="file-drop"><input type="file" :disabled="warmupVisible || historyBusy || fileBusy" accept=".csv,.txt" @change="pickFile('candles', $event)"><el-icon><Upload /></el-icon><b>{{ candleName || '导入 1 分钟 K 线' }}</b><small>timestamp, open, high, low, close, volume</small></label>
          <p v-if="candleError" class="error">{{ candleError }}</p>
          <div class="file-ok" v-else-if="candles.length">{{ candles.length.toLocaleString() }} 根 · {{ clock(candles[0].t) }} — {{ clock(candles.at(-1)!.t) }}</div>
          <label class="field-label">资金费 CSV <span>可选</span></label>
          <label class="file-drop compact"><input type="file" :disabled="warmupVisible || historyBusy || fileBusy" accept=".csv,.txt" @change="pickFile('funding', $event)"><el-icon><Upload /></el-icon><b>{{ fundingName || '导入历史资金费' }}</b><small>timestamp, fundingRate（小数）</small></label>
          <p v-if="fundingError" class="error">{{ fundingError }}</p>
          </div>
          <div class="sidebar-section">
          <div class="section-title"><span>02</span> 策略参数</div>
          <label class="field-label">整个事件保证金预算 <small>U · 上限 {{ maxMargin }}</small></label>
          <div class="input-row"><input v-model.number="margin" type="number" min="0.1" :max="maxMargin" step="0.5"><span>USDT（上限 {{ maxMargin }}）</span></div>
          <label class="field-label">周度方向阈值 <small>此前七根完整 UTC 日线</small></label><div class="input-row"><input v-model.number="weekMinPct" type="number" min="0" max="100" step="0.1"><span>%</span></div>
          <div v-for="(tier,i) in tiers" :key="i" class="two-inputs"><div><label class="field-label">第 {{i+1}} 档当日涨跌幅</label><div class="input-row"><input v-model.number="tier.movePct" type="number" min="0.1" max="90" step="0.5"><span>%</span></div></div><div><label class="field-label">累计预算比例</label><div class="input-row"><input v-model.number="tier.allocationPct" type="number" min="1" max="100" step="1"><span>%</span></div></div></div>
          <p class="import-hint">比例同时限制累计保证金与计划风险。已投入额度扣除后才补；每档最多成交一次，不将各档全额相加。</p>
          <label class="field-label">止损幅度 <small>首次事件日开盘参考，须超过最高档</small></label><div class="input-row"><input v-model.number="stopPct" type="number" min="1" max="94" step="1"><span>%</span></div>
          <label class="field-label">整体净止盈 <small>相对累计入场名义本金，含费用/资金费</small></label><div class="input-row"><input v-model.number="takeProfitPct" type="number" min="0.01" max="30" step="0.1"><span>%</span></div>
          <label class="field-label">限价入场 Maker 费率</label><div class="input-row"><input v-model.number="makerFeePct" type="number" min="0" max="5" step="0.001"><span>%</span></div>
          <label class="field-label">杠杆</label>
          <div class="input-row"><input v-model.number="leverage" type="number" min="1" max="10" step="1"><span>×</span></div>
          <div class="two-inputs"><div><label class="field-label">Taker 费率</label><div class="input-row"><input v-model.number="takerFeePct" type="number" min="0" step="0.001"><span>%</span></div></div><div><label class="field-label">价格 Tick</label><div class="input-row"><input v-model.number="tickSize" type="number" min="0.000001" step="0.01"></div></div></div>
          <div class="two-inputs"><div><label class="field-label">数量步进</label><div class="input-row"><input v-model.number="qtyStep" type="number" min="0.000001" step="0.001"></div></div><div><label class="field-label">撮合约定</label><div class="fixed-value">限价穿价 1 Tick</div></div></div>
          </div>
          <div class="sidebar-section">
          <div class="section-title"><span>03</span> 模拟账户</div>
          <label class="field-label">单事件计划风险上限</label><div class="input-row"><input v-model.number="riskUsdt" type="number" min="0.01" step="1"><span>USDT</span></div>
          <label class="field-label">退出不利滑点</label><div class="input-row"><input v-model.number="slippagePct" type="number" min="0" max="5" step="0.01"><span>%</span></div>
          <label class="field-label">最长持仓时间</label><div class="input-row"><input v-model.number="maxHoldHours" type="number" min="1" max="168" step="1"><span>小时</span></div>
          <label class="field-label">模拟账户权益 <small>单事件风险不超过权益 1%</small></label>
          <div class="input-row"><input v-model.number="walletBalance" type="number" min="1" step="100"><span>USDT</span></div>
          <div class="start-actions"><button class="start-button" :disabled="!candles.length || warmupVisible || historyBusy || fileBusy" @click="startReplay"><el-icon><VideoCamera /></el-icon> {{ ready ? '重新开始回放' : '载入并开始' }}</button></div>
          </div>
          <div class="sidebar-section history-section">
          <div class="history-box">
            <div class="history-heading"><b><span class="section-number">04</span> 本地数据历史</b><span>{{ savedDatasets.length }} 组回放</span></div>
            <p v-if="!savedDatasets.length" class="history-empty">回放准备成功后，K 线与资金费会合并保存为一条记录。</p>
            <div v-for="item in savedDatasets" :key="item.id" class="history-item">
              <div class="history-detail"><strong :title="item.candleName">{{ item.symbol }} · {{ item.candleName }}</strong><small :title="item.fundingName">资金费：{{ item.fundingName || '未导入' }}（{{ item.fundingRows.toLocaleString() }} 条）</small><small>K 线 {{ item.candleRows.toLocaleString() }} 根 · {{ fileSize(item.size) }}</small><small>{{ clock(item.start) }} — {{ clock(item.end) }}</small><small>保存于 {{ clock(item.savedAt) }}</small></div>
              <div class="history-actions"><button type="button" :disabled="historyBusy || warmupVisible || fileBusy" @click="loadSavedDataset(item)">{{ loadingHistoryId === item.id ? '载入中' : '载入并开始' }}</button><button type="button" class="danger" :disabled="historyBusy || warmupVisible || fileBusy" :aria-label="`删除 ${item.symbol} 回放`" @click="removeSavedDataset(item)">删除</button></div>
            </div>
            <small class="history-note">仅保存在当前浏览器；清除网站数据可能删除记录，请保留原始 CSV。</small>
          </div>
          <div class="import-hint">支持任意标的分钟线；文件名或 CSV 标的列可自动识别。XAU/XAG 使用预设参数，其他标的请核对价格 Tick、数量步进、费率和保证金参数。回放仅在当前浏览器运行。</div>
          </div>
        </section>
        <section v-if="savedRuns.length" class="card rules-card"><div class="section-title">已完成回放 · 最近 10 次</div><div v-for="run in savedRuns.slice(0,10)" :key="run.id" class="history-item"><div class="history-detail"><strong>{{run.strategyName}} · {{run.symbol}}</strong><small>{{run.version}} · {{new Date(run.createdAt).toLocaleString()}}</small><small>净盈亏 {{number(run.net)}} U</small></div><button class="inline-action" @click="exportSavedRun(run.id)">导出</button></div><small class="history-note">完整结果保存在当前浏览器，可导出留存。</small></section>
        <section class="card rules-card">
          <div class="section-title"><span>05</span> 策略规则快照</div>
          <div class="rule-line"><b>方向</b><span>此前七根完整 UTC 日线：最后收盘 / 第一根开盘 − 1。周跌优先多、周涨优先空，未达到阈值则空仓；不使用当天收盘选择方向。</span></div>
          <div class="rule-line"><b>挂单</b><span>以当天开盘为基准，按设置的单日跌幅买入或涨幅卖出。按累计比例配置保证金和风险额度，限价须穿过 1 Tick 才模拟成交。</span></div>
          <div class="rule-line"><b>补仓</b><span>仅补更深且未成交的档位；同档不重复，跳档不叠加完整额度。只持一侧。周度方向反转或中性时暂停补仓，不自动反手。</span></div>
          <div class="rule-line"><b>换日</b><span>撤销昨日未成交挂单，参考价重算；已有仓位的累计预算、已成交档位、止损和首次入场时间均保留。</span></div>
          <div class="rule-line"><b>退出</b><span>整体扣费后止盈、固定事件止损或持仓到期退出。退出后当日不再开仓，次日重新判断。</span></div>
          <div class="rule-warning">至少需要此前七根完整日线。当前参数是研究示例；未模拟订单队列、流动性或交易所清算。跳空/资金费可能超过计划风险。同分钟多档穿越按不利路径依次补仓后止损，新成交当分钟不假定获利退出。AI 旁路不参与执行。</div>
        </section>
      </aside>
      <section class="workspace">
        <p class="import-hint">{{ (runManifest?.data.fundingRows ?? funding.length) ? `已载入 ${runManifest?.data.fundingRows ?? funding.length} 条资金费记录，请确认覆盖回放区间。` : '未导入资金费：当前结果不含资金费成本。' }} 参数修改需重新载入才能生效；导出报告采用运行时锁定的参数。</p>
        <div class="summary-row">
          <article class="metric-card"><span>账户权益 / 最大回撤</span><strong>{{ snapshot ? number(snapshot.equity) : '—' }} U</strong><small>最大回撤 {{ snapshot ? number(snapshot.maxDrawdown) : '—' }} U · {{ snapshot ? number(snapshot.maxDrawdownPct) : '—' }}%</small><small>逐分钟收盘权益，包含已实现与浮动盈亏</small></article>
          <article class="metric-card"><span>当前价格</span><strong>{{ snapshot?.index ? number(snapshot.price) : '—' }}</strong><small>{{ snapshot?.symbol || symbol }}</small></article>
          <article class="metric-card"><span>已实现盈亏</span><strong class="realized-amount"><span class="realized-main" :class="pnlClass(snapshot?.realized || 0)">{{ snapshot ? number(snapshot.realized) : '—' }} U</span><em class="funding-inline" :class="pnlClass(snapshot?.realizedFunding || 0)">（{{ snapshot && snapshot.realizedFunding > 0 ? '+' : '' }}{{ snapshot ? number(snapshot.realizedFunding) : '—' }} U）</em></strong><div class="realized-sides"><span>多 <b :class="pnlClass(snapshot?.realizedBySide?.long || 0)">{{ snapshot ? number(snapshot.realizedBySide.long) : '—' }} U</b></span><span>空 <b :class="pnlClass(snapshot?.realizedBySide?.short || 0)">{{ snapshot ? number(snapshot.realizedBySide.short) : '—' }} U</b></span></div><small>已平仓净盈亏（括号内为资金费）</small></article>
          <article class="metric-card floating-pnl-card"><span>当前浮动盈亏</span><strong :class="pnlClass(snapshot?.unrealized || 0)">{{ snapshot ? number(snapshot.unrealized) : '—' }} <em>U</em></strong><small>多空合计</small></article>
          <article class="metric-card loss-peak-card"><span>亏损峰值（多 / 空 / 总）</span><div><b>多 {{ snapshot ? `-${number(snapshot.maxLossPeak.long)}` : '—' }} U</b><b>空 {{ snapshot ? `-${number(snapshot.maxLossPeak.short)}` : '—' }} U</b><b class="total">总 {{ snapshot ? `-${number(snapshot.maxLossPeak.total)}` : '—' }} U</b></div><small>总亏损为同一时点多空合计浮亏峰值</small><div v-if="snapshot" class="peak-times"><span>多 {{ clock(snapshot.lossPeakContext?.long?.time || 0) }}</span><span>空 {{ clock(snapshot.lossPeakContext?.short?.time || 0) }}</span><span>总 {{ clock(snapshot.totalLossPeakTime || 0) }}</span></div><details v-if="snapshot?.lossPeakContext?.long" class="peak-detail"><summary>查看多头峰值发生时的状态</summary><p>时间 {{ clock(snapshot.lossPeakContext.long.time) }} · 价格 {{ number(snapshot.lossPeakContext.long.price, 3) }} · 均价 {{ number(snapshot.lossPeakContext.long.entryPrice, 3) }} <button type="button" class="peak-fill-link" @click="openPeakFills">详情</button></p><p>{{ rangePhaseName(snapshot.lossPeakContext.long.phase) }} · 已补 {{ snapshot.lossPeakContext.long.additions }} 次 · 仓位保证金 {{ number(snapshot.lossPeakContext.long.margin) }} U</p></details></article>
          <article class="metric-card distribution-card"><span>平仓收益分布</span><strong>≥10U {{ snapshot?.positionDistribution.large ?? '—' }} <em>/</em> 0–10U {{ snapshot?.positionDistribution.small ?? '—' }}</strong><small>按每笔盈利平仓的净盈亏计数；不代表累计收益</small></article>
        </div>
        <section class="card special-review"><div class="panel-heading"><div class="section-title">周度背景与日内分档</div><small>单向持仓 · 累计预算 · 跨日不重置</small></div><div class="special-review-grid"><div><span>七日涨跌 / 当日方向</span><b>{{ snapshot?.dailyContext?.weekPct == null ? '预热中' : number(snapshot.dailyContext.weekPct)+'%' }} · {{snapshot?.dailyContext?.bias === 'long' ? '做多观察' : snapshot?.dailyContext?.bias === 'short' ? '做空观察' : '空仓观察'}}</b><small>已完成 {{snapshot?.dailyContext?.completeDays ?? 0}} / 7 根日线，UTC 日切</small></div><div><span>日开盘 / 当前日涨跌</span><b>{{snapshot?.dailyContext?.dayOpen ? number(snapshot.dailyContext.dayOpen) : '—'}} / {{snapshot?.dailyContext?.dailyPct == null ? '—' : number(snapshot.dailyContext.dailyPct)+'%'}}</b><small>日涨跌不是日内最高最低振幅</small></div><div><span>观察事件 / 开仓 / 补仓</span><b>{{snapshot?.eventStats?.observations ?? 0}} / {{snapshot?.eventStats?.opened ?? 0}} / {{snapshot?.eventStats?.additions ?? 0}}</b><small>预算过滤 {{snapshot?.eventStats?.skipped ?? 0}} · 撤销未成交档位 {{snapshot?.eventStats?.canceled ?? 0}}</small></div><div><span>保证金峰值 / 已平仓</span><b>{{number(snapshot?.marginPeak)}} U / {{snapshot?.eventStats?.closed ?? 0}}</b><small>每档一次；不同时持有多空</small></div></div>
          <details v-if="snapshot?.recentEvents?.length"><summary>最近 20 个事件、撤单与预算过滤原因</summary><article v-for="event in snapshot.recentEvents" :key="event.id"><p>{{clock(event.t)}} · {{event.side === 'long' ? '做多' : '做空'}} · {{event.status}} · {{event.reason || '等待成交 / 持仓管理'}} · 预算 {{number(event.marginBudget)}} U / 风险 {{number(event.riskBudget)}} U</p><small v-for="(reason,i) in event.skips" :key="i">{{reason}}<br></small></article></details>
        </section>
        <section class="card chart-card">
          <div class="panel-heading"><div><div class="section-title"><span>03</span> 分钟走势与策略状态</div><div class="subheading">{{ snapshot?.index ? clock(snapshot.time) : '导入数据后开始回放' }} <i v-if="snapshot">·</i> {{ snapshot?.state || '等待数据' }}</div></div><div class="chart-meta" v-if="chartMinMax"><span>H {{ number(chartMinMax.max) }}</span><span>L {{ number(chartMinMax.min) }}</span></div></div>
          <div class="chart-wrap"><svg viewBox="0 0 1000 260" preserveAspectRatio="none" aria-label="分钟收盘价走势"><defs><linearGradient id="chart-fill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#27c99b" stop-opacity=".2"/><stop offset="1" stop-color="#27c99b" stop-opacity="0"/></linearGradient></defs><path v-if="chartPath" :d="`${chartPath} L 1000 260 L 0 260 Z`" fill="url(#chart-fill)"/><path v-if="chartPath" :d="chartPath" fill="none" stroke="#26c99a" stroke-width="2.2" vector-effect="non-scaling-stroke"/><text v-if="!chartPath" x="500" y="132" text-anchor="middle" fill="#69798c" font-size="14">导入连续的分钟 K 线后查看回放图表</text></svg><div class="chart-grid"><i></i><i></i><i></i><i></i></div></div>
          <div class="progress-meta"><span>{{ snapshot ? `${snapshot.index.toLocaleString()} / ${snapshot.total.toLocaleString()} 分钟` : '回放进度' }}</span><span>{{ progress }}%</span></div><div class="progress-track"><i :style="{ width: `${progress}%` }"></i></div>
          <div class="player"><button class="icon-button" :disabled="!ready || isPlaying" title="单步前进一分钟" @click="send('step')"><el-icon><CaretRight /></el-icon><span>单步</span></button><button class="play-button" :disabled="!ready" @click="send(isPlaying ? 'pause' : 'play')"><el-icon><component :is="isPlaying ? VideoPause : VideoPlay" /></el-icon>{{ isPlaying ? '暂停' : '播放' }}</button><button class="icon-button" :disabled="!ready || !isPlaying" @click="send('pause')">停止</button><label>速度<select v-model.number="speed"><option :value="10">10×</option><option :value="20">20×</option><option :value="50">50×</option><option :value="100">100×</option><option :value="200">200×</option><option :value="500">500×</option></select><small>每秒 {{ speed * 20 }} 分钟</small></label><span class="player-spacer"></span><button class="export-button" :disabled="!ready || !snapshot" @click="downloadReport">导出完整报告</button><button class="export-button" :disabled="!allLogs.length" @click="downloadLogs"><el-icon><Download /></el-icon> 导出平仓记录</button></div>
        </section>
        <section class="position-grid">
          <article v-for="side in (['long', 'short'] as const)" :key="side" class="card position-card" :class="side"><header><div><i></i><b>{{ side === 'long' ? '多头仓位' : '空头仓位' }}</b></div><span>单向 · 已补 {{snapshot?.positions[side]?.adds ?? 0}} 次</span></header><div v-if="snapshot?.positions[side]" class="position-data"><strong :class="pnlClass(snapshot.positions[side].pnl)">{{ number(snapshot.positions[side].pnl) }} U</strong><div class="position-opened-at"><small>开仓时间</small><b>{{ clock(snapshot.positions[side].openedAt) }}</b></div><div class="position-cols"><div><small>事件止损 / 净止盈价</small><b>{{ number(snapshot.positions[side].stop, 3) }} / {{ number(snapshot.positions[side].target, 3) }}</b></div><div><small>计划风险</small><b>{{ number(snapshot.positions[side].plannedRisk) }} U</b></div><div><small>持仓均价</small><b>{{ number(snapshot.positions[side].avg, 3) }}</b></div><div><small>名义价值</small><b>{{ number(snapshot.positions[side].notional) }} U</b></div><div><small>保证金</small><b>{{ number(snapshot.positions[side].margin) }} U</b></div><div><small>持仓数量</small><b>{{ number(snapshot.positions[side].qty, 4) }}</b></div></div></div><div v-else class="position-empty">当前无{{ side === 'long' ? '多头' : '空头' }}仓位</div><details v-if="snapshot?.positions[side]?.fills?.length"><summary>查看每档成交与累计额度</summary><p v-for="(fill,i) in snapshot.positions[side].fills" :key="i">{{clock(fill.time)}} · {{fill.label}} · {{number(fill.price,3)}} × {{number(fill.qty,4)}} · 本笔 {{number(fill.margin)}} U / 累计 {{number(fill.cumulativeMargin)}} U</p></details><div v-if="snapshot?.orders[side]" class="pending-order">委托中 · {{ snapshot.orders[side].purpose === 'close' ? '止盈' : snapshot.orders[side].purpose === 'add' ? '补仓' : '开仓' }} {{ snapshot.orders[side].price == null ? '市价待定' : number(snapshot.orders[side].price, 3) }} <small>{{ snapshot.orders[side].label }}</small></div></article>
        </section>
        <section class="card logs-card">
          <div class="panel-heading"><div><div class="section-title"><span>04</span> 仓位盈亏记录</div><div class="subheading">展示全部平仓记录，包含盈利、亏损和零收益</div></div><div class="log-toolbar"><span>{{ allLogs.length }} 条</span></div></div>
          <div class="log-head position-log-head"><span>开仓时间</span><span>开仓均价</span><span>平仓时间</span><span>平仓均价</span><span>平仓净盈亏</span><span>资金费</span></div>
          <div class="log-list"><article v-for="row in filteredLogs" :key="row.id" class="log-row position-log" :title="row.reason"><time><small :class="row.side === 'long' ? 'positive' : 'negative'">{{ row.side === 'long' ? '多' : '空' }}</small> {{ clock(row.openedAt) }}</time><span class="position-price">{{ number(row.openPrice, 3) }}</span><time>{{ clock(row.closedAt) }}</time><span class="position-price">{{ number(row.closePrice, 3) }}</span><b :class="pnlClass(row.pnl)">{{ number(row.pnl) }} U</b><span :class="pnlClass(row.funding)">{{ number(row.funding) }} U</span></article><div v-if="!filteredLogs.length" class="log-empty">仓位平仓后会在这里显示盈亏汇总</div></div>
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
.start-actions{display:flex;align-items:stretch;gap:7px;margin-top:17px}.start-actions .start-button{flex:1;min-width:0;margin-top:0}.special-review{padding:14px 16px}.special-review .panel-heading>small{color:#8195a9;font-size:10px}.special-review-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;margin-top:12px}.special-review-grid>div{padding:9px 11px;border-radius:7px;background:#0d1720}.special-review-grid span,.special-review-grid small{display:block;color:#8496a8;font-size:9px}.special-review-grid b{display:block;margin:5px 0;color:#dce7f1;font:600 14px ui-monospace,Consolas,monospace}.special-review-grid b.positive{color:var(--green)}.special-review-grid b.negative{color:var(--red)}@media(max-width:850px){.special-review-grid{grid-template-columns:repeat(2,1fr)}}@media(max-width:560px){.special-review-grid{grid-template-columns:1fr 1fr}}
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
.replay-page.embedded { height: 100%; min-height: 0; overflow: auto; }
.replay-page.embedded .layout { height: calc(100% - 60px); }
@media (max-width: 850px) { .replay-page.embedded .layout { height: auto; } }
</style>
