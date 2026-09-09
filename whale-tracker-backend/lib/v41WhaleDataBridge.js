/**
 * E1: Hyperliquid whale cache → standardized events → Python engine.
 * Telemetry only — does NOT enable S8 Alpha scoring.
 */
const axios = require('axios');
const { readWhaleModeCache } = require('./cache');

const DEFAULT_MODE = 'hf';

let lastForwardAt = 0;
let lastError = '';
let timer = null;
let prevPositions = new Map(); // wallet|symbol -> { notional, direction, sequence }

function cfg() {
  return {
    enabled: String(process.env.V41_WHALE_BRIDGE_ENABLED || 'false').toLowerCase() === 'true'
      || String(process.env.V41_WHALE_BRIDGE_ENABLED || '') === '1',
    intervalMs: Math.max(2000, Number(process.env.V41_WHALE_BRIDGE_INTERVAL_MS) || 5000),
    mode: String(process.env.V41_WHALE_BRIDGE_MODE || DEFAULT_MODE),
    engineBase: String(process.env.V41_ENGINE_BASE_URL || 'http://127.0.0.1:8711').replace(/\/$/, ''),
    token: String(process.env.V41_ENGINE_INTERNAL_TOKEN || 'dev-internal-token'),
  };
}

function engineHeaders() {
  return {
    'X-Engine-Token': cfg().token,
    'Content-Type': 'application/json',
  };
}

function positionNotional(pos) {
  // Canonical HL cache field is positionValue (USD notional), not "notional"
  const v = Number(pos?.positionValue);
  if (Number.isFinite(v) && Math.abs(v) > 0) return Math.abs(v);
  const fallback = Number(pos?.notional ?? 0);
  if (Number.isFinite(fallback) && Math.abs(fallback) > 0) return Math.abs(fallback);
  const size = Math.abs(Number(pos?.size ?? pos?.szi ?? 0));
  const px = Number(pos?.entryPx ?? pos?.markPx ?? pos?.price ?? 0);
  return size * px;
}

function positionDirection(pos) {
  const side = String(pos?.side || pos?.positionSide || '').toLowerCase();
  if (side === 'long' || side === 'buy') return 'long';
  if (side === 'short' || side === 'sell') return 'short';
  const szi = Number(pos?.szi ?? pos?.size ?? 0);
  if (szi > 0) return 'long';
  if (szi < 0) return 'short';
  return 'flat';
}

function symbolOf(pos) {
  return String(pos?.coin || pos?.symbol || pos?.instId || '').replace(/-USDT.*/, '').toUpperCase();
}

function walletId(whale) {
  return String(whale?.id || whale?.address || whale?.wallet || '').toLowerCase();
}

function positionKey(wid, pos) {
  // Match realtimeBridge: coin:side (same coin can flip long/short)
  const symbol = symbolOf(pos);
  const direction = positionDirection(pos);
  return `${wid}|${symbol}|${direction}`;
}

function classifyEvent(before, after) {
  const b = before || 0;
  const a = after || 0;
  if (Math.abs(b) < 1e-6 && Math.abs(a) > 1e-6) return 'POSITION_OPEN';
  if (Math.abs(a) < 1e-6 && Math.abs(b) > 1e-6) return 'POSITION_CLOSE';
  if (b > 0 && a < 0) return 'POSITION_FLIP';
  if (b < 0 && a > 0) return 'POSITION_FLIP';
  if (Math.abs(a) > Math.abs(b)) return 'POSITION_INCREASE';
  if (Math.abs(a) < Math.abs(b)) return 'POSITION_REDUCE';
  return null;
}

const ALERT_KIND_TO_EVENT = {
  open: 'POSITION_OPEN',
  increase: 'POSITION_INCREASE',
  decrease: 'POSITION_REDUCE',
  close: 'POSITION_CLOSE',
};

/**
 * Realtime path: reuse HL webData2 diffs (same source as realtimeBridge alerts).
 * Telemetry only — no S8 scoring.
 */
