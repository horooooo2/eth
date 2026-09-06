/**
 * X 监控账号配置（持久化到 cache/x-watch-accounts.json）
 * data 页面增删改 / 开启关闭；拉取任务只抓 enabled 账号。
 */
const { readCache, writeCache } = require('./cache');

const CACHE_NAME = 'x-watch-accounts';

const DEFAULT_ACCOUNTS = [
  { username: 'VitalikButerin', label: 'V神', name: 'Vitalik Buterin', enabled: true },
  { username: 'elonmusk', label: '马斯克', name: 'Elon Musk', enabled: true },
  { username: 'cz_binance', label: 'CZ', name: 'CZ', enabled: true },
];

function normalizeUsername(raw) {
  return String(raw || '')
    .trim()
    .replace(/^@+/, '')
    .replace(/\s+/g, '');
}

function isValidUsername(username) {
  return /^[A-Za-z0-9_]{1,15}$/.test(username);
}

function normalizeAccount(input = {}) {
  const username = normalizeUsername(input.username);
  if (!isValidUsername(username)) {
    const err = new Error('用户名无效（1–15 位字母/数字/下划线）');
    err.code = 'INVALID_USER';
    throw err;
  }
  const label = String(input.label || username).trim() || username;
  const name = String(input.name || label).trim() || label;
  const enabled = input.enabled === false || input.enabled === 0 || input.enabled === '0' ? false : true;
  return { username, label, name, enabled };
}

function readStored() {
  const cached = readCache(CACHE_NAME);
  const list = cached?.data?.accounts;
  if (Array.isArray(list) && list.length) {
    return list
      .map((a) => {
        try {
          return normalizeAccount(a);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  }
  return null;
}

function persist(accounts) {
  const payload = {
    accounts,
    updatedAt: Date.now(),
  };
  writeCache(CACHE_NAME, payload);
  return payload;
}

/** 全部账号（含关闭） */
function getWatchAccounts({ enabledOnly = false } = {}) {
  let stored = readStored();
  if (!stored?.length) {
    persist(DEFAULT_ACCOUNTS.map((a) => ({ ...a })));
    stored = DEFAULT_ACCOUNTS.map((a) => ({ ...a }));
  }
  if (enabledOnly) return stored.filter((a) => a.enabled !== false);
  return stored;
}

function listAccounts() {
  const accounts = getWatchAccounts();
  const cached = readCache(CACHE_NAME);
  return {
    accounts,
    updatedAt: Number(cached?.updatedAt || cached?.data?.updatedAt) || Date.now(),
  };
}

function addAccount(input) {
  const next = normalizeAccount({ ...input, enabled: input.enabled !== false });
  const accounts = getWatchAccounts();
  if (accounts.some((a) => a.username.toLowerCase() === next.username.toLowerCase())) {
    const err = new Error(`已存在 @${next.username}`);
    err.code = 'DUPLICATE';
    throw err;
  }
  accounts.push(next);
  persist(accounts);
  return listAccounts();
}

function updateAccount(username, patch = {}) {
  const key = normalizeUsername(username).toLowerCase();
  const accounts = getWatchAccounts();
  const idx = accounts.findIndex((a) => a.username.toLowerCase() === key);
  if (idx < 0) {
    const err = new Error('账号不存在');
    err.code = 'NOT_FOUND';
    throw err;
  }
  const cur = accounts[idx];
  const merged = normalizeAccount({
    username: cur.username,
    label: patch.label != null ? patch.label : cur.label,
    name: patch.name != null ? patch.name : cur.name,
    enabled: patch.enabled != null ? patch.enabled : cur.enabled,
  });
  accounts[idx] = { ...merged, username: cur.username };
  persist(accounts);
  return listAccounts();
}

function setAccountEnabled(username, enabled) {
  return updateAccount(username, { enabled: Boolean(enabled) });
}

function removeAccount(username) {
  const key = normalizeUsername(username).toLowerCase();
  const accounts = getWatchAccounts();
  const next = accounts.filter((a) => a.username.toLowerCase() !== key);
  if (next.length === accounts.length) {
    const err = new Error('账号不存在');
    err.code = 'NOT_FOUND';
    throw err;
  }
  if (!next.length) {
    const err = new Error('至少保留 1 个监控账号');
    err.code = 'LAST_ONE';
    throw err;
  }
  persist(next);
  return listAccounts();
}

function replaceAccounts(list) {
  if (!Array.isArray(list) || !list.length) {
    const err = new Error('账号列表不能为空');
    err.code = 'EMPTY';
    throw err;
  }
  const seen = new Set();
  const accounts = [];
  for (const item of list) {
    const a = normalizeAccount(item);
    const k = a.username.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    accounts.push(a);
  }
  if (!accounts.length) {
    const err = new Error('没有有效账号');
    err.code = 'EMPTY';
    throw err;
  }
  persist(accounts);
  return listAccounts();
}

module.exports = {
  DEFAULT_ACCOUNTS,
  normalizeUsername,
  getWatchAccounts,
  listAccounts,
  addAccount,
  updateAccount,
  setAccountEnabled,
  removeAccount,
  replaceAccounts,
};
