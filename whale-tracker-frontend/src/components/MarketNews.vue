<script setup lang="ts">
import NewsAssetScroller from './NewsAssetScroller.vue';
import { reactive, computed, onUnmounted, ref, watch } from 'vue';
import { http } from '@/api';
import { radarClient } from '@/utils/radarRealtime';
import { newsWatch } from '@/utils/newsWatch';
import { preferredCoinsState } from '@/utils/watchedCoins';
import MobileNews from './mobile/MobileNews.vue';
import NewsAiChat from './NewsAiChat.vue';
import MarketComments, {type CommentCache} from './MarketComments.vue';
import ContractLogo from './ContractLogo.vue';

const props = defineProps<{ active: boolean; mobile?:boolean }>();
type Article = { title: string; summary: string; source: string; url: string; publishedAt: string | number | null; category?: string };
type Snapshot = { rows: Article[]; updatedAt: string | number | null; stale: boolean; warning: string; fetchedAt: number };
const commentsCache = reactive<{entries:CommentCache}>({entries:{}});
const symbol = ref('');
const selectedUrl = ref('');
const readerOpen = ref(false);
const cache = ref<Record<string, Snapshot>>({});
const pending = ref(false);
const error = ref('');
const page = ref(1);
const pageSize = 20;
let disposed = false;
let generation = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
let controller: AbortController | undefined;
const catalog = computed(() => new Map((radarClient.state.value?.catalog || []).map(a => [a.symbol, a])));
const assets = computed(() => newsWatch.value.map(id => ({
  symbol: id, name: catalog.value.get(id)?.name || id.replace(/USDT$/, ''),
  assetType: catalog.value.get(id)?.assetType || (preferredCoinsState.value.includes(id.replace(/USDT$/, '')) ? 'CRYPTO' : 'TRADFI'),
})));
const snapshot = computed(() => cache.value[symbol.value || 'all']);
const rows = computed(() => snapshot.value?.rows || []);
const pages = computed(() => Math.max(1, Math.ceil(rows.value.length / pageSize)));
const visible = computed(() => rows.value.slice((page.value - 1) * pageSize, page.value * pageSize));
const selected = computed(() => rows.value.find(n => identity(n) === selectedUrl.value) || visible.value[0]);
const assetName = computed(() => assets.value.find(a => a.symbol === symbol.value)?.name || '综合资讯');
function identity(n: Article) { return `${n.url}|${n.title}`; }
function safeUrl(raw: string) { try { const u = new URL(raw); return ['https:', 'http:'].includes(u.protocol) ? u.href : ''; } catch { return ''; } }
function date(value: string | number | null | undefined) { if (value == null) return '时间未知'; const d = new Date(value); return Number.isFinite(d.getTime()) ? d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) : '时间未知'; }
function schedule(delay = 600000) {
  clearTimeout(timer);
  if (!disposed && props.active) timer = setTimeout(() => void load(), delay);
}
async function load() {
  clearTimeout(timer);
  if (disposed || !props.active || pending.value) return;
  const key = symbol.value || 'all';
  const existing = cache.value[key];
  const age = Date.now() - (existing?.fetchedAt || 0);
  if (existing && age < 600000) { schedule(600000 - age); return; }
  pending.value = true;
  error.value = '';
  controller = new AbortController();
  const request = controller;
  const version = ++generation;
  let failed = false;
  try {
    const { data } = await http.get<{ articles?: Article[]; items?: Article[]; updatedAt?: string | number; stale?: boolean; warning?: string; error?: string }>(key === 'all' ? '/news' : '/tradfi/radar/news', { params: key === 'all' ? undefined : { symbol: key }, signal: request.signal });
    if (disposed || version !== generation) return;
    const incoming = data.articles ?? data.items;
    if (!Array.isArray(incoming)) throw new Error('新闻响应格式不正确');
    if (data.error && !incoming.length) throw new Error('暂时无法获取该标的新闻');
    const seen = new Set<string>();
    const clean = incoming.filter(n => {
      if (!n || typeof n.title !== 'string' || !n.title.trim()) return false;
      const id = identity(n); if (seen.has(id)) return false; seen.add(id); return true;
    }).slice(0, 100).map(n => ({ ...n, summary: typeof n.summary === 'string' ? n.summary : '', source: typeof n.source === 'string' ? n.source : '来源未标注', url: safeUrl(n.url) }));
    const entries = Object.entries(cache.value).filter(([id]) => id !== key).slice(-63);
    cache.value = { ...Object.fromEntries(entries), [key]: { rows: clean, updatedAt: data.updatedAt ?? null, stale: !!data.stale, warning: data.warning || data.error || '', fetchedAt: Date.now() } };
  } catch (e) {
    if (disposed || version !== generation) return;
    failed = true;
    if (!disposed && !controller?.signal.aborted && key === (symbol.value || 'all')) error.value = e instanceof Error ? e.message : '新闻获取失败，请稍后重试';
  } finally {
    if (!disposed && version === generation) { pending.value = false; schedule(failed ? 60000 : 600000); }
  }
}
watch(symbol, () => { readerOpen.value = false; page.value = 1; selectedUrl.value = ''; error.value = ''; });
watch([() => props.active, symbol], () => { generation++; controller?.abort(); pending.value = false; clearTimeout(timer); if (props.active) void load(); }, { immediate: true });
watch(assets, list => { if (symbol.value && !list.some(a => a.symbol === symbol.value)) symbol.value = ''; });
watch(pages, total => { page.value = Math.min(page.value, total); });
onUnmounted(() => { disposed = true; clearTimeout(timer); controller?.abort(); });
// Shared controller, independent PC and H5 views.
async function refreshMobile(){if(pending.value)return;const cached=snapshot.value;if(cached)cached.fetchedAt=0;await load();if(error.value)throw new Error(error.value);}
const mobileModel = reactive({ refreshMobile, commentsCache, symbol, assets, assetName, readerOpen, selectedUrl, identity, selected, rows, visible, page, pages, pending, error, snapshot, date, safeUrl, load });
export type NewsModel = typeof mobileModel;
</script>

