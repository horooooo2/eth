/**
 * 浏览器端实时推送：HTTP 升级到 /realtime
 */
const { WebSocketServer } = require('ws');

let wss = null;
const clients = new Set();

function attachRealtimeHub(httpServer) {
  if (wss) return wss;
  wss = new WebSocketServer({ server: httpServer, path: '/realtime' });

  wss.on('connection', (socket) => {
    clients.add(socket);
    try {
      socket.send(JSON.stringify({ type: 'hello', at: Date.now(), clients: clients.size }));
    } catch {
      // ignore
    }
    socket.on('close', () => clients.delete(socket));
    socket.on('error', () => clients.delete(socket));
    socket.on('message', (raw) => {
      // 客户端 ping
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

  console.log('[realtime] hub attached path=/realtime');
  return wss;
}

function broadcast(message) {
  if (!clients.size) return 0;
  const payload = typeof message === 'string' ? message : JSON.stringify(message);
  let n = 0;
  for (const socket of clients) {
    if (socket.readyState !== 1) continue;
    try {
      socket.send(payload);
      n += 1;
    } catch {
      clients.delete(socket);
    }
  }
  return n;
}

function clientCount() {
  return clients.size;
}

module.exports = {
  attachRealtimeHub,
  broadcast,
  clientCount,
};
