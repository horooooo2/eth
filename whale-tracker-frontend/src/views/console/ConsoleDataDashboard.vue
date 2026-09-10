<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import {
  addManualWhale,
  addXWatchAccount,
  createAuthUser,
  deleteAuthUser,
  deleteXWatchAccount,
  fetchApiHealth,
  fetchDataBrowse,
  fetchDataMonitor,
  fetchXAccounts,
  fetchXStatus,
  listAuthUsers,
  refreshXWatchNow,
  renameWhale,
  resetSiteData,
  toggleXWatchAccount,
  updateAuthUserPassword,
  updateXWatchAccount,
  type ConsoleXAccount,
} from '@/api';

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
type MonitorItem = { at?: number; message?: string; detail?: string; ok?: boolean };

const pageErr = ref('');
const users = ref<AuthUser[]>([]);
const whales = ref<WhaleRow[]>([]);
const browse = ref<Record<string, unknown> | null>(null);
const whaleDir = ref('all');
const whaleSort = ref<{ key: string; dir: number }>({ key: 'netUsd', dir: -1 });
const whaleSearch = ref('');
const whalePage = ref(1);
const whalePageSize = 20;
const monitorTab = ref<'socket' | 'requests' | 'errors'>('socket');
const monitor = ref<{
  socket?: MonitorItem[];
  requests?: MonitorItem[];
  errors?: MonitorItem[];
  limits?: Record<string, number>;
}>({ socket: [], requests: [], errors: [] });
const xAccounts = ref<ConsoleXAccount[]>([]);
const xMeta = ref<Record<string, unknown> | null>(null);
const startedAtMs = ref(0);
const nowMs = ref(Date.now());

const newUser = ref('');
const newPass = ref('');
const userMsg = ref('');
const userMsgOk = ref(false);
const whaleMsg = ref('');
const whaleMsgOk = ref(false);
const xUsername = ref('');
const xLabel = ref('');
const xMsg = ref('');
const xMsgOk = ref(false);
const addWhaleOpen = ref(false);
const manualAddr = ref('');
const manualName = ref('');
const resetBusy = ref(false);
const xAddBusy = ref(false);
const xPollBusy = ref(false);
const rtText = ref('实时 —');
const rtOn = ref(false);
const pullStatus = ref('待命');
const pullStatusClass = ref('status-text');
const pullStatusHtml = ref('');

let uptimeTimer: number | undefined;
let monitorTimer: number | undefined;
let browseTimer: number | undefined;

function esc(s: unknown) {
  return String(s ?? '');
}

function fmtTime(ts: unknown) {
  const n = Number(ts) || 0;
  if (!n) return '—';
  const d = new Date(n);
  return Number.isNaN(d.getTime()) ? String(ts) : d.toLocaleString('zh-CN', { hour12: false });
}

