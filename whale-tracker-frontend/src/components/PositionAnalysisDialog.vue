<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { WhaleProfile } from '@/types';
import {
  analyzeUserPosition,
  type MarginMode,
  type UserPositionInput,
} from '@/utils/positionAnalysis';
import type { RecoOptions, RecoQuotes } from '@/utils/recommend';
import { readWatchedCoins } from '@/utils/watchedCoins';
import {
  directionLabel,
  formatLeverage,
  formatPct,
  formatPnl,
  formatPrice,
  formatUsd,
} from '@/utils/format';
import WhaleLocateLink from '@/components/WhaleLocateLink.vue';

const STORAGE_KEY = 'whale-tracker-pos-analysis';

function readSaved(): Partial<UserPositionInput> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as Partial<UserPositionInput>;
  } catch {
    return {};
  }
}

const props = defineProps<{
  modelValue: boolean;
  whales: WhaleProfile[];
  quotes: RecoQuotes;
  recoOptions: RecoOptions;
  defaultCoin?: string;
  preset?: Partial<UserPositionInput> | null;
}>();

const emit = defineEmits<{
  'update:modelValue': [value: boolean];
  locateWhale: [payload: { id: string; name: string; coin?: string }];
}>();

const saved = readSaved();
const coinOptions = computed(() => readWatchedCoins());
const coin = ref<string>(saved.coin || props.defaultCoin || coinOptions.value[0] || 'BTC');
const side = ref<'long' | 'short'>(saved.side || 'long');
const marginMode = ref<MarginMode>(saved.marginMode === 'cross' ? 'cross' : 'isolated');
const leverage = ref(saved.leverage || 20);
const marginUsd = ref(saved.marginUsd || 500);
const accountEquityUsd = ref(saved.accountEquityUsd || saved.marginUsd || 500);
const entryPx = ref(saved.entryPx || 0);

watch(
  () => [props.modelValue, props.preset] as const,
  ([open, preset]) => {
    if (!open) return;
    if (preset) {
      if (preset.coin) coin.value = preset.coin;
      if (preset.side) side.value = preset.side;
      if (preset.marginMode) marginMode.value = preset.marginMode;
      if (preset.leverage) leverage.value = preset.leverage;
      if (preset.marginUsd) marginUsd.value = preset.marginUsd;
      if (preset.accountEquityUsd) accountEquityUsd.value = preset.accountEquityUsd;
      if (preset.entryPx) entryPx.value = preset.entryPx;
      return;
    }
    if (props.defaultCoin) coin.value = props.defaultCoin;
    if (!entryPx.value) {
      const spot = Number(props.quotes[coin.value]) || 0;
      if (spot > 0) entryPx.value = spot;
    }
  },
);

watch([coin, side, marginMode, leverage, marginUsd, accountEquityUsd, entryPx], () => {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      coin: coin.value,
      side: side.value,
      marginMode: marginMode.value,
      leverage: leverage.value,
      marginUsd: marginUsd.value,
      accountEquityUsd: accountEquityUsd.value,
      entryPx: entryPx.value,
    }),
  );
});

watch(marginMode, (mode) => {
  if (mode === 'cross' && accountEquityUsd.value < marginUsd.value) {
    accountEquityUsd.value = marginUsd.value;
  }
});

const input = computed<UserPositionInput>(() => ({
  coin: coin.value,
  side: side.value,
  marginMode: marginMode.value,
  leverage: Math.max(1, leverage.value || 1),
  marginUsd: Math.max(0, marginUsd.value || 0),
  accountEquityUsd:
    marginMode.value === 'cross'
      ? Math.max(0, accountEquityUsd.value || marginUsd.value || 0)
      : undefined,
  entryPx: Math.max(0, entryPx.value || 0),
}));

const result = computed(() =>
  analyzeUserPosition(input.value, props.whales, props.quotes, props.recoOptions),
);

function close() {
  emit('update:modelValue', false);
}

