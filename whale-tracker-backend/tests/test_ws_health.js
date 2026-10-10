const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createHlWsClient } = require('../lib/hlWsClient');
class Socket extends EventEmitter {
  static instance;
  constructor() { super(); this.readyState = 1; this.sent = []; Socket.instance = this; }
  send(raw) { this.sent.push(JSON.parse(raw)); }
  close() {}
}
test('position subscription uses supported protocol; transport open is not data health', () => {
  const received = [];
  const c = createHlWsClient({ WebSocket: Socket, onWebData: x => received.push(x) });
  c.syncSubscriptions({ fillAddresses: ['0xabc'], webDataAddresses: ['0xabc'] });
  c.start(); const ws = Socket.instance;
  try {
    ws.emit('open');
    assert.equal(c.getStatus().connected, true);
    assert.equal(c.getStatus().healthy, false);
    assert.deepEqual(ws.sent[1].subscription, { type: 'allDexsClearinghouseState', user: '0xabc' });
    for (const msg of ws.sent) ws.emit('message', JSON.stringify({ channel: 'subscriptionResponse', data: msg }));
    assert.equal(c.getStatus().healthy, false);
    ws.emit('message', JSON.stringify({ channel: 'allDexsClearinghouseState', data: { user: '0xabc', clearinghouseStates: [['', { assetPositions: [] }], ['xyz', { assetPositions: [{ position: { coin: 'xyz:SNDK', szi: '10' } }] }]] } }));
    assert.equal(c.getStatus().healthy, true);
    assert.equal(received[0].user, '0xabc');
    assert.equal(received[0].data.clearinghouseState.assetPositions[0].position.coin, 'xyz:SNDK');
    ws.emit('message', JSON.stringify({ channel: 'allDexsClearinghouseState', data: { user: '0xabc', clearinghouseStates: [['xyz', {}]] } }));
    assert.equal(received.length, 1);
    ws.emit('message', JSON.stringify({ channel: 'error', data: 'upstream rejects request' }));
    assert.equal(c.getStatus().healthy, false);
    assert.equal(c.getStatus().subscriptionErrors[0].message, 'upstream rejects request');
  } finally { c.stop(); }
});