function fmtDuration(ms: number) {
  const sec = Math.floor(Math.max(0, Number(ms) || 0) / 1000);
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (d) return `${d}天 ${h}时 ${m}分 ${s}秒`;
  if (h) return `${h}时 ${m}分 ${s}秒`;
  if (m) return `${m}分 ${s}秒`;
  return `${s}秒`;
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

const uptimeLabel = computed(() => {
  if (startedAtMs.value > 0) return fmtDuration(nowMs.value - startedAtMs.value);
  const d = browse.value || {};
  return fmtDuration(Number(d.uptimeMs) || 0);
});

const bannerStats = computed(() => {
  const d = browse.value || {};
  const st = (d.status || {}) as Record<string, number>;
  const daily = (d.dailyIo || {}) as Record<string, unknown>;
  return [
    { l: '巨鲸', n: st.whales ?? 0, title: '' },
    { l: '成交', n: st.fills ?? 0, title: '' },
    { l: '事件', n: st.events ?? 0, title: '' },
    { l: '异动', n: st.alerts ?? 0, title: '' },
    {
      l: '今日新增',
      n: daily.addedRows ?? 0,
      title: `上海时区 ${daily.ymd || '今日'} 新写入条数（成交/事件/异动），零点清零`,
    },
    {
      l: '今日删除',
      n: `${Number(daily.deletedRows) || 0}条`,
      title: `今日清理涉及 ${Number(daily.deletedDays) || 0} 个自然日 · 共删 ${Number(daily.deletedRows) || 0} 条`,
    },
  ];
});

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

const monitorList = computed(() => {
  if (monitorTab.value === 'socket') return monitor.value.socket || [];
  if (monitorTab.value === 'requests') return monitor.value.requests || [];
  return monitor.value.errors || [];
});

const monitorHint = computed(() => {
  const lim = monitor.value.limits || {};
  const list = monitorList.value;
  if (monitorTab.value === 'socket') return `最新 ${lim.socket || 100} 条`;
  if (monitorTab.value === 'requests') return `请求 ${list.length}`;
  return `报错 ${list.length}`;
});

const xOnCount = computed(() => xAccounts.value.filter((a) => a.enabled !== false).length);

const xBannerMeta = computed(() => {
  const poll = ((xMeta.value && xMeta.value.poll) || {}) as Record<string, unknown>;
  const windowOpen = Boolean(poll.windowOpen);
  const parts = [
    `当前监控 ${xAccounts.value.length} 人（开启 ${xOnCount.value}）`,
    `拉取间隔 ${Math.round((Number(poll.pollMs) || 0) / 60000)} 分钟`,
    `窗口 ${windowOpen ? '开启' : '暂停（凌晨 3–9 点）'}`,
  ];
  if (xMeta.value && xMeta.value.updatedAt) {
    parts.push(`配置更新 ${fmtTime(xMeta.value.updatedAt)}`);
  }
  if (poll.lastPollAt) parts.push(`上次拉取 ${fmtTime(poll.lastPollAt)}`);
  return parts.join(' · ');
});

function showErr(msg: string) {
  pageErr.value = msg || '';
}

async function loadBrowse() {
  const data = await fetchDataBrowse(500);
  browse.value = data;
  whales.value = Array.isArray(data.whales) ? (data.whales as WhaleRow[]) : [];
  const nextStarted = Number(data.startedAt) || 0;
  if (nextStarted > 0) startedAtMs.value = nextStarted;
  if (whalePage.value > whalePageCount.value) whalePage.value = whalePageCount.value;
}

async function loadUsers() {
  const data = await listAuthUsers();
  users.value = data.users || [];
}

async function loadMonitor() {
  monitor.value = await fetchDataMonitor();
}

async function loadXWatch() {
  const data = await fetchXAccounts();
  xAccounts.value = data.accounts || [];
  xMeta.value = data;
}

function updateProgressHint(
  backfill: Record<string, unknown> | undefined,
  whaleRefresh: Record<string, unknown> | undefined,
) {
  pullStatusHtml.value = '';
  if (whaleRefresh && (whaleRefresh.status === 'resetting' || whaleRefresh.status === 'running')) {
    pullStatus.value = '正在重置并重新拉取…';
    pullStatusClass.value = 'status-text';
    return;
  }
  const bf = backfill || {};
  if (bf.enabled === false) {
    pullStatus.value = '历史补齐已关闭';
    pullStatusClass.value = 'status-text';
    return;
  }
  if (bf.done) {
    pullStatus.value = '历史补齐已完成 · 后续靠实时推送';
    pullStatusClass.value = 'status-text on';
    return;
  }
  const day = (Number(bf.dayOffset) || 0) + 1;
  const days = Number(bf.days) || 7;
  const idx = Number(bf.whaleIndex) || 0;
  const total = Number(bf.whaleTotal) || 0;
  const base =
    total > 0
      ? `历史补齐进行中：第 ${day}/${days} 天 · 地址 ${Math.min(idx + 1, total)}/${total}`
      : `历史补齐待命：第 ${day}/${days} 天 · 等待巨鲸名单`;
  if (bf.rateLimited) {
    pullStatus.value = '';
    pullStatusHtml.value = `${base}<span class="rate-limit">（429限流，半小时后重试）</span>`;
  } else {
    pullStatus.value = base;
  }
  pullStatusClass.value = 'status-text';
}

async function loadHealthBits() {
  try {
    const h = await fetchApiHealth();
    const rt = (h.realtime || {}) as Record<string, unknown>;
    rtOn.value = Boolean(rt.connected);
    rtText.value = rt.connected
      ? `实时已连接 · 订阅 ${rt.fillSubs || 0}`
      : '实时未连接';
    updateProgressHint(
      h.fillBackfill as Record<string, unknown> | undefined,
      h.whaleRefresh as Record<string, unknown> | undefined,
    );
  } catch {
    rtText.value = '实时未知';
    rtOn.value = false;
  }
}

async function refreshAll() {
  try {
    showErr('');
    await Promise.all([loadBrowse(), loadUsers(), loadMonitor(), loadHealthBits(), loadXWatch()]);
  } catch (e) {
    showErr(`加载失败：${e instanceof Error ? e.message : String(e)}`);
  }
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
    await loadBrowse();
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
    await loadBrowse();
  } catch (e) {
    whaleMsgOk.value = false;
    whaleMsg.value = e instanceof Error ? e.message : String(e);
  }
}

