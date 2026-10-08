const test = require('node:test');
const assert = require('node:assert/strict');
require('./helpers/isolateSqlite');
const { safeSend, MAX_BUFFER } = require('../lib/socketSend');
function socket(bufferedAmount = 0) {
  return { readyState: 1, bufferedAmount, sent: [], closed: [],
    send(value) { this.sent.push(value); }, close(...args) { this.closed.push(args); },
    terminate() { this.terminated = true; } };
}
test('outgoing UTF-8 payload counts toward the buffer limit before sending', () => {
  const ws = socket(MAX_BUFFER - 5);
  assert.equal(safeSend(ws, '巨鲸'), false);
  assert.equal(ws.sent.length, 0); assert.equal(ws.closed[0][0], 1013);
  const exact = socket(MAX_BUFFER - 6);
  assert.equal(safeSend(exact, '巨鲸'), true);
  assert.equal(safeSend(socket(), 'x'.repeat(MAX_BUFFER + 1)), false);
});
test('closed sockets and send errors do not escape into the commit publisher', () => {
  const closed = socket(); closed.readyState = 3;
  assert.equal(safeSend(closed, {}), false);
  const broken = socket(); broken.send = () => { throw Error('transport'); };
  assert.equal(safeSend(broken, {}), false); assert.equal(broken.terminated, true);
});
test('runtime monitor reports process memory with explicit event-loop units', () => {
  const runtime = require('../lib/opsMonitor').getMonitorSnapshot().runtime;
  assert.ok(runtime.memory.rss > 0); assert.ok(runtime.memory.heapUsed > 0);
  assert.equal(runtime.eventLoopDelay.scope, 'since-monitor-start');
  assert.ok(runtime.eventLoopDelay.p95Ms === null || runtime.eventLoopDelay.p95Ms >= 0);
});
