<script setup lang="ts">
import { computed } from 'vue';
import type { ResearchModel } from '@/composables/useContractResearch';
import ResearchSources from './ResearchSources.vue';
const props = defineProps<{ model: ResearchModel }>();
const m = computed(() => props.model);
const day = computed(() => m.value.current?.technical.frames.find(f => f.interval === '1d' && f.available));
const target = computed(() => m.value.metrics.find(v => v.id === 'targetConsensus' && !v.stale));
const spot = computed(() => m.value.metrics.find(v => v.id === 'underlyingPrice' && !v.stale));
const short = computed(() => m.value.metrics.find(v => v.id === 'squeezeRisk' && !v.stale) || m.value.metrics.find(v => v.id === 'shortInterest' && !v.stale));
const upside = computed(() => {
  const a = target.value, b = spot.value;
  return a && b && b.value > 0 && a.currency === b.currency && a.asOf === b.asOf ? (a.value / b.value - 1) * 100 : null;
});
const equity = computed(() => m.value.current?.market.category === 'EQUITY');
const recentEvents = computed(() => {
  const future = m.value.events.filter(e => m.value.eventState(e) !== '近期已发生');
  return [...future, ...m.value.events.filter(e => m.value.eventState(e) === '近期已发生').reverse()].slice(0, 3);
});
function width(value: number | null) { return Math.max(0, Math.min(100, (value ?? 0) * 10)) + '%'; }
</script>
<template>
  <div v-if="m.current" class="research-compact-overview">
    <p class="research-scope-line">{{ m.current.market.name }} · {{ m.current.horizon }} 天多空分析 · 资料回看 {{ m.current.lookbackDays || 30 }} 天 · 评分为证据支持度</p>
    <div class="research-focus-grid">
      <article class="research-card research-asset-card">
        <div class="research-card-title"><div><h2>{{ m.current.symbol.replace(/USDT$/, '') }} <small>{{ m.current.market.name }}</small></h2><p>币安 USDT 永续合约</p></div><span class="research-tag">{{ m.current.market.assetType === 'CRYPTO' ? '加密资产' : '传统资产' }}</span></div>
        <div class="research-asset-price"><strong>{{ m.num(m.current.quote?.lastPrice) }} <small>USDT</small></strong><span :class="Number(m.current.quote?.priceChangePercent) >= 0 ? 'bull' : 'bear'">{{ m.pct(m.current.quote?.priceChangePercent) }}<small>24h</small></span></div>
        <small>行情采样 {{ m.date(m.current.quote?.closeTime) }}{{ m.current.quote?.stale ? ' · 已过期' : '' }}</small>
        <div class="research-asset-metrics">
          <div><span>日线 RSI14</span><b>{{ m.num(day?.rsi, 1) }}</b></div>
          <template v-if="equity">
            <div><span>机构共识目标价</span><b>{{ target ? (target.currency === 'KRW' ? '₩' : '$') + m.num(target.value) : '—' }}</b><small>{{ target?.asOf || '待检索核对' }}</small></div>
            <div><span>目标价隐含空间</span><b>{{ m.pct(upside) }}</b><small>同日、同币种底层股价口径</small></div>
            <div><span>{{ short?.id === 'squeezeRisk' ? 'S3 轧空评分' : '股票空头占比' }}</span><b>{{ short ? m.num(short.value, 1) + (short.id === 'shortInterest' ? '%' : '') : '—' }}</b><small>{{ short?.asOf || '待检索核对' }}</small></div>
          </template>
          <template v-else-if="m.current.market.baseAsset === 'KORU'">
            <div><span>跟踪指数</span><b class="research-small-value">MSCI Korea 25/50</b></div><div><span>杠杆目标</span><b>每日 3 倍</b></div><div><span>每周损耗</span><b>非固定值</b></div>
          </template>
          <template v-else>
            <div><span>资金费率</span><b>{{ m.current.derivatives.fundingRate == null ? '—' : m.pct(m.current.derivatives.fundingRate * 100, 4) }}</b></div>
            <div><span>24h 持仓量变化</span><b>{{ m.pct(m.current.derivatives.oiChangePct) }}</b></div>
            <div><span>24h 主动买卖量比</span><b>{{ m.num(m.current.derivatives.takerRatio, 2) }}</b></div>
          </template>
        </div>
        <div class="research-compact-scores">
          <div v-for="side in (['bull','bear'] as const)" :key="side" class="research-score-line">
            <div><span>{{ side === 'bull' ? '多头综合分' : '空头综合分' }}</span><b :class="side">{{ m.range(m.scores?.[side]) }}<small v-if="m.scores?.[side]"> / 10</small></b></div>
            <div class="research-score-track"><i :class="side" :style="{ width: width(m.scores?.[side]?.low ?? null) }" /><i v-if="m.scores?.[side] && m.scores[side]!.high > m.scores[side]!.low" class="research-score-unknown" :style="{ left: width(m.scores[side]!.low), width: width(m.scores[side]!.high - m.scores[side]!.low) }" /></div>
          </div>
          <small>{{ m.scores?.label }} · 多空独立评分</small>
        </div>
        <ResearchSources v-if="equity" :model="m" :ids="[...new Set([...(target?.sourceIds || []), ...(spot?.sourceIds || []), ...(short?.sourceIds || [])])]" />
      </article>
      <article class="research-card research-dimension-summary">
        <div class="research-card-title"><h3>五维评分</h3><button class="research-text" @click="m.tab = 'evidence'">查看详情 →</button></div>
        <div class="research-dimension-columns"><span>维度 / 权重</span><span>多头</span><span>空头</span></div>
        <div v-for="row in m.dimensions" :key="row.id" class="research-dimension-line"><span>{{ row.label }} <small>{{ row.weight }}%</small></span><div v-for="side in (['bull','bear'] as const)" :key="side"><b :class="row[side] == null ? 'research-muted' : side">{{ m.num(row[side], 1) }}</b><div class="research-mini-track"><i :class="side" :style="{ width: width(row[side]) }" /></div></div></div>
        <div class="research-coverage-note"><span>资料覆盖 {{ m.scores?.coverage ?? 0 }}%</span><small>缺失项不补零</small></div>
      </article>
    </div>
    <div class="research-section-heading"><h3>近期事件</h3><button class="research-text" @click="m.tab = 'events'">全部日历 →</button></div>
    <div class="research-recent-events"><article v-for="event in recentEvents" :key="event.id" class="research-card"><time>{{ m.eventDate(event) }}</time><div><h3>{{ event.title }}</h3><p>{{ event.note || event.relation }}</p></div><span class="research-tag" :class="{ warning: event.stale }">{{ event.stale ? '日程待复核' : m.eventState(event) }}</span></article><p v-if="!recentEvents.length" class="research-quiet-empty">暂未取得相关事件，联网分析后补充有来源的资料。</p></div>
  </div>
</template>
