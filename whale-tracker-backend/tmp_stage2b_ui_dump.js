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
    expression: `(() => {
      const text = document.body.innerText;
      const footer = document.querySelector('.footer-note');
      const pills = Array.from(document.querySelectorAll('.pill')).map((el) => (el.innerText || '').replace(/\\s+/g, ' ').trim());
      const brand = (document.querySelector('.brand') || {}).innerText || '';
      const logs = {
        system: Array.from(document.querySelectorAll('.log-col')[0] ? document.querySelectorAll('.log-col')[0].querySelectorAll('.log-entry') : []).slice(-8).map((e) => e.innerText.trim()),
        position: Array.from(document.querySelectorAll('.log-col')[1] ? document.querySelectorAll('.log-col')[1].querySelectorAll('.log-entry') : []).slice(-8).map((e) => e.innerText.trim()),
      };
      return {
        brand: brand.replace(/\\s+/g, ' ').trim(),
        pills,
        footer: footer ? footer.innerText.trim() : '',
        hasSimulatedCang: /模拟仓/.test(text),
        simulatedCangHits: (text.match(/模拟仓[^\\n]{0,20}/g) || []).slice(0, 8),
        hasPaperCang: /Paper仓/.test(text),
        hasShadow: /Alpha执行[：:]\\s*SHADOW/.test(text) || text.includes('Alpha执行：SHADOW'),
        hasOkxDemo: text.includes('OKX 模拟盘'),
        s1Badge: (text.match(/S1[^\n]{0,20}/) || [''])[0],
        logs,
      };
    })()`,
    returnByValue: true,
  });
  console.log(JSON.stringify(ev.result && ev.result.value ? ev.result.value : ev, null, 2));
  client.close();
})().catch((e) => {
  console.error(String(e));
  process.exit(1);
});