<template>
  <MobileNews v-if="mobile" :model="mobileModel" :active="active" />
  <section v-else class="market-news" aria-label="新闻中心">
    <NewsAssetScroller :count="assets.length"><div class="asset-strip" aria-label="关注标的">
      <button class="asset-chip" :class="{ active: !symbol }" :aria-pressed="!symbol" @click="symbol = ''"><span class="overview-icon">◎</span><span>综合资讯<small>市场快讯</small></span></button>
      <button v-for="asset in assets" :key="asset.symbol" class="asset-chip" :class="{ active: symbol === asset.symbol }" :aria-pressed="symbol === asset.symbol" @click="symbol = symbol === asset.symbol ? '' : asset.symbol">
        <ContractLogo :symbol="asset.symbol" :asset-type="asset.assetType" /><span>{{ asset.name }}<small>{{ asset.symbol.replace(/USDT$/, '') }}</small></span>
      </button>
    </div>
    </NewsAssetScroller>
    <div class="news-scroll-area split-news-scroll">

      <div class="feed-status"><span>{{ assetName }} <b>{{ rows.length }}</b> 条新闻</span><span>{{ pending ? '正在更新…' : snapshot?.updatedAt ? `更新于 ${date(snapshot.updatedAt)}` : '' }}{{ snapshot?.stale ? ' · 缓存数据' : '' }}</span></div>
      <div v-if="error || snapshot?.warning" class="news-warning" role="status">{{ error || snapshot?.warning }}<span v-if="snapshot?.rows.length"> · 保留上次内容</span><button v-if="error" :disabled="pending" @click="load">重试</button></div>
      <div v-if="!rows.length" class="empty-news" :class="{'with-comments':symbol}" role="status">{{ pending ? '正在读取新闻…' : error ? '暂时无法加载新闻' : '暂时没有相关新闻' }}</div>
      <div v-else class="news-columns">
        <div class="news-feed">
          <button v-for="item in visible" :key="identity(item)" class="news-item" :class="{ selected: selected === item }" @click="selectedUrl = identity(item); readerOpen = true">
            <div class="article-meta"><span class="news-label">新闻</span><span>{{ item.source }}</span><time>{{ date(item.publishedAt) }}</time></div>
            <h2>{{ item.title }}</h2><p>{{ item.summary }}</p><span class="read-hint">阅读详情 ↗</span>
          </button>
          <div v-if="pages > 1" class="pagination"><button :disabled="page === 1" @click="page--; selectedUrl = ''">上一页</button><span>{{ page }} / {{ pages }}</span><button :disabled="page === pages" @click="page++; selectedUrl = ''">下一页</button></div>
        </div>
        <aside v-if="selected" class="news-reader" aria-label="新闻详情">
          <div class="reader-heading">新闻详情 <span>{{ selected.source }}</span></div>
          <div class="reader-content"><div class="article-meta"><span class="news-label">新闻</span><time>{{ date(selected.publishedAt) }}</time></div><h2>{{ selected.title }}</h2><p class="article-summary">{{ selected.summary || '该来源未提供摘要，请打开原文阅读。' }}</p><a v-if="safeUrl(selected.url)" :href="safeUrl(selected.url)" target="_blank" rel="noopener noreferrer" class="original-link">阅读来源原文 ↗</a><p class="source-note">展示来源提供的标题与摘要，完整内容以原文为准。</p><NewsAiChat :active="active" :symbol="symbol" :title="selected.title" :summary="selected.summary" :url="selected.url" :published-at="selected.publishedAt" /><div class="related-comments"><h3>相关评论</h3><MarketComments embedded :cache-state="commentsCache" :symbol="symbol" :active="active" /></div></div>
        </aside>
      </div>
    <div v-if="!rows.length && symbol" class="empty-related-comments"><h3>相关评论</h3><MarketComments embedded :cache-state="commentsCache" :symbol="symbol" :active="active" /></div>
    </div>
  </section>
