<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import {
  fetchOkxTradeBalance,
  fetchOkxTradeStatus,
  placeOkxOrder,
  type OkxOpenEvent,
  type OkxTradeBalanceDetail,
  type OkxTrader,
} from '@/api';
import { isLoggedIn } from '@/stores/auth';

const props = defineProps<{
  traderId?: string;
  trader?: OkxTrader | null;
  /** 当前选中牛人的持仓，用于一键带入合约 */
  leadPositions?: OkxOpenEvent[];
}>();

const status = ref<{ configured: boolean; simulated: boolean; base: string } | null>(null);
const loading = ref(false);
const busy = ref(false);
const error = ref('');
const balanceDetails = ref<OkxTradeBalanceDetail[]>([]);
const totalEq = ref<number | null>(null);
const lastOrderId = ref('');

const instId = ref('');
const side = ref<'buy' | 'sell'>('buy');
const posSide = ref<'long' | 'short'>('long');
const tdMode = ref<'cross' | 'isolated'>('cross');
const ordType = ref<'market' | 'limit'>('market');
const sz = ref('');
const px = ref('');
const lever = ref('5');

const titleSub = computed(() => {
  if (!status.value) return '检测交易配置…';
  if (!status.value.configured) return '未配置 API Key';
  return status.value.simulated ? '模拟盘' : '实盘';
});

const usdtAvail = computed(() => {
  const row = balanceDetails.value.find((d) => d.ccy === 'USDT');
  return row ? row.availBal : null;
});

async function refreshMeta() {
  error.value = '';
  try {
    status.value = await fetchOkxTradeStatus();
  } catch (err) {
    error.value = err instanceof Error ? err.message : '状态加载失败';
  }
}

async function refreshAccount() {
  if (!isLoggedIn.value) {
    error.value = '请先登录后再使用交易功能';
    return;
  }
  if (!status.value?.configured) {
    await refreshMeta();
    if (!status.value?.configured) {
      error.value = '请在后端 .env 配置 OKX_API_KEY / SECRET / PASSPHRASE';
      return;
    }
  }
  loading.value = true;
  error.value = '';
  try {
    const bal = await fetchOkxTradeBalance('USDT');
    balanceDetails.value = bal.balance?.details || [];
    totalEq.value = bal.balance?.totalEq ?? null;
    status.value = {
      configured: bal.configured,
      simulated: bal.simulated,
      base: bal.base,
    };
  } catch (err) {
    error.value = err instanceof Error ? err.message : '账户加载失败';
  } finally {
    loading.value = false;
  }
}

function applyLeadPosition(pos: OkxOpenEvent) {
  instId.value = pos.instId || '';
  if (pos.side === 'short') {
    side.value = 'sell';
    posSide.value = 'short';
  } else {
    side.value = 'buy';
    posSide.value = 'long';
  }
  tdMode.value = pos.mgnMode === 'isolated' ? 'isolated' : 'cross';
  if (pos.lever) lever.value = String(pos.lever);
  ordType.value = 'market';
}

function syncFromLead() {
  const list = props.leadPositions || [];
  if (!list.length) {
    ElMessage.info('当前交易员暂无持仓可带入');
    return;
  }
  applyLeadPosition(list[0]);
  ElMessage.success(`已带入 ${list[0].instId}`);
}

watch(
  () => [props.traderId, props.leadPositions] as const,
  () => {
    const list = props.leadPositions || [];
    if (list[0]?.instId && !instId.value) applyLeadPosition(list[0]);
  },
  { immediate: true },
);

async function submitOrder() {
  if (!isLoggedIn.value) {
    ElMessage.warning('请先登录');
    return;
  }
  if (!instId.value.trim() || !sz.value.trim()) {
    ElMessage.warning('请填写合约与数量');
    return;
  }
  const modeLabel = status.value?.simulated ? '模拟盘' : '实盘';
  try {
    await ElMessageBox.confirm(
      `${modeLabel}下单\n${instId.value}\n${side.value} / ${posSide.value}\n${ordType.value} sz=${sz.value}` +
        (ordType.value === 'limit' ? ` px=${px.value}` : ''),
      '确认下单',
      { confirmButtonText: '下单', cancelButtonText: '取消', type: 'warning' },
    );
  } catch {
    return;
  }
  busy.value = true;
  error.value = '';
  try {
    const data = await placeOkxOrder({
      instId: instId.value.trim(),
      side: side.value,
      posSide: posSide.value,
      tdMode: tdMode.value,
      ordType: ordType.value,
      sz: sz.value.trim(),
      px: ordType.value === 'limit' ? px.value.trim() : undefined,
      lever: lever.value,
    });
    const ordId = String((data.order && (data.order.ordId || data.order.clOrdId)) || '');
    lastOrderId.value = ordId;
    ElMessage.success(ordId ? `下单成功 ${ordId}` : '下单成功');
    // 刷新账户单独做，失败不影响「已下单」结论（OKX 偶发超时）
    void refreshAccount().catch(() => undefined);
  } catch (err) {
    const msg = err instanceof Error ? err.message : '下单失败';
    error.value = msg === 'TIMEOUT' ? '下单请求超时，请到模拟盘持仓里确认是否已成交' : msg;
    ElMessage.error(error.value);
  } finally {
    busy.value = false;
  }
}

onMounted(async () => {
  await refreshMeta();
  if (isLoggedIn.value && status.value?.configured) {
    await refreshAccount();
  }
});

watch(isLoggedIn, (ok) => {
  if (ok) void refreshAccount();
});
</script>

