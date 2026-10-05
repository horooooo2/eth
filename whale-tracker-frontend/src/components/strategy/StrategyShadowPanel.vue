<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue';
import { http } from '@/api';
type Source = { sourceId: string; title: string; summary: string; source: string; publishedAt: string; url: string };
type Judgment = { verdict: 'SUPPORT' | 'AVOID' | 'INSUFFICIENT'; summary: string; evidence: { sourceId: string; interpretation: string }[]; counterEvidence: string[]; missingData: string[]; invalidation: string[] };
type ShadowEvent = { id: string; symbol: string; direction: 'UP' | 'DOWN'; createdAt: number; expiresAt: number; marketAsOf: number; changePct: number; backgroundPct: number; impulseAtr: number; close: number; criteria: string };
type Observation = { state: string; reason: string; observedAt: number; event: ShadowEvent | null };
type RecordRow = { id: string; symbol: string; status: string; verdict?: string; createdAt: number; decisionAt?: number; model?: string; promptVersion?: string; judgment?: Judgment; error?: string; news?: { items: Source[] }; event?: ShadowEvent; rawOutput?: string };
const props = defineProps<{ symbol: string; active: boolean }>();
const observation = ref<Observation | null>(null), selected = ref<RecordRow | null>(null), records = ref<RecordRow[]>([]);
const busy = ref(false), analyzing = ref(false), error = ref('');
let generation = 0, detailRequest = 0;
const label = (value: string) => ({ SUPPORT: '支持继续观察', AVOID: '建议跳过', INSUFFICIENT: '证据不足', RUNNING: '分析中', FAILED: '分析失败', COMPLETED: '已完成' }[value] || value);
const time = (value?: number | string) => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—';
function message(e: any) { return e?.response?.data?.error || (e?.code === 'ECONNABORTED' ? '等待超时，服务器可能仍在分析，请刷新记录；不要重复提交。' : '请求失败，请稍后重试'); }
function url(value: string) { try { return new URL(value).protocol === 'https:' ? value : undefined; } catch { return undefined; } }
async function history() {
  const token = generation, symbol = props.symbol;
  try { const { data } = await http.get<{ records: RecordRow[] }>('/tradfi/strategy-shadow/history', { params: { symbol } }); if (token === generation) records.value = data.records; }
  catch (e) { if (token === generation) error.value = message(e); }
}
async function observe() {
  if (busy.value || analyzing.value) return;
  const token = generation; busy.value = true; error.value = ''; selected.value = null;
  try {
    const { data } = await http.post<Observation>('/tradfi/strategy-shadow/observe', { symbol: props.symbol, mode: 'LIVE' }, { timeout: 45000 });
    if (token === generation) observation.value = data;
  } catch (e) { if (token === generation) { observation.value = null; error.value = message(e); } }
  finally { if (token === generation) busy.value = false; }
}
async function analyze() {
  if (!observation.value?.event || analyzing.value || busy.value) return;
  const token = generation, eventId = observation.value.event.id;
  analyzing.value = true; error.value = '';
  try { const { data } = await http.post<RecordRow>('/tradfi/strategy-shadow/analyze', { eventId }, { timeout: 115000 }); if (token === generation) selected.value = data; }
  catch (e: any) { if (token === generation) { error.value = message(e); if (e?.response?.data?.record) selected.value = e.response.data.record; } }
  finally { if (token === generation) { analyzing.value = false; void history(); } }
}
async function detail(id: string) {
  const token = generation, request = ++detailRequest; error.value = '';
  try { const { data } = await http.get<RecordRow>(`/tradfi/strategy-shadow/records/${encodeURIComponent(id)}`); if (token === generation && request === detailRequest) selected.value = data; }
  catch (e) { if (token === generation && request === detailRequest) error.value = message(e); }
}
function download() {
  if (!selected.value) return;
  const link = document.createElement('a'), blob = URL.createObjectURL(new Blob([JSON.stringify(selected.value, null, 2)], { type: 'application/json' }));
  link.href = blob; link.download = `shadow-${selected.value.symbol}-${selected.value.id}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(blob), 1000);
}
watch(() => props.symbol, () => { generation++; observation.value = null; selected.value = null; records.value = []; error.value = ''; busy.value = analyzing.value = false; if (props.active) void history(); });
watch(() => props.active, active => { if (active) void history(); }, { immediate: true });
onBeforeUnmount(() => { generation++; });
</script>
<template>
  <section class="shadow-panel">
    <header><div><h2>AI 情绪观察 <small>旁路研究 · 不参与交易决策</small></h2><p>手动检查 {{ symbol }} 的最新完整小时行情；只有异常事件才可分析，不自动消耗 AI token。</p></div>
      <button :disabled="busy || analyzing" @click="observe">{{ busy ? '检查行情中…' : '检查当前异常' }}</button></header>
    <p class="note">研究规则：前 72 小时同向净变化，最新完整小时位移 ≥ 2 倍事件前 ATR14，且涨跌幅绝对值 ≥ 0.5%。这是独立旁路研究条件，不是当前回放策略的入场信号，不参与执行决策。</p>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <div v-if="observation" class="observation">
      <p>{{ observation.reason }} <small>· 检查于 {{ time(observation.observedAt) }}</small></p>
      <template v-if="observation.event">
        <div class="facts"><span>{{ observation.event.direction === 'DOWN' ? '下跌加速 · 观察反弹' : '上涨加速 · 观察回落' }}</span><b>1h {{ observation.event.changePct.toFixed(2) }}%</b><span>背景 {{ observation.event.backgroundPct.toFixed(2) }}%</span><span>{{ observation.event.impulseAtr.toFixed(2) }} ATR</span></div>
        <p class="note">冻结行情截至 {{ time(observation.event.marketAsOf) }}；同向事件 6 小时内复用。首次分析须在捕获后 15 分钟内，过期不做事后补判。</p>
        <button :disabled="analyzing || busy" @click="analyze">{{ analyzing ? 'AI 分析中，结果会在服务器留档…' : '分析并留档' }}</button>
      </template>
    </div>
    <div v-if="selected" class="result">
      <header><h3>{{ label(selected.judgment?.verdict || selected.status) }}</h3><button @click="download">导出完整记录</button></header>
      <p class="note">记录 {{ time(selected.createdAt) }} · 决策资料截至 {{ time(selected.decisionAt) }} · {{ selected.model || '未形成模型结论' }} · {{ selected.promptVersion || '—' }}</p>
      <p v-if="selected.status === 'RUNNING'">分析正在服务器运行，请稍后刷新记录并点击查看；重复点击不会并发调用模型。</p>
      <p v-if="selected.error" class="error">{{ selected.error }}</p>
      <template v-if="selected.judgment">
        <p>{{ selected.judgment.summary }}</p>
        <div class="columns"><div><h4>来源与解释</h4><p v-for="(item, i) in selected.judgment.evidence" :key="i"><b>[{{ item.sourceId }}]</b> {{ item.interpretation }}</p><p v-if="!selected.judgment.evidence.length" class="note">没有可引用的充分证据。</p></div>
          <div><h4>反证与不利因素</h4><ul><li v-for="(item,i) in selected.judgment.counterEvidence" :key="i">{{ item }}</li></ul><h4>缺少的信息</h4><ul><li v-for="(item,i) in selected.judgment.missingData" :key="i">{{ item }}</li></ul><h4>推翻判断的条件</h4><ul><li v-for="(item,i) in selected.judgment.invalidation" :key="i">{{ item }}</li></ul></div></div>
      </template>
      <details v-if="selected.news?.items.length"><summary>查看当时提供的新闻（标题与摘要，非全文核实）</summary><article v-for="item in selected.news.items" :key="item.sourceId"><a :href="url(item.url)" target="_blank" rel="noopener noreferrer">[{{ item.sourceId }}] {{ item.title }}</a><small>{{ item.source }} · {{ time(item.publishedAt) }}</small><p>{{ item.summary }}</p></article></details>
      <details v-if="selected.rawOutput"><summary>AI 原始回答</summary><pre>{{ selected.rawOutput }}</pre></details>
    </div>
    <div class="history"><header><h3>服务器观察记录 · 最近 20 次</h3><button @click="history">刷新记录</button></header><p v-if="!records.length" class="note">暂无分析记录。此处不使用历史回放数据，也不会把今天的新闻补入历史交易。</p>
      <button v-for="record in records" :key="record.id" class="history-row" @click="detail(record.id)"><span>{{ time(record.createdAt) }}</span><span>{{ record.symbol }}</span><b>{{ label(record.verdict || record.status) }}</b></button>
    </div>
  </section>
</template>
<style scoped>
.shadow-panel{margin-top:20px;padding:20px;border:1px solid #29394b;border-radius:10px;background:#121b26;color:#dce6f1;font-size:14px;line-height:1.8}.shadow-panel header{display:flex;justify-content:space-between;align-items:center;gap:16px;flex-wrap:wrap}.shadow-panel h2{font-size:17px;margin:0}.shadow-panel h3{font-size:15px;margin:8px 0}.shadow-panel h4{margin:10px 0}.shadow-panel small,.note{color:#91a5bc;font-size:12px}.shadow-panel button{cursor:pointer;border:1px solid #3b5167;border-radius:6px;padding:8px 14px;background:#1a2939;color:#e1eaf4}.shadow-panel button:disabled{opacity:.5;cursor:wait}.shadow-panel .error{color:#ff9a9a}.observation,.result,.history{border-top:1px solid #29394b;margin-top:16px;padding-top:14px}.facts{display:flex;gap:20px;flex-wrap:wrap}.columns{display:grid;grid-template-columns:1fr 1fr;gap:24px}.shadow-panel ul{padding-left:20px}.shadow-panel a{color:#8cbef0}.shadow-panel article{padding:10px 0;border-bottom:1px solid #29394b}.shadow-panel article small{display:block}.shadow-panel pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:300px;overflow:auto}.shadow-panel summary{cursor:pointer}.history-row{display:flex;justify-content:space-between;gap:12px;width:100%;margin:8px 0;text-align:left}@media(max-width:800px){.columns{grid-template-columns:1fr}.shadow-panel{padding:14px}}
</style>
