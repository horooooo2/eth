const fs = require('fs');
const path = require('path');

const bundledWhales = require('../config/whales.json');
const bundledStable = require('../config/whales-stable.json');
const bundledHf = require('../config/whales-hf.json');

const CONFIG_DIR = process.env.CONFIG_DIR || path.join(__dirname, '..', 'config');
const CONFIG_FILE = path.join(CONFIG_DIR, 'whales.json');
const STABLE_FILE = path.join(CONFIG_DIR, 'whales-stable.json');
const HF_FILE = path.join(CONFIG_DIR, 'whales-hf.json');

let memoryOverride = null;

const DEFAULT_KEYWORD_GROUPS = {
  macro: ['非农', 'CPI', 'PPI', 'PMI', 'ISM', 'FOMC', '美联储', '加息', '降息', '利率', '通胀', '就业', '失业率', 'PCE'],
  crypto: ['比特币', '以太坊', '加密货币', 'ETF', 'CLARITY', 'SEC', 'CFTC', '稳定币', 'USDT', 'USDC', '区块链'],
  usStock: ['美股', '纳斯达克', '纳指', '标普', '道指', '道琼斯', '纽交所', '英伟达', '特斯拉', '苹果', '微软', '谷歌', '亚马逊', '英特尔', '博通'],
  event: ['杰克逊霍尔', '众议院', '参议院'],
};

function flattenKeywords(groups) {
  return [...new Set(Object.values(groups || {}).flat().map((item) => String(item).trim()).filter(Boolean))];
}

const DEFAULT_CONFIG = {
  mode: 'hf',
  whales: [],
  keywordGroups: DEFAULT_KEYWORD_GROUPS,
  keywords: flattenKeywords(DEFAULT_KEYWORD_GROUPS),
};

/** 默认 200（priority 排名前 N）；可用环境变量 TOP_WHALE_LIMIT 覆盖（69–1000） */
const TOP_WHALE_LIMIT = Math.max(
  69,
  Math.min(1000, Number(process.env.TOP_WHALE_LIMIT) || 200),
);

function normalizeMode(_value) {
  return 'hf';
}

function readJsonFile(file, fallback) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    console.warn('[config] 读取失败', file, err.message);
  }
  return fallback;
}

function loadPresetWhales(mode) {
  const key = normalizeMode(mode);
  if (key === 'hf') {
    const raw = readJsonFile(HF_FILE, bundledHf);
    return Array.isArray(raw.whales) ? raw.whales : [];
  }
  const raw = readJsonFile(STABLE_FILE, bundledStable);
  return Array.isArray(raw.whales) ? raw.whales : [];
}

function loadRawConfig() {
  if (memoryOverride) return memoryOverride;
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    }
  } catch (err) {
    console.warn('[config] 读取文件失败，改用内置配置:', err.message);
  }
  return bundledWhales;
}

function normalizeWhale(item = {}) {
  return {
    id: String(item.id || item.name || '').trim(),
    name: String(item.name || '').trim(),
    address: String(item.address || '').trim(),
    description: String(item.description || ''),
    winRate: Number(item.winRate) || 0,
    maxDrawdown: Number(item.maxDrawdown) || 0,
    closedTrades: Number(item.closedTrades) || 0,
    weekVlm: Number(item.weekVlm) || 0,
    monthVlm: Number(item.monthVlm) || 0,
    /** 外部脚本定期写入；越高越靠前。为 0 时回退到成交笔数/周成交额 */
    priority: Number(item.priority) || 0,
    style: item.style === 'hf' ? 'hf' : item.style === 'stable' ? 'stable' : undefined,
    enabled: item.enabled !== false,
    /** 后台手动添加；不被 TopN 裁切 */
    manual: item.manual === true,
    /** 人工命名，榜单扩容时保留 */
    customName: item.customName === true,
  };
}

