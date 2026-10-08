import { onUnmounted, ref } from 'vue';
import { readWatchedCoins } from '@/utils/watchedCoins';
import type { StateCursor, WhaleStateCommit } from '@/utils/whaleState';

import type { ObservationSnapshot, ObservationCommit } from '@/types/whaleObservation';

export type RealtimeMessage =
  | ObservationSnapshot
  | ObservationCommit
  | { type: 'hello'; epoch: string; seq: number }
  | { type: 'pong'; at?: number }
  | { type: 'caughtUp'; epoch: string; seq: number }
  | { type: 'resyncRequired' }
  | WhaleStateCommit;
export type RealtimeStatus = 'connected' | 'connecting' | 'disconnected';

export function useRealtime(onMessage: (msg: RealtimeMessage) => void, getCursor: () => StateCursor) {
  const connected = ref(false);
  const status = ref<RealtimeStatus>('disconnected');
  let socket: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let pingTimer: ReturnType<typeof setInterval> | undefined;
  let stopped = true;
  let lastReceived = 0;

  function clearTimers() {
    clearTimeout(reconnectTimer); reconnectTimer = undefined;
    clearInterval(pingTimer); pingTimer = undefined;
  }
  function scheduleReconnect() {
    if (stopped || reconnectTimer) return;
    status.value = 'connecting';
    reconnectTimer = setTimeout(() => { reconnectTimer = undefined; connect(); }, 2500);
  }
  function resume() {
    if (socket?.readyState !== WebSocket.OPEN) return;
    const cursor = getCursor();
    socket.send(JSON.stringify({ type: 'resume', epoch: cursor.epoch, afterSeq: cursor.seq }));
  }
  function connect() {
    if (stopped || typeof window === 'undefined' || socket) return;
    status.value = 'connecting';
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    let current: WebSocket;
    try { current = new WebSocket(`${proto}//${window.location.host}/realtime?coins=${encodeURIComponent(readWatchedCoins().join(','))}`); }
    catch { scheduleReconnect(); return; }
    socket = current;
    current.onopen = () => {
      if (socket !== current || stopped) { current.close(); return; }
      connected.value = true;
      status.value = 'connected';
      lastReceived = Date.now();
      resume();
      pingTimer = setInterval(() => {
        if (Date.now() - lastReceived > 60_000) { connected.value = false; status.value = 'connecting'; current.close(); return; }
        if (current.readyState === WebSocket.OPEN) current.send(JSON.stringify({ type: 'ping' }));
      }, 25_000);
    };
    current.onmessage = event => {
      if (socket !== current || stopped) return;
      lastReceived = Date.now();
      let message: RealtimeMessage;
      try { message = JSON.parse(String(event.data)) as RealtimeMessage; }
      catch { return; }
      if (message.type !== 'pong') onMessage(message);
    };
    current.onclose = () => {
      if (socket !== current) return;
      socket = null; connected.value = false; clearTimers();
      if (stopped) status.value = 'disconnected';
      else scheduleReconnect();
    };
    current.onerror = () => {
      if (socket !== current) return;
      connected.value = false; status.value = 'connecting'; current.close();
    };
  }
  function start() { stopped = false; connect(); }
  function stop() {
    stopped = true; clearTimers(); connected.value = false; status.value = 'disconnected';
    const current = socket; socket = null; current?.close();
  }
  onUnmounted(stop);
  return { connected, status, start, stop, resume };
}