<template>
  <section class="okx-order">
    <header class="panel-head">
      <div class="titles">
        <h3>开单</h3>
        <p class="sub">
          <span :class="{ sim: status?.simulated, live: status && !status.simulated }">
            {{ titleSub }}
          </span>
          <template v-if="traderId"> · {{ trader?.name || traderId }}</template>
        </p>
      </div>
      <button type="button" class="ghost" :disabled="loading || busy" @click="refreshAccount">
        {{ loading ? '…' : '账户' }}
      </button>
    </header>

    <div class="body">
      <p v-if="error" class="err">{{ error }}</p>

      <div v-if="!isLoggedIn" class="hint">登录后可下单；密钥仅保存在服务器 .env。</div>

      <div v-else-if="status && !status.configured" class="hint">
        在 <code>whale-tracker-backend/.env</code> 填写：
        <br />OKX_API_KEY / OKX_API_SECRET / OKX_API_PASSPHRASE
        <br />并保持 <code>OKX_TRADE_SIMULATED=1</code>（模拟盘），然后重启后端。
      </div>

      <template v-else>
        <div class="bal">
          <span>权益 {{ totalEq != null ? totalEq.toFixed(2) : '—' }}</span>
          <span>USDT 可用 {{ usdtAvail != null ? usdtAvail.toFixed(2) : '—' }}</span>
        </div>

        <div class="row">
          <button type="button" class="ghost sm" @click="syncFromLead">带入牛人持仓</button>
        </div>

        <label class="field">
          <span>合约 instId</span>
          <input v-model="instId" placeholder="BTC-USDT-SWAP" />
        </label>

        <div class="grid2">
          <label class="field">
            <span>方向 side</span>
            <select v-model="side">
              <option value="buy">buy 买入</option>
              <option value="sell">sell 卖出</option>
            </select>
          </label>
          <label class="field">
            <span>持仓 posSide</span>
            <select v-model="posSide">
              <option value="long">long 多</option>
              <option value="short">short 空</option>
            </select>
          </label>
        </div>

        <div class="grid2">
          <label class="field">
            <span>保证金</span>
            <select v-model="tdMode">
              <option value="cross">全仓 cross</option>
              <option value="isolated">逐仓 isolated</option>
            </select>
          </label>
          <label class="field">
            <span>杠杆</span>
            <input v-model="lever" type="number" min="1" max="125" />
          </label>
        </div>

        <div class="grid2">
          <label class="field">
            <span>类型</span>
            <select v-model="ordType">
              <option value="market">市价</option>
              <option value="limit">限价</option>
            </select>
          </label>
          <label class="field">
            <span>数量 sz（张）</span>
            <input v-model="sz" placeholder="1" />
          </label>
        </div>

        <label v-if="ordType === 'limit'" class="field">
          <span>价格 px</span>
          <input v-model="px" placeholder="限价" />
        </label>

        <button type="button" class="submit" :disabled="busy || loading" @click="submitOrder">
          {{ busy ? '提交中…' : status?.simulated ? '模拟下单' : '实盘下单' }}
        </button>

        <p v-if="lastOrderId" class="hint">最近订单：{{ lastOrderId }}</p>
      </template>
    </div>
  </section>
</template>

<style scoped>
.okx-order {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: #121821;
  border: 1px solid #1e2630;
  border-radius: 12px;
  overflow: hidden;
  color: #e0e3eb;
}
.panel-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
  padding: 10px 12px 8px;
  border-bottom: 1px solid var(--okx-border, #1e2630);
  flex-shrink: 0;
}
.titles {
  min-width: 0;
}
.panel-head h3 {
  margin: 0;
  font-size: 15px;
  font-weight: 700;
}
.panel-head .sub {
  margin: 4px 0 0;
  font-size: 11px;
  color: var(--okx-text-3, #6a7282);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sub .sim {
  color: #f0b429;
}
.sub .live {
  color: #f87171;
}
.body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 10px 12px 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.hint {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--okx-text-2, #a0a8b8);
}
.hint code {
  font-size: 11px;
  color: #e8edf5;
}
.err {
  margin: 0;
  font-size: 12px;
  color: #f87171;
}
.bal {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  font-size: 11px;
  color: var(--okx-text-2, #a0a8b8);
}
.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 11px;
  color: var(--okx-text-3, #6a7282);
}
.field input,
.field select {
  height: 28px;
  border: 1px solid #1e2630;
  border-radius: 4px;
  background: #0a0e14;
  color: #e0e3eb;
  font: inherit;
  font-size: 12px;
  padding: 0 8px;
}
.grid2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}
.ghost {
  border: 0;
  border-radius: 4px;
  padding: 4px 8px;
  background: #1a222e;
  color: #b0c4de;
  font: inherit;
  font-size: 11px;
  cursor: pointer;
}
.ghost.sm {
  align-self: flex-start;
}
.ghost:hover:not(:disabled) {
  color: #f0f4fa;
}
.ghost:disabled {
  opacity: 0.5;
  cursor: wait;
}
.submit {
  margin-top: 4px;
  height: 32px;
  border: 0;
  border-radius: 6px;
  background: color-mix(in srgb, #f0b429 35%, #1a222e);
  color: #fff8e6;
  font: inherit;
  font-size: 13px;
  font-weight: 700;
  cursor: pointer;
}
.submit:hover:not(:disabled) {
  background: color-mix(in srgb, #f0b429 50%, #1a222e);
}
.submit:disabled {
  opacity: 0.55;
  cursor: wait;
}
</style>
