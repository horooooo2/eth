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
  const page = targets.find((t) => t.type === 'page' && String(t.url || '').includes('43.160.208.168'));
  const client = await cdp(page.webSocketDebuggerUrl);
  await client.send('Runtime.enable');
  const ev = await client.send('Runtime.evaluate', {
    expression: `(async () => {
      const t = localStorage.getItem('whale-tracker-auth-token') || '';
      const headers = { Authorization: 'Bearer ' + t, Accept: 'application/json' };
      const d = await fetch('/api/whale-ai/engine/dashboard', { headers }).then((r) => r.json());
      const se = (d.snapshot && d.snapshot.engine) || {};
      const b = d.bridge || {};
      const footerEl = document.querySelector('.footer-note');
      const pills = Array.from(document.querySelectorAll('.header .pill, .header-right .pill')).map((el) =>
        (el.innerText || '').replace(/\\s+/g, ' ').trim(),
      );
      const brand = ((document.querySelector('.brand') || {}).innerText || '').replace(/\\s+/g, ' ').trim();
      const text = document.body.innerText;
      const logCols = Array.from(document.querySelectorAll('.log-list, .log-box'));
      const system = logCols[0]
        ? Array.from(logCols[0].querySelectorAll('.log-entry')).slice(-10).map((e) => e.innerText.trim())
        : [];
      const position = logCols[1]
        ? Array.from(logCols[1].querySelectorAll('.log-entry')).slice(-8).map((e) => e.innerText.trim())
        : [];
      return {
        snap: {
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
          open_positions: (d.snapshot.open_positions || []).length,
        },
        bridge: {
          transport_status: b.transport_status,
          engine_runtime_status: b.engine_runtime_status,
          strategy_runtime_status: b.strategy_runtime_status,
          last_tick_at: b.last_tick_at,
          last_evaluated_at: b.last_evaluated_at,
        },
        ui: {
          brand,
          pills,
          footer: footerEl ? footerEl.innerText.trim() : '',
          hasSimulatedCang: text.indexOf('模拟仓') !== -1,
          hasPaperCang: text.indexOf('Paper仓') !== -1,
          hasOkxDemo: text.indexOf('OKX 模拟盘') !== -1,
          startVisible: Array.from(document.querySelectorAll('button')).some((b) => (b.textContent || '').trim() === '启动交易系统'),
          stopVisible: Array.from(document.querySelectorAll('button')).some((b) => (b.textContent || '').trim() === '停止'),
          system,
          position,
        },
      };
    })()`,
    returnByValue: true,
    awaitPromise: true,
  });
  if (ev.exceptionDetails) {
    console.error(ev.exceptionDetails.exception && ev.exceptionDetails.exception.description);
    process.exit(1);
  }
  console.log(JSON.stringify(ev.result.value, null, 2));
  client.close();
})().catch((e) => {
  console.error(String(e && e.stack ? e.stack : e));
  process.exit(1);
});
