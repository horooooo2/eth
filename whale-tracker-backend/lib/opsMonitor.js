/**
 * 运维监控环形缓冲：Socket / 正常请求 / 报错
 */
const SOCKET_MAX = 100;
const REQUEST_MAX = 200;
const ERROR_MAX = 200;
const { monitorEventLoopDelay } = require('node:perf_hooks');
const eventLoopDelay = monitorEventLoopDelay({ resolution: 20 });
eventLoopDelay.enable();

const socketLogs = [];
const requestLogs = [];
const errorLogs = [];

function pushFront(list, max, item) {
  list.unshift(item);
  if (list.length > max) list.length = max;
}

function pushSocket(entry = {}) {
  pushFront(socketLogs, SOCKET_MAX, {
    at: Date.now(),
    kind: entry.kind || 'event',
    message: String(entry.message || ''),
    detail: entry.detail || null,
  });
}

function pushRequest(entry = {}) {
  pushFront(requestLogs, REQUEST_MAX, {
    at: Date.now(),
    method: entry.method || 'GET',
    path: String(entry.path || ''),
    status: Number(entry.status) || 0,
    ms: Number(entry.ms) || 0,
    ok: entry.ok !== false,
    message: String(entry.message || ''),
  });
}

function pushError(entry = {}) {
  pushFront(errorLogs, ERROR_MAX, {
    at: Date.now(),
    source: String(entry.source || 'server'),
    message: String(entry.message || '未知错误'),
    detail: entry.detail || null,
  });
}

function getMonitorSnapshot() {
  return {
    at: Date.now(),
    runtime: {
      memory: process.memoryUsage(),
      uptimeSeconds: process.uptime(),
      eventLoopDelay: {
        sampleCount: eventLoopDelay.count,
        p95Ms: eventLoopDelay.count ? eventLoopDelay.percentile(95) / 1e6 : null,
        maxMs: eventLoopDelay.count ? eventLoopDelay.max / 1e6 : null,
        scope: 'since-monitor-start',
      },
    },
    observationCompute: require('./whaleObservationWorker').getStatus(),
    statisticsCompute: require('./statisticsWorker').getStatus(),
    socket: [...socketLogs],
    requests: [...requestLogs],
    errors: [...errorLogs],
    limits: { socket: SOCKET_MAX, requests: REQUEST_MAX, errors: ERROR_MAX },
  };
}

module.exports = {
  pushSocket,
  pushRequest,
  pushError,
  getMonitorSnapshot,
  SOCKET_MAX,
};
