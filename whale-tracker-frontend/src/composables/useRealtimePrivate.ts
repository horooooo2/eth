import { onUnmounted, ref } from 'vue';
import { authToken } from '@/stores/auth';

export type PrivateRealtimeMessage =
  | { type: 'hello'; channel?: string; userId?: string; at?: number }
  | { type: 'pong'; at?: number }
  | {
      type: 'v41Event';
      at?: number;
      eventId?: string;
      sequence?: number;
      eventType?: string;
      timestamp?: string;
      payload?: Record<string, unknown>;
    };

type Handler = (msg: PrivateRealtimeMessage) => void;

const RECONNECT_MS = 2500;
const PING_MS = 25000;

function privateRealtimeUrl(token: string) {
  if (typeof window === 'undefined' || !token) return '';
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}/realtime/private?token=${encodeURIComponent(token)}`;
}

export type RealtimeStatus = 'connected' | 'connecting' | 'disconnected';

export function useRealtimePrivate(onMessage: Handler) {
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
    const token = String(authToken.value || '').trim();
    const url = privateRealtimeUrl(token);
    if (!url) {
      status.value = 'disconnected';
      connected.value = false;
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
        const msg = JSON.parse(String(ev.data)) as PrivateRealtimeMessage;
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