async function resetSite() {
  if (
    !window.confirm(
      '是否重置整站数据？\n将清空成交/异动/仓位缓存并重新拉取；用户账号与手动添加的巨鲸会保留。',
    )
  ) {
    return;
  }
  resetBusy.value = true;
  pullStatus.value = '正在重置并重新拉取…';
  pullStatusHtml.value = '';
  try {
    const data = await resetSiteData(3);
    const bf = (data.fillBackfill || {}) as Record<string, unknown>;
    const kept = data.keptManuals ?? 0;
    pullStatus.value =
      `重置完成 · 保留手动 ${kept} 个 · ` +
      (bf.done
        ? '补齐已完成'
        : `补齐第 ${(Number(bf.dayOffset) || 0) + 1}/${bf.days || 7} 天 · 地址 ${(Number(bf.whaleIndex) || 0) + 1}/${bf.whaleTotal || 0}`);
    await loadBrowse();
    await loadHealthBits();
  } catch (e) {
    pullStatus.value = `失败：${e instanceof Error ? e.message : String(e)}`;
  } finally {
    resetBusy.value = false;
  }
}

async function addXAccount() {
  const username = xUsername.value.trim().replace(/^@+/, '');
  const label = xLabel.value.trim();
  if (!username) {
    xMsgOk.value = false;
    xMsg.value = '请填写用户名';
    return;
  }
  xAddBusy.value = true;
  try {
    const data = await addXWatchAccount(username, label || username);
    xAccounts.value = data.accounts || [];
    xMeta.value = data;
    xUsername.value = '';
    xLabel.value = '';
    try {
      const st = await fetchXStatus();
      xMeta.value = { ...data, poll: st };
    } catch {
      /* ignore */
    }
    xMsgOk.value = true;
    xMsg.value = `已添加 @${username}`;
  } catch (e) {
    xMsgOk.value = false;
    xMsg.value = e instanceof Error ? e.message : String(e);
  } finally {
    xAddBusy.value = false;
  }
}

async function toggleX(username: string, enabled: boolean) {
  try {
    const data = await toggleXWatchAccount(username, enabled);
    xAccounts.value = data.accounts || [];
    try {
      const st = await fetchXStatus();
      xMeta.value = { ...data, poll: st };
    } catch {
      xMeta.value = data;
    }
    xMsgOk.value = true;
    xMsg.value = `${enabled ? '已开启 @' : '已关闭 @'}${username}${enabled ? '' : '（不再拉取）'}`;
  } catch (e) {
    xMsgOk.value = false;
    xMsg.value = e instanceof Error ? e.message : String(e);
  }
}

async function deleteX(username: string) {
  if (!window.confirm(`确定删除 @${username}？`)) return;
  try {
    const data = await deleteXWatchAccount(username);
    xAccounts.value = data.accounts || [];
    try {
      const st = await fetchXStatus();
      xMeta.value = { ...data, poll: st };
    } catch {
      xMeta.value = data;
    }
    xMsgOk.value = true;
    xMsg.value = `已删除 @${username}`;
  } catch (e) {
    xMsgOk.value = false;
    xMsg.value = e instanceof Error ? e.message : String(e);
  }
}

