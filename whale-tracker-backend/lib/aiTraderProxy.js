/**
 * Reverse-proxy /ai-api/* → AI Trader FastAPI (/api/*).
 * Production Node has no Vite proxy; without this, POST hits express.static → 405.
 */
const http = require('http');
const https = require('https');
const { URL } = require('url');

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailers',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
]);

function createAiTraderProxy(options = {}) {
  const base = String(
    options.target || process.env.AI_TRADER_URL || 'http://127.0.0.1:8000',
  ).replace(/\/$/, '');

  return function aiTraderProxy(req, res) {
    const suffix = req.url.startsWith('/') ? req.url : `/${req.url || ''}`;
    let target;
    try {
      target = new URL(`/api${suffix}`, `${base}/`);
    } catch (err) {
      res.status(500).json({ detail: `invalid AI_TRADER_URL: ${err.message}` });
      return;
    }

    const lib = target.protocol === 'https:' ? https : http;
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (v == null || HOP_BY_HOP.has(k.toLowerCase())) continue;
      headers[k] = v;
    }
    headers.host = target.host;

    const method = req.method || 'GET';
    const hasBody = method !== 'GET' && method !== 'HEAD';
    const ct = String(req.headers['content-type'] || '');
    let bodyBuf = null;
    if (hasBody && ct.includes('application/json') && req.body !== undefined) {
      bodyBuf = Buffer.from(JSON.stringify(req.body));
      headers['content-type'] = 'application/json; charset=utf-8';
      headers['content-length'] = String(bodyBuf.length);
    }

    const proxyReq = lib.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (target.protocol === 'https:' ? 443 : 80),
        path: `${target.pathname}${target.search}`,
        method,
        headers,
        timeout: Number(process.env.AI_TRADER_PROXY_TIMEOUT_MS) || 60_000,
      },
      (proxyRes) => {
        const outHeaders = { ...proxyRes.headers };
        delete outHeaders['transfer-encoding'];
        res.writeHead(proxyRes.statusCode || 502, outHeaders);
        proxyRes.pipe(res);
      },
    );

    proxyReq.on('timeout', () => {
      proxyReq.destroy();
      if (!res.headersSent) {
        res.status(504).json({ detail: 'AI Trader 代理超时' });
      }
    });
    proxyReq.on('error', (err) => {
      if (!res.headersSent) {
        res.status(502).json({
          detail: `AI Trader 不可达 (${base}): ${err.message}`,
        });
      }
    });

    if (bodyBuf) {
      proxyReq.end(bodyBuf);
      return;
    }
    if (hasBody && !req.readableEnded) {
      req.pipe(proxyReq);
      return;
    }
    proxyReq.end();
  };
}

module.exports = { createAiTraderProxy };
