<script setup lang="ts">
import { ref } from 'vue';
import { ElMessage } from 'element-plus';
import { isLoggedIn } from '@/stores/auth';
import { aiKeyHint, bindAiKey, refreshAiKeyStatus } from '@/stores/aiKey';
import { deleteBinanceKeys, deleteOkxKeys, fetchOkxKeys, saveBinanceKeys, saveOkxKeys } from '@/api';

defineProps<{
  variant?: 'default' | 'sidebar';
}>();

const visible = ref(false);
const activeApiTab = ref<'deepseek' | 'okx' | 'binance'>('deepseek');
const saving = ref(false);
const deepseekInput = ref('');
const okxKey = ref('');
const okxSecret = ref('');
const okxPass = ref('');
const okxSimulated = ref(true);
const okxHint = ref('');
const okxReady = ref(false);
const binanceKey = ref('');
const binanceSecret = ref('');
const binanceSimulated = ref(true);
const binanceHint = ref('');
const binanceReady = ref(false);

async function loadOkx() {
  if (!isLoggedIn.value) return;
  try {
    const data = await fetchOkxKeys();
    okxHint.value = data.okx?.apiKeyHint || '';
    okxReady.value = Boolean(data.okx?.ready);
    okxSimulated.value = data.okx?.simulated !== false;
    binanceHint.value = data.binance?.apiKeyHint || '';
    binanceReady.value = Boolean(data.binance?.ready);
    binanceSimulated.value = data.binance?.simulated !== false;
  } catch {
    okxHint.value = '';
    okxReady.value = false;
    binanceHint.value = '';
    binanceReady.value = false;
  }
}

async function open() {
  activeApiTab.value = 'deepseek';
  deepseekInput.value = '';
  okxKey.value = '';
  okxSecret.value = '';
  okxPass.value = '';
  binanceKey.value = '';
  binanceSecret.value = '';
  visible.value = true;
  if (isLoggedIn.value) {
    void refreshAiKeyStatus(true);
    void loadOkx();
  }
}

function close() {
  visible.value = false;
}

async function save() {
  if (!isLoggedIn.value) {
    ElMessage.warning('请先登录');
    return;
  }
  saving.value = true;
  try {
    let didSomething = false;
    if (activeApiTab.value === 'deepseek' && deepseekInput.value.trim()) {
      const r = await bindAiKey(deepseekInput.value.trim());
      if (!r.ok) throw new Error(r.warn || 'DeepSeek 保存失败');
      ElMessage.success('DeepSeek 密钥已保存');
      deepseekInput.value = '';
      didSomething = true;
    }
    const fillingKeys = Boolean(
      okxKey.value.trim() || okxSecret.value.trim() || okxPass.value.trim(),
    );
    if (activeApiTab.value === 'okx' && fillingKeys) {
      if (!okxKey.value.trim() || !okxSecret.value.trim() || !okxPass.value.trim()) {
        throw new Error('OKX 请同时填写 Key / Secret / Passphrase');
      }
      const secretLen = okxSecret.value.trim().length;
      await saveOkxKeys({
        apiKey: okxKey.value.trim(),
        apiSecret: okxSecret.value.trim(),
        apiPassphrase: okxPass.value.trim(),
        simulated: okxSimulated.value,
        enabled: true,
      });
      if (secretLen !== 32) {
        ElMessage.warning(
          `已保存，但 Secret 长度为 ${secretLen} 位。OKX Secret 一般是 32 位，少一位会报 Invalid Sign，请重新完整粘贴。`,
        );
      } else {
        ElMessage.success(
          okxSimulated.value
            ? 'OKX 密钥已保存（模拟盘）'
            : 'OKX 密钥已保存（实盘）',
        );
      }
      okxKey.value = '';
      okxSecret.value = '';
      okxPass.value = '';
      await loadOkx();
      didSomething = true;
    } else if (activeApiTab.value === 'okx' && okxReady.value) {
      await saveOkxKeys({
        flagsOnly: true,
        simulated: okxSimulated.value,
        enabled: true,
      });
      ElMessage.success(
        okxSimulated.value ? '已切换为模拟盘' : '已切换为实盘',
      );
      await loadOkx();
      didSomething = true;
    }
    if (activeApiTab.value === 'binance') {
      const fillingBinance = Boolean(binanceKey.value.trim() || binanceSecret.value.trim());
      if (fillingBinance) {
        if (!binanceKey.value.trim() || !binanceSecret.value.trim()) throw new Error('币安请同时填写 API Key 和 Secret');
        if (binanceSecret.value.trim().length !== 64) {
          ElMessage.warning(`币安 Secret 当前 ${binanceSecret.value.trim().length} 位，一般应为 64 位，请完整复制后再保存`);
        }
        await saveBinanceKeys({ apiKey: binanceKey.value.trim(), apiSecret: binanceSecret.value.trim(), simulated: binanceSimulated.value, enabled: true });
        binanceKey.value = '';
        binanceSecret.value = '';
        await loadOkx();
        ElMessage.success(binanceSimulated.value ? '币安演示盘密钥已保存' : '币安实盘密钥已保存');
        didSomething = true;
      } else if (binanceReady.value) {
        await saveBinanceKeys({ flagsOnly: true, simulated: binanceSimulated.value, enabled: true });
        await loadOkx();
        ElMessage.success(binanceSimulated.value ? '已切换为演示盘' : '已切换为实盘');
        didSomething = true;
      }
    }
    if (!didSomething) ElMessage.info('没有需要保存的更改');
    else visible.value = false;
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '保存失败');
  } finally {
    saving.value = false;
  }
}

