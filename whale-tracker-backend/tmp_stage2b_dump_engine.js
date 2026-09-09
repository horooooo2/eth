'use strict';
const http = require('http');
const WebSocket = require('ws');

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

(async () => {
  const targets = await getJson('/json/list');
  const page =
    targets.find((t) => t.type === 'page' && String(t.url || '').includes('43.160.208.168')) ||
    targets.find((t) => t.type === 'page');
  const client = await cdp(page.webSocketDebuggerUrl);
  await client.send('Runtime.enable');
  const out = await client.send('Runtime.evaluate', {
    expression: ` (async () => {
      const t = localStorage.getItem('whale-tracker-auth-token') || '';
      const res = await fetch('/api/whale-ai/engine/dashboard', {
        headers: { Authorization: 'Bearer ' + t, Accept: 'application/json' },
      });
      const j = await res.json();
      const se = (j.snapshot && j.snapshot.engine) || {};
      const ve = (j.view && j.view.engine) || {};
      const b = j.bridge || {};
      return {
        http: res.status,
        snap_engine: {
          state: se.state,
          last_tick_at: se.last_tick_at,
          last_evaluated_at: se.last_evaluated_at,
          evaluation_count: se.evaluation_count,
          alpha_opening_enabled: se.alpha_opening_enabled,
          active_strategy: se.active_strategy,
          alpha_execution: se.alpha_execution,
        },
        view_engine_keys: Object.keys(ve),
        bridge: {
          transport_status: b.transport_status,
          engine_runtime_status: b.engine_runtime_status,
          strategy_runtime_status: b.strategy_runtime_status,
          last_tick_at: b.last_tick_at,
          last_evaluated_at: b.last_evaluated_at,
          last_tick_age_ms: b.last_tick_age_ms,
          last_eval_age_ms: b.last_eval_age_ms,
          alpha_execution: b.alpha_execution,
        },
        top_user_id_ready: j.snapshot && j.snapshot.user_id_ready,
        account_environment: j.snapshot && j.snapshot.account_environment,
      };
    })()`,
    returnByValue: true,
    awaitPromise: true,
  });
  if (out.exceptionDetails) {
    console.error(out.exceptionDetails.exception && out.exceptionDetails.exception.description);
    process.exit(1);
  }
  console.log(JSON.stringify(out.result.value, null, 2));
  client.close();
})().catch((err) => {
  console.error(String(err && err.stack ? err.stack : err));
  process.exit(1);
});
