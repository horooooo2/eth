/**
 * 将 whale-tracker-backend 的运行时文件同步到 whale-tracker-deploy
 * （生产机跑 deploy 目录；CI 上传前执行，避免漏文件导致 404）
 */
const fs = require('fs');
const path = require('path');

const backendRoot = path.join(__dirname, '..');
const projectRoot = path.join(backendRoot, '..');
const deployRoot = path.join(projectRoot, 'whale-tracker-deploy');

const FILES = [
  'server.js',
  'package.json',
  'package-lock.json',
  'lib/createApp.js',
  'lib/db.js',
  'lib/authStore.js',
  'lib/realtimeBridge.js',
  'lib/realtimeHub.js',
  'lib/hlWsClient.js',
  'lib/hlInfoClient.js',
  'lib/config.js',
  'lib/cache.js',
  'lib/runtime.js',
  'lib/opsMonitor.js',
  'lib/sqliteStore.js',
  'lib/whales.js',
  'lib/news.js',
  'lib/newsService.js',
  'lib/markets.js',
  'lib/hyperliquid.js',
  'lib/onchain.js',
  'lib/exchangeLabels.js',
  'lib/calendar.js',
  'lib/calendarFeed.js',
  'lib/fillBackfill.js',
  'lib/positionBackfill.js',
  'lib/positionEventPolicy.js',
  'lib/xFeedPoller.js',
  'lib/xWatchAccounts.js',
  'lib/sorsaTwitter.js',
  'lib/myMemoryTranslate.js',
  'lib/siteReset.js',
  'lib/deepseekClient.js',
  'lib/userAiKeys.js',
  'lib/okxTradeClient.js',
  'lib/userExchangeKeys.js',
  'lib/whaleAiRuntimeLogs.js',
  'lib/v41EngineClient.js',
  'lib/v41RealtimeBridge.js',
  'lib/v41ExecutionGateway.js',
  'lib/v41AlphaLiveGate.js',
  'lib/v41UserBinding.js',
  'lib/v41QaExchange.js',
  'lib/v41WhaleDataBridge.js',
  'routes/auth.js',
  'routes/whales.js',
  'routes/news.js',
  'routes/markets.js',
  'routes/x.js',
  'routes/whaleAi.js',
  'routes/whaleAiTrade.js',
  'routes/whaleAiEngine.js',
  'scripts/remote-deploy.sh',
];

function copyFile(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

let n = 0;
let missing = 0;
for (const rel of FILES) {
  const src = path.join(backendRoot, rel);
  const dest = path.join(deployRoot, rel);
  if (!fs.existsSync(src)) {
    console.warn(`[skip] missing ${rel}`);
    missing += 1;
    continue;
  }
  copyFile(src, dest);
  n += 1;
}

// config whales
for (const name of ['whales.json', 'whales-stable.json', 'whales-hf.json']) {
  const src = path.join(backendRoot, 'config', name);
  if (fs.existsSync(src)) {
    copyFile(src, path.join(deployRoot, 'config', name));
    n += 1;
  }
}

console.log(`[sync-deploy] copied ${n} files → ${deployRoot} (missing ${missing})`);