async function editX(username: string) {
  const cur = xAccounts.value.find((a) => a.username === username);
  const label = window.prompt('显示名（筛选标签）', (cur && cur.label) || username);
  if (label == null) return;
  try {
    const data = await updateXWatchAccount(username, String(label).trim() || username);
    xAccounts.value = data.accounts || [];
    try {
      const st = await fetchXStatus();
      xMeta.value = { ...data, poll: st };
    } catch {
      xMeta.value = data;
    }
    xMsgOk.value = true;
    xMsg.value = `已更新 @${username}`;
  } catch (e) {
    xMsgOk.value = false;
    xMsg.value = e instanceof Error ? e.message : String(e);
  }
}

async function reloadX() {
  try {
    await loadXWatch();
    xMsgOk.value = true;
    xMsg.value = '列表已刷新';
  } catch (e) {
    xMsgOk.value = false;
    xMsg.value = e instanceof Error ? e.message : String(e);
  }
}

async function pollX() {
  xPollBusy.value = true;
  xMsg.value = '正在拉取…';
  xMsgOk.value = false;
  try {
    await refreshXWatchNow();
    await loadXWatch();
    xMsgOk.value = true;
    xMsg.value = '拉取完成';
  } catch (e) {
    xMsgOk.value = false;
    xMsg.value = e instanceof Error ? e.message : String(e);
  } finally {
    xPollBusy.value = false;
  }
}

onMounted(() => {
  void refreshAll();
  uptimeTimer = window.setInterval(() => {
    nowMs.value = Date.now();
  }, 1000);
  monitorTimer = window.setInterval(() => {
    void Promise.all([loadMonitor(), loadHealthBits()]).catch(() => undefined);
  }, 2500);
  browseTimer = window.setInterval(() => {
    void loadBrowse().catch(() => undefined);
  }, 20000);
});

onUnmounted(() => {
  if (uptimeTimer) window.clearInterval(uptimeTimer);
  if (monitorTimer) window.clearInterval(monitorTimer);
  if (browseTimer) window.clearInterval(browseTimer);
});
</script>

