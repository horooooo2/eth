const MAX_BUFFER = 4 * 1024 * 1024;
function safeSend(socket, message) {
  if (socket.readyState !== 1) return false;
  try {
    const payload = typeof message === 'string' ? message : JSON.stringify(message);
    if (socket.bufferedAmount + Buffer.byteLength(payload) > MAX_BUFFER) {
      socket.close(1013, 'Client must resume from cursor'); return false;
    }
    socket.send(payload); return true;
  } catch { socket.terminate(); return false; }
}
module.exports = { safeSend, MAX_BUFFER };
