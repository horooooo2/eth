const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const LIMIT = Math.max(
  69,
  Math.min(1000, Number(process.env.TOP_WHALE_LIMIT) || 200),
);

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

function rowToWhale(row) {
  const address = String(row.address || '').toLowerCase();
  const suffix = address.slice(-4);
  const winRate = Math.round(Number(row.winRate) || 0);
  const closedTrades = Number(row.closedTrades) || 0;
  const maxDrawdown = Math.round(Number(row.ddMonth ?? row.ddAll) || 0);
  const coins = (row.top || []).slice(0, 4).join('/');
  return {
    id: makeWhaleId(address),
    name: `高频${winRate}%·${closedTrades}笔${suffix}`,
    address,
    description: `近月成交 ${closedTrades} 笔，胜率 ${winRate}%，回撤约 ${maxDrawdown}%，主做 ${coins || '—'}`,
    winRate,
    maxDrawdown,
    closedTrades,
    weekVlm: Number(row.weekVlm) || 0,
    enabled: true,
    style: 'hf',
  };
}

function pickCandidates(existing, pool, need, filters) {
  const seen = new Set(existing.map((item) => item.address.toLowerCase()));
  const picked = [];
  for (const row of pool) {
    const address = String(row.address || '').toLowerCase();
    if (!address || seen.has(address)) continue;
    if (row.closedTrades < filters.minTrades) continue;
    if (row.winRate < filters.minWinRate) continue;
    if (row.daysAgo > filters.maxDaysAgo) continue;
    picked.push(rowToWhale(row));
    seen.add(address);
    if (picked.length >= need) break;
  }
  return picked;
}

function expandWhales(currentWhales, screen) {
  const ranked = Array.isArray(screen.ranked) ? screen.ranked : [];
  const all = Array.isArray(screen.all) ? screen.all : [];
  const pool = [...ranked, ...all];
  const whales = [...currentWhales];
  const need = LIMIT - whales.length;
  if (need <= 0) return sortWhalesHf(whales).slice(0, LIMIT);

  const tiers = [
    { minTrades: 620, minWinRate: 59, maxDaysAgo: 7 },
    { minTrades: 400, minWinRate: 50, maxDaysAgo: 14 },
    { minTrades: 200, minWinRate: 40, maxDaysAgo: 30 },
    { minTrades: 50, minWinRate: 30, maxDaysAgo: 60 },
    { minTrades: 0, minWinRate: 0, maxDaysAgo: 9999 },
  ];

  for (const filters of tiers) {
    const remaining = LIMIT - whales.length;
    if (remaining <= 0) break;
    whales.push(...pickCandidates(whales, pool, remaining, filters));
  }

  return sortWhalesHf(whales).slice(0, LIMIT);
}

function writeJson(file, data) {
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

const screen = JSON.parse(fs.readFileSync(path.join(__dirname, 'screen-result-2.json'), 'utf8'));
const hfFile = path.join(ROOT, 'config', 'whales-hf.json');
const whalesFile = path.join(ROOT, 'config', 'whales.json');
const deployHfFile = path.join(ROOT, '..', 'whale-tracker-deploy', 'config', 'whales-hf.json');
const deployWhalesFile = path.join(ROOT, '..', 'whale-tracker-deploy', 'config', 'whales.json');

const current = JSON.parse(fs.readFileSync(hfFile, 'utf8'));
const expanded = expandWhales(current.whales, screen);
const hfPayload = { whales: expanded };
writeJson(hfFile, hfPayload);

const whalesConfig = JSON.parse(fs.readFileSync(whalesFile, 'utf8'));
whalesConfig.mode = 'hf';
whalesConfig.whales = expanded;
writeJson(whalesFile, whalesConfig);

writeJson(deployHfFile, hfPayload);
const deployWhales = JSON.parse(fs.readFileSync(deployWhalesFile, 'utf8'));
deployWhales.mode = 'hf';
deployWhales.whales = expanded;
writeJson(deployWhalesFile, deployWhales);

console.log(`HF whales expanded: ${current.whales.length} -> ${expanded.length}`);
