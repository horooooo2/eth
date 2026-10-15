import { computed, onUnmounted, reactive, ref, watch, type Ref } from 'vue';
import { http, type RadarAvailableContract } from '@/api';
import { preferredCoinsState } from '@/utils/watchedCoins';
import type { ResearchSnapshot, ResearchRecord, ResearchEvent, ResearchSource, ResearchAlerts } from '@/types/contractResearch';

export const RESEARCH_TABS = [{ id: 'overview', label: '总览' }, { id: 'evidence', label: '评分详情' }, { id: 'institutions', label: '机构观点' }, { id: 'events', label: '事件日历' }, { id: 'alerts', label: '警报' }] as const;
export type ResearchTab = typeof RESEARCH_TABS[number]['id'];
export function useContractResearch(active: Ref<boolean>) {
  function read(key: string, fallback: string) { try { return localStorage.getItem(key) || fallback; } catch { return fallback; } }
  const preferredSymbols = computed(() => [...new Set(preferredCoinsState.value.map(id => {
    const base = id.trim().toUpperCase(); return base.endsWith('USDT') ? base : base + 'USDT';
  }).filter(id => /^[A-Z0-9]{1,26}USDT$/.test(id)))]);
  const savedSymbol = read('contract-research:symbol', '');
  const symbol = ref(preferredSymbols.value.includes(savedSymbol) ? savedSymbol : preferredSymbols.value[0] || '');
  const horizon = ref(30), tab = ref<ResearchTab>('overview');
  const catalog = ref<RadarAvailableContract[]>([]), catalogStale = ref(false), catalogLoaded = ref(false);
  const snapshot = ref<ResearchSnapshot | null>(null), record = ref<ResearchRecord | null>(null);
  const pending = ref(false), starting = ref(false), error = ref(''), notice = ref(''), job = ref<ResearchRecord | null>(null), pollError = ref('');
  const alerts = ref<ResearchAlerts | null>(null), alertError = ref('');
  let generation = 0, disposed = false, timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined, catalogController: AbortController | undefined, pollController: AbortController | undefined;
  let catalogPending = false;
  const visible = ref(document.visibilityState !== 'hidden');
  const current = computed(() => snapshot.value);
  const analysis = computed(() => record.value?.snapshot.id === snapshot.value?.id ? record.value?.analysis : null);
  const research = computed(() => record.value?.snapshot.id === snapshot.value?.id ? record.value?.research : null);
  const dimensions = computed(() => analysis.value?.dimensions || current.value?.dimensions || []);
  const scores = computed(() => analysis.value?.scores || current.value?.scores);
  const sources = computed(() => [...(current.value?.sources || []), ...(research.value?.sources || [])]);
  const selectedMarket = computed(() => catalog.value.find(a => a.symbol === symbol.value));
  const quickAssets = computed(() => preferredSymbols.value.filter(id => !catalogLoaded.value || catalog.value.some(a => a.symbol === id)));
  const running = computed(() => job.value?.status === 'RUNNING');
  const events = computed(() => {
    const result: ResearchEvent[] = [], seen = new Set<string>();
    for (const item of [...(current.value?.events || []), ...(analysis.value?.events || [])]) {
      const key = item.title.replace(/\s/g, '') + ':' + eventStamp(item);
      if (!seen.has(key)) { result.push(item); seen.add(key); }
    }
    return result.sort((a, b) => (eventStamp(a) ?? Infinity) - (eventStamp(b) ?? Infinity));
  });
  const selectedEvents = computed(() => events.value.filter(e => { const at = eventStamp(e); return at != null && at >= Date.now() && at <= Date.now() + horizon.value * 86400000; }));
  const institutions = computed(() => analysis.value?.institutions || []);
  const metrics = computed(() => analysis.value?.metrics || []);
  function safeUrl(raw: string | null | undefined) { try { const u = new URL(raw || ''); return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password ? u.href : ''; } catch { return ''; } }
  function date(value: string | number | null | undefined) {
    if (value == null) return '日期未知';
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
    const d = new Date(value); return Number.isFinite(d.getTime()) ? d.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) : '日期未知';
  }
  function num(value: unknown, digits = 2) { if (value == null || value === '') return '—'; const n = Number(value); return Number.isFinite(n) ? n.toLocaleString('en-US', { maximumFractionDigits: digits }) : '—'; }
  function pct(value: unknown, digits = 2) { return value == null || value === '' || !Number.isFinite(Number(value)) ? '—' : (Number(value) > 0 ? '+' : '') + num(value, digits) + '%'; }
  function range(value: { low: number; high: number } | null | undefined) { return value ? value.low === value.high ? value.low.toFixed(2) : value.low.toFixed(2) + '–' + value.high.toFixed(2) : '待研究'; }
  function eventStamp(e: ResearchEvent) { const value = e.at || (e.date ? e.date + 'T' + (e.time || '00:00') + ':00+08:00' : ''); const stamp = Date.parse(value); return Number.isFinite(stamp) ? stamp : null; }
  function eventDate(e: ResearchEvent) { return e.ongoing ? '持续关注' : e.at ? date(e.at) : (e.date || '日期待确认') + (e.time ? ' ' + e.time : ' · 时刻待确认'); }
  function eventState(e: ResearchEvent) { const at = eventStamp(e); return at == null ? '持续关注' : at < Date.now() ? '近期已发生' : '待发生'; }
  function sourceById(id: string): ResearchSource | undefined { return sources.value.find(s => s.id === id); }
  function message(e: unknown) { return e instanceof Error ? e.message === 'TIMEOUT' ? '请求超时，请稍后重试' : e.message : '请求失败，请稍后重试'; }
  async function loadCatalog() {
    if (catalogPending || catalogLoaded.value || !active.value || !visible.value) return;
    catalogPending = true; const request = catalogController = new AbortController();
    try { const { data } = await http.get<{ contracts: RadarAvailableContract[]; stale: boolean }>('/research/catalog', { signal: request.signal });
      if (!disposed) { catalog.value = data.contracts; catalogStale.value = data.stale; catalogLoaded.value = true; }
    } catch (e) { if (!request.signal.aborted) error.value = message(e); }
    finally { catalogPending = false; if (request.signal.aborted && active.value && visible.value && !disposed) void loadCatalog(); }
  }
  async function loadAlerts() {
    if (!current.value || disposed) return;
    const id = current.value.id;
    try {
      const { data } = await http.post<ResearchAlerts>('/research/alerts', { snapshotId: id, recordId: record.value?.id || (job.value?.snapshot.id === id ? job.value.id : undefined) });
      if (!disposed && current.value?.id === id) { alerts.value = data; alertError.value = ''; }
    } catch (e) { if (!disposed && current.value?.id === id) alertError.value = message(e); }
  }
  async function load(restore = false) {
    if (!active.value || !visible.value || disposed || !symbol.value || !catalogLoaded.value) return;
    const version = ++generation; controller?.abort(); const request = controller = new AbortController();
    pending.value = true; error.value = ''; notice.value = '';
    const params = { symbol: symbol.value, horizon: horizon.value };
    try {
      if (restore) {
        const latest = await http.get<{ item: ResearchRecord | null }>('/research/latest', { params, signal: request.signal });
        if (version !== generation || disposed) return;
        if (latest.data.item) {
          const row = latest.data.item; snapshot.value = row.snapshot;
          if (row.status === 'RUNNING') { job.value = row; schedulePoll(100); } else record.value = row;
          notice.value = '已恢复上次 30 天分析，资料采样 ' + date(row.snapshot.generatedAt) + '；点击 AI 多空分析可重新采集。';
          void loadAlerts(); return;
        }
      }
      const { data } = await http.get<ResearchSnapshot>('/research/snapshot', { params, timeout: 45000, signal: request.signal });
      if (version !== generation || disposed) return;
      snapshot.value = data; if (record.value?.snapshot.id !== data.id) record.value = null;
      void loadAlerts();
    } catch (e) { if (version === generation && !request.signal.aborted) error.value = message(e); }
    finally { if (version === generation) pending.value = false; }
  }
  function schedulePoll(delay = 3500) { clearTimeout(timer); if (running.value && active.value && visible.value && !disposed) timer = setTimeout(() => void poll(), delay); }
  async function poll() {
    if (!job.value || !running.value || !active.value || !visible.value || disposed) return;
    const id = job.value.id; pollController?.abort(); const request = pollController = new AbortController();
    try {
      const { data } = await http.get<ResearchRecord>('/research/history/' + id, { signal: request.signal });
      if (disposed || request.signal.aborted || job.value?.id !== id) return;
      job.value = data; pollError.value = '';
      if (data.status !== 'RUNNING') {
        if (data.status === 'COMPLETED' && snapshot.value?.id === data.snapshot.id) { record.value = data; void loadAlerts(); }
        notice.value = data.status === 'FAILED' ? data.error : data.symbol.replace(/USDT$/, '') + ' 多空分析已完成';
      }
    } catch (e) { if (!request.signal.aborted) pollError.value = message(e); }
    finally { schedulePoll(pollError.value ? 10000 : 3500); }
  }
  async function analyze() {
    if (!current.value || starting.value || running.value) return;
    starting.value = true; error.value = ''; const requestedSymbol = symbol.value, requestedHorizon = horizon.value;
    try {
      // Re-register persisted snapshots after a restart and refresh old market facts.
      await load();
      if (disposed || error.value || !current.value || symbol.value !== requestedSymbol || horizon.value !== requestedHorizon) return;
      const id = current.value.id;
      const { data } = await http.post<ResearchRecord>('/research/analyze', { snapshotId: id, web: true });
      if (disposed) return;
      if (data.status === 'COMPLETED' && snapshot.value?.id === id) { record.value = data; void loadAlerts(); }
      else { job.value = data; schedulePoll(); }
    } catch (e) { error.value = message(e); } finally { starting.value = false; }
  }
  function select(id: string) { if (quickAssets.value.includes(id)) symbol.value = id; }
  function visibility() { visible.value = document.visibilityState !== 'hidden'; }
  document.addEventListener('visibilitychange', visibility);
  watch(quickAssets, ids => { if (!ids.includes(symbol.value)) symbol.value = ids[0] || ''; }, { immediate: true, flush: 'sync' });
  watch([symbol, horizon], () => {
    generation++; controller?.abort(); snapshot.value = null; record.value = null; alerts.value = null; error.value = ''; notice.value = ''; pending.value = false; alertError.value = '';
    try { localStorage.setItem('contract-research:symbol', symbol.value); } catch { /* unavailable */ }
  }, { flush: 'sync' });
  watch([active, visible, symbol, catalogLoaded], () => {
    if (active.value && visible.value) { void loadCatalog(); if (catalogLoaded.value && symbol.value && !snapshot.value && !pending.value) void load(true); schedulePoll(100); }
    else { clearTimeout(timer); generation++; controller?.abort(); catalogController?.abort(); pollController?.abort(); pending.value = false; }
  }, { immediate: true });
  onUnmounted(() => { disposed = true; generation++; clearTimeout(timer); controller?.abort(); catalogController?.abort(); pollController?.abort(); document.removeEventListener('visibilitychange', visibility); });
  return reactive({ symbol, horizon, tab, tabs: RESEARCH_TABS, catalog, catalogStale, quickAssets, selectedMarket, current, analysis, research, dimensions, scores, sources,
    pending, starting, error, notice, running, pollError, selectedEvents, events, institutions, metrics, alerts, alertError,
    safeUrl, date, num, pct, range, eventDate, eventState, sourceById, load, loadCatalog, loadAlerts, analyze, select });
}
export type ResearchModel = ReturnType<typeof useContractResearch>;
