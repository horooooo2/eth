import { onUnmounted, ref } from 'vue';

export type RealtimeMessage =
  | { type: 'hello'; at?: number; clients?: number }
  | { type: 'pong'; at?: number }
  | { type: 'fill'; trade: Record<string, unknown>; at?: number }
  | { type: 'alert'; alert: Record<string, unknown>; at?: number }
  | { type: 'whalePatch'; whaleId: string; patch: Record<string, unknown>; at?: number }
  | {
      type: 'okxUpdate';
      at?: number;
      updatedAt?: number;
      traders?: unknown[];
      opens?: unknown[];
      positions?: unknown[];
      positionsByTrader?: Record<string, unknown[]>;
      meta?: Record<string, unknown>;
    }
  | { type: 'okxAlert'; alert: Record<string, unknown>; at?: number }
  | {
      type: 'xTweet';
      at?: number;
      tweets?: Array<Record<string, unknown>>;
      accounts?: unknown[];
    };

type Handler = (msg: RealtimeMessage) => void;

const RECONNECT_MS = 2500;
const PING_MS = 25000;

function realtimeUrl() {
  if (typeof window === 'undefined') return '';
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}/realtime`;
}

export type RealtimeStatus = 'connected' | 'connecting' | 'disconnected';

export function useRealtime(onMessage: Handler) {
  const connected = ref(false);
  const status = ref<RealtimeStatus>('disconnected');
  let socket: WebSocket | null = null;
  let reconnectTimer: number | undefined;
  let pingTimer: number | undefined;
  let stopped = false;

  function clearTimers() {
    if (reconnectTimer) {
      window.clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
    }
    if (pingTimer) {
      window.clearInterval(pingTimer);
      pingTimer = undefined;
    }
  }

  function scheduleReconnect() {
    if (stopped || reconnectTimer) return;
    status.value = 'connecting';
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = undefined;
      connect();
    }, RECONNECT_MS);
  }

  function connect() {
    if (stopped || typeof window === 'undefined') return;
    clearTimers();
    const url = realtimeUrl();
    if (!url) {
      status.value = 'disconnected';
      return;
    }
    status.value = 'connecting';
    try {
      socket = new WebSocket(url);
    } catch {
      scheduleReconnect();
      return;
    }

    socket.onopen = () => {
      connected.value = true;
      status.value = 'connected';
      pingTimer = window.setInterval(() => {
        try {
          socket?.send(JSON.stringify({ type: 'ping' }));
        } catch {
          // ignore
        }
      }, PING_MS);
    };

    socket.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data)) as RealtimeMessage;
        if (msg?.type === 'pong' || msg?.type === 'hello') return;
        onMessage(msg);
      } catch {
        // ignore
      }
    };

    socket.onclose = () => {
      connected.value = false;
      clearTimers();
      if (stopped) {
        status.value = 'disconnected';
        return;
      }
      scheduleReconnect();
    };

    socket.onerror = () => {
      try {
        socket?.close();
      } catch {
        // ignore
      }
    };
  }

  function start() {
    stopped = false;
    connect();
  }

  function stop() {
    stopped = true;
    clearTimers();
    connected.value = false;
    status.value = 'disconnected';
    try {
      socket?.close();
    } catch {
      // ignore
    }
    socket = null;
  }

  onUnmounted(() => stop());

  return { connected, status, start, stop };
}
