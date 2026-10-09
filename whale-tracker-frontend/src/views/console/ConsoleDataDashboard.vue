<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { addManualWhale, createAuthUser, deleteAuthUser, fetchManagementWhales, fetchAlertCount, listAuthUsers, renameWhale, resetSiteData, fetchResetStatus, type ResetRecovery, type ResetJob, updateAuthUserPassword } from '@/api';

type AuthUser = { id: string; username: string; createdAt: number };
type WhaleRow = {
  id?: string;
  name?: string;
  address?: string;
  direction?: string;
  longUsd?: number;
  shortUsd?: number;
  netUsd?: number;
  closedTrades?: number;
  manual?: boolean;
  customName?: boolean;
};
const pageErr = ref('');
const users = ref<AuthUser[]>([]);
const whales = ref<WhaleRow[]>([]);
const whaleTotal = ref<number | null>(null);
const whaleDir = ref('all');
const whaleSort = ref<{ key: string; dir: number }>({ key: 'netUsd', dir: -1 });
const whaleSearch = ref('');
const whalePage = ref(1);
const whalePageSize = 20;
const newUser = ref('');
const newPass = ref('');
const userMsg = ref('');
const userMsgOk = ref(false);
const whaleMsg = ref('');
const whaleMsgOk = ref(false);
const addWhaleOpen = ref(false);
const manualAddr = ref('');
const manualName = ref('');
const resetBusy = ref(false);
const resetStatus = ref('');
const refreshing = ref(false);
const alertTotal = ref<number | null>(null);
const alertCountAt = ref(0);
const alertCountError = ref('');
const alertCountInitializing = ref(false);
let countTimer: ReturnType<typeof setTimeout> | undefined;
let alertCountPending: Promise<void> | null = null;
function loadAlertCount() {
  clearTimeout(countTimer);
  if (alertCountPending) return alertCountPending;
  const generation = recoveryGeneration;
  alertCountPending = fetchAlertCount().then(data => {
    if (disposed || generation !== recoveryGeneration) return;
    alertTotal.value = data.total;
    alertCountAt.value = data.countedAt;
    alertCountError.value = '';
    alertCountInitializing.value = data.status === 'initializing';
    if (alertCountInitializing.value && !resetBusy.value) countTimer = setTimeout(() => void loadAlertCount(), 10000);
  }).catch(error => {
    if (!disposed && generation === recoveryGeneration) alertCountError.value = error instanceof Error ? error.message : String(error);
  }).finally(() => { alertCountPending = null; });
  return alertCountPending;
}

function fmtTime(ts: unknown) {
  const n = Number(ts) || 0;
  if (!n) return '—';
  const d = new Date(n);
  return Number.isNaN(d.getTime()) ? String(ts) : d.toLocaleString('zh-CN', { hour12: false });
}

function fmtUsd(n: unknown) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  const abs = Math.abs(v);
  const sign = v < 0 ? '-' : '';
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(1)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}

function shortAddr(s: unknown) {
  const t = String(s || '');
  return t.length < 12 ? t || '—' : `${t.slice(0, 6)}…${t.slice(-4)}`;
}

const filteredWhales = computed(() => {
  let list = whales.value.slice();
  if (whaleDir.value !== 'all') {
    list = list.filter((w) => (w.direction || 'neutral') === whaleDir.value);
  }
  const q = whaleSearch.value.trim().toLowerCase();
  if (q) {
    list = list.filter((w) =>
      [w.name, w.id, w.address, w.direction]
        .map((x) => String(x || '').toLowerCase())
        .join(' ')
        .includes(q),
    );
  }
  const { key, dir } = whaleSort.value;
  list.sort((a, b) => {
    const av = (a as Record<string, unknown>)[key];
    const bv = (b as Record<string, unknown>)[key];
    if (typeof av === 'string' || typeof bv === 'string') {
      return String(av || '').localeCompare(String(bv || ''), 'zh') * dir;
    }
    return ((Number(av) || 0) - (Number(bv) || 0)) * dir;
  });
  return list;
});

const whalePageCount = computed(() =>
  Math.max(1, Math.ceil(filteredWhales.value.length / whalePageSize)),
);

const pagedWhales = computed(() => {
  const start = (whalePage.value - 1) * whalePageSize;
  return filteredWhales.value.slice(start, start + whalePageSize);
});

