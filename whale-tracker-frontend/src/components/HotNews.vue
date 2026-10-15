<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import { http } from '@/api';
import AdaptivePage from './mobile/AdaptivePage.vue';
import NewsAiChat from './NewsAiChat.vue';
const props = defineProps<{ active: boolean; mobile: boolean }>();
type Item = { id:string; title:string; summary:string; publishedAt:number; source:string; url:string; category:string; important:boolean };
type Snapshot = { items:Item[]; updatedAt:number|null; stale:boolean; warning:string; ranking:string };
const snapshot=ref<Snapshot|null>(null), error=ref(''), loading=ref(false), limit=ref(10);
const selected=ref<Item|null>(null), detailOpen=ref(false), visible=ref(!document.hidden);
const rows=computed(()=>snapshot.value?.items.slice(0,limit.value)||[]);
let controller:AbortController|undefined,timer:ReturnType<typeof setTimeout>|undefined,generation=0,lastReadAt=0;
function date(at:number|null){return at?new Date(at).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}):'时间未知';}
function time(at:number){return new Date(at).toLocaleTimeString('zh-CN',{timeZone:'Asia/Shanghai',hour:'2-digit',minute:'2-digit',hour12:false});}
function categoryClass(category:string){return ({'宏观':'macro','科技':'tech','财经':'finance','加密':'crypto','全球市场':'global'} as Record<string,string>)[category] || 'finance';}
function safeUrl(raw:string){try{const u=new URL(raw);return u.protocol==='https:'&&!u.username&&!u.password?u.href:'';}catch{return '';}}
function schedule(delay=60000){clearTimeout(timer);if(props.active&&visible.value)timer=setTimeout(()=>void load(),delay);}
async function load(){
  if(!props.active||!visible.value||controller)return;
  const remaining=60000-(Date.now()-lastReadAt);
  if(snapshot.value&&remaining>0){schedule(remaining);return;}
  const version=++generation,request=controller=new AbortController();loading.value=!snapshot.value;
  try{
    const {data}=await http.get<Snapshot>('/news/hot',{signal:request.signal,timeout:11000});
    if(version!==generation)return;
    snapshot.value=data;lastReadAt=Date.now();error.value='';
  }catch(e){if(version===generation&&!request.signal.aborted)error.value=e instanceof Error?e.message:'热点新闻读取失败';}
  finally{if(version===generation){loading.value=false;controller=undefined;schedule();}}
}
function visibility(){visible.value=!document.hidden;}
document.addEventListener('visibilitychange',visibility);
watch([()=>props.active,visible],([active,onScreen])=>{
  clearTimeout(timer);generation++;controller?.abort();controller=undefined;loading.value=false;
  if(active&&onScreen)void load();else detailOpen.value=false;
},{immediate:true});
onUnmounted(()=>{generation++;clearTimeout(timer);controller?.abort();document.removeEventListener('visibilitychange',visibility);});
function open(item:Item){selected.value=item;detailOpen.value=true;}
</script>
<template>
<section class="hot-news" :class="{'is-mobile':mobile}" aria-label="热点新闻">
  <div class="hot-content">
  <header class="hot-heading">
    <div class="hot-heading-group">
      <div class="hot-heading-title"><svg class="hot-icon" aria-hidden="true" viewBox="0 0 24 24"><path d="M4 6h16M4 12h16M4 18h16"/></svg><h2>重要事件</h2></div>
      <span class="hot-badge">HOT NEWS</span>
      <span class="hot-status">{{ snapshot?.stale?'缓存资料':'财经快讯' }}<template v-if="snapshot?.updatedAt"> · {{ date(snapshot.updatedAt) }} 更新</template></span>
    </div>
    <button v-if="(snapshot?.items.length||0)>limit" class="hot-more" @click="limit=Math.min(60,limit+20)">查看更多 <span aria-hidden="true">›</span></button><button v-else-if="limit>10" class="hot-more" @click="limit=10">收起</button>
  </header>
  <p v-if="error||snapshot?.warning" class="hot-warning" role="status">{{ error||snapshot?.warning }}<button v-if="error" @click="load">重试</button></p>
  <p v-if="loading" class="hot-empty" role="status">正在读取热点新闻…</p>
  <p v-else-if="!rows.length" class="hot-empty">暂未取得可用快讯，稍后自动重试。</p>
  <ol v-else class="hot-list">
    <li v-for="(item,index) in rows" :key="item.id"><button class="hot-item" @click="open(item)" :title="item.title">
      <span class="hot-rank" :class="{prominent:index<3}">{{ String(index+1).padStart(2,'0') }}</span>
      <div class="hot-item-body"><div class="hot-title" :class="{important:item.important}">{{ item.title }}</div><div class="hot-item-meta"><span class="hot-category" :class="'tag-'+categoryClass(item.category)">{{ item.category }}</span><time :datetime="new Date(item.publishedAt).toISOString()" :title="date(item.publishedAt)+'（北京时间）'">{{ time(item.publishedAt) }}</time><span class="hot-source" :title="item.source">{{ item.source }}</span></div></div>
    </button></li>
  </ol>
  <p v-if="rows.length" class="hot-footnote"><svg aria-hidden="true" viewBox="0 0 20 20"><circle cx="10" cy="10" r="7.5"/><path d="M10 9v5M10 5.5v1"/></svg><span>{{ snapshot?.ranking }} · 点击标题查看摘要与原文</span></p>
  </div>
  <AdaptivePage v-model="detailOpen" :mobile="mobile" title="热点新闻" width="min(720px,94vw)" append-to-body destroy-on-close>
    <article v-if="selected" class="hot-detail"><p class="hot-meta">{{ selected.source }} · {{ date(selected.publishedAt) }} · {{ selected.category }}</p><h2>{{ selected.title }}</h2><p class="hot-summary">{{ selected.summary||'来源未提供摘要，请查看原文。' }}</p><a v-if="safeUrl(selected.url)" :href="safeUrl(selected.url)" target="_blank" rel="noopener noreferrer">阅读来源原文 ↗</a><NewsAiChat :active="active&&detailOpen" symbol="" :title="selected.title" :summary="selected.summary" :url="selected.url" :published-at="selected.publishedAt"/></article>
  </AdaptivePage>
