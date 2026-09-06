<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import CoinPreferences from '@/components/CoinPreferences.vue';
import {
  authLoading,
  authUser,
  isLoggedIn,
  login as authLogin,
  logout as authLogout,
} from '@/stores/auth';

const router = useRouter();
const loginUser = ref('');
const loginPass = ref('');
const loginBusy = ref(false);

async function submitLogin() {
  if (loginBusy.value) return;
  loginBusy.value = true;
  try {
    await authLogin(loginUser.value.trim(), loginPass.value);
    ElMessage.success(`已登录：${authUser.value?.username || ''}`);
    loginPass.value = '';
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '登录失败');
  } finally {
    loginBusy.value = false;
  }
}

function onLogout() {
  void ElMessageBox.confirm('确认退出登录？', '退出', {
    confirmButtonText: '退出',
    cancelButtonText: '取消',
    type: 'warning',
  })
    .then(() => authLogout())
    .then(() => ElMessage.success('已退出登录'))
    .catch(() => undefined);
}

function openDesktop() {
  void router.push({ path: '/', query: { view: 'desktop' } });
}
</script>

<template>
  <div class="m-me">
    <section class="m-card">
      <div class="m-card-title">账户</div>
      <template v-if="isLoggedIn">
        <div class="row">
          <span class="label">用户名</span>
          <span class="val">{{ authUser?.username }}</span>
        </div>
        <button type="button" class="btn danger" @click="onLogout">退出登录</button>
      </template>
      <template v-else>
        <el-input v-model="loginUser" placeholder="用户名" size="large" class="field" />
        <el-input
          v-model="loginPass"
          type="password"
          placeholder="密码"
          size="large"
          show-password
          class="field"
          @keyup.enter="submitLogin"
        />
        <button type="button" class="btn primary" :disabled="loginBusy || authLoading" @click="submitLogin">
          登录
        </button>
      </template>
    </section>

    <section class="m-card">
      <div class="m-card-title">关注币种</div>
      <CoinPreferences />
    </section>

    <section class="m-card">
      <div class="m-card-title">显示</div>
      <button type="button" class="btn ghost" @click="openDesktop">切换到电脑版布局</button>
      <p class="hint">手机访问默认进入本页；可在地址加 ?view=desktop 强制电脑版。</p>
    </section>
  </div>
</template>

<style scoped>
.m-card {
  background: #141a24;
  border: 1px solid #1f2937;
  border-radius: 16px;
  padding: 14px;
  margin-bottom: 12px;
}
.m-card-title {
  font-size: 13px;
  font-weight: 700;
  color: #8b9bb5;
  margin-bottom: 12px;
}
.row {
  display: flex;
  justify-content: space-between;
  margin-bottom: 12px;
  font-size: 14px;
}
.label {
  color: #8b9bb5;
}
.val {
  font-weight: 700;
}
.field {
  margin-bottom: 10px;
}
.btn {
  width: 100%;
  border: 0;
  border-radius: 12px;
  padding: 12px;
  font: inherit;
  font-size: 14px;
  font-weight: 700;
  margin-top: 4px;
}
.btn.primary {
  background: #2a4a6a;
  color: #f0f4fa;
}
.btn.danger {
  background: #3a1a1a;
  color: #f87171;
}
.btn.ghost {
  background: #1a222e;
  color: #b0c4de;
}
.btn:disabled {
  opacity: 0.5;
}
.hint {
  margin: 10px 0 0;
  font-size: 12px;
  color: #6a7e9c;
  line-height: 1.5;
}
</style>