function showErr(msg: string) {
  pageErr.value = msg || '';
}

let whalesPending: Promise<void> | null = null;
function loadWhales() {
  if (whalesPending) return whalesPending;
  whalesPending = fetchManagementWhales().then(data => {
    whales.value = data.whales as WhaleRow[];
    whaleTotal.value = data.total;
    if (whalePage.value > whalePageCount.value) whalePage.value = whalePageCount.value;
  }).finally(() => { whalesPending = null; });
  return whalesPending;
}

async function loadUsers() {
  const data = await listAuthUsers();
  users.value = data.users || [];
}

async function refreshAll() {
  if (refreshing.value) return;
  refreshing.value = true;
  try {
    showErr('');
    await Promise.all([loadWhales(), loadUsers(), loadAlertCount()]);
  } catch (e) {
    showErr(`加载失败：${e instanceof Error ? e.message : String(e)}`);
  } finally { refreshing.value = false; }
}

async function createUser() {
  try {
    const data = await createAuthUser(newUser.value.trim(), newPass.value);
    userMsgOk.value = true;
    userMsg.value = `已创建 ${data.user.username}`;
    newUser.value = '';
    newPass.value = '';
    await loadUsers();
  } catch (e) {
    userMsgOk.value = false;
    userMsg.value = e instanceof Error ? e.message : String(e);
  }
}

async function deleteUser(id: string) {
  if (!window.confirm('确认删除该用户？')) return;
  try {
    const data = await deleteAuthUser(id);
    userMsgOk.value = true;
    userMsg.value = `已删除 ${data.user?.username || ''}`;
    await loadUsers();
  } catch (e) {
    userMsgOk.value = false;
    userMsg.value = e instanceof Error ? e.message : String(e);
  }
}

async function changePassword(id: string) {
  const password = window.prompt('输入新密码（至少 4 位）');
  if (password == null) return;
  try {
    const data = await updateAuthUserPassword(id, password);
    userMsgOk.value = true;
    userMsg.value = `已改密 ${data.user?.username || ''}`;
    await loadUsers();
  } catch (e) {
    userMsgOk.value = false;
    userMsg.value = e instanceof Error ? e.message : String(e);
  }
}

function setWhaleDir(dir: string) {
  whaleDir.value = dir;
  whalePage.value = 1;
}

function sortWhales(key: string) {
  if (whaleSort.value.key === key) {
    whaleSort.value = { key, dir: whaleSort.value.dir * -1 };
  } else {
    whaleSort.value = { key, dir: key === 'name' || key === 'direction' ? 1 : -1 };
  }
  whalePage.value = 1;
}

async function addWhale() {
  try {
    const data = await addManualWhale(manualAddr.value.trim(), manualName.value.trim());
    whaleMsgOk.value = true;
    whaleMsg.value = `已添加 ${data.whale?.name || manualAddr.value}`;
    addWhaleOpen.value = false;
    await loadWhales();
  } catch (e) {
    whaleMsgOk.value = false;
    whaleMsg.value = e instanceof Error ? e.message : String(e);
  }
}

async function renameWhaleRow(id: string, current: string) {
  const next = window.prompt('新的巨鲸名称', current);
  if (next == null) return;
  const name = String(next).trim();
  if (!name) return;
  try {
    const data = await renameWhale(id, name);
    whaleMsgOk.value = true;
    whaleMsg.value = `已改名：${data.whale?.name || name}`;
    await loadWhales();
  } catch (e) {
    whaleMsgOk.value = false;
    whaleMsg.value = e instanceof Error ? e.message : String(e);
  }
}