</section>
</template>
<style scoped>
.hot-news {
  --hot-panel: #131823;
  --hot-hover: #242c3d;
  --hot-text: #e2e8f0;
  --hot-sub: #8f9bb3;
  --hot-muted: #8190a7;
  --hot-border: #2a2f3e;
  --hot-blue: #3b82f6;
  --hot-yellow: #f59e0b;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  min-height: 0;
  padding: 22px 20px;
  color: var(--hot-text);
  overflow: auto;
  overscroll-behavior: contain;
  scrollbar-width: thin;
  scrollbar-color: var(--hot-border) transparent;
  container-type: inline-size;
}
.hot-content { width: 100%; max-width: 800px; margin: 0 auto; flex: none; min-width: 0; }
.hot-heading { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; margin-bottom: 20px; }
.hot-heading-group { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 12px; min-width: 0; }
.hot-heading-title { display: flex; align-items: center; gap: 8px; }
.hot-heading h2 { margin: 0; font-size: 20px; line-height: 1.5; font-weight: 700; white-space: nowrap; }
.hot-icon { width: 20px; height: 20px; color: var(--hot-blue); fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; flex: none; }
.hot-badge { font-size: 10px; font-weight: 600; color: var(--hot-yellow); background: rgba(245,158,11,.15); padding: 3px 8px; border-radius: 4px; letter-spacing: .5px; white-space: nowrap; }
.hot-status { color: var(--hot-muted); font-size: 11px; font-family: Consolas, monospace; line-height: 1.7; }
.hot-more { flex: none; padding: 6px 0; border: 0; background: none; color: var(--hot-sub); font: inherit; font-size: 12px; white-space: nowrap; cursor: pointer; }
.hot-more span { margin-left: 3px; }
.hot-more:hover { color: var(--hot-blue); }
.hot-list { padding: 0; margin: 0; list-style: none; display: flex; flex-direction: column; gap: 10px; }
.hot-list li { min-width: 0; }
.hot-item { box-sizing: border-box; display: flex; align-items: flex-start; gap: 16px; width: 100%; padding: 16px 20px; text-align: left; background: var(--hot-panel); border: 1px solid var(--hot-border); border-radius: 8px; font: inherit; color: var(--hot-text); cursor: pointer; transition: background .18s, border-color .18s, transform .18s; }
.hot-item:focus-visible,.hot-more:focus-visible { outline: 2px solid var(--hot-blue); outline-offset: 3px; }
.hot-rank { width: 28px; padding-top: 2px; color: var(--hot-blue); opacity: .8; font: 700 16px/1.5 Consolas, monospace; font-variant-numeric: tabular-nums; flex: none; }
.hot-rank.prominent { opacity: 1; }
.hot-item-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 10px; }
.hot-title { font-size: 15px; font-weight: 600; line-height: 1.6; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; }
.hot-title.important { font-weight: 700; }
.hot-item-meta { display: flex; align-items: center; flex-wrap: wrap; gap: 6px 16px; font-size: 11px; line-height: 1.5; color: var(--hot-muted); }
.hot-category { padding: 2px 8px; border-radius: 4px; font-weight: 500; font-size: 11px; white-space: nowrap; }
.tag-macro { background: rgba(6,182,212,.15); color: #06b6d4; }
.tag-tech { background: rgba(168,85,247,.15); color: #c084fc; }
.tag-finance { background: rgba(245,158,11,.15); color: var(--hot-yellow); }
.tag-crypto { background: rgba(0,230,118,.12); color: #00e676; }
.tag-global { background: rgba(59,130,246,.15); color: #60a5fa; }
.hot-item-meta time { font-family: Consolas, monospace; font-variant-numeric: tabular-nums; white-space: nowrap; }
.hot-source { margin-left: auto; overflow-wrap: anywhere; }
.hot-empty { color: var(--hot-sub); text-align: center; font-size: 12px; padding: 35px 8px; }
.hot-warning { color: var(--hot-yellow); font-size: 12px; line-height: 1.8; border: 1px solid var(--hot-border); border-radius: 7px; padding: 9px 11px; }
.hot-warning button { background: none; color: var(--hot-blue); border: 0; cursor: pointer; padding: 4px 8px; }
.hot-footnote { display: flex; align-items: flex-start; gap: 8px; color: var(--hot-sub); font-size: 11px; line-height: 1.8; margin: 22px 0 0; padding-top: 16px; border-top: 1px solid var(--hot-border); }
.hot-footnote svg { width: 16px; height: 16px; margin-top: 2px; flex: none; fill: none; stroke: var(--hot-muted); stroke-width: 1.4; }
.hot-meta { display: flex; flex-wrap: wrap; gap: 4px 8px; font-size: 11px; line-height: 1.7; color: var(--muted); margin-top: 6px; }
.hot-detail { color: var(--text); }
.hot-detail h2 { font-size: 20px; line-height: 1.6; margin: 14px 0; }
.hot-summary { font-size: 14px; line-height: 2; white-space: pre-wrap; overflow-wrap: anywhere; }
.hot-detail>a { color: var(--accent); font-size: 13px; text-decoration: none; }
.is-mobile { padding: 12px 0 20px; }
.is-mobile .hot-heading h2 { font-size: 18px; }
.is-mobile .hot-more { padding: 8px 0; min-height: 44px; }
.is-mobile .hot-item { padding: 14px; gap: 10px; }
.is-mobile .hot-title { font-size: 14px; line-height: 1.7; -webkit-line-clamp: 3; }
.is-mobile .hot-rank { width: 24px; font-size: 15px; }
@container(max-width:480px) {
  .hot-heading-group { column-gap: 8px; }
  .hot-status { flex-basis: 100%; }
  .hot-heading h2 { font-size: 17px; }
  .hot-item { padding: 14px 12px; gap: 10px; }
  .hot-rank { width: 24px; font-size: 15px; }
  .hot-title { font-size: 14px; }
  .hot-item-meta { column-gap: 10px; }
}
@media (hover:hover) and (pointer:fine) {
  .hot-item:hover { background: var(--hot-hover); border-color: var(--hot-blue); transform: translateX(3px); }
  .hot-item:hover .hot-title { color: var(--hot-yellow); }
  .hot-item:hover .hot-rank { opacity: 1; }
}
@media (prefers-reduced-motion:reduce) {
  .hot-item { transition: none; }
  .hot-item:hover { transform: none; }
}
</style>
