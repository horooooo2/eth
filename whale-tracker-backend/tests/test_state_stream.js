const test = require('node:test');
const assert = require('node:assert/strict');
const { createStateStream } = require('../lib/stateStream');

test('decoration outage has bounded pending deltas and rotates the cursor on overflow', () => {
  let failing = true;
  const sent = [];
  const stream = createStateStream({ epoch: 'old', maxPendingItems: 2,
    decorate: () => { if (failing) throw Error('unavailable'); return {}; }, publish: e => sent.push(e) });
  stream.enqueue({ alerts: [{ id: 'a' }] }); stream.flush();
  stream.enqueue({ alerts: [{ id: 'b' }, { id: 'c' }] });
  assert.equal(sent[0].type, 'resyncRequired'); assert.notEqual(sent[0].epoch, 'old');
  failing = false;
  assert.equal(stream.resume({ epoch: 'old', afterSeq: 0 }).type, 'resyncRequired');
  stream.enqueue({ alerts: [{ id: 'new' }] });
  assert.deepEqual(stream.flush().alerts, [{ id: 'new' }]);
  stream.close();
});

test('pending bytes count replacements and removals without false growth', () => {
  const sent = [];
  const stream = createStateStream({ maxPendingBytes: 300, publish: e => sent.push(e) });
  for (let i = 0; i < 100; i++) stream.enqueue({ alerts: [{ id: 'a', text: 'x'.repeat(80) }] });
  stream.enqueue({ removedAlertIds: ['a'] });
  stream.enqueue({ alerts: [{ id: 'a', text: 'replacement' }] });
  const event = stream.flush(); assert.equal(event.alerts[0].text, 'replacement');
  assert.deepEqual(event.removedAlertIds, []); assert.equal(sent.length, 1);
  stream.enqueue({ alerts: [{ id: 'large', text: 'x'.repeat(500) }] });
  assert.equal(sent.at(-1).type, 'resyncRequired');
  stream.close();
});

test('oversize decorated event is never published as a commit or replayed', () => {
  const sent = [];
  const stream = createStateStream({ epoch: 'old', maxEventBytes: 300,
    decorate: () => ({ text: 'x'.repeat(400) }), publish: e => sent.push(e) });
  stream.enqueue({ whales: [{ id: 'a' }] }); assert.equal(stream.flush(), null);
  assert.deepEqual(sent.map(e => e.type), ['resyncRequired']);
  assert.equal(stream.resume({ epoch: 'old', afterSeq: 0 }).type, 'resyncRequired');
  stream.close();
});

test('snapshot cursor flushes committed changes; replay bridges the HTTP/socket gap', () => {
  const sent = [];
  const stream = createStateStream({ epoch: 'test', publish: e => sent.push(e) });
  stream.enqueue({ whales: [{ id: 'a', positions: [] }] });
  const snapshot = stream.cursor();
  stream.enqueue({ whales: [{ id: 'b', positions: [{ size: 1 }] }], alerts: [{ id: 'open-b' }] });
  const replay = stream.resume({ epoch: snapshot.epoch, afterSeq: snapshot.seq });
  assert.deepEqual(replay.events.map(e => e.seq), [2]);
  assert.equal(replay.events[0].whales[0].id, 'b');
  assert.equal(sent.length, 2);
  assert.deepEqual(stream.resume({ epoch: 'test', afterSeq: 2 }).events, []);
  stream.close();
});

test('bounded replay requests a new snapshot for expired, restarted or invalid cursors', () => {
  const stream = createStateStream({ epoch: 'new', maxEvents: 2 });
  for (let i = 0; i < 3; i++) { stream.enqueue({ alerts: [{ id: String(i) }] }); stream.flush(); }
  for (const request of [{ epoch: 'old', afterSeq: 3 }, { epoch: 'new', afterSeq: 0 },
    { epoch: 'new', afterSeq: -1 }, { epoch: 'new', afterSeq: 4 }, { epoch: 'new', afterSeq: 1.5 }]) {
    assert.equal(stream.resume(request).type, 'resyncRequired');
  }
  assert.deepEqual(stream.resume({ epoch: 'new', afterSeq: 1 }).events.map(e => e.seq), [2, 3]);
  stream.close();
});

test('microbatch upserts/removals preserve final state and immutable replay payloads', () => {
  const stream = createStateStream({ epoch: 'test' });
  const row = { id: 'a', size: 1 };
  stream.enqueue({ whales: [row], alerts: [{ id: 'old' }] });
  stream.enqueue({ whales: [{ id: 'a', size: 2 }], removedAlertIds: ['old'] });
  const event = stream.flush();
  row.size = 9;
  assert.deepEqual(event.whales, [{ id: 'a', size: 2 }]);
  assert.deepEqual(event.alerts, []);
  assert.deepEqual(event.removedAlertIds, ['old']);
  stream.close();
});

test('failed publication remains replayable; oversize payload forces resync', () => {
  const stream = createStateStream({ epoch: 'test', publish: () => { throw new Error('transport'); } });
  stream.enqueue({ alerts: [{ id: 'a' }] }); stream.flush();
  assert.equal(stream.resume({ epoch: 'test', afterSeq: 0 }).events.length, 1);
  stream.close();
  const bounded = createStateStream({ epoch: 'test', maxBytes: 10 });
  bounded.enqueue({ alerts: [{ id: 'a' }] }); bounded.flush();
  assert.equal(bounded.resume({ epoch: 'test', afterSeq: 0 }).type, 'resyncRequired');
  bounded.close();
});