let recoveryTimer: ReturnType<typeof setTimeout> | undefined;
let disposed = false;
let recoveryGeneration = 0;
function displayRecovery(recovery: ResetRecovery | null | undefined, warning?: string | null) {
  const suffix = warning ? `；仓位刷新失败：${warning}` : '';
  if (!recovery) { resetStatus.value = `已清理数据，回补状态暂不可用${suffix}`; return; }
  resetStatus.value = recovery.status === 'disabled' ? '已清理数据，成交采集已停用，无法自动回补'
    : recovery.status === 'complete' ? `最近 24 小时回补检查完成（${recovery.recovered}/${recovery.monitored} 个地址），以数据源可返回的成交为准${suffix}`
    : `历史回补中：${recovery.recovered}/${recovery.monitored} 个地址${recovery.errors ? `，${recovery.errors} 个待重试` : ''}${suffix}`;
}
function displayJob(job: ResetJob | null | undefined) {
  resetBusy.value = job?.status === 'queued' || job?.status === 'clearing';
  if (job?.status === 'queued') resetStatus.value = '后台重置已排队…';
  else if (job?.status === 'clearing') resetStatus.value = `后台清理中：已删除 ${job.deletedRows.toLocaleString('zh-CN')} 条记录，采集暂时暂停`;
  else if (job?.status === 'failed') resetStatus.value = `清理未完成：${job.error || '未知错误'}。采集已暂停，请重试重置`;
}
async function pollRecovery(generation = recoveryGeneration) {
  if (disposed || generation !== recoveryGeneration) return;
  let pending = true;
  try {
    const data = await fetchResetStatus();
    if (disposed || generation !== recoveryGeneration) return;
    const wasClearing = resetBusy.value;
    displayJob(data.job);
    if (!resetBusy.value && data.job?.status !== 'failed' && data.recovery) displayRecovery(data.recovery, data.error);
    pending = resetBusy.value || data.recovery?.status === 'recovering';
    if (wasClearing && !resetBusy.value) await Promise.all([loadWhales(), loadAlertCount()]);
    else if (data.recovery) void loadAlertCount();
  } catch { if (!disposed && generation === recoveryGeneration) resetStatus.value = '重置进度读取失败，稍后重试'; }
  if (pending && !disposed && generation === recoveryGeneration) recoveryTimer = setTimeout(() => void pollRecovery(generation), resetBusy.value ? 2000 : 10000);
}

async function resetSite() {
  if (
    !window.confirm(
      '是否重置整站数据？\n将清空成交/异动/仓位缓存并重新拉取；用户账号与手动添加的巨鲸会保留。',
    )
  ) {
    return;
  }
  clearTimeout(recoveryTimer);
  recoveryGeneration++;
  resetBusy.value = true;
  resetStatus.value = '正在提交后台重置…';
  clearTimeout(countTimer);
  try {
    const data = await resetSiteData();
    displayJob(data.job);
    await pollRecovery();
  } catch (e) {
    resetStatus.value = `提交失败：${e instanceof Error ? e.message : String(e)}，正在确认后台状态…`;
    // A timed-out POST may already be accepted. Check before enabling another reset.
    await pollRecovery();
  }

}

onMounted(() => { void refreshAll(); void pollRecovery(); });
onUnmounted(() => { disposed = true; clearTimeout(recoveryTimer); clearTimeout(countTimer); });
</script>

