/**
 * Python V4.1 WS → Node private realtime hub
 */
const WebSocket = require('ws');
const { broadcastPrivate, sendToUser } = require('./realtimeHub');
const { cfg } = require('./v41EngineClient');

let socket = null;
let stopped = false;
let reconnectAttempt = 0;
let reconnectTimer = null;
let lastMessageAt = 0;
let lastSequence = 0;
let lastError = '';
let connected = false;

function status() {
  return {
    connected,
    lastMessageAt,
    lastSequence,
    reconnectAttempt,
    lastError,
  };
}

function mapEventToFrontend(event) {
  return {
    type: 'v41Event',
    at: Date.now(),
    eventId: event.event_id,
    sequence: event.sequence,
    eventType: event.type,
    timestamp: event.timestamp,
    payload: event.payload || {},
  };
}

function handleEvent(event) {
  if (!event || typeof event !== 'object') return;
  if (event.type === 'heartbeat') {
    lastMessageAt = Date.now();
    return;
  }
  const seq = Number(event.sequence || 0);
  if (seq && lastSequence && seq > lastSequence + 1) {
    console.warn('[V41] sequence gap', lastSequence, '->', seq, '— frontend should resnapshot');
    broadcastPrivate({
      type: 'v41Event',
      at: Date.now(),
      eventType: 'engine.sequence_gap',
      sequence: seq,
      payload: { from: lastSequence, to: seq, resnapshot: true },
    });
  }
  if (seq) lastSequence = seq;
  lastMessageAt = Date.now();

  const msg = mapEventToFrontend(event);
  const owner = String(process.env.V41_ENGINE_OWNER_USER_ID || '').trim();
  if (owner) sendToUser(owner, msg);
  else broadcastPrivate(msg);
}

function scheduleReconnect() {
  if (stopped || reconnectTimer) return;
  const delays = [1000, 2000, 5000, 10000, 30000];
  const wait = delays[Math.min(reconnectAttempt, delays.length - 1)];
  reconnectAttempt += 1;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, wait);
}

function connect() {
  if (stopped) return;
  const c = cfg();
  if (!c.enabled) return;
  const base = c.baseUrl.replace(/^http/, 'ws');
  const url = `${base}/internal/v1/events?token=${encodeURIComponent(c.token)}`;
  try {
    socket = new WebSocket(url);
  } catch (err) {
    lastError = err.message || String(err);
    scheduleReconnect();
    return;
  }

  socket.on('open', () => {
    connected = true;
    reconnectAttempt = 0;
    lastError = '';
    console.log('[V41_ENGINE_CONNECTED] ws events');
  });

  socket.on('message', (raw) => {
    try {
      const event = JSON.parse(String(raw));
      handleEvent(event);
    } catch (err) {
      lastError = err.message || String(err);
    }
  });

  socket.on('close', () => {
    connected = false;
    console.warn('[V41_ENGINE_DISCONNECTED] ws events');
    scheduleReconnect();
  });

  socket.on('error', (err) => {
    lastError = err.message || String(err);
  });
}

function startV41RealtimeBridge() {
  stopped = false;
  connect();
  return status();
}

function stopV41RealtimeBridge() {
  stopped = true;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  try {
    socket?.close();
  } catch {
    // ignore
  }
  socket = null;
  connected = false;
}

module.exports = {
  startV41RealtimeBridge,
  stopV41RealtimeBridge,
  getV41RealtimeBridgeStatus: status,
};
