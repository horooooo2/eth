const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
require('./helpers/isolateSqlite');
process.env.CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-sync-cache-'));
const roster = [{ id: 'sync-a', name: 'A', address: '0xa', enabled: true }, { id: 'sync-b', name: 'B', address: '0xb', enabled: true }];
const config = require('../lib/config');
config.getActiveWhales = () => roster;
config.readConfig = () => ({ mode: 'hf', whales: roster });
const express = require('express');
const WebSocket = require('ws');
const { commitWhaleState } = require('../lib/cache');
const { attachRealtimeHub } = require('../lib/realtimeHub');
const { stream } = require('../lib/whaleSync');

test('bootstrap -> concurrent change -> resume converges, including empty whales and canonical alerts', async t => {
  const app = express(); app.use(express.json()); app.use('/api/whales', require('../routes/whales'));
  const server = http.createServer(app);
  attachRealtimeHub(server);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let socket;
  t.after(async () => {
    socket?.terminate(); stream.close();
    await new Promise(resolve => server.close(resolve));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  commitWhaleState('hf', { whales: roster.map(w => ({ ...w, positions: [] })) });
  const response = await fetch(`${base}/api/whales/bootstrap`);
  assert.equal(response.status, 200);
  const snapshot = await response.json();
  assert.equal(snapshot.whales.length, 2);
  const whale = { ...roster[1], positions: [{ coin: 'BTC', side: 'long', size: 1, positionValue: 60000 }] };
  const time = Date.now();
  commitWhaleState('hf', { whales: [whale], trades: [{ id: 'sync-trade', whaleId: whale.id,
    whaleName: whale.name, asset: 'BTC', side: 'buy', amount: 1, amountUsd: 60000, price: 60000,
    startPosition: 0, time, source: 'hyperliquid' }] });
  const messages = [];
  socket = new WebSocket(base.replace('http:', 'ws:') + '/realtime');
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('resume timed out')), 4000);
    socket.on('error', reject);
    socket.on('message', raw => {
      const msg = JSON.parse(String(raw)); messages.push(msg);
      if (msg.type === 'hello') socket.send(JSON.stringify({ type: 'resume', epoch: snapshot.epoch, afterSeq: snapshot.seq }));
      if (msg.type === 'caughtUp') { clearTimeout(timer); resolve(); }
    });
  });
  const commits = messages.filter(msg => msg.type === 'stateCommit');
  assert.ok(commits.length >= 1);
  assert.equal(commits.flatMap(msg => msg.whales).find(w => w.id === whale.id).positions[0].size, 1);
  const alerts = commits.flatMap(msg => msg.alerts);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].totalUsd, 60000);
  const latest = await (await fetch(`${base}/api/whales/bootstrap`)).json();
  assert.equal(latest.alerts[0].id, alerts[0].id);
  assert.equal(latest.alerts[0].totalUsd, 60000);
  assert.equal(messages.at(-1).seq, latest.seq);
  const history = await (await fetch(`${base}/api/whales/alert-history?paged=1&page=1&limit=100`)).json();
  assert.equal(history.epoch, latest.epoch);
  assert.equal(history.seq, latest.seq);
  // Once caught up, a newly committed position arrives without another HTTP read.
  const liveUpdate = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('live update timed out')), 4000);
    const listener = raw => {
      const msg = JSON.parse(String(raw));
      if (msg.type !== 'stateCommit' || msg.seq <= latest.seq) return;
      clearTimeout(timer); socket.off('message', listener); resolve(msg);
    };
    socket.on('message', listener);
  });
  commitWhaleState('hf', { whales: [{ ...whale, positions: [] }] });
  stream.flush();
  const live = await liveUpdate;
  assert.equal(live.seq, latest.seq + 1);
  assert.deepEqual(live.whales.find(w => w.id === whale.id).positions, []);
  assert.equal((await fetch(`${base}/api/whales/alert-history`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"alerts":[]}' })).status, 410);
  assert.equal((await fetch(`${base}/api/whales/config`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"whales":[]}' })).status, 401);
});
