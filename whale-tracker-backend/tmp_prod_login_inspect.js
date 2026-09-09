'use strict';
const http = require('http');
const WebSocket = require('ws');

function getJson(path) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port: 9222, path }, (res) => {
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

async function evaluate(client, expression) {
  const out = await client.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (out.exceptionDetails) throw new Error(out.exceptionDetails.text || 'eval failed');
  return out.result && out.result.value;
}

(async () => {
  const targets = await getJson('/json/list');
  const page =
    targets.find((t) => t.type === 'page' && String(t.url || '').includes('43.160.208.168')) ||
    targets.find((t) => t.type === 'page');
  if (!page) throw new Error('no page');
  const client = await cdp(page.webSocketDebuggerUrl);
  await client.send('Runtime.enable');
  await client.send('Page.enable');
  await client.send('Page.navigate', { url: 'http://43.160.208.168/#/' });
  await new Promise((r) => setTimeout(r, 4000));
  const info = await evaluate(
    client,
    `(() => {
      const text = document.body ? document.body.innerText : '';
      return {
        href: location.href,
        title: document.title,
        hasLogin: /登录/.test(text),
        hasCabin: text.includes('个人交易舱'),
        hasHoro: text.includes('horo'),
        token: Boolean(localStorage.getItem('whale-tracker-auth-token')),
        user: localStorage.getItem('whale-tracker-auth-user'),
        cred: Boolean(localStorage.getItem('whale-tracker-auth-cred')),
        snippet: text.slice(0, 600),
      };
    })()`,
  );
  console.log(JSON.stringify(info, null, 2));
  client.close();
})().catch((err) => {
  console.error(String(err && err.stack ? err.stack : err));
  process.exit(1);
});
