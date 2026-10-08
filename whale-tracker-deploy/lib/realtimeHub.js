const {observationsEnabled}=require('./featureFlags');
/**
 * 浏览器端实时推送
 * - /realtime          公开频道（巨鲸状态）
 * - /realtime/private  鉴权私有频道（鲸鱼AI 引擎事件）
 */
const { WebSocketServer } = require('ws');
const { getSessionUser } = require('./authStore');

let publicWss = null;
let privateWss = null;
const publicClients = new Set();
/** @type {Map<string, Set<import('ws')>>} userId -> sockets */
const privateByUser = new Map();
const privateClients = new Set();
const { safeSend } = require('./socketSend');

function extractToken(req) {
  try {
    const url = new URL(req.url || '', 'http://localhost');
    const q = url.searchParams.get('token');
    if (q) return String(q).trim();
  } catch {
    // ignore
  }
  const h = req.headers?.authorization || req.headers?.Authorization || '';
  const m = String(h).match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : '';
}

function attachRealtimeHub(httpServer) {
  if (publicWss) return { publicWss, privateWss };

  const sync = require('./whaleSync');
  sync.initialize();
  publicWss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
  publicWss.on('connection', (socket, req) => {
    const coins=new URL(req.url,'http://localhost').searchParams.get('coins');
    if(observationsEnabled())socket.observationCoins=require('./observationScope').normalize(String(coins||'').split(','));
    socket.syncReady = false;
    socket.alive = true;
    socket.on('pong', () => { socket.alive = true; });
    publicClients.add(socket);
    try {
      if(observationsEnabled()){
        socket.observationFrame=require('./whaleObservationWorker').snapshot(socket.observationCoins);
        safeSend(socket, socket.observationFrame);
      }
      safeSend(socket, { type: 'hello', ...sync.stream.cursor(), at: Date.now(), clients: publicClients.size });
    } catch {
      // ignore
    }
    socket.on('close', () => publicClients.delete(socket));
    socket.on('error', () => publicClients.delete(socket));
    socket.on('message', (raw) => {
      try {
        const msg = JSON.parse(String(raw));
        if (msg?.type === 'ping') {
          safeSend(socket, { type: 'pong', at: Date.now() });
        } else if (msg?.type === 'resume') {
          // Flush/replay/subscribe is synchronous, so publication cannot enter
          // between replay's high-water mark and live subscription.
          socket.syncReady = false;
          const replay = sync.stream.resume(msg);
          if (replay.type === 'resyncRequired') { safeSend(socket, replay); return; }
          for (const event of replay.events) if (!safeSend(socket, event)) return;
          socket.syncReady = true;
          safeSend(socket, { type: 'caughtUp', epoch: replay.epoch, seq: replay.seq });
        }
      } catch {
        safeSend(socket, { type: 'resyncRequired' });
      }
    });
  });

  privateWss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
  httpServer.on('upgrade', (req, socket, head) => {
    let pathname = '';
    try {
      pathname = new URL(req.url || '', 'http://localhost').pathname;
    } catch {
      return;
    }
    if (pathname === '/realtime') {
      if (publicClients.size >= 200) { socket.destroy(); return; }
      publicWss.handleUpgrade(req, socket, head, ws => publicWss.emit('connection', ws, req));
      return;
    }
    if (pathname !== '/realtime/private') { socket.destroy(); return; }
    const token = extractToken(req);
    const session = getSessionUser(token);
    if (!session?.user?.id) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    privateWss.handleUpgrade(req, socket, head, (ws) => {
      privateWss.emit('connection', ws, req, session);
    });
  });

  privateWss.on('connection', (ws, _req, session) => {
    ws.alive = true;
    ws.on('pong', () => { ws.alive = true; });
    const userId = session.user.id;
    ws.userId = userId;
    ws.username = session.user.username;
    privateClients.add(ws);
    if (!privateByUser.has(userId)) privateByUser.set(userId, new Set());
    privateByUser.get(userId).add(ws);
    try {
      ws.send(
        JSON.stringify({
          type: 'hello',
          channel: 'private',
          userId,
          at: Date.now(),
        }),
      );
    } catch {
      // ignore
    }
    ws.on('close', () => {
      privateClients.delete(ws);
      const set = privateByUser.get(userId);
      if (set) {
        set.delete(ws);
        if (!set.size) privateByUser.delete(userId);
      }
    });
    ws.on('error', () => {
      privateClients.delete(ws);
    });
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(String(raw));
        if (msg?.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong', at: Date.now() }));
        }
      } catch {
        // ignore
      }
    });
  });

  const heartbeat = setInterval(() => {
    for (const socket of [...publicClients, ...privateClients]) {
      if (socket.alive === false) { socket.terminate(); continue; }
      socket.alive = false;
      if (socket.readyState === 1) socket.ping();
    }
  }, 30_000);
  heartbeat.unref?.();
  httpServer.on('close', () => {
    clearInterval(heartbeat);
    for (const socket of [...publicClients, ...privateClients]) socket.terminate();
    publicClients.clear(); privateClients.clear(); privateByUser.clear();
    publicWss.close(); privateWss.close(); publicWss = null; privateWss = null;
  });

  console.log('[realtime] hub attached path=/realtime + /realtime/private');
  return { publicWss, privateWss };
}

