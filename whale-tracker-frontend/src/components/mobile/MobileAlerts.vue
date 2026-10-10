<script setup lang="ts">
import { whaleAssetLabel, whaleAssetOptionLabel, isWhaleTradfi } from '@/utils/whaleAssetLabel';
import MobileScroll from './MobileScroll.vue';
import {ref} from 'vue';
import type {AlertsModel} from '../NewsList.vue';
import MobileSheet from './MobileSheet.vue';
defineProps<{model:AlertsModel}>();const filters=ref(false);
</script>
<template><section class="h5-alerts">
<header class="h5-tools"><span>{{model.alertWindowLabel}} · 最新 50 条</span><button @click="filters=true">筛选 {{model.alertCoinFilter==='all'?'':model.alertCoinFilter}} ⌄</button></header>
<MobileScroll :refresh="model.refreshMobile" :busy="model.alertLoading"><p v-if="!model.pagedAlerts.length" class="h5-empty">{{model.alertLoading?'正在读取异动…':model.alertEmptyText()}}</p>
<button v-for="row in model.pagedAlerts" :key="row.alert.id" class="h5-alert h5-card" @click="model.openAlert(row.alert)"><div class="h5-between"><span :class="row.view.side==='short'?'negative':'positive'">{{row.view.sideBadgeLabel}} · {{row.view.actionLabel}} <small v-if="row.closedOpen">已平仓</small></span><time>{{row.view.relativeTime}}</time></div><div class="h5-between h5-alert-value"><strong>{{whaleAssetLabel(row.view.coin)}} <el-tag v-if="isWhaleTradfi(row.view.coin)" size="small" type="info">TradFi</el-tag></strong><b>{{row.view.notionalUsd==null?'—':model.formatUsd(row.view.notionalUsd)}} <small>名义金额</small></b></div><p>成交价 {{model.formatPrice(row.view.price)}} <span v-if="model.alertFundingWarn(row)"> · 高费率</span></p><small>{{row.alert.whaleName || row.alert.address}} · 查看详情 ›</small><p v-if="row.view.verifyText">{{row.view.verifyText}}</p></button></MobileScroll>
<MobileSheet v-model="filters" title="异动筛选"><label class="h5-field">币种<select v-model="model.alertCoinFilter"><option value="all">全部币种</option><option v-for="coin in model.preferredCoins" :key="coin" :value="coin">{{whaleAssetOptionLabel(coin)}}</option></select></label><label class="h5-field">金额门槛<select v-model="model.alertMinUsd"><option v-for="opt in model.ALERT_MIN_USD_OPTIONS" :key="opt.value" :value="opt.value">{{opt.label}}</option></select></label><label class="h5-field">方向<select v-model="model.alertSideFilter"><option value="all">全部方向</option><option value="long">做多</option><option value="short">做空</option></select></label><label class="h5-field">只看开仓<input type="checkbox" v-model="model.openOnly"></label><button class="h5-primary" @click="filters=false">完成</button></MobileSheet>
</section></template>
