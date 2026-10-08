export type SocketStatus = 'idle' | 'connecting' | 'connected' | 'disconnected';
export type SocketConnection = { name: string; status: SocketStatus };

// Paused modules are intentionally idle, and must not lower the active connections' status.
export function summarizeSocketConnections(connections: SocketConnection[]) {
  const active = connections.filter(connection => connection.status !== 'idle');
  const status: SocketStatus = active.some(connection => connection.status === 'disconnected') ? 'disconnected'
    : active.some(connection => connection.status === 'connecting') ? 'connecting'
    : active.length ? 'connected' : 'idle';
  const labels: Record<SocketStatus, string> = { idle: '未启用', connecting: '连接 / 同步中', connected: '已连接并同步', disconnected: '连接异常，正在重试' };
  const heading = status === 'connected' ? '全部已启用实时连接正常' : status === 'idle' ? '实时连接未启用'
    : status === 'connecting' ? '实时连接正在连接或同步' : '部分实时连接异常';
  return { status, title: [heading, ...connections.map(connection => `${connection.name}：${labels[connection.status]}`)].join('\n') };
}
