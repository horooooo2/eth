/**
 * 浏览器端实时推送
 * - /realtime          公开频道（巨鲸/推文）
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

  publicWss = new WebSocketServer({ server: httpServer, path: '/realtime' });
  publicWss.on('connection', (socket) => {
    publicClients.add(socket);
    try {
      socket.send(JSON.stringify({ type: 'hello', at: Date.now(), clients: publicClients.size }));
    } catch {
      // ignore
    }
    socket.on('close', () => publicClients.delete(socket));
    socket.on('error', () => publicClients.delete(socket));
    socket.on('message', (raw) => {
      try {
        const msg = JSON.parse(String(raw));
        if (msg?.type === 'ping') {
          socket.send(JSON.stringify({ type: 'pong', at: Date.now() }));
        }
      } catch {
        // ignore
      }
    });
  });

  privateWss = new WebSocketServer({ noServer: true });
  httpServer.on('upgrade', (req, socket, head) => {
    let pathname = '';
    try {
      pathname = new URL(req.url || '', 'http://localhost').pathname;
    } catch {
      return;
    }
    if (pathname !== '/realtime/private') return;
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
      socket.send(payload);
      n += 1;
    } catch {
      publicClients.delete(socket);
    }
  }
  return n;
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
  sendToUser,
  broadcastPrivate,
  clientCount,
  privateClientCount,
};
