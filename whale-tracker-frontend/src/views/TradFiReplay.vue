<script setup lang="ts">
import { computed, onBeforeUnmount, ref, toRaw } from 'vue';
import { useRouter } from 'vue-router';
import { ArrowLeft, Download, Upload, VideoPlay, VideoPause, VideoCamera, CaretRight, InfoFilled } from '@element-plus/icons-vue';
import { ElMessage } from 'element-plus';

type Candle = { t: number; o: number; h: number; l: number; c: number; v: number };
type LogRow = { id: string; time: number; type: string; text: string; [key: string]: any };
type Snapshot = { index: number; total: number; progress: number; time: number; price: number; state: string; symbol: string; positions: Record<string, any>; orders: Record<string, any>; realized: number; realizedFunding: number; maxLossPeak: Record<'long' | 'short' | 'total', number>; fees: number; funding: number; unrealized: number; net: number; tradeCount: number; recentLogs: LogRow[]; logsTotal: number; candles: Candle[]; paused: boolean; market: any };

const router = useRouter();
const worker = new Worker(new URL('../tradfi-replay/replay.worker.ts', import.meta.url), { type: 'module' });
const symbol = ref('XAUUSDT');
const margin = ref(20); const leverage = ref(20); const makerFeePct = ref(0); const tickSize = ref(0.01); const qtyStep = ref(0.001);
const candleName = ref(''); const fundingName = ref(''); const candles = ref<Candle[]>([]); const funding = ref<{ t: number; rate: number }[]>([]);
const candleError = ref(''); const fundingError = ref(''); const status = ref('请导入分钟K线数据'); const snapshot = ref<Snapshot | null>(null);
const speed = ref(20); const ready = ref(false); const isPlaying = ref(false); const allLogs = ref<LogRow[]>([]);
const templatesVisible = ref(false);
const warmupVisible = ref(false); const warmupProgress = ref(0); const warmupStage = ref('准备回放数据…');
let warmupCloseTimer: number | undefined;
let chunkAckTimer: number | undefined;
const transferState = { rows: [] as Candle[], offset: 0, chunkSize: 4_000, settings: null as any, funding: [] as { t: number; rate: number }[] };
const symbolDefaults = computed(() => symbol.value === 'XAUUSDT' ? { margin: 20, leverage: 20, tick: 0.01 } : symbol.value === 'XAGUSDT' ? { margin: 10, leverage: 10, tick: 0.001 } : { margin: 20, leverage: 20, tick: 0.01 });
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
function parseCandles(text: string): Candle[] {
  const rows = readCsv(text); if (!rows.length) throw new Error('文件没有有效数据');
  const heads = rows[0].map((x) => x.trim().toLowerCase()); const hasHead = ['timestamp', 'time', 'datetime', 'open_time', 'open time', 'open_time_utc', 'open_time_ms'].some((h) => heads.includes(h));
  const data = hasHead ? rows.slice(1) : rows;
  const idx = hasHead ? { t: indexMap(heads, ['timestamp', 'time', 'datetime', 'open_time', 'open time', 'open_time_utc', 'open_time_ms'], 0), o: indexMap(heads, ['open', 'o'], 1), h: indexMap(heads, ['high', 'h'], 2), l: indexMap(heads, ['low', 'l'], 3), c: indexMap(heads, ['close', 'c'], 4), v: indexMap(heads, ['volume', 'vol', 'v'], 5) } : { t: 0, o: 1, h: 2, l: 3, c: 4, v: 5 };
  const out = data.map((r, i) => {
    const c = { t: parseTime(r[idx.t]), o: Number(r[idx.o]), h: Number(r[idx.h]), l: Number(r[idx.l]), c: Number(r[idx.c]), v: Number(r[idx.v] || 0) };
    if (![c.t, c.o, c.h, c.l, c.c, c.v].every(Number.isFinite) || c.o <= 0 || c.h <= 0 || c.l <= 0 || c.c <= 0 || c.v < 0 || c.h < Math.max(c.o, c.c, c.l) || c.l > Math.min(c.o, c.c, c.h)) throw new Error(`第 ${i + (hasHead ? 2 : 1)} 行K线数据无效`);
    return c;
  }).sort((a, b) => a.t - b.t);
  if (out.length < 1200) throw new Error('分钟K线至少需要 1,200 根（策略指标需要 20 小时预热）');
  if (out.some((x, i) => i > 0 && x.t === out[i - 1].t)) throw new Error('分钟K线存在重复时间戳，请先清理后重新导入。');
  if (out.some((x, i) => i > 0 && x.t - out[i - 1].t !== 60_000)) throw new Error('发现缺失分钟。请先补齐连续的 1 分钟K线再导入，避免回放结果失真。');
  return out;
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
  const heads = rows[0].map((x) => x.trim().toLowerCase()); const hasHead = ['timestamp', 'time', 'datetime'].some((h) => heads.includes(h));
  const data = hasHead ? rows.slice(1) : rows;
  const ti = hasHead ? indexMap(heads, ['timestamp', 'time', 'datetime'], 0) : 0;
  const ri = hasHead ? indexMap(heads, ['fundingrate', 'funding_rate', 'rate'], 1) : 1;
  const parsed = data.map((r, i) => { const t = parseTime(r[ti]); const rate = Number(r[ri]); if (!Number.isFinite(t) || !Number.isFinite(rate)) throw new Error(`第 ${i + (hasHead ? 2 : 1)} 行资金费率无效`); return { t, rate }; }).sort((a, b) => a.t - b.t);
  if (parsed.some((x, i) => i > 0 && x.t === parsed[i - 1].t)) throw new Error('资金费文件存在重复时间戳，请先清理后重新导入。');
  return parsed;
}
async function pickFile(kind: 'candles' | 'funding', event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0]; if (!file) return;
  const text = await file.text();
  if (kind === 'candles') {
    candleError.value = ''; try { candles.value = parseCandles(text); candleName.value = file.name; const detected = guessSymbol(file.name, text); if (detected) { symbol.value = detected; resetDefaults(); } snapshot.value = null; ready.value = false; status.value = `已载入 ${candles.value.length.toLocaleString()} 根连续分钟K线${detected ? ` · 标的 ${detected}` : ''}`; }
    catch (err) { candles.value = []; candleName.value = ''; candleError.value = err instanceof Error ? err.message : 'K线文件解析失败'; }
  } else {
    fundingError.value = ''; try { funding.value = parseFunding(text); fundingName.value = file.name; status.value = `已载入资金费：${funding.value.length.toLocaleString()} 条`; }
    catch (err) { funding.value = []; fundingName.value = ''; fundingError.value = err instanceof Error ? err.message : '资金费文件解析失败'; }
  }
  (event.target as HTMLInputElement).value = '';
}
function resetDefaults() { margin.value = symbolDefaults.value.margin; leverage.value = symbolDefaults.value.leverage; tickSize.value = symbolDefaults.value.tick; }
async function startReplay() {
  symbol.value = symbol.value.trim().toUpperCase();
  if (!symbol.value) { status.value = '请填写回放标的'; return; }
  if (candles.value.length < 1200) { status.value = '请先导入至少 1,200 根连续分钟K线'; return; }
  if (!(margin.value > 0 && margin.value <= 20) || !(leverage.value >= 1 && leverage.value <= 50) || !(tickSize.value > 0) || !(qtyStep.value > 0) || !(makerFeePct.value >= 0)) { ElMessage.warning('参数无效：保证金 0–20U、杠杆 1–50×，Tick/数量步进需大于 0'); return; }
  allLogs.value = []; ready.value = false; isPlaying.value = false;
  if (warmupCloseTimer) window.clearTimeout(warmupCloseTimer);
  warmupVisible.value = true; warmupProgress.value = 1; warmupStage.value = '准备回放参数…'; status.value = '正在准备策略回放…';
  try {
    const rows = toRaw(candles.value);
    transferState.rows = rows; transferState.offset = 0; transferState.settings = { symbol: symbol.value.trim().toUpperCase(), marginUsdt: margin.value, leverage: leverage.value, makerFee: makerFeePct.value / 100, tickSize: tickSize.value, qtyStep: qtyStep.value, orderTtlMs: 90_000 }; transferState.funding = toRaw(funding.value);
    warmupProgress.value = 4; warmupStage.value = `检查完成 · ${rows.length.toLocaleString()} 根 K 线、${transferState.funding.length.toLocaleString()} 条资金费`;
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    worker.postMessage({ type: 'init-start', candleCount: rows.length, funding: transferState.funding, settings: transferState.settings });
    sendNextChunk();
  } catch (err) {
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
    snapshot.value = event.data.payload; ready.value = true; status.value = '回放已就绪';
    warmupProgress.value = 100; warmupStage.value = '准备完成';
    warmupCloseTimer = window.setTimeout(() => { warmupVisible.value = false; }, 450);
  }
  if (event.data.type === 'tick') {
    snapshot.value = event.data.payload; isPlaying.value = !event.data.payload.paused && event.data.payload.index < event.data.payload.total;
    allLogs.value.push(...(event.data.newLogs || []));
    if (event.data.payload.index >= event.data.payload.total) { isPlaying.value = false; status.value = '回放完成'; }
  }
  if (event.data.type === 'export') allLogs.value = event.data.payload;
}
worker.addEventListener('message', onWorker);
worker.addEventListener('error', (event) => {
  if (chunkAckTimer) window.clearTimeout(chunkAckTimer); chunkAckTimer = undefined;
  warmupVisible.value = false; ready.value = false; isPlaying.value = false;
  status.value = `回放引擎启动失败：${event.message || event.filename || 'Worker 模块加载异常（请刷新页面重试）'}`;
});
worker.addEventListener('message', (event) => {
  if (event.data.type !== 'replay-error') return;
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
    <header class="topbar">
      <button class="back" @click="router.push('/')"><el-icon><ArrowLeft /></el-icon> 返回 TradFi</button>
      <div class="brand"><span class="brand-dot"></span><div><strong>TradFi 策略回放</strong><small>本地历史模拟 · 不连接实盘</small></div></div>
      <div class="status-pill" :class="{ live: isPlaying }"><i></i>{{ status }}</div>
    </header>
    <div class="layout">
      <aside class="sidebar">
        <section class="card import-card">
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
          <label class="field-label">单笔保证金 <small>U · 上限 20</small></label>
          <div class="input-row"><input v-model.number="margin" type="number" min="0.1" max="20" step="0.5"><span>USDT</span></div>
          <label class="field-label">杠杆</label>
          <div class="input-row"><input v-model.number="leverage" type="number" min="1" max="50" step="1"><span>×</span></div>
          <div class="two-inputs"><div><label class="field-label">Maker 费率</label><div class="input-row"><input v-model.number="makerFeePct" type="number" min="0" step="0.001"><span>%</span></div></div><div><label class="field-label">价格 Tick</label><div class="input-row"><input v-model.number="tickSize" type="number" min="0.000001" step="0.01"></div></div></div>
          <div class="two-inputs"><div><label class="field-label">数量步进</label><div class="input-row"><input v-model.number="qtyStep" type="number" min="0.000001" step="0.001"></div></div><div><label class="field-label">撮合约定</label><div class="fixed-value">穿价 1 Tick</div></div></div>
          <button class="start-button" :disabled="!candles.length || warmupVisible" @click="startReplay"><el-icon><VideoCamera /></el-icon> {{ ready ? '重新开始回放' : '载入并开始' }}</button>
          <div class="import-hint">支持任意标的分钟线；文件名或 CSV 标的列可自动识别。XAU/XAG 使用预设参数，其他标的请核对价格 Tick、数量步进、费率和保证金参数。导入数据仅在当前浏览器运行。</div>
        </section>
        <section class="card rules-card">
          <div class="section-title"><span>02</span> 策略规则快照</div>
          <div class="rule-line"><b>底仓</b><span>震荡确认后双向 Maker 建仓</span></div>
          <div class="rule-line"><b>补仓</b><span>15m ATR × 0.6；0.08%—0.35%</span></div>
          <div class="rule-line"><b>稀疏</b><span>趋势与 ATR 距离确认后，最多 5 档合并</span></div>
          <div class="rule-line"><b>止盈</b><span>单边净利达标 Maker 平仓；10 秒后重建</span></div>
          <div class="rule-line"><b>上限</b><span>多头 100 档 · 空头 50 档</span></div>
          <div class="rule-warning">指标预热需要 20 小时数据。策略决策函数与 live 共用；回放不触发交易所委托。分钟线无法还原分钟内成交顺序。</div>
        </section>
      </aside>
      <section class="workspace">
        <div class="summary-row">
          <article class="metric-card"><span>当前价格</span><strong>{{ snapshot ? number(snapshot.price) : '—' }}</strong><small>{{ symbol }}</small></article>
          <article class="metric-card"><span>已实现盈亏</span><strong class="realized-amount"><span class="realized-main" :class="pnlClass(snapshot?.realized || 0)">{{ snapshot ? number(snapshot.realized) : '—' }} U</span><em class="funding-inline" :class="pnlClass(snapshot?.realizedFunding || 0)">（{{ snapshot && snapshot.realizedFunding > 0 ? '+' : '' }}{{ snapshot ? number(snapshot.realizedFunding) : '—' }} U）</em></strong><small>已平仓净盈亏（括号内为资金费）</small></article>
          <article class="metric-card floating-pnl-card"><span>当前浮动盈亏</span><strong :class="pnlClass(snapshot?.unrealized || 0)">{{ snapshot ? number(snapshot.unrealized) : '—' }} <em>U</em></strong><small>多空合计</small></article>
          <article class="metric-card loss-peak-card"><span>亏损峰值（多 / 空 / 总）</span><div><b>多 {{ snapshot ? `-${number(snapshot.maxLossPeak.long)}` : '—' }} U</b><b>空 {{ snapshot ? `-${number(snapshot.maxLossPeak.short)}` : '—' }} U</b><b class="total">总 {{ snapshot ? `-${number(snapshot.maxLossPeak.total)}` : '—' }} U</b></div><small>总亏损为同一时点多空合计浮亏峰值</small></article>
          <article class="metric-card"><span>有效成交</span><strong>{{ snapshot?.tradeCount ?? '—' }}</strong><small>开仓、补仓、平仓成交</small></article>
        </div>
        <section class="card chart-card">
          <div class="panel-heading"><div><div class="section-title"><span>03</span> 分钟走势与策略状态</div><div class="subheading">{{ snapshot ? clock(snapshot.time) : '导入数据后开始回放' }} <i v-if="snapshot">·</i> {{ snapshot?.state || '等待数据' }}</div></div><div class="chart-meta" v-if="chartMinMax"><span>H {{ number(chartMinMax.max) }}</span><span>L {{ number(chartMinMax.min) }}</span></div></div>
          <div class="chart-wrap"><svg viewBox="0 0 1000 260" preserveAspectRatio="none" aria-label="分钟收盘价走势"><defs><linearGradient id="chart-fill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#27c99b" stop-opacity=".2"/><stop offset="1" stop-color="#27c99b" stop-opacity="0"/></linearGradient></defs><path v-if="chartPath" :d="`${chartPath} L 1000 260 L 0 260 Z`" fill="url(#chart-fill)"/><path v-if="chartPath" :d="chartPath" fill="none" stroke="#26c99a" stroke-width="2.2" vector-effect="non-scaling-stroke"/><text v-if="!chartPath" x="500" y="132" text-anchor="middle" fill="#69798c" font-size="14">导入连续的分钟 K 线后查看回放图表</text></svg><div class="chart-grid"><i></i><i></i><i></i><i></i></div></div>
          <div class="progress-meta"><span>{{ snapshot ? `${snapshot.index.toLocaleString()} / ${snapshot.total.toLocaleString()} 分钟` : '回放进度' }}</span><span>{{ progress }}%</span></div><div class="progress-track"><i :style="{ width: `${progress}%` }"></i></div>
          <div class="player"><button class="icon-button" :disabled="!ready || isPlaying" title="单步前进一分钟" @click="send('step')"><el-icon><CaretRight /></el-icon><span>单步</span></button><button class="play-button" :disabled="!ready" @click="send(isPlaying ? 'pause' : 'play')"><el-icon><component :is="isPlaying ? VideoPause : VideoPlay" /></el-icon>{{ isPlaying ? '暂停' : '播放' }}</button><button class="icon-button" :disabled="!ready || !isPlaying" @click="send('pause')">停止</button><label>速度<select v-model.number="speed"><option :value="10">10×</option><option :value="20">20×</option><option :value="50">50×</option><option :value="100">100×</option><option :value="200">200×</option></select><small>每秒 {{ speed * 20 }} 分钟</small></label><span class="player-spacer"></span><button class="export-button" :disabled="!allLogs.length" @click="downloadLogs"><el-icon><Download /></el-icon> 导出平仓记录</button></div>
        </section>
        <section class="position-grid">
          <article v-for="side in (['long', 'short'] as const)" :key="side" class="card position-card" :class="side"><header><div><i></i><b>{{ side === 'long' ? '多头仓位' : '空头仓位' }}</b></div><span>{{ snapshot?.positions[side]?.adds ?? 0 }} / {{ side === 'long' ? 100 : 50 }} 补仓</span></header><div v-if="snapshot?.positions[side]" class="position-data"><strong :class="pnlClass(snapshot.positions[side].pnl)">{{ number(snapshot.positions[side].pnl) }} U</strong><div class="position-opened-at"><small>开仓时间</small><b>{{ clock(snapshot.positions[side].openedAt) }}</b></div><div class="position-cols"><div><small>持仓均价</small><b>{{ number(snapshot.positions[side].avg, 3) }}</b></div><div><small>名义价值</small><b>{{ number(snapshot.positions[side].notional) }} U</b></div><div><small>保证金</small><b>{{ number(snapshot.positions[side].margin) }} U</b></div><div><small>持仓数量</small><b>{{ number(snapshot.positions[side].qty, 4) }}</b></div></div></div><div v-else class="position-empty">当前无{{ side === 'long' ? '多头' : '空头' }}仓位</div><div v-if="snapshot?.orders[side]" class="pending-order">委托中 · {{ snapshot.orders[side].purpose === 'close' ? '止盈' : snapshot.orders[side].purpose === 'add' ? '补仓' : '开仓' }} {{ number(snapshot.orders[side].price, 3) }} <small>{{ snapshot.orders[side].label }}</small></div></article>
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
.inline-action{height:25px;padding:0 7px;border:1px solid #2b3948;border-radius:5px;background:#18222d;color:#a9bbcf;font-size:9px;white-space:nowrap;cursor:pointer}.inline-action:hover{border-color:#9a7414;color:#f0c54c}.metric-card strong .funding-inline{font:500 11px ui-monospace,Consolas,monospace;color:#98aabd}.loss-peak-card>div{display:grid;grid-template-columns:1fr 1fr;gap:4px 8px;margin:6px 0;color:var(--red);font:600 12px ui-monospace,Consolas,monospace}.loss-peak-card>div b{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.loss-peak-card>div b.total{grid-column:1/-1;padding-top:4px;border-top:1px solid #27313b;color:#f0c54c}.position-opened-at{display:flex;justify-content:space-between;gap:8px;margin-top:5px;padding:5px 7px;border-radius:5px;background:#0c1219}.position-opened-at small{color:#718399;font-size:9px}.position-opened-at b{color:#9eafc2;font-size:9px;font-weight:500}.position-log-head,.position-log{grid-template-columns:repeat(6,minmax(0,1fr));align-items:center;text-align:center}.position-log time,.position-price{color:#8497ad;font-variant-numeric:tabular-nums;white-space:nowrap}.position-log>b{font-variant-numeric:tabular-nums}.position-log>span{text-align:center;font-variant-numeric:tabular-nums}.position-log .position-price{text-align:center;color:#c1cedd}@media(max-width:850px){.position-log-head,.position-log{gap:5px}.position-log{font-size:9px}}@media(max-width:560px){.position-log-head,.position-log{gap:4px}.position-log{font-size:8px}.position-log-head{font-size:8px;padding-left:5px;padding-right:5px}.position-log{padding-left:5px;padding-right:5px}}
.help-button{display:inline-flex;align-items:center;justify-content:center;width:19px;height:19px;margin-left:1px;padding:0;border:0;border-radius:50%;background:transparent;color:#8ea2b9;cursor:pointer}.help-button:hover{background:#242b31;color:#f0c54c}.help-button .el-icon{font-size:15px}.template-backdrop{position:fixed;inset:0;z-index:1400;display:flex;align-items:center;justify-content:center;padding:16px;background:#05080dcc}.template-dialog{width:min(620px,100%);max-height:min(760px,92vh);display:flex;flex-direction:column;overflow:hidden;border:1px solid #344352;border-radius:12px;background:#111820;box-shadow:0 24px 70px #0009}.template-dialog>header{display:flex;align-items:center;justify-content:space-between;padding:15px 18px;border-bottom:1px solid #26323e}.template-dialog h2{margin:0;color:#e7edf5;font-size:15px}.template-close{width:28px;height:28px;border:0;border-radius:6px;background:transparent;color:#9badc0;font-size:22px;cursor:pointer}.template-close:hover{background:#202a34;color:#fff}.template-content{overflow:auto;padding:16px 18px 20px}.template-content>p{margin:0 0 14px;color:#9aabbd;font-size:11px;line-height:1.6}.template-block{margin-top:12px;padding:13px;border:1px solid #283542;border-radius:8px;background:#0d141c}.template-block h3{margin:0 0 9px;color:#e1bd53;font-size:12px}.template-block pre{overflow:auto;margin:0 0 9px;padding:10px;border-radius:5px;background:#080d12;color:#c6d4e3;font:11px/1.6 ui-monospace,Consolas,monospace;white-space:pre}.template-block small{display:block;color:#8395a9;font-size:10px;line-height:1.6}
.metric-card strong.realized-amount{display:flex;align-items:baseline;gap:2px;font-size:20px;overflow:hidden;text-overflow:clip}.realized-main{min-width:0;overflow:hidden;text-overflow:ellipsis;font:600 20px/1.35 ui-monospace,Consolas,monospace}.floating-pnl-card strong{font-size:20px}.metric-card strong .funding-inline{flex:0 0 auto;font:500 11px/1.35 ui-monospace,Consolas,monospace}.metric-card strong .funding-inline.positive{color:var(--green)!important}.metric-card strong .funding-inline.negative{color:var(--red)!important}@media(max-width:560px){.realized-main,.floating-pnl-card strong{font-size:18px}.metric-card strong .funding-inline{font-size:10px}}
</style>
