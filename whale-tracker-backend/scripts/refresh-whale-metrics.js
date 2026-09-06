/**
 * 定期刷新名单排序指标（priority / weekVlm）。
 * 数据源：Hyperliquid 官方排行榜（周/月成交额、账户价值）。
 * 保留筛选得到的 closedTrades / winRate / maxDrawdown，不覆盖。
 *
 * 建议：每周跑一次
 *   node scripts/refresh-whale-metrics.js
 *   npm run refresh:metrics
 */
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const ROOT = path.join(__dirname, '..');
const LEADERBOARD_URL = 'https://stats-data.hyperliquid.xyz/Mainnet/leaderboard';

function windowPerf(row, window) {
  const list = row.windowPerformances || [];
  const hit = list.find((item) => item?.[0] === window);
  return hit?.[1] || { pnl: '0', roi: '0', vlm: '0' };
}

function log10p(value) {
  return Math.log10(Math.max(0, Number(value) || 0) + 1);
}

/**
 * priority：综合筛选质量 + 榜单活跃度（越高越靠前）
 * - closedTrades / 胜率−回撤：保留历史筛选信号
 * - weekVlm / monthVlm / accountValue：来自榜单的实时活跃度
 */
function computePriority({ closedTrades, winRate, maxDrawdown, weekVlm, monthVlm, accountValue }) {
  const quality = (Number(winRate) || 0) - (Number(maxDrawdown) || 0);
  return Math.round(
    log10p(closedTrades) * 1200 +
      log10p(weekVlm) * 220 +
      log10p(monthVlm) * 80 +
      log10p(accountValue) * 40 +
      quality * 3,
  );
}

function sortWhalesHf(whales) {
  return [...whales].sort((a, b) => {
    const priority = (Number(b.priority) || 0) - (Number(a.priority) || 0);
    if (priority) return priority;
    const trades = (Number(b.closedTrades) || 0) - (Number(a.closedTrades) || 0);
    if (trades) return trades;
    const vlm = (Number(b.weekVlm) || 0) - (Number(a.weekVlm) || 0);
    if (vlm) return vlm;
    return (Number(b.winRate) || 0) - (Number(a.winRate) || 0);
  });
}

function writeJson(file, data) {
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

async function main() {
  console.log('[metrics] fetching leaderboard...');
  const { data } = await axios.get(LEADERBOARD_URL, { timeout: 90_000 });
  const rows = Array.isArray(data?.leaderboardRows) ? data.leaderboardRows : [];
  const byAddr = new Map();
  for (const row of rows) {
    const address = String(row.ethAddress || '').toLowerCase();
    if (!address.startsWith('0x')) continue;
    const week = windowPerf(row, 'week');
    const month = windowPerf(row, 'month');
    byAddr.set(address, {
      weekVlm: Number(week.vlm) || 0,
      monthVlm: Number(month.vlm) || 0,
      accountValue: Number(row.accountValue) || 0,
      monthPnl: Number(month.pnl) || 0,
    });
  }
  console.log(`[metrics] leaderboard rows=${rows.length}`);

  const hfFile = path.join(ROOT, 'config', 'whales-hf.json');
  const whalesFile = path.join(ROOT, 'config', 'whales.json');
  const deployHfFile = path.join(ROOT, '..', 'whale-tracker-deploy', 'config', 'whales-hf.json');
  const deployWhalesFile = path.join(ROOT, '..', 'whale-tracker-deploy', 'config', 'whales.json');

  const current = JSON.parse(fs.readFileSync(hfFile, 'utf8'));
  const whales = Array.isArray(current.whales) ? current.whales : [];
  let hit = 0;
  const updated = whales.map((whale) => {
    const address = String(whale.address || '').toLowerCase();
    const lb = byAddr.get(address);
    const weekVlm = lb ? lb.weekVlm : Number(whale.weekVlm) || 0;
    if (lb) hit += 1;
    const priority = computePriority({
      closedTrades: whale.closedTrades,
      winRate: whale.winRate,
      maxDrawdown: whale.maxDrawdown,
      weekVlm,
      monthVlm: lb?.monthVlm || 0,
      accountValue: lb?.accountValue || 0,
    });
    return {
      ...whale,
      weekVlm,
      monthVlm: lb ? lb.monthVlm : Number(whale.monthVlm) || 0,
      priority,
    };
  });

  const sorted = sortWhalesHf(updated);
  const hfPayload = { whales: sorted };
  writeJson(hfFile, hfPayload);

  const whalesConfig = JSON.parse(fs.readFileSync(whalesFile, 'utf8'));
  whalesConfig.mode = 'hf';
  whalesConfig.whales = sorted;
  writeJson(whalesFile, whalesConfig);

  if (fs.existsSync(path.dirname(deployHfFile))) {
    writeJson(deployHfFile, hfPayload);
    if (fs.existsSync(deployWhalesFile)) {
      const deployWhales = JSON.parse(fs.readFileSync(deployWhalesFile, 'utf8'));
      deployWhales.mode = 'hf';
      deployWhales.whales = sorted;
      writeJson(deployWhalesFile, deployWhales);
    }
  }

  const top = sorted.slice(0, 5).map((w) => `${w.name}(p=${w.priority})`).join(' | ');
  console.log(`[metrics] updated ${sorted.length} whales, leaderboard hits=${hit}`);
  console.log(`[metrics] top5: ${top}`);
}

main().catch((err) => {
  console.error('[metrics] failed:', err.message || err);
  process.exit(1);
});