function readConfig() {
  try {
    const raw = loadRawConfig();
    const keywordGroups =
      raw.keywordGroups && typeof raw.keywordGroups === 'object'
        ? raw.keywordGroups
        : DEFAULT_KEYWORD_GROUPS;
    const keywords = Array.isArray(raw.keywords) && raw.keywords.length
      ? raw.keywords.map((item) => String(item).trim()).filter(Boolean)
      : flattenKeywords(keywordGroups);
    const mode = normalizeMode(raw.mode);
    let whales = Array.isArray(raw.whales) ? raw.whales.map(normalizeWhale) : [];
    if (!whales.length) {
      whales = loadPresetWhales(mode).map(normalizeWhale);
    }
    return {
      mode,
      whales,
      keywordGroups,
      keywords,
    };
  } catch (err) {
    console.warn('[config] 读取失败，使用默认配置:', err.message);
    return { ...DEFAULT_CONFIG, whales: loadPresetWhales('stable').map(normalizeWhale) };
  }
}

/** 高胜率、低回撤优先：综合分 = 胜率 - 最大回撤 */
function sortWhalesStable(whales) {
  return [...whales].sort((a, b) => {
    const scoreA = (Number(a.winRate) || 0) - (Number(a.maxDrawdown) || 0);
    const scoreB = (Number(b.winRate) || 0) - (Number(b.maxDrawdown) || 0);
    if (scoreB !== scoreA) return scoreB - scoreA;
    return (Number(b.winRate) || 0) - (Number(a.winRate) || 0);
  });
}

/** 高频优先：priority > 成交笔数 > 周成交额 > 胜率-回撤 */
function sortWhalesHf(whales) {
  return [...whales].sort((a, b) => {
    const priority = (Number(b.priority) || 0) - (Number(a.priority) || 0);
    if (priority) return priority;
    const trades = (Number(b.closedTrades) || 0) - (Number(a.closedTrades) || 0);
    if (trades) return trades;
    const vlm = (Number(b.weekVlm) || 0) - (Number(a.weekVlm) || 0);
    if (vlm) return vlm;
    const scoreA = (Number(a.winRate) || 0) - (Number(a.maxDrawdown) || 0);
    const scoreB = (Number(b.winRate) || 0) - (Number(b.maxDrawdown) || 0);
    if (scoreB !== scoreA) return scoreB - scoreA;
    return (Number(b.winRate) || 0) - (Number(a.winRate) || 0);
  });
}

function sortWhales(whales, mode) {
  const key = normalizeMode(mode || (memoryOverride && memoryOverride.mode) || 'stable');
  return key === 'hf' ? sortWhalesHf(whales) : sortWhalesStable(whales);
}

function writeConfig(config) {
  const keywordGroups =
    config.keywordGroups && typeof config.keywordGroups === 'object'
      ? config.keywordGroups
      : DEFAULT_KEYWORD_GROUPS;
  const mode = normalizeMode(config.mode);
  const next = {
    mode,
    whales: sortWhales(Array.isArray(config.whales) ? config.whales.map(normalizeWhale) : [], mode),
    keywordGroups,
    keywords: Array.isArray(config.keywords) && config.keywords.length
      ? config.keywords.map((item) => String(item).trim()).filter(Boolean)
      : flattenKeywords(keywordGroups),
  };
  memoryOverride = next;
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2), 'utf8');
  } catch (err) {
    console.warn('[config] 写入失败（仅当前实例生效）:', err.message);
  }
  return next;
}

function mergeWhalesByAddress(...lists) {
  const map = new Map();
  for (const list of lists) {
    for (const item of list || []) {
      const whale = normalizeWhale(item);
      const key = normalizeAddress(whale.address) || String(whale.id || '').toLowerCase();
      if (!key || map.has(key)) continue;
      map.set(key, whale);
    }
  }
  return [...map.values()];
}

function makeWhaleId(address) {
  const value = String(address || '').toLowerCase();
  return `0x${value.slice(2, 6)}-${value.slice(-4)}`;
}