function broadcast(message) {
  if (!publicClients.size) return 0;
  const payload = typeof message === 'string' ? message : JSON.stringify(message);
  let n = 0;
  for (const socket of publicClients) {
    if (socket.readyState !== 1) continue;
    try {
      if (safeSend(socket, payload)) n += 1;
    } catch {
      publicClients.delete(socket);
    }
  }
  return n;
}

function broadcastState(event) {
  const payload = JSON.stringify(event);
  for (const socket of publicClients) if (socket.syncReady) safeSend(socket, payload);
}

function broadcastObservations() {
  if(!observationsEnabled())return;
  const frames=new Map();
  for(const socket of publicClients) {
    const coins=socket.observationCoins;
    const key=JSON.stringify(coins);
    if(!frames.has(key))frames.set(key,require('./whaleObservationWorker').snapshot(coins));
    const frame=frames.get(key),previous=socket.observationFrame;
    if(previous?.epoch===frame.epoch) {
      const old=new Map(previous.rows.map(row=>[row.id,JSON.stringify(row)]));
      safeSend(socket,{...frame,type:'observationCommit',ids:frame.rows.map(row=>row.id),
        rows:frame.rows.filter(row=>old.get(row.id)!==JSON.stringify(row))});
    } else safeSend(socket,frame);
    socket.observationFrame=frame;
  }
}

function sendToUser(userId, message) {
  const set = privateByUser.get(String(userId || ''));
  if (!set || !set.size) return 0;
  const payload = typeof message === 'string' ? message : JSON.stringify(message);
  let n = 0;
  for (const socket of set) {
    if (socket.readyState !== 1) continue;
    try {
      socket.send(payload);
      n += 1;
    } catch {
      set.delete(socket);
      privateClients.delete(socket);
    }
  }
  return n;
}

/** 发给所有已鉴权私有连接（单引擎个人站） */
function broadcastPrivate(message) {
  if (!privateClients.size) return 0;
  const payload = typeof message === 'string' ? message : JSON.stringify(message);
  let n = 0;
  for (const socket of privateClients) {
    if (socket.readyState !== 1) continue;
    try {
      socket.send(payload);
      n += 1;
    } catch {
      privateClients.delete(socket);
    }
  }
  return n;
}

function clientCount() {
  return publicClients.size;
}

function privateClientCount() {
  return privateClients.size;
}

module.exports = {
  attachRealtimeHub,
  broadcast,
  broadcastState,
  broadcastObservations,
  sendToUser,
  broadcastPrivate,
  clientCount,
  privateClientCount,
};
