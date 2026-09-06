<script setup lang="ts">
import { computed, ref } from 'vue';
import type { WhalePositionRiskResult } from '@/utils/whalePositionRisk';
import { formatPct, formatRelativeAgo, formatTime } from '@/utils/format';

const props = defineProps<{
  result: WhalePositionRiskResult;
  whaleLabel: string;
  coinLabel: string;
  /** 是否展开维度明细（默认收起） */
  defaultExpanded?: boolean;
}>();

const dimsOpen = ref(Boolean(props.defaultExpanded));

const sideLabel = computed(() =>
  props.result.current.direction === 'long' ? '做多' : '做空',
);

const leverageText = computed(() => {
  const lev = props.result.current.leverage;
  return lev ? `${lev}x` : '--';
});

const crowdText = computed(() => {
  const cur = props.result.current;
  if (cur.crowdRatio == null || cur.crowdDirection == null) return '方向拥挤度：数据缺失';
  const against =
    cur.crowdDirection !== 'mixed' && cur.crowdDirection !== cur.direction;
  if (against) return `逆势（同向 ${cur.crowdRatio.toFixed(0)}%）`;
  if (cur.crowdDirection === 'mixed') return `多空胶着（同向 ${cur.crowdRatio.toFixed(0)}%）`;
  return `顺势（同向 ${cur.crowdRatio.toFixed(0)}%）`;
});

const holdingText = computed(() => {
  const cur = props.result.current;
  if (cur.openHistoryComplete === false) {
    const last = cur.lastAddTimeMs
      ? formatRelativeAgo(cur.lastAddTimeMs)
      : null;
    return last
      ? `首次开仓：未知 | 最近加仓：${last}`
      : '首次开仓：未知（成交历史不完整）';
  }
  const first = cur.firstOpenTimeMs || cur.openTimeMs;
  const last = cur.lastAddTimeMs;
  if (first == null && last == null) return '持仓时间：数据缺失';
  const firstPart = first ? `首次开仓：${formatRelativeAgo(first)}` : '首次开仓：未知';
  const lastPart =
    last && last !== first ? ` | 最近加仓：${formatRelativeAgo(last)}` : '';
  const bag = cur.isPotentialBagholding ? ' ⚠️ 长期持仓，存在扛单风险' : '';
  return `${firstPart}${lastPart}${bag}`;
});

function riskTone(level: string) {
  return `tone-${level}`;
}

function credTone(color: string) {
  return `cred-${color}`;
}

function weightPct(w: number) {
  return `${Math.round(w * 100)}%`;
}
</script>

<template>
  <div class="risk-assessment">
    <div class="top-row">
      <span class="cred-pill" :class="credTone(result.credibility.color)">
        {{ result.credibility.label }}
      </span>
      <span class="risk-pill" :class="riskTone(result.tradeRisk.level)">
        风险分：{{ result.tradeRisk.score }}（{{ result.tradeRisk.levelLabel }}）
      </span>
    </div>

    <div class="meta">
      <div class="meta-line">
        <strong>巨鲸：{{ whaleLabel }}</strong>
        <span>{{ sideLabel }} {{ coinLabel }}</span>
        <span>{{ leverageText }}</span>
      </div>
      <div class="meta-line muted">
        <span>
          浮盈：{{
            result.current.unrealizedPnlPct == null
              ? '数据缺失'
              : formatPct(result.current.unrealizedPnlPct)
          }}
        </span>
        <span>
          仓位占比：{{
            result.current.positionRatio == null
              ? '数据缺失'
              : `${result.current.positionRatio.toFixed(0)}%`
          }}
        </span>
        <span>
          爆仓距离：{{
            result.current.liquidationDistance == null
              ? '数据缺失'
              : `${result.current.liquidationDistance.toFixed(0)}%`
          }}
        </span>
      </div>
      <div class="meta-line" :class="{ warn: result.current.isPotentialBagholding }">
        {{ holdingText }}
      </div>
      <div class="meta-line muted">方向：{{ crowdText }}</div>
      <div v-if="result.current.firstOpenTimeMs || result.current.lastAddTimeMs" class="meta-line muted tiny">
        <template v-if="result.current.openHistoryComplete === false">
          首次开仓时间未知
          <template v-if="result.current.lastAddTimeMs">
            · 最近加仓 {{ formatTime(result.current.lastAddTimeMs) }}
          </template>
        </template>
        <template v-else>
          首次开仓 {{ formatTime(result.current.firstOpenTimeMs || result.current.openTimeMs || 0) }}
          <template
            v-if="
              result.current.lastAddTimeMs &&
              result.current.lastAddTimeMs !== result.current.firstOpenTimeMs
            "
          >
            · 最近加仓 {{ formatTime(result.current.lastAddTimeMs) }}
          </template>
        </template>
      </div>
    </div>

    <div class="section">
      <div class="section-title">巨鲸可信度</div>
      <ul class="bullets">
        <li v-for="(b, i) in result.credibility.bullets" :key="i">{{ b }}</li>
      </ul>
    </div>

    <div class="section">
      <div class="section-title">当前交易风险评估</div>
      <p class="summary">{{ result.tradeRisk.summary }}</p>
      <ul class="warnings">
        <li v-for="(w, i) in result.tradeRisk.warnings" :key="i">{{ w }}</li>
      </ul>
      <p class="advice">建议：{{ result.followAdvice }}</p>

      <button type="button" class="dims-toggle" @click="dimsOpen = !dimsOpen">
        {{ dimsOpen ? '收起评分明细' : '展开评分明细' }}
      </button>
      <ul v-if="dimsOpen" class="dims">
        <li v-for="d in result.tradeRisk.dimensions" :key="d.key" :class="{ missing: d.missing }">
          <div class="dim-head">
            <strong>{{ d.label }}</strong>
            <span v-if="d.missing" class="dim-score miss">未计入</span>
            <span v-else class="dim-score">{{ Math.round(d.score || 0) }}/100</span>
          </div>
          <div class="dim-meta">
            权重 {{ weightPct(d.weight) }}
            <template v-if="!d.missing">
              · 有效 {{ weightPct(d.effectiveWeight) }}
            </template>
          </div>
          <div class="dim-detail">
            {{ d.missing ? d.missingLabel || '数据缺失，不纳入评分' : d.detail }}
          </div>
        </li>
      </ul>
    </div>
  </div>
