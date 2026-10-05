const net = require('net');
let state = { configured: false, reachable: null, checkedAt: null };
function check() {
  const value = process.env.OUTBOUND_PROXY_URL;
  if (!value || value === 'direct') { state = { configured: false, reachable: null, checkedAt: Date.now() }; return; }
  let url;
  try { url = new URL(value); } catch { state = { configured: true, reachable: false, checkedAt: Date.now(), error: '代理 URL 无效' }; return; }
  const socket = net.connect({ host: url.hostname, port: Number(url.port) || (url.protocol === 'https:' ? 443 : 80) });
  const finish = (reachable, error) => { state = { configured: true, reachable, checkedAt: Date.now(), error }; socket.destroy(); };
  socket.setTimeout(3000);
  socket.once('connect', () => finish(true));
  socket.once('error', e => finish(false, e.code));
  socket.once('timeout', () => finish(false, 'PROXY_TIMEOUT'));
}
function start() { check(); const timer = setInterval(check, 60000); timer.unref(); }
module.exports = { start, getStatus: () => state };
