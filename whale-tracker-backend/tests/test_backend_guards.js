'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

/**
 * 保护两个已修的线上问题不被悄悄回退：
 * - position-backfill 撞 Hyperliquid 429 后必须冷却，不能每 8 秒原地重试
 * - 只有 alert-history 同步路由放宽 body 上限，其余仍是 1mb
 */

test('POSITION_EVENT_MIN_USD stays at 1000', () => {
  const { POSITION_EVENT_MIN_USD } = require('../lib/positionEventPolicy');
  assert.equal(POSITION_EVENT_MIN_USD, 1000);

  const policy = fs.readFileSync(path.join(__dirname, '..', 'lib', 'positionEventPolicy.js'), 'utf8');
  assert.match(policy, /Number\(process\.env\.POSITION_EVENT_MIN_USD\) \|\| 1000/);
});

test('position backfill pauses instead of hammering after a 429', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'positionBackfill.js'), 'utf8');
  assert.match(src, /isRateLimited\(err\)/);
  assert.match(src, /enterRateLimitPause/);
  assert.match(src, /if \(running \|\| isPaused\(\)\) return;/);
  // 不允许靠提高抓取频率来绕过限流
  assert.match(src, /Number\(process\.env\.POSITION_BACKFILL_INTERVAL_MS\) \|\| 8000/);

  const { getPositionBackfillStatus } = require('../lib/positionBackfill');
  const status = getPositionBackfillStatus();
  assert.equal(status.intervalMs, 8000);
  assert.equal(typeof status.rateLimited, 'boolean');
  assert.ok(status.rateLimitPauseMs >= 60_000);
});

test('only the alert-history POST route gets a raised body limit', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'createApp.js'), 'utf8');
  // 全局仍是 1mb
  assert.match(src, /app\.use\(express\.json\(\{ limit: '1mb' \}\)\)/);
  assert.match(src, /ALERT_HISTORY_BODY_LIMIT = process\.env\.ALERT_HISTORY_BODY_LIMIT \|\| '4mb'/);
  assert.match(src, /\/\\\/whales\\\/alert-history\\\/\?\$\/\.test/);
  // 不允许出现无上限
  assert.doesNotMatch(src, /limit: Infinity|limit: '0'|limit: 0\b/);
});

test('whale summary aggregation layer is fully removed', () => {
  const backend = path.join(__dirname, '..');
  assert.equal(fs.existsSync(path.join(backend, 'lib', 'whaleSummary.js')), false);

  const routes = fs.readFileSync(path.join(backend, 'routes', 'whales.js'), 'utf8');
  assert.doesNotMatch(routes, /whaleSummary|\/summary/);

  const files = fs.readFileSync(path.join(backend, 'scripts', 'sync-deploy.js'), 'utf8');
  assert.doesNotMatch(files, /whaleSummary/);
});
