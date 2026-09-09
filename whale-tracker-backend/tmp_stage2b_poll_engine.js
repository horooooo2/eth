'use strict';
const fs = require('fs');
const http = require('http');
const path = require('path');
const WebSocket = require('ws');

const out = path.join(__dirname, 'tmp_stage2b_out', 'engine_polls.jsonl');
fs.mkdirSync(path.dirname(out), { recursive: true });

function getJson(p) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port: 9222, path: p }, (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(d));
          } catch (err) {
            reject(err);
          }
        });
      })
      .on('error', reject);
  });
}

function cdp(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let id = 0;
    const pending = new Map();
    ws.on('open', () => {
      resolve({
        send(method, params = {}) {
          const msgId = ++id;
          return new Promise((res, rej) => {
            pending.set(msgId, { res, rej });
            ws.send(JSON.stringify({ id: msgId, method, params }));
          });
        },
        close() {
          ws.close();
        },
      });
    });
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) rej(new Error(msg.error.message || JSON.stringify(msg.error)));
        else res(msg.result);
      }
    });
    ws.on('error', reject);
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

(async () => {
  const targets = await getJson('/json/list');
  const page =
    targets.find((t) => t.type === 'page' && String(t.url || '').includes('43.160.208.168')) ||
    targets.find((t) => t.type === 'page');
  const client = await cdp(page.webSocketDebuggerUrl);
  await client.send('Runtime.enable');
  const started = Date.now();
  while (Date.now() - started < 8 * 60 * 1000) {
    const ev = await client.send('Runtime.evaluate', {
      expression: ` (async () => {
        const t = localStorage.getItem('whale-tracker-auth-token') || '';
        const [d, diag, oi, ti] = await Promise.all([
          fetch('/api/whale-ai/engine/dashboard', { headers: { Authorization: 'Bearer ' + t } }).then((r) => r.json()),
          fetch('/api/whale-ai/engine/strategy/S1/diagnostics', { headers: { Authorization: 'Bearer ' + t } }).then((r) => r.json()),
          fetch('/api/whale-ai/engine/order-intents', { headers: { Authorization: 'Bearer ' + t } }).then((r) => r.json()),
          fetch('/api/whale-ai/engine/trade-intents', { headers: { Authorization: 'Bearer ' + t } }).then((r) => r.json()),
        ]);
        const se = (d.snapshot && d.snapshot.engine) || {};
        const b = d.bridge || {};
        const md = (diag && diag.market_data) || {};
        const ois = Array.isArray(oi) ? oi : (oi && oi.order_intents) || [];
        const tis = Array.isArray(ti) ? ti : (ti && ti.trade_intents) || [];
        const pos = (d.snapshot && d.snapshot.open_positions) || [];
        const s7 = ((d.snapshot && d.snapshot.s7) || []).find((x) => x.strategy_id === 'S1') || {};
        const edge = (d.snapshot && d.snapshot.edge) || {};
        return {
          at: new Date().toISOString(),
          state: se.state,
          alpha_opening_enabled: se.alpha_opening_enabled,
          active_strategy: se.active_strategy,
          alpha_execution: se.alpha_execution || d.snapshot.alpha_execution,
          account_environment: d.snapshot.account_environment,
          user_id_ready: d.snapshot.user_id_ready,
          live_permission: d.snapshot.live_permission,
          last_tick_at: se.last_tick_at,
          last_evaluated_at: se.last_evaluated_at,
          evaluation_count: se.evaluation_count,
          transport_status: b.transport_status,
          engine_runtime_status: b.engine_runtime_status,
          strategy_runtime_status: b.strategy_runtime_status,
          last_tick_age_ms: b.last_tick_age_ms,
          last_eval_age_ms: b.last_eval_age_ms,
          decision: diag.last_decision || diag.decision,
          reason_codes: diag.last_reason_codes || diag.reason_codes || [],
          md_source: md.source,
          md_instrument: md.instrument,
          md_timeframe: md.timeframe,
          md_bars: md.bars_loaded,
          md_state: md.state,
          ti: tis.length,
          oi: ois.length,
          oi_status: ois.map((x) => x.status || x.execution_status),
          pos: pos.length,
          s7: s7.sample_count,
          edge: edge.sample_count,
        };
      })()`,
      returnByValue: true,
      awaitPromise: true,
    });
    if (ev.exceptionDetails) {
      console.error(ev.exceptionDetails.text || 'eval fail');
    } else {
      const row = ev.result.value;
      fs.appendFileSync(out, JSON.stringify(row) + '\n');
      console.log('ENGINE_POLL', JSON.stringify(row));
    }
    await sleep(40000);
  }
  client.close();
  console.log('ENGINE_POLL_DONE');
})().catch((err) => {
  console.error(String(err && err.stack ? err.stack : err));
  process.exit(1);
});