<template>
  <main class="console-main">
    <div class="err-banner" :class="{ show: Boolean(pageErr) }">{{ pageErr }}</div>
    <section class="banner">
      <div>
        <div class="meta">
          启动：<b>{{ fmtTime(browse && browse.startedAt) }}</b>
          · 已运行 <b>{{ uptimeLabel }}</b>
          <template v-if="browse && browse.whaleRefresh">
            · 最近任务
            <b>{{ ((browse.whaleRefresh as Record<string, unknown>).status as string) || '—' }}</b>
            {{
              fmtTime(
                (browse.whaleRefresh as Record<string, unknown>).finishedAt ||
                  (browse.whaleRefresh as Record<string, unknown>).startedAt,
              )
            }}
          </template>
        </div>
        <div style="margin-top: 10px; display: flex; gap: 12px; flex-wrap: wrap; align-items: center">
          <button class="warn" type="button" :disabled="resetBusy" @click="resetSite">重置</button>
          <span v-if="pullStatusHtml" :class="pullStatusClass" v-html="pullStatusHtml"></span>
          <span v-else :class="pullStatusClass">{{ pullStatus }}</span>
          <span class="status-text" :class="rtOn ? 'on' : 'off'">{{ rtText }}</span>
        </div>
      </div>
      <div class="banner-stats">
        <div v-for="item in bannerStats" :key="item.l" class="bstat" :title="item.title || undefined">
          <div class="n">{{ item.n }}</div>
          <div class="l">{{ item.l }}</div>
        </div>
      </div>
    </section>

    <div class="grid-2">
      <section class="card">
        <div class="card-head">
          <h2>用户管理</h2>
          <span class="pill">{{ users.length }}</span>
        </div>
        <div class="form-row">
          <label>用户名 <input v-model="newUser" /></label>
          <label>密码 <input v-model="newPass" type="password" /></label>
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
              style="width: 160px"
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

      <section class="card auto">
        <div class="card-head">
          <h2>监控账号</h2>
          <div class="card-tools">
            <button type="button" class="sm ghost" @click="reloadX">刷新列表</button>
            <button type="button" class="sm" :disabled="xPollBusy" @click="pollX">立即拉取</button>
          </div>
        </div>
        <div class="form-row" style="flex-direction: column; align-items: stretch; gap: 10px">
          <div class="status-text" style="line-height: 1.6">{{ xBannerMeta }}</div>
          <div style="display: flex; flex-wrap: wrap; gap: 8px; align-items: end">
            <label style="flex: 1; min-width: 140px">
              X 用户名（不含 @）
              <input v-model="xUsername" placeholder="例如 cz_binance" maxlength="15" autocomplete="off" />
            </label>
            <label style="flex: 1; min-width: 120px">
              显示名（筛选标签）
              <input v-model="xLabel" placeholder="例如 CZ" maxlength="32" autocomplete="off" />
            </label>
            <button type="button" class="sm" :disabled="xAddBusy" @click="addXAccount">添加</button>
          </div>
          <span class="msg" :class="xMsg ? (xMsgOk ? 'ok' : 'err') : ''">{{ xMsg }}</span>
        </div>
        <div class="card-body" style="max-height: 320px">
          <table>
            <thead>
              <tr>
                <th class="nosort">显示名</th>
                <th class="nosort">用户名</th>
                <th class="nosort">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="a in xAccounts" :key="a.username" :style="a.enabled === false ? 'opacity:.55' : ''">
                <td>
                  <b>{{ a.label || a.name || a.username }}</b>
                  <span v-if="a.enabled === false" class="dim"> 已关闭</span>
                </td>
                <td class="mono">
                  <a class="dim" :href="`https://x.com/${esc(a.username)}`" target="_blank" rel="noopener">
                    @{{ a.username }}
                  </a>
                </td>
                <td>
                  <button
                    type="button"
                    class="sm"
                    :class="a.enabled !== false ? 'ghost' : ''"
                    @click="toggleX(a.username, a.enabled === false)"
                  >
                    {{ a.enabled !== false ? '关闭' : '开启' }}
                  </button>
                  <button type="button" class="sm ghost" @click="editX(a.username)">改标签</button>
                  <button type="button" class="sm danger" @click="deleteX(a.username)">删除</button>
                </td>
              </tr>
            </tbody>
          </table>
          <div v-if="!xAccounts.length" class="empty">暂无账号</div>
        </div>
        <p class="msg" style="padding: 8px 14px 12px; margin: 0; line-height: 1.55">
          改动立即写入服务器；关闭后不拉取该账号。定时拉取（默认 30 分钟，北京时间 9:00–次日 3:00）只抓开启中的账号。主站 X 筛选仅显示开启账号。至少保留 1 个账号（可全部关闭拉取）。
        </p>
      </section>

      <section class="card">
        <div class="card-head">
          <h2>数据监控</h2>
          <span class="pill">{{ monitorHint }}</span>
        </div>
        <div class="tabs">
          <button
            type="button"
            class="tab"
            :class="{ on: monitorTab === 'socket' }"
            @click="monitorTab = 'socket'"
          >
            Socket
          </button>
          <button
            type="button"
            class="tab"
            :class="{ on: monitorTab === 'requests' }"
            @click="monitorTab = 'requests'"
          >
            正常请求
          </button>
          <button
            type="button"
            class="tab"
            :class="{ on: monitorTab === 'errors' }"
            @click="monitorTab = 'errors'"
          >
            报错记录
          </button>
        </div>
        <div class="card-body">
          <div class="log-stream">
            <div v-if="!monitorList.length" class="empty">暂无记录</div>
            <div
              v-for="(item, idx) in monitorList"
              :key="idx"
              class="log-line"
              :class="monitorTab === 'errors' || item.ok === false ? 'err' : 'ok'"
            >
              <span class="t">{{ fmtTime(item.at) }}</span>
              {{ item.message || item.detail || JSON.stringify(item) }}
            </div>
          </div>
        </div>
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