function persistPresetWhales(whales) {
  const next = {
    updatedAt: Date.now(),
    whales: sortWhalesHf(whales.map(normalizeWhale)),
  };
  try {
    fs.writeFileSync(HF_FILE, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  } catch (err) {
    console.warn('[config] 写入 HF 名单失败:', err.message);
  }
  return next;
}

/**
 * 手动添加巨鲸地址（可自定义名称）。写入当前配置 + HF 预设，保证重启后仍在。
 */
function addManualWhale({ address, name } = {}) {
  const addr = normalizeAddress(address);
  if (!addr) {
    const err = new Error('地址格式无效，需为 0x + 40 位十六进制');
    err.status = 400;
    throw err;
  }
  const label = String(name || '').trim() || addr.slice(-6);
  const id = makeWhaleId(addr);
  const whale = normalizeWhale({
    id,
    name: label,
    address: addr,
    description: '手动添加',
    enabled: true,
    style: 'hf',
    manual: true,
    customName: Boolean(String(name || '').trim()),
    priority: 99999,
  });

  const current = readConfig();
  const merged = mergeWhalesByAddress([whale], current.whales);
  // 同地址则覆盖名称 / manual 标记
  const byAddr = new Map(
    merged.map((item) => [normalizeAddress(item.address) || item.id, item]),
  );
  byAddr.set(addr, {
    ...(byAddr.get(addr) || {}),
    ...whale,
  });
  const whales = [...byAddr.values()];
  const saved = writeConfig({
    mode: 'hf',
    whales,
    keywordGroups: current.keywordGroups,
    keywords: current.keywords,
  });
  persistPresetWhales(mergeWhalesByAddress(whales, loadPresetWhales('hf')));
  return { whale: byAddr.get(addr), config: saved };
}

/** 修改巨鲸展示名称（标记 customName，避免被榜单脚本覆盖） */
function renameWhale(idOrAddress, name) {
  const label = String(name || '').trim();
  if (!label) {
    const err = new Error('名称不能为空');
    err.status = 400;
    throw err;
  }
  const key = String(idOrAddress || '').trim().toLowerCase();
  const addrKey = normalizeAddress(idOrAddress);
  const current = readConfig();
  let hit = null;
  const whales = current.whales.map((item) => {
    const match =
      String(item.id || '').toLowerCase() === key ||
      normalizeAddress(item.address) === addrKey ||
      (addrKey && normalizeAddress(item.address) === addrKey);
    if (!match) return item;
    hit = normalizeWhale({
      ...item,
      name: label,
      customName: true,
      manual: item.manual === true,
    });
    return hit;
  });
  if (!hit) {
    const err = new Error('未找到该巨鲸');
    err.status = 404;
    throw err;
  }
  const saved = writeConfig({
    mode: current.mode,
    whales,
    keywordGroups: current.keywordGroups,
    keywords: current.keywords,
  });
  const preset = loadPresetWhales('hf').map((item) => {
    if (
      String(item.id || '').toLowerCase() === String(hit.id).toLowerCase() ||
      normalizeAddress(item.address) === normalizeAddress(hit.address)
    ) {
      return { ...item, name: label, customName: true, manual: item.manual === true || hit.manual };
    }
    return item;
  });
  persistPresetWhales(preset);
  return { whale: hit, config: saved };
}

function getActiveWhales() {
  const config = readConfig();
  const configWhales =
    Array.isArray(config.whales) && config.whales.length
      ? config.whales.map(normalizeWhale)
      : [];
  const presetWhales = loadPresetWhales('hf').map(normalizeWhale);
  let whales = mergeWhalesByAddress(configWhales, presetWhales);
  whales = whales.filter((whale) => whale.enabled !== false);

  const manuals = whales.filter((w) => w.manual);
  const rest = whales.filter((w) => !w.manual);
  const ranked = sortWhalesHf(rest).slice(0, TOP_WHALE_LIMIT);
  // 手动添加的永远保留，不被 TopN 裁切
  return mergeWhalesByAddress(manuals, ranked);
}

function setWhaleMode(_mode) {
  const current = readConfig();
  const whales = loadPresetWhales('hf').map(normalizeWhale);
  return writeConfig({
    mode: 'hf',
    whales,
    keywordGroups: current.keywordGroups,
    keywords: current.keywords,
  });
}

/** 统一成小写 0x 地址，方便和链上/HL 数据比对 */
function normalizeAddress(value) {
  if (!value || typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!/^0x[a-fA-F0-9]{40}$/.test(trimmed)) return '';
  return trimmed.toLowerCase();
}

module.exports = {
  DEFAULT_KEYWORD_GROUPS,
  flattenKeywords,
  readConfig,
  writeConfig,
  setWhaleMode,
  getActiveWhales,
  mergeWhalesByAddress,
  loadPresetWhales,
  persistPresetWhales,
  addManualWhale,
  renameWhale,
  makeWhaleId,
  normalizeMode,
  normalizeAddress,
  sortWhales,
  TOP_WHALE_LIMIT,
};
