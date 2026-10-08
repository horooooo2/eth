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
  'lib/apiGateway.js',
  'lib/db.js',
  'lib/authStore.js',
  'lib/realtimeBridge.js',
  'lib/realtimeHub.js',
  'lib/socketSend.js',
  'lib/stateStream.js',
  'lib/whaleSync.js',
  'lib/whaleObservationEngine.js',
  'lib/whaleObservationStore.js',
  'lib/observationScope.js',
  'lib/whaleObservationWorker.js',
  'lib/observationCompute.js',
  'lib/observationComputeChild.js',
  'lib/observationGarbage.js',
  'lib/whaleRetention.js',
  'lib/maintenanceAuth.js',
  'lib/hlWsClient.js',
  'lib/dataFreshness.js',
  'lib/outboundHealth.js',
  'lib/positionPoller.js',
  'lib/hlInfoClient.js',
  'lib/config.js',
  'lib/cache.js',
  'lib/boundedCache.js',
  'lib/runtime.js',
  'lib/opsMonitor.js',
  'lib/sqliteStore.js',
  'lib/fillFactProjection.js',
  'lib/observationEvidence.js',
  'lib/asyncMirror.js',
  'lib/whales.js',
  'lib/news.js',
  'lib/newsService.js',
  'lib/markets.js',
  'lib/tradfiMarkets.js',
  'lib/radarLongTrend.js',
  'lib/radarStream.js',
  'lib/radarRealtime.js',
  'lib/radarSort.js',
  'lib/featureFlags.js',
  'lib/tradfiDirection.js',
  'lib/tradfiAnalysis.js',
  'lib/tradfiAnalysisStore.js',
  'lib/strategyShadow.js',
  'lib/strategyShadowStore.js',
  'lib/tradfiIntel.js',
  'lib/tradfiWhales.js',
  'lib/binanceTradfiTrade.js',
  'lib/binanceAiLedger.js',
  'lib/tradfiRangeCore.cjs',
  'lib/tradfiRangeStrategy.js',
  'lib/hyperliquid.js',
  'lib/onchain.js',
  'lib/exchangeLabels.js',
  'lib/calendar.js',
  'lib/calendarFeed.js',
  'lib/fillBackfill.js',
  'lib/positionBackfill.js',
  'lib/positionEventPolicy.js',
  'lib/siteReset.js',
  'lib/deepseekClient.js',
  'lib/marketBrief.js',
  'lib/assetRegistry.js',
  'lib/briefModuleCache.js',
  'lib/analysisResult.js',
  'lib/analysisCapability.js',
  'lib/directionEngine.js',
  'lib/briefAnalysisStore.js',
  'lib/userAiKeys.js',
  'lib/userExchangeKeys.js',
  'lib/defillamaMacro.js',
  'public/data.html',
  'routes/auth.js',
  'routes/whales.js',
  'routes/news.js',
  'routes/markets.js',
  'routes/tradfi.js',
  'routes/strategyShadow.js',
  'routes/flow.js',
  'routes/whaleAi.js',
  'scripts/remote-deploy.sh',
  'scripts/audit-whale-data.js',
];

// Older packages may still contain these retired, unmounted modules.
const RETIRED_FILES = [
  'lib/statisticsWorker.js',
  'lib/statisticsCompute.js',
  'lib/statisticsComputeChild.js',
  'lib/resonanceEngine.js',

  'lib/directionSummary.js',
  'lib/sharedQuery.js',
  'lib/binanceAiAccountBook.js',
  'lib/cryptoAiOrderGate.js',
  'lib/okxTradeClient.js',
  'lib/okxAiLedger.js',
  'lib/dexpaprikaFlow.js',
  'lib/binanceCryptoTrade.js',
  'routes/okxTrade.js',
  'routes/okxKeys.js',
  'routes/binanceTrade.js',
];
for (const rel of RETIRED_FILES) {
  const target = path.resolve(deployRoot, rel);
  if (!target.startsWith(`${path.resolve(deployRoot)}${path.sep}`)) {
    throw new Error(`Retired module escapes deploy directory: ${rel}`);
  }
  fs.rmSync(target, { force: true });
}

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

function collectLocalRequires(abs) {
  const text = fs.readFileSync(abs, 'utf8');
  const re = /require\(['"](\.\.?\/[^'"]+)['"]\)/g;
  const out = [];
  let match;
  while ((match = re.exec(text))) out.push(match[1]);
  return out;
}

function resolveLocal(fromAbs, spec) {
  const base = path.resolve(path.dirname(fromAbs), spec);
  return [base, `${base}.js`, `${base}.cjs`, `${base}.json`, path.join(base, 'index.js')].find((candidate) =>
    fs.existsSync(candidate),
  );
}

const unresolved = [];
for (const rel of FILES) {
  if (!rel.endsWith('.js')) continue;
  const dest = path.join(deployRoot, rel);
  if (!fs.existsSync(dest)) continue;
  for (const spec of collectLocalRequires(dest)) {
    if (resolveLocal(dest, spec)) continue;
    unresolved.push(`${rel} -> ${spec}`);
  }
}
if (unresolved.length) {
  console.error('[sync-deploy] packed JS requires missing local modules:');
  for (const row of unresolved) console.error(`  ${row}`);
  process.exit(2);
}

console.log(`[sync-deploy] copied ${n} files → ${deployRoot} (missing ${missing})`);
