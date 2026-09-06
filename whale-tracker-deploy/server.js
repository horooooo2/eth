/**
 * 巨鲸追踪与宏观共振仪表盘 · 后端入口
 * 开发时由 Vite 把 /api 代理到这里；生产环境同时托管前端静态文件。
 */
const path = require('path');
const fs = require('fs');
const http = require('http');

/** 轻量加载 .env（不依赖 dotenv 包） */
function loadEnvFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return;
    const text = fs.readFileSync(filePath, 'utf8');
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (process.env[key] == null || process.env[key] === '') {
        process.env[key] = value;
      }
    }
  } catch (err) {
    console.warn('[env] 读取 .env 失败:', err.message);
  }
}

loadEnvFile(path.join(__dirname, '.env'));

const express = require('express');
const { createApp } = require('./lib/createApp');
const { refreshWhalesShard, isProgressiveLoading } = require('./lib/whales');
const { refreshNews } = require('./lib/newsService');
const { getMarkets } = require('./lib/markets');
const { getHlInfoConfig } = require('./lib/hlInfoClient');
const { attachRealtimeHub } = require('./lib/realtimeHub');
const { startRealtimeBridge, syncFromCache, getRealtimeStatus } = require('./lib/realtimeBridge');
const { startFillBackfill, getBackfillStatus } = require('./lib/fillBackfill');
const {
  startPositionBackfill,
  getPositionBackfillStatus,
} = require('./lib/positionBackfill');
const { startOkxPolling, getOkxStatus } = require('./lib/okxCopyTrading');

const app = createApp({ prefixes: ['/api'] });
const PORT = Number(process.env.PORT) || 80;
/**
 * 定时分片刷新间隔（毫秒）。
 * 有实时 WS 时默认 5 分钟兜底；可用 REFRESH_INTERVAL 覆盖。
 */
const REFRESH_MS = Math.max(
  30_000,
  Number(process.env.REFRESH_INTERVAL_MS || process.env.REFRESH_INTERVAL) || 300_000,
);
const publicDir = path.join(__dirname, 'public');

if (fs.existsSync(publicDir)) {
  app.use(
    express.static(publicDir, {
      index: false,
      setHeaders(res, filePath) {
        if (filePath.endsWith('.html')) {
          res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
        } else if (filePath.includes(`${path.sep}assets${path.sep}`)) {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        }
      },
    }),
  );
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    if (req.path === '/realtime') return next();
    // 保留 public 下独立 html（如 data.html）
    if (req.path.endsWith('.html')) {
      const file = path.join(publicDir, path.basename(req.path));
      if (fs.existsSync(file)) {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
        return res.sendFile(file);
      }
    }
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.sendFile(path.join(publicDir, 'index.html'));
  });
}

let refreshing = false;

async function refreshAll(reason) {
  if (refreshing) return;
  refreshing = true;
  const started = Date.now();
  try {
    const skipWhales = isProgressiveLoading();
    await Promise.all([
      skipWhales ? Promise.resolve() : refreshWhalesShard(),
      refreshNews(true),
    ]);
    await getMarkets(false);
    try {
      syncFromCache();
    } catch {
      // ignore
    }
    console.log(
      `[cache] ${reason} 完成，耗时 ${Date.now() - started}ms${skipWhales ? '（巨鲸让路分段加载）' : ''}`,
    );
  } catch (err) {
    console.error(`[cache] ${reason} 失败:`, err.message);
  } finally {
    refreshing = false;
  }
}

const server = http.createServer(app);
attachRealtimeHub(server);

server.listen(PORT, '0.0.0.0', () => {
  const hl = getHlInfoConfig();
  console.log(`WhaleTracker 已启动 http://0.0.0.0:${PORT}`);
  console.log(
    `[hl-info] endpoint=${hl.primaryUrl} goldRush=${hl.usingGoldRush} key=${hl.hasApiKey} concurrency=${hl.maxConcurrent}`,
  );
  console.log(`[cache] 分片定时间隔 ${REFRESH_MS}ms（可用 REFRESH_INTERVAL 调整）`);
  try {
    startRealtimeBridge();
    console.log('[realtime]', JSON.stringify(getRealtimeStatus()));
  } catch (err) {
    console.warn('[realtime] bridge 启动失败:', err.message);
  }
  try {
    startFillBackfill();
    console.log('[fill-backfill]', JSON.stringify(getBackfillStatus()));
  } catch (err) {
    console.warn('[fill-backfill] 启动失败:', err.message);
  }
  try {
    startPositionBackfill();
    console.log('[position-backfill]', JSON.stringify(getPositionBackfillStatus()));
  } catch (err) {
    console.warn('[position-backfill] 启动失败:', err.message);
  }
  try {
    startOkxPolling();
    console.log('[okx]', JSON.stringify(getOkxStatus()));
  } catch (err) {
    console.warn('[okx] 启动失败:', err.message);
  }
  refreshAll('启动预热');
  setInterval(() => refreshAll('定时刷新'), REFRESH_MS);
});