function ingestRealtimePositionDiff(whale, prevPositions, nextPositions, alerts) {
  const c = cfg();
  if (!c.enabled) return { skipped: true, reason: 'disabled' };
  const nodeReceivedAt = new Date().toISOString();
  const wid = walletId(whale);
  if (!wid) return { skipped: true, reason: 'no_wallet' };

  const events = [];
  const list = Array.isArray(alerts) && alerts.length
    ? alerts
    : null;

  if (list) {
    for (const alert of list) {
      const item = Array.isArray(alert.items) ? alert.items[0] : null;
      const kind = String(alert.kind || item?.kind || '');
      const eventType = ALERT_KIND_TO_EVENT[kind];
      if (!eventType) continue;
      const pos = {
        coin: item?.coin || alert.coin,
        side: item?.side || alert.side,
        positionValue: item?.remainingUsd ?? item?.usd,
        entryPx: item?.price,
        leverage: item?.leverage,
      };
      const symbol = symbolOf(pos);
      if (!symbol) continue;
      const direction = positionDirection(pos);
      const key = `${wid}|${symbol}|${direction}`;
      const prev = prevPositions.find(
        (p) => symbolOf(p) === symbol && positionDirection(p) === direction,
      );
      const next = (nextPositions || []).find(
        (p) => symbolOf(p) === symbol && positionDirection(p) === direction,
      );
      const beforeUsd = prev ? positionNotional(prev) : Number(item?.prevUsd || 0);
      const afterUsd =
        eventType === 'POSITION_CLOSE' ? 0 : next ? positionNotional(next) : Number(item?.remainingUsd ?? item?.usd ?? 0);
      const seq = (prevPositions_getSeq(key) || 0) + 1;
      prevPositions_set(key, afterUsd, direction, seq);

      events.push({
        event_id: String(alert.id || `${wid}:${symbol}:${seq}`),
        timestamp: nodeReceivedAt,
        source_event_timestamp: new Date(Number(alert.at) || Date.now()).toISOString(),
        node_received_at: nodeReceivedAt,
        wallet_id: wid,
        symbol,
        event_type: eventType,
        direction,
        position_notional_before_usd: beforeUsd,
        position_notional_after_usd: afterUsd,
        position_delta_usd: afterUsd - beforeUsd,
        entry_price: Number(item?.price || next?.entryPx || 0) || null,
        mark_price: Number(next?.markPx || 0) || null,
        leverage: Number(item?.leverage || next?.leverage || 0) || null,
        unrealized_pnl_usd: Number(next?.unrealizedPnl || 0) || null,
        liquidation_price: Number(next?.liquidationPx || 0) || null,
        source: 'hyperliquid_ws',
        source_sequence: seq,
      });
    }
  }

  if (!events.length) return { ok: true, events: 0 };

  const nodeForwardedAt = new Date().toISOString();
  for (const ev of events) ev.node_forwarded_at = nodeForwardedAt;

  // fire-and-forget; polling path still sends snapshots
  axios
    .post(`${c.engineBase}/internal/v1/data/whale-events`, { events }, {
      timeout: 5000,
      headers: engineHeaders(),
    })
    .then(() => {
      lastForwardAt = Date.now();
      lastError = '';
    })
    .catch((err) => {
      lastError = err.message || String(err);
      console.error('[V41_WHALE_BRIDGE] realtime forward failed', lastError);
    });

  return { ok: true, events: events.length, path: 'realtime' };
}

function prevPositions_getSeq(key) {
  return prevPositions.get(key)?.sequence || 0;
}

function prevPositions_set(key, notional, direction, sequence) {
  prevPositions.set(key, { notional, direction, sequence });
}

