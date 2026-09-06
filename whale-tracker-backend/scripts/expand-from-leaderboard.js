/**
 * 从 Hyperliquid 官方排行榜扩容高频名单。
 * 保留现有 screened HF 地址，再按月成交额补齐到 LIMIT。
 *
 * 用法：node scripts/expand-from-leaderboard.js
 * 可选环境变量：TOP_WHALE_LIMIT（默认 200）
 */
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const ROOT = path.join(__dirname, '..');
const LIMIT = Math.max(
  69,
  Math.min(1000, Number(process.env.TOP_WHALE_LIMIT) || 200),
);
const LEADERBOARD_URL = 'https://stats-data.hyperliquid.xyz/Mainnet/leaderboard';

function sortWhalesHf(whales) {
  return [...whales].sort((a, b) => {
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

function makeWhaleId(address) {
  const value = String(address || '').toLowerCase();
  return `0x${value.slice(2, 6)}-${value.slice(-4)}`;
}

function formatCompactUsd(value) {
  const n = Math.abs(Number(value) || 0);
  if (n >= 1e8) return `${(n / 1e8).toFixed(1)}亿`;
  if (n >= 1e4) return `${Math.round(n / 1e4)}万`;
  return String(Math.round(n));
}

function windowPerf(row, window) {
  const list = row.windowPerformances || row.window_performances || [];
  const hit = list.find((item) => item?.[0] === window);
  return hit?.[1] || { pnl: '0', roi: '0', vlm: '0' };
}

function rowToWhale(row) {
  const address = String(row.ethAddress || row.address || '').toLowerCase();
  const suffix = address.slice(-6);
  const month = windowPerf(row, 'month');
  const week = windowPerf(row, 'week');
  const accountValue = Number(row.accountValue || row.account_value) || 0;
  const monthPnl = Number(month.pnl) || 0;
  const monthVlm = Number(month.vlm) || 0;
  const weekVlm = Number(week.vlm) || 0;
  const display = String(row.displayName || row.display_name || '').trim();
  // 标题只保留 ENS/展示名或地址后缀；成交额等指标走独立字段，避免「榜单·月成…」堆叠
  const name = display || suffix;
  return {
    id: makeWhaleId(address),
    name,
    address,
    description: `HL 榜单：账户 $${formatCompactUsd(accountValue)}，月成交 $${formatCompactUsd(monthVlm)}，月盈亏 $${formatCompactUsd(monthPnl)}`,
    winRate: 0,
    maxDrawdown: 0,
    closedTrades: 0,
    weekVlm,
    monthVlm,
    enabled: true,
    style: 'hf',
  };
}

function scoreRow(row) {
  const month = windowPerf(row, 'month');
  const week = windowPerf(row, 'week');
  const all = windowPerf(row, 'allTime');
  return {
    row,
    address: String(row.ethAddress || '').toLowerCase(),
    accountValue: Number(row.accountValue) || 0,
    monthPnl: Number(month.pnl) || 0,
    monthVlm: Number(month.vlm) || 0,
    weekVlm: Number(week.vlm) || 0,
    allPnl: Number(all.pnl) || 0,
  };
}

function pickFromLeaderboard(existing, rows, need) {
  const seen = new Set(existing.map((item) => String(item.address || '').toLowerCase()));
  const scored = rows
    .map(scoreRow)
    .filter((item) => item.address.startsWith('0x') && item.address.length === 42)
    .filter((item) => !seen.has(item.address))
    .filter((item) => item.accountValue >= 200_000)
    .filter((item) => item.monthVlm >= 1_000_000)
    .filter((item) => item.monthPnl > 0);

  scored.sort((a, b) => {
    if (b.monthVlm !== a.monthVlm) return b.monthVlm - a.monthVlm;
    if (b.accountValue !== a.accountValue) return b.accountValue - a.accountValue;
    return b.monthPnl - a.monthPnl;
  });

  const picked = [];
  for (const item of scored) {
    if (picked.length >= need) break;
    picked.push(rowToWhale(item.row));
    seen.add(item.address);
  }
  return picked;
}

function writeJson(file, data) {
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

async function main() {
  console.log(`[expand] limit=${LIMIT}, fetching leaderboard...`);
  const { data } = await axios.get(LEADERBOARD_URL, { timeout: 90_000 });
  const rows = Array.isArray(data?.leaderboardRows) ? data.leaderboardRows : [];
  console.log(`[expand] leaderboard rows=${rows.length}`);

  const hfFile = path.join(ROOT, 'config', 'whales-hf.json');
  const whalesFile = path.join(ROOT, 'config', 'whales.json');
  const deployHfFile = path.join(ROOT, '..', 'whale-tracker-deploy', 'config', 'whales-hf.json');
  const deployWhalesFile = path.join(ROOT, '..', 'whale-tracker-deploy', 'config', 'whales.json');

  const current = JSON.parse(fs.readFileSync(hfFile, 'utf8'));
  const base = Array.isArray(current.whales) ? current.whales : [];
  const manuals = base.filter((w) => w && w.manual);
  const restBase = base.filter((w) => !(w && w.manual));
  const need = Math.max(0, LIMIT - restBase.length);
  const extras = pickFromLeaderboard(restBase, rows, need);
  // 保留人工名称：榜单扩容不覆盖 customName / manual
  const byAddr = new Map();
  for (const item of [...restBase, ...extras]) {
    const key = String(item.address || '').toLowerCase();
    if (!key || byAddr.has(key)) continue;
    byAddr.set(key, item);
  }
  for (const item of restBase) {
    if (!item?.customName) continue;
    const key = String(item.address || '').toLowerCase();
    if (!key || !byAddr.has(key)) continue;
    byAddr.set(key, { ...byAddr.get(key), name: item.name, customName: true });
  }
  const ranked = sortWhalesHf([...byAddr.values()]).slice(0, LIMIT);
  const expanded = [...manuals, ...ranked.filter((w) => !manuals.some((m) => String(m.address).toLowerCase() === String(w.address).toLowerCase()))];

  const hfPayload = { whales: expanded };
  writeJson(hfFile, hfPayload);

  const whalesConfig = JSON.parse(fs.readFileSync(whalesFile, 'utf8'));
  whalesConfig.mode = 'hf';
  whalesConfig.whales = expanded;
  writeJson(whalesFile, whalesConfig);

  if (fs.existsSync(path.dirname(deployHfFile))) {
    writeJson(deployHfFile, hfPayload);
    if (fs.existsSync(deployWhalesFile)) {
      const deployWhales = JSON.parse(fs.readFileSync(deployWhalesFile, 'utf8'));
      deployWhales.mode = 'hf';
      deployWhales.whales = expanded;
      writeJson(deployWhalesFile, deployWhales);
    }
  }

  console.log(`[expand] ${base.length} -> ${expanded.length} (+${extras.length} from leaderboard)`);
}

main().catch((err) => {
  console.error('[expand] failed:', err.message || err);
  process.exit(1);
});
