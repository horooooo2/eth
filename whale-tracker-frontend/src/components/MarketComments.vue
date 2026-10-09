<script setup lang="ts">
import { computed, reactive, toRef, onUnmounted, ref, watch } from 'vue';
import { http } from '@/api';
const props = defineProps<{ symbol: string; active: boolean; cacheState?:{entries:CommentCache} }>();
type Comment = { id: string; title: string; summary: string; source: string; author: string; publishedAt: number | null; url: string };
type Result = { items: Comment[]; supported: boolean; pending: boolean; stale?: boolean; error?: string; updatedAt: number | null };
export type CommentCache = Record<string, Result & {nextFetchAt:number}>;
const cache = toRef(props.cacheState || reactive<{entries:CommentCache}>({entries:{}}), 'entries');
const result = computed(() => cache.value[props.symbol]);
const error = ref(''), loading = ref(false);
let timer: ReturnType<typeof setTimeout> | undefined;
let controller: AbortController | undefined;
let generation = 0;
function url(raw: string) { try { const u = new URL(raw); return u.protocol === 'https:' && u.hostname === 'guba.eastmoney.com' ? u.href : ''; } catch { return ''; } }
function date(at: number | null) { return at && Number.isFinite(at) ? new Date(at).toLocaleString('zh-CN', { hour12: false }) : '时间未提供'; }
async function load() {
  const version = ++generation, symbol = props.symbol;
  clearTimeout(timer); controller?.abort();
  if (!props.active || !symbol) { loading.value = false; return; }
  error.value = '';
  const remaining = (cache.value[symbol]?.nextFetchAt || 0) - Date.now();
  if (remaining > 0) { loading.value = false; timer = setTimeout(load, remaining); return; }
  controller = new AbortController(); loading.value = true;
  let delay = 600000;
  try {
    const { data } = await http.get<Result>('/news/comments', { params: { symbol }, signal: controller.signal });
    if (version !== generation) return;
    if (!Array.isArray(data.items)) throw new Error('评论响应格式异常');
    delay = data.pending ? 2500 : data.error && data.supported ? 60000 : 600000;
    if (!data.pending && !data.error && data.updatedAt) delay = Math.max(2500, Math.min(delay, data.updatedAt + 600000 - Date.now()));
    cache.value = { ...Object.fromEntries(Object.entries(cache.value).filter(([key]) => key !== symbol).slice(-59)), [symbol]: { ...data, nextFetchAt: Date.now() + delay } };
  } catch {
    if (version !== generation) return;
    error.value = '评论读取失败，稍后自动重试'; delay = 60000;
  } finally {
    if (version === generation) { loading.value = false; if (props.active) timer = setTimeout(load, delay); }
  }
}
watch([() => props.active, () => props.symbol], load, { immediate: true });
onUnmounted(() => { generation++; clearTimeout(timer); controller?.abort(); });
async function refresh(){if(loading.value)return;if(result.value)result.value.nextFetchAt=0;await load();if(error.value)throw new Error(error.value);}
defineExpose({refresh});
</script>
<template>
  <section class="market-comments" aria-label="相关评论">
    <div class="comment-note"><span v-if="result?.updatedAt">更新于 {{ date(result.updatedAt) }}{{ result.stale ? ' · 缓存内容' : '' }}</span></div>
    <p v-if="error || result?.error" class="error" role="status">{{ error || result?.error }}</p>
    <p v-if="result?.pending" role="status" class="pending">正在收集讨论，完成后自动更新…</p>
    <div v-if="!symbol" class="empty" role="status">请选择上方标的查看相关评论</div>
    <div v-else-if="!result?.items.length" class="empty" role="status">{{ loading || result?.pending ? '正在读取评论…' : result?.supported === false ? '该标的暂无已确认的中文讨论源' : error || result?.error ? '暂时无法读取评论' : '当前没有可展示的用户讨论' }}</div>
    <div v-else class="comment-grid"><article v-for="item in result.items" :key="item.id" class="comment-card"><div class="author"><span>{{ item.author }}<small>{{ item.source }} · {{ date(item.publishedAt) }}</small></span></div><h3>{{ item.title }}</h3><p v-if="item.summary">{{ item.summary }}</p><a v-if="url(item.url)" :href="url(item.url)" target="_blank" rel="noopener noreferrer">查看原帖与回复 ↗</a></article></div>
  </section>
</template>
<style scoped>
.comment-note{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;font-size:11px;color:var(--muted);margin:12px 0 20px}.comment-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}.comment-card{border:1px solid var(--border);background:var(--workspace-surface);border-radius:10px;padding:19px;overflow-wrap:anywhere}.author{display:flex;align-items:center;gap:9px;font-size:12px}.avatar{width:30px;height:30px;border-radius:50%;background:#302a40;color:#c9b3eb;display:grid;place-items:center;flex-shrink:0}.author small{display:block;color:var(--muted);font-size:10px;margin-top:4px}.comment-card h3{font-size:15px;font-weight:500;line-height:1.8;margin:16px 0}.comment-card p{font-size:13px;line-height:1.9;white-space:pre-line}.comment-card a{font-size:11px;color:#c1a4df;text-decoration:none}.empty{text-align:center;border:1px dashed var(--border);border-radius:10px;padding:70px 20px;color:var(--muted)}.error{color:#d9ad70;font-size:12px}.pending{font-size:12px;color:var(--muted)}@media(max-width:900px){.comment-grid{grid-template-columns:1fr}}
</style>