<template>
  <main class="console-main data-dashboard">
    <div class="err-banner" :class="{ show: Boolean(pageErr) }">{{ pageErr }}</div>
    <header class="data-heading">
      <div><h2>数据管理</h2><p>管理用户、巨鲸与数据库记录</p></div>
      <div class="data-actions">
        <button class="ghost" type="button" :disabled="resetBusy || refreshing" @click="refreshAll">{{ refreshing ? '正在刷新…' : '刷新数据' }}</button>
        <button class="warn" type="button" :disabled="resetBusy || refreshing" @click="resetSite">{{ resetBusy ? '正在重置…' : '重置数据' }}</button>
      </div>
    </header>
    <section class="data-overview" aria-label="数据库概览">
      <div class="overview-item"><span title="全部存储记录，含未达展示门槛的记录；前台按时间和筛选条件展示最多 50 条">数据库异动记录（全部）</span><strong>{{ alertTotal == null ? '—' : alertTotal.toLocaleString('zh-CN') }}<small>条</small></strong><p v-if="alertCountError" class="count-error">{{ alertCountError }}{{ alertTotal == null ? '' : '（显示上次统计）' }}</p><p v-else>{{ alertCountInitializing ? '正在分批建立计数…' : alertCountAt ? `统计于 ${fmtTime(alertCountAt)}` : '正在读取…' }}</p></div>
      <div class="overview-item"><span>已拉取巨鲸</span><strong>{{ whaleTotal ?? '—' }}<small>个</small></strong><p>当前数据库中的巨鲸</p></div>
      <div class="overview-item"><span>用户账号</span><strong>{{ users.length }}<small>个</small></strong><p>已创建的登录账号</p></div>
    </section>
    <div v-if="resetStatus" class="recovery-status" role="status">{{ resetStatus }}</div>

    <div class="data-grid">
      <section class="card">
        <div class="card-head">
          <h2>用户管理</h2>
          <span class="pill">{{ users.length }}</span>
        </div>
        <div class="form-row">
          <label>用户名 <input v-model="newUser" placeholder="输入用户名" autocomplete="off" /></label>
          <label>密码 <input v-model="newPass" type="password" placeholder="设置登录密码" autocomplete="new-password" /></label>
          <button type="button" class="sm" @click="createUser">增加</button>
          <span class="msg" :class="userMsg ? (userMsgOk ? 'ok' : 'err') : ''">{{ userMsg }}</span>
        </div>
        <div class="card-body">
          <table>
            <thead>
              <tr>
                <th class="nosort">用户名</th>
                <th class="nosort">创建时间</th>
                <th class="nosort">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="u in users" :key="u.id">
                <td>{{ u.username }}</td>
                <td class="dim">{{ fmtTime(u.createdAt) }}</td>
                <td>
                  <button type="button" class="ghost sm" @click="changePassword(u.id)">改密</button>
                  <button type="button" class="danger sm" @click="deleteUser(u.id)">删除</button>
                </td>
              </tr>
            </tbody>
          </table>
          <div v-if="!users.length" class="empty">暂无用户</div>
        </div>
      </section>

      <section class="card">
        <div class="card-head">
          <h2>巨鲸列表</h2>
          <span class="pill">{{ filteredWhales.length }}/{{ whales.length }}</span>
        </div>
        <div class="filters">
          <button
            v-for="opt in [
              { dir: 'all', label: '全部' },
              { dir: 'long', label: '做多' },
              { dir: 'short', label: '做空' },
              { dir: 'neutral', label: '中性' },
            ]"
            :key="opt.dir"
            type="button"
            class="chip"
            :class="{ on: whaleDir === opt.dir }"
            @click="setWhaleDir(opt.dir)"
          >
            {{ opt.label }}
          </button>
          <div class="filters-right">
            <input
              v-model="whaleSearch"
              type="search"
              placeholder="搜索名称或地址"
              aria-label="搜索巨鲸"
              @input="whalePage = 1"
            />
            <button type="button" class="sm" @click="addWhaleOpen = true">新增</button>
          </div>
        </div>
        <div class="card-body">
          <table>
            <thead>
              <tr>
                <th
                  v-for="col in [
                    { key: 'name', label: '名称' },
                    { key: 'direction', label: '方向' },
                    { key: 'longUsd', label: '多头' },
                    { key: 'shortUsd', label: '空头' },
                    { key: 'netUsd', label: '净名义' },
                    { key: 'closedTrades', label: '已平' },
                  ]"
                  :key="col.key"
                  :class="{ active: whaleSort.key === col.key }"
                  @click="sortWhales(col.key)"
                >
                  {{ col.label }} <span class="arrow">↕</span>
                </th>
                <th class="nosort">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="w in pagedWhales" :key="String(w.id)">
                <td :title="w.address || ''">
                  {{ w.name || shortAddr(w.id) }}
                  <span v-if="w.manual" class="pill">手动</span>
                  <span v-else-if="w.customName" class="pill">改名</span>
                </td>
                <td>
                  <span v-if="w.direction === 'long'" class="up">做多</span>
                  <span v-else-if="w.direction === 'short'" class="down">做空</span>
                  <span v-else class="dim">中性</span>
                </td>
                <td>{{ fmtUsd(w.longUsd) }}</td>
                <td>{{ fmtUsd(w.shortUsd) }}</td>
                <td>{{ fmtUsd(w.netUsd) }}</td>
                <td>{{ w.closedTrades ?? 0 }}</td>
                <td>
                  <button
                    type="button"
                    class="sm ghost"
                    @click="renameWhaleRow(String(w.id || ''), String(w.name || ''))"
                  >
                    改名
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
          <div v-if="!filteredWhales.length" class="empty">暂无巨鲸</div>
        </div>
        <div class="pager-bar">
          <button type="button" class="sm" :disabled="whalePage <= 1" @click="whalePage = 1">首页</button>
          <button type="button" class="sm" :disabled="whalePage <= 1" @click="whalePage -= 1">上一页</button>
          <span>第 {{ whalePage }}/{{ whalePageCount }} 页 · {{ filteredWhales.length }} 条</span>
          <button
            type="button"
            class="sm"
            :disabled="whalePage >= whalePageCount"
            @click="whalePage += 1"
          >
            下一页
          </button>
        </div>
        <span class="msg" :class="whaleMsg ? (whaleMsgOk ? 'ok' : 'err') : ''" style="padding: 0 12px 8px">
          {{ whaleMsg }}
        </span>
      </section>



    </div>
  </main>

  <div class="modal-mask" :class="{ show: addWhaleOpen }" @click.self="addWhaleOpen = false">
    <div class="modal">
      <h3>新增巨鲸</h3>
      <div class="field">
        <label>地址</label>
        <input v-model="manualAddr" />
      </div>
      <div class="field">
        <label>名称</label>
        <input v-model="manualName" />
      </div>
      <div class="actions">
        <button type="button" class="ghost" @click="addWhaleOpen = false">取消</button>
        <button type="button" @click="addWhale">确认添加</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.data-dashboard{max-width:1500px;padding-top:24px}