function buildEventsFromCache(mode) {
  const nodeReceivedAt = new Date().toISOString();
  const cached = readWhaleModeCache(mode);
  const whales = Array.isArray(cached?.data?.whales) ? cached.data.whales : [];
  const events = [];
  const snapshotWhales = [];

  for (const whale of whales) {
    const wid = walletId(whale);
    if (!wid) continue;
    const positions = Array.isArray(whale.positions) ? whale.positions : [];
    const snapPositions = [];
    for (const pos of positions) {
      const symbol = symbolOf(pos);
      if (!symbol) continue;
      const notional = positionNotional(pos);
      const direction = positionDirection(pos);
      const key = positionKey(wid, pos);
      const prev = prevPositions.get(key);
      const before = prev ? prev.notional * (prev.direction === 'short' ? -1 : 1) : 0;
      const afterSigned = notional * (direction === 'short' ? -1 : direction === 'long' ? 1 : 0);
      const eventType = classifyEvent(before, afterSigned);
      const seq = (prev?.sequence || 0) + 1;
      prevPositions.set(key, { notional, direction, sequence: seq });

      snapPositions.push({
        symbol,
        direction,
        position_notional_usd: notional,
        leverage: Number(pos?.leverage || 0) || null,
        entry_price: Number(pos?.entryPx || pos?.entry_price || 0) || null,
        mark_price: Number(pos?.markPx || pos?.mark_price || 0) || null,
      });

      if (!eventType || !prev) {
        // first observation: seed only, no event (avoid false OPEN flood)
        if (!prev) continue;
      }
      if (!eventType) continue;

      events.push({
        event_id: `${wid}:${symbol}:${seq}`,
        timestamp: nodeReceivedAt,
        source_event_timestamp: cached?.updatedAt
          ? new Date(cached.updatedAt).toISOString()
          : nodeReceivedAt,
        node_received_at: nodeReceivedAt,
        wallet_id: wid,
        symbol,
        event_type: eventType,
        direction,
        position_notional_before_usd: Math.abs(before),
        position_notional_after_usd: notional,
        position_delta_usd: notional - Math.abs(before),
        entry_price: Number(pos?.entryPx || 0) || null,
        mark_price: Number(pos?.markPx || 0) || null,
        leverage: Number(pos?.leverage || 0) || null,
        unrealized_pnl_usd: Number(pos?.unrealizedPnl || 0) || null,
        liquidation_price: Number(pos?.liquidationPx || 0) || null,
        source: 'hyperliquid',
        source_sequence: seq,
      });
    }
    snapshotWhales.push({
      wallet_id: wid,
      positions: snapPositions,
    });
  }

  return {
    snapshot: {
      source: 'hyperliquid',
      mode,
      source_event_timestamp: cached?.updatedAt
        ? new Date(cached.updatedAt).toISOString()
        : nodeReceivedAt,
      node_received_at: nodeReceivedAt,
      whales: snapshotWhales,
    },
    events,
    nodeReceivedAt,
  };
}

async function forwardOnce() {
  const c = cfg();
  if (!c.enabled) return { skipped: true, reason: 'disabled' };
  const built = buildEventsFromCache(c.mode);
  const nodeForwardedAt = new Date().toISOString();
  built.snapshot.node_forwarded_at = nodeForwardedAt;
  for (const ev of built.events) {
    ev.node_forwarded_at = nodeForwardedAt;
  }

  try {
    await axios.post(`${c.engineBase}/internal/v1/data/whale-snapshot`, built.snapshot, {
      timeout: 5000,
      headers: engineHeaders(),
    });
    if (built.events.length) {
      await axios.post(
        `${c.engineBase}/internal/v1/data/whale-events`,
        { events: built.events },
        { timeout: 5000, headers: engineHeaders() },
      );
    }
    lastForwardAt = Date.now();
    lastError = '';
    return {
      ok: true,
      whales: built.snapshot.whales.length,
      events: built.events.length,
      forwarded_at: nodeForwardedAt,
    };
  } catch (err) {
    lastError = err.message || String(err);
    console.error('[V41_WHALE_BRIDGE]', lastError);
    return { ok: false, error: lastError };
  }
}

function startWhaleDataBridge() {
  const c = cfg();
  if (!c.enabled) {
    console.log('[V41_WHALE_BRIDGE] disabled (set V41_WHALE_BRIDGE_ENABLED=true)');
    return;
  }
  if (timer) return;
  console.log('[V41_WHALE_BRIDGE] starting', c.intervalMs, 'ms mode=', c.mode);
  forwardOnce().catch(() => {});
  timer = setInterval(() => {
    forwardOnce().catch(() => {});
  }, c.intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
}

function stopWhaleDataBridge() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

function whaleBridgeStatus() {
  const c = cfg();
  return {
    enabled: c.enabled,
    mode: c.mode,
    intervalMs: c.intervalMs,
    lastForwardAt,
    lastError,
    trackedKeys: prevPositions.size,
    alpha_enabled: false,
  };
}

module.exports = {
  startWhaleDataBridge,
  stopWhaleDataBridge,
  forwardOnce,
  whaleBridgeStatus,
  buildEventsFromCache,
  ingestRealtimePositionDiff,
  cfg,
};
