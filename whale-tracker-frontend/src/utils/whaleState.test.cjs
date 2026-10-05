const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const source = fs.readFileSync(require('node:path').join(__dirname, 'whaleState.ts'), 'utf8');
const api = {};
vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, { exports: api });
const { stateFromBootstrap, reduceStateCommit, mergeAlertQuery, canApplyDetailResponse, stabilizeIds, recentAlerts } = api;
const whale = (id, size = 1) => ({ id, name: id, positions: size ? [{ coin: 'BTC', side: 'long', size, positionValue: size * 1000 }] : [] });
const alert = (id, time = 1, usd = 1000) => ({ id, at: time, whaleId: 'a', items: [{ time, usd, kind: 'open' }] });
const initial = () => stateFromBootstrap({ protocolVersion: 1, epoch: 'one', seq: 10, whales: [whale('a'), whale('closed', 0)], alerts: [alert('e')], summary: null, updatedAt: 100 });
const commit = (seq, fields = {}) => ({ type: 'stateCommit', epoch: 'one', seq, ...fields });
const plain = value => JSON.parse(JSON.stringify(value));

test('bootstrap contains empty-position profiles and atomically replaces an old roster', () => {
  const state = initial();
  assert.ok(state.whalesById.closed);
  assert.equal(state.whalesById.closed.positions.length, 0);
  const reset = stateFromBootstrap({ protocolVersion: 1, epoch: 'two', seq: 0, whales: [], alerts: [], summary: null, updatedAt: 101 });
  assert.deepEqual(Object.keys(reset.whalesById), []);
  assert.equal(reset.epoch, 'two');
});

test('upserts new whales, updates shared entities and closes positions without losing identity', () => {
  const before = initial();
  const next = reduceStateCommit(before, commit(11, { whales: [whale('a', 2), whale('b'), whale('closed', 3)] })).state;
  assert.equal(next.whalesById.a.positions[0].size, 2);
  assert.equal(next.whalesById.b.id, 'b');
  assert.equal(next.whalesById.closed.positions[0].size, 3);
  assert.equal(before.whalesById.a.positions[0].size, 1);
  const closed = reduceStateCommit(next, commit(12, { whales: [whale('a', 0)] })).state;
  assert.equal(closed.whalesById.a.positions.length, 0);
  assert.equal(closed.whalesById.a.name, 'a');
});

test('replay duplicates are idempotent; gaps and foreign epochs require resync', () => {
  const state = initial();
  assert.equal(reduceStateCommit(state, commit(10)).status, 'duplicate');
  assert.equal(reduceStateCommit(state, commit(9)).state, state);
  assert.equal(reduceStateCommit(state, commit(12)).status, 'resync');
  assert.equal(reduceStateCommit(state, { ...commit(11), epoch: 'two' }).status, 'resync');
  assert.equal(reduceStateCommit(state, commit(11)).status, 'applied');
});

test('HTTP history cannot overwrite a newer WS entity or resurrect a removed event', () => {
  let state = reduceStateCommit(initial(), commit(11, { alerts: [alert('e', 2, 2000), alert('new', 3)] })).state;
  state = mergeAlertQuery(state, [alert('e', 1, 1000), alert('old', 0)], { epoch: 'one', seq: 10 });
  assert.equal(state.alertsById.e.items[0].usd, 2000);
  assert.ok(state.alertsById.new);
  assert.ok(state.alertsById.old);
  state = reduceStateCommit(state, commit(12, { removedAlertIds: ['e'], removedWhaleIds: ['closed'] })).state;
  state = mergeAlertQuery(state, [alert('e')], { epoch: 'one', seq: 10 });
  assert.equal(state.alertsById.e, undefined);
  assert.equal(state.whalesById.closed, undefined);
  assert.equal(mergeAlertQuery(state, [], { epoch: 'one', seq: 13 }), null);
  assert.equal(mergeAlertQuery(state, [], { epoch: 'two', seq: 1 }), null);
});

test('late detail enrichment must match the exact requested profile', () => {
  const before = initial();
  const requested = before.whalesById.a;
  assert.equal(canApplyDetailResponse(before.whalesById.a, requested), true);
  const after = reduceStateCommit(before, commit(11, { whales: [whale('a', 2)] })).state;
  assert.equal(canApplyDetailResponse(after.whalesById.a, requested), false);
  assert.equal(canApplyDetailResponse(undefined, requested), false);
});

test('hover/locate freezes existing order while removals and new whales remain correct', () => {
  assert.deepEqual(plain(stabilizeIds(['a', 'b'], ['b', 'c', 'a'], true)), ['a', 'b', 'c']);
  assert.deepEqual(plain(stabilizeIds(['a', 'b'], ['b', 'c'], true)), ['b', 'c']);
  assert.deepEqual(plain(stabilizeIds(['a', 'b'], ['b', 'a'], false)), ['b', 'a']);
});

test('default alert projection is latest 100; execution time and equal-time ID are deterministic', () => {
  const rows = Array.from({ length: 150 }, (_, i) => alert(String(i), i));
  const result = recentAlerts(rows);
  assert.equal(result.length, 100);
  assert.equal(result[0].id, '149');
  assert.equal(result[99].id, '50');
  assert.deepEqual(plain(recentAlerts([alert('b', 1), alert('a', 1)]).map(row => row.id)), ['a', 'b']);
});