</template>

<style scoped>
.market-news{padding:20px 24px 32px;color:var(--text);background:var(--workspace-bg);box-sizing:border-box}.market-news button{font:inherit;cursor:pointer;color:inherit}.asset-strip{display:flex;flex-wrap:nowrap;gap:10px;overflow-x:auto;overflow-y:hidden;padding:1px 3px 8px 1px;scrollbar-width:thin;margin-bottom:17px}.asset-chip{display:flex;align-items:center;gap:8px;border:1px solid var(--border);border-radius:8px;background:var(--workspace-surface);padding:10px 14px;flex:0 0 164px;min-width:164px;max-width:164px;text-align:left;font-size:12px!important;min-height:48px}.asset-chip>span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.asset-chip small{display:block;font-size:10px;color:var(--muted);margin-top:2px}.asset-chip.active{border-color:#9b7441;background:#f4b35e10;color:#f4b35e}.asset-chip:hover{border-color:#647089}.overview-icon{font-size:22px;color:#f4b35e}.feed-status{display:flex;justify-content:space-between;gap:12px;font-size:11px;color:var(--muted);padding:4px 0 13px}.feed-status b{color:var(--text);font-weight:400;margin-left:7px}.news-columns{display:grid;grid-template-columns:minmax(0,1.3fr) minmax(320px,1fr);gap:20px;align-items:start}.news-feed{min-width:0}.news-item{display:block;width:100%;text-align:left;border:1px solid var(--border);border-radius:9px;background:var(--workspace-surface);padding:18px;margin-bottom:11px}.news-item:hover{border-color:#536077}.news-item.selected{border-color:#936d3e;background:#f4b35e05}.article-meta{display:flex;align-items:center;gap:9px;flex-wrap:wrap;color:var(--muted);font-size:10px}.news-label{color:#f4b35e}.article-meta time{margin-left:auto}.news-item h2{font-size:16px;font-weight:550;line-height:1.7;margin:12px 0 7px;overflow-wrap:anywhere}.news-item p{font-size:12px;line-height:1.9;color:var(--muted);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;margin:0}.read-hint{display:block;margin-top:12px;font-size:10px;color:var(--muted)}.news-reader{border:1px solid var(--border);border-radius:10px;background:var(--workspace-surface);position:sticky;top:0;max-height:calc(100vh - 50px);overflow:auto;scrollbar-width:thin}.reader-heading{padding:16px 19px;border-bottom:1px solid var(--border);font-size:12px;display:flex;justify-content:space-between;gap:10px}.reader-heading span{color:var(--muted);font-size:11px}.reader-content{padding:22px}.reader-content h2{font-size:21px;line-height:1.75;font-weight:550;margin:16px 0;overflow-wrap:anywhere}.article-summary{font-size:13px;line-height:2;white-space:pre-line;overflow-wrap:anywhere;color:var(--text);padding:12px 15px;border-left:2px solid #9c7444;background:#f4b35e06}.original-link{display:inline-block;font-size:12px;color:#f4b35e;margin:8px 0;text-decoration:none}.source-note{color:var(--muted);font-size:10px;line-height:1.8}.related-comments{border-top:1px solid var(--border);margin-top:25px;padding-top:14px}.related-comments h3{font-size:13px;font-weight:500}.related-comments p,.related-comments small{color:var(--muted);font-size:11px}.comments-empty,.empty-news{text-align:center;padding:75px 20px;border:1px dashed var(--border);border-radius:10px;color:var(--muted)}.comments-empty h2{font-size:18px;color:var(--text);font-weight:500}.comments-empty p{font-size:13px}.comments-empty small{font-size:12px;line-height:1.8}.comment-symbol{font-size:32px;color:#9f96c8}.news-warning{font-size:12px;color:#e5b273;padding:10px 0 15px}.news-warning button{margin-left:12px;background:none;border:0;color:#f4b35e}.pagination{display:flex;justify-content:center;gap:18px;align-items:center;padding:12px;font-size:12px}.pagination button{background:var(--workspace-surface);border:1px solid var(--border);border-radius:5px;padding:6px 10px}.market-news button:disabled{opacity:.4;cursor:default}.market-news button:focus-visible,.market-news a:focus-visible{outline:2px solid #b58b53;outline-offset:2px}@media(max-width:1100px){.news-columns{grid-template-columns:minmax(0,1fr) minmax(290px,1fr);gap:14px}.market-news{padding:18px}.reader-content{padding:16px}}@media(max-width:800px){.news-columns{grid-template-columns:1fr}.news-reader{position:static;max-height:none}}

.market-news.market-news{display:flex;flex-direction:column;overflow:hidden;height:100%;min-height:0;padding-bottom:16px}.asset-strip{flex-shrink:0}.news-scroll-area{flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain;scrollbar-width:thin;padding-right:5px}.news-reader{position:static;max-height:none;overflow:visible}
.news-scroll-area.split-news-scroll{display:flex;flex-direction:column;overflow:hidden;padding-right:0}
.split-news-scroll>.feed-status,.split-news-scroll>.news-warning{flex-shrink:0}
.split-news-scroll>.empty-news{flex:1;min-height:0;overflow:auto;box-sizing:border-box}
.split-news-scroll>.news-columns{flex:1;min-height:0;grid-template-rows:minmax(0,1fr);align-items:stretch;overflow:hidden}
.split-news-scroll .news-feed,.split-news-scroll .news-reader{min-height:0;height:100%;box-sizing:border-box;overflow-y:auto;overflow-x:hidden;overscroll-behavior:contain;scrollbar-width:thin}
.split-news-scroll .news-feed{padding:2px 6px 2px 2px}
@media(max-width:800px){.split-news-scroll>.news-columns{grid-template-rows:repeat(2,minmax(0,1fr))}}
.empty-related-comments{flex:1;min-height:0;overflow:auto}.empty-related-comments h3{font-size:13px}
.split-news-scroll>.empty-news.with-comments{flex:none;padding:24px 16px;margin-bottom:16px}
</style>