</template>

<style scoped>
.risk-assessment {
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 12px;
  background: color-mix(in srgb, var(--card) 82%, transparent);
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.top-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}
.cred-pill,
.risk-pill {
  display: inline-flex;
  align-items: center;
  border-radius: 999px;
  padding: 4px 10px;
  font-size: 12px;
  font-weight: 800;
  border: 1px solid var(--border);
}
.cred-high {
  color: #67c23a;
  border-color: color-mix(in srgb, #67c23a 50%, var(--border));
  background: color-mix(in srgb, #67c23a 12%, transparent);
}
.cred-mid {
  color: #e6a23c;
  border-color: color-mix(in srgb, #e6a23c 50%, var(--border));
  background: color-mix(in srgb, #e6a23c 12%, transparent);
}
.cred-watch {
  color: var(--muted);
  background: color-mix(in srgb, var(--muted) 10%, transparent);
}
.cred-low {
  color: #f56c6c;
  border-color: color-mix(in srgb, #f56c6c 50%, var(--border));
  background: color-mix(in srgb, #f56c6c 12%, transparent);
}
.tone-low {
  color: #67c23a;
  border-color: color-mix(in srgb, #67c23a 50%, var(--border));
  background: color-mix(in srgb, #67c23a 12%, transparent);
}
.tone-medium {
  color: #e6a23c;
  border-color: color-mix(in srgb, #e6a23c 50%, var(--border));
  background: color-mix(in srgb, #e6a23c 12%, transparent);
}
.tone-high {
  color: #e6a23c;
  border-color: color-mix(in srgb, #f59e0b 55%, var(--border));
  background: color-mix(in srgb, #f59e0b 14%, transparent);
}
.tone-extreme {
  color: #f56c6c;
  border-color: color-mix(in srgb, #f56c6c 55%, var(--border));
  background: color-mix(in srgb, #f56c6c 14%, transparent);
}
.meta {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 13px;
}
.meta-line {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;
}
.meta-line.muted {
  color: var(--muted);
}
.meta-line.tiny {
  font-size: 12px;
}
.meta-line.warn {
  color: #e6a23c;
  font-weight: 700;
}
.section {
  border-top: 1px solid var(--border);
  padding-top: 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.section-title {
  font-size: 13px;
  font-weight: 800;
}
.summary,
.advice {
  margin: 0;
  font-size: 12px;
  line-height: 1.45;
}
.advice {
  font-weight: 700;
}
.summary {
  color: var(--muted);
}
.bullets,
.warnings,
.dims {
  margin: 0;
  padding-left: 16px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: var(--muted);
  line-height: 1.45;
}
.dims-toggle {
  align-self: flex-start;
  margin-top: 4px;
  border: 0;
  background: transparent;
  color: var(--accent);
  font-size: 12px;
  font-weight: 700;
  cursor: pointer;
  padding: 0;
}
.dims {
  list-style: none;
  padding: 0;
  margin-top: 4px;
  gap: 8px;
}
.dims li {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 8px 10px;
  background: color-mix(in srgb, var(--card) 70%, transparent);
}
.dims li.missing {
  opacity: 0.85;
}
.dim-head {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  color: var(--text, inherit);
  font-size: 12px;
}
.dim-score {
  font-variant-numeric: tabular-nums;
  font-weight: 800;
}
.dim-score.miss {
  color: var(--muted);
  font-weight: 600;
}
.dim-meta {
  font-size: 11px;
  color: var(--muted);
  margin-top: 2px;
}
.dim-detail {
  margin-top: 4px;
  font-size: 12px;
  color: var(--muted);
}
</style>
