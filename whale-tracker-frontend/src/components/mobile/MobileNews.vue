<script setup lang="ts">
import MobileScroll from './MobileScroll.vue';
import {ref,watch,nextTick} from 'vue';
import type {NewsModel} from '../MarketNews.vue';
import ContractLogo from '../ContractLogo.vue';
import MarketComments from '../MarketComments.vue';
import NewsAiChat from '../NewsAiChat.vue';
const props=defineProps<{model:NewsModel;active:boolean}>();
const reader=ref<HTMLElement|null>(null);const back=ref<HTMLButtonElement|null>(null);let trigger:HTMLElement|null=null;
async function open(id:string,event:MouseEvent){trigger=event.currentTarget as HTMLElement;props.model.selectedUrl=id;props.model.readerOpen=true;await nextTick();if(reader.value)reader.value.scrollTop=0;back.value?.focus();}
async function close(){props.model.readerOpen=false;await nextTick();trigger?.focus();}
watch(()=>props.model.selectedUrl,()=>{if(reader.value)reader.value.scrollTop=0;});
const limit=ref(20),comments=ref<InstanceType<typeof MarketComments>|null>(null);
watch(()=>[props.model.symbol,props.model.search],()=>{limit.value=20;});
async function refresh(){if(props.model.tab==='comments')await comments.value?.refresh();else await props.model.refreshMobile();}
</script>
<template><section class="h5-news">
<div v-show="!model.readerOpen" class="h5-news-home"><nav class="h5-tabs"><button :class="{active:model.tab==='news'}" :aria-pressed="model.tab==='news'" @click="model.tab='news'">新闻</button><button :class="{active:model.tab==='comments'}" :aria-pressed="model.tab==='comments'" @click="model.tab='comments'">评论</button><input v-if="model.tab==='news'" v-model="model.search" aria-label="搜索新闻" placeholder="搜索已加载新闻"></nav>
<div class="h5-assets"><button :class="{active:!model.symbol}" :aria-pressed="!model.symbol" @click="model.symbol=''">◎ <span>综合资讯<small>市场快讯</small></span></button><button v-for="a in model.assets" :key="a.symbol" :class="{active:model.symbol===a.symbol}" :aria-pressed="model.symbol===a.symbol" @click="model.symbol=model.symbol===a.symbol?'':a.symbol"><ContractLogo :symbol="a.symbol" :asset-type="a.assetType"/><span>{{a.name}}<small>{{a.symbol.replace(/USDT$/,'')}}</small></span></button></div>
<MobileScroll :reset-key="model.symbol+model.search+model.tab" :refresh="refresh" :more="model.tab==='news'?()=>{limit+=20}:undefined" :has-more="model.tab==='news' && limit<model.rows.length" :busy="model.pending"><MarketComments ref="comments" :cache-state="model.commentsCache" v-show="model.tab==='comments'" :symbol="model.symbol" :active="active && model.tab==='comments'"/><template v-if="model.tab==='news'"><div class="h5-tools"><span>{{model.assetName}} · {{model.rows.length}} 条</span><span>{{model.pending?'更新中…':model.snapshot?.stale?'缓存数据':''}}</span></div><p v-if="model.error || model.snapshot?.warning" class="h5-notice">{{model.error || model.snapshot?.warning}} <button @click="model.load()" :disabled="model.pending">重试</button></p><p v-if="!model.rows.length" class="h5-empty">{{model.pending?'正在加载…':'暂无匹配新闻'}}</p>
<button v-for="item in model.rows.slice(0,limit)" :key="model.identity(item)" class="h5-card h5-article" @click="open(model.identity(item),$event)"><div class="h5-between"><span>{{item.source}}</span><time>{{model.date(item.publishedAt)}}</time></div><h2>{{item.title}}</h2><p>{{item.summary}}</p><small>阅读详情 ↗</small></button></template></MobileScroll></div>
<section v-if="model.readerOpen && model.selected" class="h5-reader" @keydown.esc="close"><header class="h5-reader-bar"><button ref="back" @click="close">‹ 返回</button><span>新闻详情</span><small>{{model.selected.source}}</small></header><div ref="reader" class="h5-scroll"><small>{{model.date(model.selected.publishedAt)}}</small><h1>{{model.selected.title}}</h1><p class="h5-summary">{{model.selected.summary || '该来源未提供摘要，请查看原文。'}}</p><a v-if="model.safeUrl(model.selected.url)" :href="model.safeUrl(model.selected.url)" target="_blank" rel="noopener noreferrer">阅读来源原文 ↗</a><p class="h5-muted">完整内容以来源原文为准。</p><NewsAiChat :active="active" :symbol="model.symbol" :title="model.selected.title" :summary="model.selected.summary" :url="model.selected.url" :published-at="model.selected.publishedAt"/><button class="h5-discuss" @click="model.tab='comments'">查看标的相关评论 →</button></div></section>
</section></template>