function fillSpot() {
  const spot = Number(props.quotes[coin.value]) || 0;
  if (spot > 0) entryPx.value = spot;
}
</script>

<template>
  <el-dialog
    :model-value="modelValue"
    width="920px"
    append-to-body
    class="pos-analysis-dialog"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <template #header>
      <div class="dlg-head">
        <span class="dlg-title">仓位分析</span>
        <span class="dlg-sub">输入你的持仓，与当前巨鲸综合数据对比</span>
      </div>
    </template>

    <div class="layout">
      <section class="form-panel">
        <h4>我的仓位</h4>
        <div class="form-grid">
          <label>
            <span>币种</span>
            <el-select v-model="coin" class="full">
              <el-option v-for="id in coinOptions" :key="id" :label="id" :value="id" />
            </el-select>
          </label>
          <label>
            <span>方向</span>
            <el-radio-group v-model="side" class="dir-group full">
              <el-radio-button value="long">做多</el-radio-button>
              <el-radio-button value="short">做空</el-radio-button>
            </el-radio-group>
          </label>
          <label>
            <span>保证金模式</span>
            <el-radio-group v-model="marginMode" class="dir-group full">
              <el-radio-button value="isolated">逐仓</el-radio-button>
              <el-radio-button value="cross">全仓</el-radio-button>
            </el-radio-group>
          </label>
          <label>
            <span>杠杆</span>
            <el-input-number v-model="leverage" class="full" :min="1" :max="125" :step="1" controls-position="right" />
          </label>
          <label>
            <span>保证金 (U)</span>
            <el-input-number v-model="marginUsd" class="full" :min="1" :step="50" controls-position="right" />
          </label>
          <label v-if="marginMode === 'cross'">
            <span>账户权益 (U)</span>
            <el-input-number
              v-model="accountEquityUsd"
              class="full"
              :min="marginUsd"
              :step="50"
              controls-position="right"
            />
            <span class="field-hint">全仓爆仓价按账户总权益估算</span>
          </label>
          <label class="wide">
            <span>开仓价</span>
            <div class="entry-row">
              <el-input-number
                v-model="entryPx"
                class="entry-input"
                :min="0"
                :step="1"
                :precision="2"
                controls-position="right"
              />
              <button class="ghost-btn" type="button" @click="fillSpot">填入现价</button>
            </div>
          </label>
        </div>
        <div class="user-card">
          <div class="user-row">
            <span class="dim">模式</span>
            <strong>{{ result.user.marginMode === 'cross' ? '全仓' : '逐仓' }}</strong>
          </div>
          <div class="user-row">
            <span class="dim">名义价值</span>
            <strong>{{ formatUsd(result.user.notionalUsd) }}</strong>
          </div>
          <div class="user-row">
            <span class="dim">现价</span>
            <strong>{{ result.user.spot ? formatPrice(result.user.spot) : '--' }}</strong>
          </div>
          <div class="user-row">
            <span class="dim">强平价</span>
            <strong>
              {{
                result.user.liquidationPx && result.user.liquidationPx > 0
                  ? formatPrice(result.user.liquidationPx)
                  : '--'
              }}
            </strong>
          </div>
          <div class="user-row">
            <span class="dim">浮盈</span>
            <strong
              :class="{
                up: result.user.pnlPct != null && result.user.pnlPct > 0,
                down: result.user.pnlPct != null && result.user.pnlPct < 0,
              }"
            >
              {{
                result.user.pnlPct == null
                  ? '--'
                  : `${formatPct(result.user.pnlPct)} (${formatPnl(result.user.pnlUsd || 0)})`
              }}
            </strong>
          </div>
        </div>
      </section>

      <section class="result-panel">
        <div class="verdict" :class="result.compare.alignLevel">
          <strong>{{ result.compare.alignLabel }}</strong>
          <p>{{ result.compare.summary }}</p>
        </div>

        <div class="metric-grid">
          <div class="metric">
            <span class="dim">巨鲸多空比</span>
            <strong>
              <span class="up">多 {{ result.whale.longPct }}%</span>
              /
              <span class="down">空 {{ result.whale.shortPct }}%</span>
            </strong>
          </div>
          <div class="metric">
            <span class="dim">同向占比</span>
            <strong>{{ result.compare.sameSidePct }}%</strong>
          </div>
          <div class="metric">
            <span class="dim">同向均价</span>
            <strong>
              {{
                result.whale.avgEntrySameSide
                  ? formatPrice(result.whale.avgEntrySameSide)
                  : '--'
              }}
            </strong>
          </div>
          <div class="metric">
            <span class="dim">开仓偏离</span>
            <strong
              :class="{
                up: result.compare.entryGapPct != null && result.compare.entryGapPct < 0,
                down: result.compare.entryGapPct != null && result.compare.entryGapPct > 0,
              }"
            >
              {{
                result.compare.entryGapPct == null
                  ? '--'
                  : formatPct(result.compare.entryGapPct)
              }}
            </strong>
          </div>
          <div class="metric">
            <span class="dim">你vs巨鲸的爆仓距离对比</span>
            <strong
              :class="{
                up: result.compare.userLiqDistPct != null && result.compare.whaleLiqDistPct != null
                  && result.compare.userLiqDistPct >= result.compare.whaleLiqDistPct,
                down: result.compare.userLiqDistPct != null && result.compare.whaleLiqDistPct != null
                  && result.compare.userLiqDistPct < result.compare.whaleLiqDistPct,
              }"
            >
              {{ result.compare.liqDistLabel }}
            </strong>
          </div>
          <div class="metric">
            <span class="dim">名义占比</span>
            <strong>
              {{
                result.compare.notionalSharePct == null
                  ? '--'
                  : `${result.compare.notionalSharePct.toFixed(2)}%`
              }}
            </strong>
          </div>
        </div>

        <ul class="bullets">
          <li v-for="(line, index) in result.compare.bullets" :key="index">{{ line }}</li>
        </ul>

        <div v-if="result.compare.peers.length" class="peers">
          <h4>同向巨鲸参考（开仓价接近度）</h4>
          <div class="peer-table">
            <div class="peer-head">
              <span>巨鲸</span>
              <span>方向</span>
              <span>开仓价</span>
              <span>杠杆</span>
              <span>名义</span>
              <span>浮盈</span>
              <span>与你价差</span>
            </div>
            <div v-for="(peer, index) in result.compare.peers" :key="index" class="peer-row">
              <WhaleLocateLink
                :id="peer.id"
                :name="peer.name"
                :whales="whales"
                :coin="coin"
                @locate="emit('locateWhale', $event)"
              />
              <span :class="side">{{ directionLabel(side) }}</span>
              <span>{{ formatPrice(peer.entryPx) }}</span>
              <span>{{ formatLeverage(peer.leverage) }}</span>
              <span>{{ formatUsd(peer.usd) }}</span>
              <span
                :class="{
                  up: peer.pnlPct != null && peer.pnlPct > 0,
                  down: peer.pnlPct != null && peer.pnlPct < 0,
                }"
              >
                {{ peer.pnlPct == null ? '--' : formatPct(peer.pnlPct) }}
              </span>
              <span
                :class="{
                  up: peer.entryGapPct != null && peer.entryGapPct < 0,
                  down: peer.entryGapPct != null && peer.entryGapPct > 0,
                }"
              >
                {{ peer.entryGapPct == null ? '--' : formatPct(peer.entryGapPct) }}
              </span>
            </div>
          </div>
        </div>
        <el-empty
          v-else
          description="当前筛选条件下暂无同向巨鲸仓位"
          :image-size="56"
        />
      </section>
    </div>

    <template #footer>
      <el-button @click="close">关闭</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.dlg-head {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.dlg-title {
  font-size: 18px;
  font-weight: 700;
}
.dlg-sub {
  color: var(--muted);
  font-size: 13px;
}
.layout {
  display: grid;
  grid-template-columns: minmax(300px, 320px) minmax(0, 1fr);
  gap: 18px;
  align-items: start;
}
.form-panel,
.result-panel {
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-width: 0;
}
.form-panel {
  padding: 14px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: color-mix(in srgb, var(--card) 92%, transparent);
}
.form-panel h4,
.peers h4 {
  margin: 0;
  font-size: 15px;
  font-weight: 700;
}
.form-grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: 14px;
}
.form-grid label {
  display: flex;
  flex-direction: column;
  gap: 8px;
  font-size: 13px;
  font-weight: 600;
  color: var(--muted);
}
.form-grid label.wide {
  grid-column: 1 / -1;
}
.form-grid :deep(.full) {
  width: 100%;
}
.form-grid :deep(.el-select),
.form-grid :deep(.el-input-number) {
  width: 100%;
}
.form-grid :deep(.el-input-number .el-input__inner) {
  text-align: left;
}
.dir-group {
  display: flex;
  width: 100%;
}
.dir-group :deep(.el-radio-button) {
  flex: 1;
}
.dir-group :deep(.el-radio-button__inner) {
  width: 100%;
  padding: 10px 12px;
  font-weight: 700;
}
.entry-row {
  display: flex;
  gap: 10px;
  align-items: stretch;
}
.entry-input {
  flex: 1;
  min-width: 0;
}
.ghost-btn {
  flex: 0 0 auto;
  border: 1px solid var(--border);
  background: color-mix(in srgb, var(--accent) 10%, transparent);
  color: var(--accent);
  border-radius: 8px;
  padding: 0 14px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
}
.ghost-btn:hover {
  border-color: var(--accent);
}
.user-card {
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 14px 14px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  background: color-mix(in srgb, var(--card) 70%, #000 6%);
}
.user-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 10px;
  font-size: 14px;
}
.user-row strong {
  font-size: 15px;
}
.result-panel {
  min-height: 100%;
}
.verdict {
  border-radius: 12px;
  padding: 14px 16px;
  border: 1px solid var(--border);
}
.verdict strong {
  font-size: 16px;
}
.verdict.strong {
  background: color-mix(in srgb, var(--bull) 14%, var(--card));
  border-color: color-mix(in srgb, var(--bull) 30%, var(--border));
}
.verdict.mixed {
  background: color-mix(in srgb, #e6a23c 14%, var(--card));
  border-color: color-mix(in srgb, #e6a23c 30%, var(--border));
}
.verdict.contrarian {
  background: color-mix(in srgb, var(--bear) 14%, var(--card));
  border-color: color-mix(in srgb, var(--bear) 30%, var(--border));
}
.verdict p {
  margin: 6px 0 0;
  font-size: 13px;
  color: var(--muted);
  line-height: 1.5;
}
.metric-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
}
.metric {
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 13px;
}
.metric strong {
  font-size: 15px;
}
.bullets {
  margin: 0;
  padding-left: 18px;
  color: var(--muted);
  font-size: 13px;
  line-height: 1.55;
}
.peer-table {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
}
.peer-head,
.peer-row {
  display: grid;
  grid-template-columns: 1.2fr 0.6fr 0.9fr 0.6fr 0.8fr 0.7fr 0.8fr;
  gap: 6px;
  align-items: center;
}
.peer-head {
  color: var(--muted);
  font-size: 11px;
}
.peer-row {
  padding: 6px 0;
  border-top: 1px solid var(--border);
}
.dim {
  color: var(--muted);
}
.field-hint {
  font-size: 12px;
  font-weight: 500;
  color: var(--muted);
  line-height: 1.4;
}
.up,
.long {
  color: var(--bull);
}
.down,
.short {
  color: var(--bear);
}
@media (max-width: 768px) {
  .layout {
    grid-template-columns: 1fr;
  }
  .metric-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .peer-head,
  .peer-row {
    grid-template-columns: 1fr 1fr;
    gap: 4px;
  }
}
</style>