async function clearOkx() {
  try {
    await deleteOkxKeys();
    okxHint.value = '';
    okxReady.value = false;
    ElMessage.success('已清除 OKX 密钥');
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '清除失败');
  }
}
async function clearBinance() {
  try {
    await deleteBinanceKeys();
    binanceHint.value = '';
    binanceReady.value = false;
    ElMessage.success('已清除币安密钥');
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '清除失败');
  }
}
</script>

<template>
  <div class="api-settings" :class="{ sidebar: variant === 'sidebar' }">
    <button
      type="button"
      class="api-trigger"
      :class="{ sidebar: variant === 'sidebar' }"
      title="API 设置"
      @click="open"
    >
      <svg v-if="variant === 'sidebar'" class="api-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path
          d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z"
          stroke="currentColor"
          stroke-width="1.8"
        />
        <path
          d="M19.4 13a7.6 7.6 0 0 0 .05-1 7.6 7.6 0 0 0-.05-1l2-1.55-1.9-3.3-2.4.95a7.4 7.4 0 0 0-1.75-1L15 3h-6l-.55 2.1a7.4 7.4 0 0 0-1.75 1l-2.4-.95L2.4 8.45 4.4 10a7.6 7.6 0 0 0 0 2l-2 1.55 1.9 3.3 2.4-.95a7.4 7.4 0 0 0 1.75 1L9 21h6l.55-2.1a7.4 7.4 0 0 0 1.75-1l2.4.95 1.9-3.3L19.4 13Z"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linejoin="round"
        />
      </svg>
      <span>{{ variant === 'sidebar' ? 'API' : 'API 设置' }}</span>
    </button>

    <el-dialog
      v-model="visible"
      title="API 设置"
      width="480px"
      append-to-body
      destroy-on-close
      class="api-settings-dialog"
      @closed="close"
    >
      <div class="dialog-body">
        <div class="api-tabs" role="tablist" aria-label="API 类型">
          <button type="button" role="tab" :aria-selected="activeApiTab === 'deepseek'" :class="{ active: activeApiTab === 'deepseek' }" @click="activeApiTab = 'deepseek'">DeepSeek API</button>
          <button type="button" role="tab" :aria-selected="activeApiTab === 'okx'" :class="{ active: activeApiTab === 'okx' }" @click="activeApiTab = 'okx'">OKX API</button>
          <button type="button" role="tab" :aria-selected="activeApiTab === 'binance'" :class="{ active: activeApiTab === 'binance' }" @click="activeApiTab = 'binance'">币安 API</button>
        </div>
        <section v-if="activeApiTab === 'deepseek'" class="setting-block" role="tabpanel">
          <h4 class="block-title">DeepSeek API</h4>
          <p class="intro">用于诊币、新闻、巨鲸智能分析。不配置不影响其他数据功能。</p>
          <template v-if="isLoggedIn">
            <el-input
              v-model="deepseekInput"
              type="password"
              show-password
              size="large"
              autocomplete="new-password"
              placeholder="sk-…（留空则不修改）"
            />
            <p class="intro">{{ aiKeyHint ? `当前密钥：${aiKeyHint}` : '尚未配置' }}</p>
          </template>
          <p v-else class="intro">登录后可配置。</p>
        </section>

        <section v-else-if="activeApiTab === 'okx'" class="setting-block" role="tabpanel">
          <h4 class="block-title">OKX 下单 API</h4>
          <p class="intro">
            用于仓位建议限价挂单（Maker，最大 100 USDT）。<br />
            下单时会先取最新价，做多低于现价 / 做空高于现价挂单，并附带止损止盈。
            模拟盘 Key 必须在 OKX「模拟盘交易 → API」里创建，并勾选下方「使用模拟盘」。<br />
            实盘 Key 在「实盘 API」创建，且不要勾选模拟盘。两套 Key 不能混用。
          </p>
          <template v-if="isLoggedIn">
            <el-input v-model="okxKey" size="large" placeholder="API Key（留空则不修改）" autocomplete="off" />
            <el-input
              v-model="okxSecret"
              type="password"
              show-password
              size="large"
              placeholder="Secret Key"
              autocomplete="new-password"
            />
            <el-input
              v-model="okxPass"
              type="password"
              show-password
              size="large"
              placeholder="Passphrase"
              autocomplete="new-password"
            />
            <label class="sim-row">
              <input v-model="okxSimulated" type="checkbox" />
              使用模拟盘（实盘 Key 请勿勾选）
            </label>
            <p class="intro">
              {{
                okxReady
                  ? `已配置：${okxHint || '****'}（${okxSimulated ? '模拟盘' : '实盘'}）`
                  : okxHint
                    ? `已保存但未就绪：${okxHint}`
                    : '尚未配置'
              }}
            </p>
            <button v-if="okxHint" type="button" class="link-btn" @click="clearOkx">清除 OKX 密钥</button>
          </template>
          <p v-else class="intro">登录后可配置。</p>
        </section>
        <section v-else class="setting-block" role="tabpanel">
          <h4 class="block-title">币安 API</h4>
          <p class="intro">用于 TradFi U 本位永续合约下单。演示盘与实盘密钥分别创建，切换环境时请同时更换密钥。实盘交易前需在币安完成合约及 TradFi 协议开通。</p>
          <template v-if="isLoggedIn">
            <el-input v-model="binanceKey" size="large" placeholder="API Key（留空则不修改）" autocomplete="off" />
            <el-input v-model="binanceSecret" type="password" show-password size="large" placeholder="Secret Key" autocomplete="new-password" />
            <label class="sim-row"><input v-model="binanceSimulated" type="checkbox" />使用币安演示盘（实盘 Key 请勿勾选）</label>
            <p class="intro">{{ binanceReady ? `已配置：${binanceHint}（${binanceSimulated ? '演示盘' : '实盘'}）` : '尚未配置' }}</p>
            <button v-if="binanceHint" type="button" class="link-btn" @click="clearBinance">清除币安密钥</button>
          </template>
          <p v-else class="intro">登录后可配置。</p>
        </section>
      </div>
      <template #footer>
        <div class="dialog-footer">
          <button type="button" class="dlg-btn ghost" @click="close">取消</button>
          <button type="button" class="dlg-btn primary" :disabled="saving" @click="save">
            {{ saving ? '…' : '保存' }}
          </button>
        </div>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.api-settings.sidebar {
  width: 100%;
  display: flex;
  justify-content: center;
}
.api-trigger {
  border: 0;
  border-radius: 999px;
  padding: 6px 14px;
  min-height: 32px;
  background: #1a222e;
  color: #b0c4de;
  font: inherit;
  font-size: 13px;
  font-weight: 700;
  cursor: pointer;
}
.api-trigger.sidebar {
  width: 56px;
  height: 48px;
  min-height: 48px;
  padding: 0;
  border-radius: 14px;
  background: transparent;
  color: #6a7e9c;
  display: inline-flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  font-size: 10px;
  font-weight: 600;
}
.api-trigger.sidebar:hover {
  background: #1a222e;
  color: #e8edf5;
}
.api-icon {
  width: 18px;
  height: 18px;
}
.dialog-body {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.api-tabs { display: flex; gap: 4px; border-bottom: 1px solid #2d333b; }
.api-tabs button { flex: 1; border: 0; border-bottom: 2px solid transparent; background: transparent; color: #8b9bb4; padding: 8px 4px; font: inherit; font-size: 12px; cursor: pointer; white-space: nowrap; }
.api-tabs button.active { border-bottom-color: #1f6feb; color: #e8edf5; font-weight: 700; }
.setting-block {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.block-title {
  margin: 0;
  font-size: 15px;
  font-weight: 700;
  color: #e8edf5;
}
.intro {
  margin: 0;
  color: #8b9bb4;
  font-size: 13px;
  line-height: 1.5;
}
.sim-row {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  color: #b0c4de;
  font-size: 13px;
}
.link-btn {
  align-self: flex-start;
  border: 0;
  background: transparent;
  color: #79b8ff;
  font: inherit;
  font-size: 12px;
  cursor: pointer;
  padding: 0;
}
.dialog-footer {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}
.dlg-btn {
  height: 34px;
  padding: 0 14px;
  border-radius: 8px;
  font: inherit;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}
.dlg-btn.ghost {
  border: 1px solid #2d333b;
  background: transparent;
  color: #8b9bb4;
}
.dlg-btn.primary {
  border: 0;
  background: #1f6feb;
  color: #fff;
}
.dlg-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
</style>
