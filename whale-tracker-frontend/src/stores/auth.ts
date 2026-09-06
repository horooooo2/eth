import { computed, ref, watch } from 'vue';
import {
  createAuthUser,
  fetchAuthMe,
  loginAuth,
  logoutAuth,
  saveAuthSettings,
} from '@/api';
import { writeMonitoredWhales, monitoredWhaleIds } from '@/utils/monitoredWhales';
import { preferredCoinsState, writePreferredCoins } from '@/utils/watchedCoins';
import { readAlertMinUsd, writeAlertMinUsd } from '@/utils/alertView';
import {
  alertSoundEnabled,
  setAlertSoundEnabled,
} from '@/utils/alertSound';

const TOKEN_KEY = 'whale-tracker-auth-token';
const USER_KEY = 'whale-tracker-auth-user';
const CRED_KEY = 'whale-tracker-auth-cred';

export type UserSettings = {
  monitoredWhales?: string[];
  preferredCoins?: string[];
  alertSoundEnabled?: boolean;
  alertSideFilter?: 'all' | 'long' | 'short';
  openOnly?: boolean;
  alertCoinFilter?: string;
  alertMinUsd?: number;
  whaleSortMode?: 'all' | 'positionValue' | 'positionPnl' | 'latest';
  whaleDirectionFilter?: string;
};

const token = ref<string>(localStorage.getItem(TOKEN_KEY) || '');
const user = ref<{ id: string; username: string; createdAt?: number } | null>(
  (() => {
    try {
      return JSON.parse(localStorage.getItem(USER_KEY) || 'null');
    } catch {
      return null;
    }
  })(),
);
const settings = ref<UserSettings>({});
const loading = ref(false);
const syncing = ref(false);
let syncTimer: ReturnType<typeof setTimeout> | null = null;
let applyingRemote = false;

export const authUser = computed(() => user.value);
export const authToken = computed(() => token.value);
export const isLoggedIn = computed(() => Boolean(user.value));
export const authLoading = computed(() => loading.value);

function readCred(): { username: string; password: string } | null {
  try {
    const raw = localStorage.getItem(CRED_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed?.username && parsed?.password) return parsed;
  } catch {
    // ignore
  }
  return null;
}

function writeCred(username: string, password: string) {
  localStorage.setItem(CRED_KEY, JSON.stringify({ username, password }));
}

function clearCred() {
  localStorage.removeItem(CRED_KEY);
}

function persistSession(nextToken: string, nextUser: typeof user.value) {
  token.value = nextToken;
  user.value = nextUser;
  if (nextToken) localStorage.setItem(TOKEN_KEY, nextToken);
  else localStorage.removeItem(TOKEN_KEY);
  if (nextUser) localStorage.setItem(USER_KEY, JSON.stringify(nextUser));
  else localStorage.removeItem(USER_KEY);
}

function collectLocalSettings(): UserSettings {
  return {
    monitoredWhales: [...monitoredWhaleIds.value],
    preferredCoins: [...preferredCoinsState.value],
    alertSoundEnabled: alertSoundEnabled.value,
    alertMinUsd: readAlertMinUsd(),
    alertSideFilter: settings.value.alertSideFilter || 'all',
    openOnly: Boolean(settings.value.openOnly),
    alertCoinFilter: settings.value.alertCoinFilter || 'all',
    whaleSortMode: settings.value.whaleSortMode || 'all',
    whaleDirectionFilter: settings.value.whaleDirectionFilter || 'all',
  };
}

function applySettings(remote: UserSettings) {
  applyingRemote = true;
  try {
    settings.value = { ...settings.value, ...remote };
    if (Array.isArray(remote.monitoredWhales)) {
      writeMonitoredWhales(remote.monitoredWhales);
    }
    if (Array.isArray(remote.preferredCoins) && remote.preferredCoins.length) {
      writePreferredCoins(remote.preferredCoins);
    }
    if (typeof remote.alertSoundEnabled === 'boolean') {
      setAlertSoundEnabled(remote.alertSoundEnabled);
    }
    if (typeof remote.alertMinUsd === 'number') {
      writeAlertMinUsd(remote.alertMinUsd);
    }
  } finally {
    applyingRemote = false;
  }
}

export function scheduleSettingsSync(delayMs = 600) {
  if (!isLoggedIn.value || applyingRemote) return;
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    void flushSettingsSync();
  }, delayMs);
}

export async function flushSettingsSync() {
  if (!isLoggedIn.value || syncing.value) return;
  syncing.value = true;
  try {
    const payload = collectLocalSettings();
    const data = await saveAuthSettings(payload);
    settings.value = { ...settings.value, ...(data.settings || payload) };
  } catch (err) {
    console.warn('[auth] 同步设置失败', err);
  } finally {
    syncing.value = false;
  }
}

export async function bootstrapAuth() {
  const cred = readCred();
  // 本地已有用户信息则先视为已登录（内网长期保持）
  if (!token.value && !user.value && !cred) return null;
  loading.value = true;
  try {
    if (token.value) {
      try {
        const data = await fetchAuthMe();
        persistSession(token.value, data.user);
        applySettings(data.settings || {});
        return data.user;
      } catch {
        // token 失效则尝试用本地凭据静默重登
      }
    }
    if (cred) {
      const data = await loginAuth(cred.username, cred.password);
      persistSession(data.token, data.user);
      applySettings((data.settings || {}) as UserSettings);
      return data.user;
    }
    // 仅有本地用户缓存、无凭据：保持展示登录态，接口失败时再提示
    if (user.value) return user.value;
    return null;
  } catch {
    // 保留本地登录展示，不强制清掉
    return user.value;
  } finally {
    loading.value = false;
  }
}

export async function login(username: string, password: string) {
  loading.value = true;
  try {
    const data = await loginAuth(username, password);
    persistSession(data.token, data.user);
    writeCred(username, password);
    const remote = (data.settings || {}) as UserSettings;
    const hasRemote =
      (Array.isArray(remote.monitoredWhales) && remote.monitoredWhales.length > 0) ||
      (Array.isArray(remote.preferredCoins) && remote.preferredCoins.length > 0) ||
      typeof remote.alertSoundEnabled === 'boolean' ||
      typeof remote.alertMinUsd === 'number' ||
      Boolean(remote.alertSideFilter && remote.alertSideFilter !== 'all');
    if (hasRemote) {
      applySettings(remote);
    } else {
      await flushSettingsSync();
    }
    return data.user;
  } finally {
    loading.value = false;
  }
}

export async function logout() {
  try {
    await logoutAuth();
  } catch {
    // ignore
  }
  clearCred();
  persistSession('', null);
  settings.value = {};
}

export async function createUser(username: string, password: string) {
  return createAuthUser(username, password);
}

export function patchAuthUiSettings(partial: Partial<UserSettings>) {
  settings.value = { ...settings.value, ...partial };
  scheduleSettingsSync();
}

export function getAuthUiSettings() {
  return settings.value;
}

// 本地偏好变更时自动同步
watch(monitoredWhaleIds, () => scheduleSettingsSync(), { deep: true });
watch(preferredCoinsState, () => scheduleSettingsSync(), { deep: true });
watch(alertSoundEnabled, () => scheduleSettingsSync());