test('long sessions bound entities and tombstones and reject HTTP older than discarded metadata', () => {
  let state = initial();
  state = reduceStateCommit(state, commit(11, { alerts: Array.from({ length: 4000 }, (_, i) => alert('bulk-' + i, i)) })).state;
  assert.ok(Object.keys(state.alertsById).length <= 3000);
  state = mergeAlertQuery(state, [alert('pinned-old', 0)], { epoch: 'one', seq: 11 });
  state = reduceStateCommit(state, commit(12, { removedAlertIds: Array.from({ length: 7000 }, (_, i) => 'deleted-' + i) })).state;
  assert.ok(state.alertsById['pinned-old']);
  assert.ok(Object.keys(state.alertRevisions).length <= 9100);
  assert.equal(mergeAlertQuery(state, [alert('deleted-6999')], { epoch: 'one', seq: 10 }), null);
  assert.ok(mergeAlertQuery(state, [alert('current-history')], { epoch: 'one', seq: 12 }));
});

test('replay, backfill, corrections and unmarked events never create a new notification', () => {
  const state = initial();
  const now = 1_000_000;
  const live = commit(11, { alerts: [alert('live', now)], notifyAlertIds: ['live'] });
  assert.deepEqual(plain(api.notificationIds(state, live, false, now)), []);
  assert.deepEqual(plain(api.notificationIds(state, live, true, now)), ['live']);
  assert.deepEqual(plain(api.notificationIds(state, { ...live, notifyAlertIds: [] }, true, now)), []);
  assert.deepEqual(plain(api.notificationIds(state, commit(11, { alerts: [alert('old', 1)], notifyAlertIds: ['old'] }), true, now)), []);
  assert.deepEqual(plain(api.notificationIds(state, commit(11, { alerts: [alert('e', now)], notifyAlertIds: ['e'] }), true, now)), []);
});

test('atomic item amounts sum correctly and scoped items do not reuse a whole-alert total', () => {
  const amounts = {};
  const code = fs.readFileSync(require('node:path').join(__dirname, 'alertAmounts.ts'), 'utf8');
  vm.runInNewContext(ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, { exports: amounts });
  const items = [{ coin: 'BTC', usd: 1000, leverage: 10 }, { coin: 'ETH', usd: 2000, leverage: 20 }];
  assert.equal(amounts.sumAlertItemNotional(items), 3000);
  assert.equal(amounts.sumAlertItemNotional(items.filter(item => item.coin === 'BTC')), 1000);
  assert.equal(amounts.sumAlertItemMargin(items), 200);
  assert.equal(amounts.sumAlertItemNotional([{ usd: 60000 }]), 60000);
  assert.equal(amounts.sumAlertItemNotional([]), null);
});

test('socket resumes the latest cursor, forwards hello/caughtUp, and ignores retired connections', () => {
  const sockets = [];
  const timers = new Map();
  let timerId = 0;
  class FakeSocket {
    static OPEN = 1;
    readyState = 0;
    sent = [];
    constructor() { sockets.push(this); }
    send(value) { this.sent.push(JSON.parse(value)); }
    close() { this.readyState = 3; this.onclose?.(); }
    open() { this.readyState = 1; this.onopen(); }
    message(value) { this.onmessage({ data: JSON.stringify(value) }); }
  }
  const exports = {};
  const code = fs.readFileSync(require('node:path').join(__dirname, '../composables/useRealtime.ts'), 'utf8');
  vm.runInNewContext(ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, {
    exports, require: name => { assert.equal(name, 'vue'); return { ref: value => ({ value }), onUnmounted: () => {} }; },
    window: { location: { protocol: 'https:', host: 'example.invalid' } }, WebSocket: FakeSocket,
    setTimeout: callback => { const id = ++timerId; timers.set(id, callback); return id; },
    clearTimeout: id => timers.delete(id), setInterval: () => ++timerId, clearInterval: () => {},
  });
  let cursor = { epoch: 'one', seq: 10 };
  const messages = [];
  const realtime = exports.useRealtime(message => messages.push(message), () => cursor);
  realtime.start(); realtime.start();
  assert.equal(sockets.length, 1);
  sockets[0].open();
  assert.deepEqual(sockets[0].sent[0], { type: 'resume', epoch: 'one', afterSeq: 10 });
  sockets[0].message({ type: 'hello', epoch: 'one', seq: 10 });
  sockets[0].message({ type: 'caughtUp', epoch: 'one', seq: 10 });
  assert.deepEqual(messages.map(message => message.type), ['hello', 'caughtUp']);
  cursor = { epoch: 'one', seq: 15 };
  sockets[0].close();
  [...timers.values()][0]();
  sockets[1].open();
  assert.equal(sockets[1].sent[0].afterSeq, 15);
  sockets[0].message({ type: 'resyncRequired' });
  assert.equal(messages.length, 2);
  realtime.stop();
  assert.equal(realtime.status.value, 'disconnected');
});