.data-heading{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-bottom:20px}
.data-heading h2{margin:0 0 6px;font-size:22px;font-weight:650}.data-heading p{margin:0;color:var(--c-muted);font-size:13px}
.data-actions{display:flex;gap:10px}.data-overview{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px;margin-bottom:20px}
.overview-item{min-width:0;padding:20px 22px;border:1px solid var(--c-line);border-radius:12px;background:var(--c-panel)}
.overview-item>span{color:var(--c-muted);font-size:13px}.overview-item strong{display:block;margin-top:12px;font-size:30px;font-variant-numeric:tabular-nums;line-height:1.2}
.overview-item small{margin-left:8px;font-size:12px;font-weight:400;color:var(--c-muted)}.overview-item p{margin:10px 0 0;color:var(--c-muted);font-size:12px;line-height:1.5;overflow-wrap:anywhere}.overview-item .count-error{color:var(--c-warn)}
.recovery-status{margin-bottom:20px;padding:12px 16px;border:1px solid var(--c-line);border-radius:10px;background:var(--c-panel2);color:var(--c-muted);font-size:13px;line-height:1.6}
.data-grid{display:grid;grid-template-columns:minmax(320px,.9fr) minmax(0,1.65fr);gap:20px;align-items:start}.data-grid .card{min-width:0;border-radius:12px;overflow:hidden}.data-grid .card-head{padding:16px 18px}.data-grid .card-head h2{font-size:15px}.data-grid .card-body{overflow-x:auto}.data-grid th,.data-grid td{padding:12px 14px;white-space:nowrap}.data-grid tbody tr:hover{background:var(--c-panel2)}
.data-grid .form-row{padding:16px;gap:12px;align-items:flex-end}.form-row label{display:flex;flex-direction:column;gap:7px;flex:1;min-width:120px}.form-row input{width:100%;min-height:34px}.form-row .msg{flex-basis:100%}.data-grid .filters{padding:14px;gap:8px}.filters-right input{width:180px;max-width:100%;min-height:30px}.data-grid .pager-bar{justify-content:flex-start;padding:12px 14px}.pager-bar span{margin-right:auto;color:var(--c-muted)}
.data-dashboard button{transition:background .15s,opacity .15s}.data-dashboard button:hover:not(:disabled){filter:brightness(1.12)}
.data-grid .card-body{scrollbar-color:var(--c-line) var(--c-panel);scrollbar-width:thin}.data-grid .card-body::-webkit-scrollbar{width:6px;height:6px}.data-grid .card-body::-webkit-scrollbar-track{background:var(--c-panel)}.data-grid .card-body::-webkit-scrollbar-thumb{background:var(--c-line);border-radius:4px}
@media(max-width:1100px){.data-grid{grid-template-columns:minmax(0,1fr)}.data-grid .form-row label{max-width:260px}}
@media(max-width:600px){.data-dashboard{padding:16px 12px 32px}.data-overview{gap:8px}.overview-item{padding:14px 10px}.overview-item strong{font-size:24px}.overview-item>span{font-size:12px}.overview-item p{font-size:11px}.data-actions{width:100%}.data-actions button{flex:1}.data-grid .filters-right{width:100%;margin-left:0}.filters-right input{flex:1;min-width:0}}
</style>
