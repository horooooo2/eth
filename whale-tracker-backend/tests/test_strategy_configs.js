'use strict';

require('./helpers/isolateSqlite');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const configs = require('../lib/v41StrategyConfigs');
const view = require('../public/strategy-config.js');
const { createApp } = require('../lib/createApp');

async function request(server, method, url, body) {
  const addr = server.address();
  const res = await fetch(`http://127.0.0.1:${addr.port}${url}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body == null ? undefined : JSON.stringify(body),
  });
  const raw = await res.text();
  let json = null;
  try { json = JSON.parse(raw); } catch { json = raw; }
  return { status: res.status, json, raw };
}

test('1 list Alpha configs', async () => {
  const out = await configs.listConfigs({ runtime: { online: false, state: 'OFFLINE' } });
  const ids = out.alpha.map((x) => x.id);
  assert.deepEqual(ids, ['S1', 'S2', 'S8']);
  assert.equal(out.overview.alpha_count, 3);
  assert.equal(out.overview.source_kind, 'MODULAR_JSON');
  assert.equal(out.source.kind, 'MODULAR_JSON');
  assert.equal(out.overview.live_allowed_count, 2);
  assert.equal(out.overview.live_permission, false);
});

test('2 list System Modules', async () => {
  const out = await configs.listConfigs({ runtime: { online: false, state: 'OFFLINE' } });
  assert.deepEqual(out.system_modules.map((x) => x.id), ['S3', 'S4', 'S5', 'S6', 'S7']);
});

function copyModular(destRoot) {
  const src = path.join(__dirname, '..', '..', 'ai-trading-system-v41', 'config');
  fs.cpSync(src, path.join(destRoot, 'config'), { recursive: true });
}

test('3 GET S1 from disk truth source', async () => {
  const s1 = await configs.getConfig('S1', { runtime: { online: false, state: 'OFFLINE' } });
  assert.equal(s1.id, 'S1');
  assert.equal(s1.type, 'ALPHA');
  assert.equal(s1.source.kind, 'MODULAR_JSON');
  assert.equal(s1.source.config_path, 'config/strategies/s1_trend.json');
  assert.equal(s1.raw_config.risk_per_trade_pct_equity, 0.004);
  assert.equal(s1.raw_config.strategy_initial_risk_cap_pct_equity, 0.0125);
  assert.equal(s1.raw_config.leverage_cap, 6);
  assert.equal(s1.release.demo_allowed, true);
  assert.equal(s1.release.live_allowed, true);
  assert.equal(s1.release.live_permission, false);
  assert.ok(!String(s1.source.config_path).includes('\\'));
  assert.ok(!String(s1.source.config_path).startsWith('/'));
  const file = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'ai-trading-system-v41', 'config', 'strategies', 's1_trend.json'), 'utf8'));
  assert.deepEqual(s1.raw_config, configs.redactSecrets(file));
});

test('4 GET S2', async () => {
  const s2 = await configs.getConfig('S2', { runtime: { online: false, state: 'OFFLINE' } });
  assert.equal(s2.id, 'S2');
  assert.equal(s2.raw_config.timeframe, '15m');
  assert.equal(s2.release.demo_allowed, false);
});

test('5 GET S8 research / not implemented', async () => {
  const s8 = await configs.getConfig('S8', { runtime: { online: false, state: 'OFFLINE' } });
  assert.equal(s8.id, 'S8');
  assert.equal(s8.release.stage, 'RESEARCH');
  assert.equal(s8.release.implemented, false);
  assert.equal(s8.release.demo_allowed, false);
  assert.equal(s8.release.live_allowed, false);
  assert.equal(s8.release.live_permission, false);
  assert.equal(s8.raw_config.strategy_id, 'S8');
  assert.equal(s8.raw_config.implemented, false);
  assert.equal(s8.raw_config.demo_allowed, false);
  assert.equal(s8.raw_config.live_allowed, false);
  assert.equal(s8.status, 'NOT_IMPLEMENTED');
});

test('6 GET S5 system module', async () => {
  const s5 = await configs.getConfig('S5', { runtime: { online: false, state: 'OFFLINE' } });
  assert.equal(s5.type, 'SYSTEM');
  assert.equal(s5.source.kind, 'MODULAR_JSON');
  assert.equal(s5.source.config_path, 'config/modules/s5_risk_budget.json');
  assert.equal(s5.raw_config.reserve_fraction, 0.15);
  assert.equal(s5.raw_config.module_id, 'S5');
  assert.equal(s5.raw_config.global_risk, undefined);
  assert.equal(s5.raw_config.per_strategy_initial_risk_cap_pct_equity, undefined);
});

test('7 unknown ID → 404', async () => {
  await assert.rejects(() => configs.getConfig('S99'), (e) => e.code === 'STRATEGY_CONFIG_NOT_FOUND' && e.status === 404);
});

test('8 path traversal impossible', async () => {
  await assert.rejects(
    () => configs.getConfig('../../.env'),
    (e) => e.code === 'STRATEGY_CONFIG_NOT_FOUND',
  );
  await assert.rejects(
    () => configs.getConfig('S1/../../config/system_config.json'),
    (e) => e.code === 'STRATEGY_CONFIG_NOT_FOUND',
  );
});

test('9 sensitive fields redact', () => {
  const out = configs.redactSecrets({
    risk_per_trade_pct_equity: 0.004,
    api_key: 'abc',
    secret: 's',
    passphrase: 'p',
    nested: { jwt: 'tok', ok: 1 },
  });
  assert.equal(out.api_key, '[REDACTED]');
  assert.equal(out.secret, '[REDACTED]');
  assert.equal(out.passphrase, '[REDACTED]');
  assert.equal(out.nested.jwt, '[REDACTED]');
  assert.equal(out.risk_per_trade_pct_equity, 0.004);
  assert.equal(out.nested.ok, 1);
});

test('10 config hash stable', async () => {
  const a = await configs.getConfig('S1', { runtime: { online: false, state: 'OFFLINE' } });
  const b = await configs.getConfig('S1', { runtime: { online: false, state: 'OFFLINE' } });
  assert.equal(a.runtime.disk_config_hash, b.runtime.disk_config_hash);
  assert.equal(a.runtime.disk_config_hash.length, 64);
  const h1 = configs.configHash({ z: 1, a: 2 });
  const h2 = configs.configHash({ a: 2, z: 1 });
  assert.equal(h1, h2);
});

test('11-12 HTTP GET only; writes 405', async () => {
  const app = createApp();
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const list = await request(server, 'GET', '/api/admin/strategy-configs');
    assert.equal(list.status, 200);
    assert.ok(Array.isArray(list.json.alpha));
    const one = await request(server, 'GET', '/api/admin/strategy-configs/S1');
    assert.equal(one.status, 200);
    assert.equal(one.json.id, 'S1');
    const unknown = await request(server, 'GET', '/api/admin/strategy-configs/S99');
    assert.equal(unknown.status, 404);
    const trav = await request(server, 'GET', '/api/admin/strategy-configs/%2e%2e%2f.env');
    assert.equal(trav.status, 404);
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const r1 = await request(server, method, '/api/admin/strategy-configs', { x: 1 });
      const r2 = await request(server, method, '/api/admin/strategy-configs/S1', { x: 1 });
      assert.equal(r1.status, 405, method);
      assert.equal(r2.status, 405, method + ' id');
      assert.equal(r1.json.error.code, 'STRATEGY_CONFIG_READ_ONLY');
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('13 invalid JSON safe error', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-bad-'));
  copyModular(dir);
  fs.writeFileSync(path.join(dir, 'config', 'strategies', 's1_trend.json'), '{nope');
  const prev = process.env.V41_ENGINE_ROOT;
  process.env.V41_ENGINE_ROOT = dir;
  try {
    const s1 = await configs.getConfig('S1', { runtime: { online: false, state: 'OFFLINE' } });
    assert.equal(s1.error.code, 'CONFIG_INVALID');
    assert.equal(s1.status, 'INVALID');
  } finally {
    if (prev == null) delete process.env.V41_ENGINE_ROOT;
    else process.env.V41_ENGINE_ROOT = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('14 schema/section missing is safe error', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-miss-'));
  copyModular(dir);
  fs.unlinkSync(path.join(dir, 'config', 'strategies', 's1_trend.json'));
  const prev = process.env.V41_ENGINE_ROOT;
  process.env.V41_ENGINE_ROOT = dir;
  try {
    const s1 = await configs.getConfig('S1', { runtime: { online: false, state: 'OFFLINE' } });
    assert.equal(s1.status, 'INVALID');
    assert.equal(s1.error.code, 'CONFIG_INVALID');
  } finally {
    if (prev == null) delete process.env.V41_ENGINE_ROOT;
    else process.env.V41_ENGINE_ROOT = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('15 runtime offline does not claim MATCH', async () => {
  const s1 = await configs.getConfig('S1', { runtime: { online: false, state: 'OFFLINE' } });
  assert.equal(s1.runtime.online, false);
  assert.equal(s1.runtime.config_match, null);
  assert.equal(s1.runtime.state, 'OFFLINE');
});

test('16 runtime/disk hash match', async () => {
  const disk = await configs.getConfig('S1', { runtime: { online: false, state: 'OFFLINE' } });
  const s1 = await configs.getConfig('S1', {
    runtime: {
      online: true,
      state: 'RUNNING',
      active_strategy: 'S1',
      effective_config: disk.raw_config,
    },
  });
  assert.equal(s1.runtime.config_match, true);
  assert.equal(s1.runtime.active, true);
});

test('17 runtime/disk hash mismatch', async () => {
  const disk = await configs.getConfig('S1', { runtime: { online: false, state: 'OFFLINE' } });
  const changed = { ...disk.raw_config, risk_per_trade_pct_equity: 0.003 };
  const s1 = await configs.getConfig('S1', {
    runtime: {
      online: true,
      state: 'RUNNING',
      active_strategy: 'S1',
      effective_config: changed,
    },
  });
  assert.equal(s1.runtime.config_match, false);
});

test('18 Alpha/System classification', async () => {
  const out = await configs.listConfigs({ runtime: { online: false, state: 'OFFLINE' } });
  const cls = view.classify(out.items);
  assert.deepEqual(cls.alpha.map((x) => x.id), ['S1', 'S2', 'S8']);
  assert.deepEqual(cls.system.map((x) => x.id), ['S3', 'S4', 'S5', 'S6', 'S7']);
});

test('19 S1 details render from JSON', async () => {
  const s1 = await configs.getConfig('S1', { runtime: { online: false, state: 'OFFLINE' } });
  const html = view.renderStructured(s1);
  assert.match(html, /风险|risk_per_trade|0\.40%/);
  assert.match(html, /S1/);
  assert.equal(view.formatValue('risk_per_trade_pct_equity', 0.004), '0.40%');
  assert.equal(view.formatValue('strategy_initial_risk_cap_pct_equity', 0.0125), '1.25%');
});

test('20 S8 RESEARCH render', async () => {
  const s8 = await configs.getConfig('S8', { runtime: { online: false, state: 'OFFLINE' } });
  const html = view.renderStructured(s8);
  assert.match(html, /RESEARCH \/ NOT IMPLEMENTED/);
});

test('21-22 Raw JSON read-only and no edit actions', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'strategy-config.html'), 'utf8');
  assert.match(html, /复制 JSON/);
  assert.equal(view.hasForbiddenAction(html.replace('复制 JSON', '')), false);
  assert.doesNotMatch(html, />Edit<|>Save<|>Delete<|>Upload<|>Create</);
  assert.match(html, /contenteditable', 'false'/);
});

test('23 MATCH / DIFF labels', () => {
  assert.equal(view.runtimeSyncLabel({ online: false }).text, 'OFFLINE');
  assert.equal(view.runtimeSyncLabel({ online: true, config_match: true }).text, 'MATCH');
  assert.equal(view.runtimeSyncLabel({ online: true, config_match: false }).text, 'RUNTIME DIFF');
});

test('24 CONFIG ERROR does not throw', async () => {
  const html = view.renderStructured({
    id: 'S1',
    error: { code: 'CONFIG_INVALID', message: 'broken' },
  });
  assert.match(html, /CONFIG_INVALID/);
  assert.doesNotMatch(html, /default trade|0\.004 fallback/i);
});

test('25 live allowed vs live permission are separate', async () => {
  const prev = process.env.V41_LIVE_TRADING_ENABLED;
  process.env.V41_LIVE_TRADING_ENABLED = 'false';
  try {
    const list = await configs.listConfigs({ runtime: { online: false, state: 'OFFLINE' } });
    assert.equal(list.overview.live_permission, false);
    assert.equal(list.overview.live_allowed_count, 2);
    const s1 = await configs.getConfig('S1', { runtime: { online: false, state: 'OFFLINE' } });
    assert.equal(s1.release.live_allowed, true);
    assert.equal(s1.release.live_permission, false);
    const s8 = await configs.getConfig('S8', { runtime: { online: false, state: 'OFFLINE' } });
    assert.equal(s8.release.live_allowed, false);
    assert.equal(s8.release.live_permission, false);
    const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'strategy-config.html'), 'utf8');
    assert.match(html, /Live Allowed YES/);
    assert.match(html, /Live Permission ON/);
    assert.doesNotMatch(html, /LIVE BLOCKED/);
  } finally {
    if (prev == null) delete process.env.V41_LIVE_TRADING_ENABLED;
    else process.env.V41_LIVE_TRADING_ENABLED = prev;
  }
});

test('26 wrong strategy id fail closed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-id-'));
  copyModular(dir);
  const p = path.join(dir, 'config', 'strategies', 's1_trend.json');
  const doc = JSON.parse(fs.readFileSync(p, 'utf8'));
  doc.strategy_id = 'S2';
  fs.writeFileSync(p, JSON.stringify(doc));
  const prev = process.env.V41_ENGINE_ROOT;
  process.env.V41_ENGINE_ROOT = dir;
  try {
    const s1 = await configs.getConfig('S1', { runtime: { online: false, state: 'OFFLINE' } });
    assert.equal(s1.status, 'INVALID');
    assert.equal(s1.error.code, 'CONFIG_INVALID');
  } finally {
    if (prev == null) delete process.env.V41_ENGINE_ROOT;
    else process.env.V41_ENGINE_ROOT = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
