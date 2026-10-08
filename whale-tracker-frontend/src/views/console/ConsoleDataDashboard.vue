<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { addManualWhale, createAuthUser, deleteAuthUser, fetchManagementWhales, listAuthUsers, renameWhale, resetSiteData, updateAuthUserPassword } from '@/api';

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
    if (whalePage.value > whalePageCount.value) whalePage.value = whalePageCount.value;
  }).finally(() => { whalesPending = null; });
  return whalesPending;
}

async function loadUsers() {
  const data = await listAuthUsers();
  users.value = data.users || [];
}

async function refreshAll() {
  try {
    showErr('');
    await Promise.all([loadWhales(), loadUsers()]);
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

async function resetSite() {
  if (
    !window.confirm(
      '是否重置整站数据？\n将清空成交/异动/仓位缓存并重新拉取；用户账号与手动添加的巨鲸会保留。',
    )
  ) {
    return;
  }
  resetBusy.value = true;
  resetStatus.value = '正在重置并重新拉取…';
  try {
    const data = await resetSiteData(3);
    resetStatus.value = `重置完成，保留用户及巨鲸配置（手动 ${data.keptManuals ?? 0} 个）`;
    await loadWhales();
  } catch (e) {
    resetStatus.value = `失败：${e instanceof Error ? e.message : String(e)}`;
  } finally {
    resetBusy.value = false;
  }
}

onMounted(() => { void refreshAll(); });
</script>

<template>
  <main class="console-main">
    <div class="err-banner" :class="{ show: Boolean(pageErr) }">{{ pageErr }}</div>
    <section class="banner">
      <div>
        <button class="ghost" type="button" :disabled="resetBusy" @click="refreshAll">刷新列表</button>
        <button class="warn" type="button" :disabled="resetBusy" @click="resetSite">重置</button>
        <span class="status-text" role="status">{{ resetStatus }}</span>
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
