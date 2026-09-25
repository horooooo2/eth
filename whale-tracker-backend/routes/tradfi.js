const express = require('express');
const { getCatalog, getQuotes } = require('../lib/tradfiMarkets');
const { getIntel } = require('../lib/tradfiIntel');
const { getWhaleActivity, getAllWhaleActivity } = require('../lib/tradfiWhales');
const { requireUser } = require('../lib/authStore');
const { getBinanceCredentialsForUser } = require('../lib/userExchangeKeys');
const { getRawAiKey } = require('../lib/userAiKeys');
const { accountBook } = require('../lib/binanceCryptoTrade');
const { analyzeTradfiAi, previewTradfiAi, placeTradfiAi, previewFingerprint } = require('../lib/tradfiAiTrade');
const { isRunning: tradfiAiMonitorRunning } = require('../lib/tradfiAiMonitor');

const router = express.Router();

router.get('/catalog', async (_req, res) => {
  try {
    const result = await getCatalog();
    res.json({ symbols: result.symbols, updatedAt: result.updatedAt, stale: Boolean(result.stale), source: 'Binance USDⓈ-M Futures' });
  } catch (err) {
    console.error('[GET /api/tradfi/catalog]', err.message);
    res.status(502).json({ error: 'TradFi 合约清单暂不可用', details: err.message });
  }
});

router.get('/quotes', async (req, res) => {
  try {
    res.json(await getQuotes(req.query.symbols));
  } catch (err) {
    console.error('[GET /api/tradfi/quotes]', err.message);
    res.status(502).json({ error: 'TradFi 行情暂不可用', details: err.message });
  }
});

router.get('/intel', async (req, res) => {
  try {
    res.json(await getIntel(req.query.symbol));
  } catch (err) {
    console.error('[GET /api/tradfi/intel]', err.message);
    res.status(err.status || 502).json({ error: err.message || 'TradFi 资讯暂不可用' });
  }
});

router.get('/whales/all', async (_req, res) => {
  try {
    res.json(await getAllWhaleActivity());
  } catch (err) {
    console.error('[GET /api/tradfi/whales/all]', err.message);
    res.status(err.status || 502).json({ error: err.message || 'TradFi 大户动态暂不可用' });
  }
});

router.get('/whales', async (req, res) => {
  try {
    res.json(await getWhaleActivity(req.query.symbol, req.query.dex, req.query.addresses));
  } catch (err) {
    console.error('[GET /api/tradfi/whales]', err.message);
    res.status(err.status || 502).json({ error: err.message || 'TradFi 大户动态暂不可用' });
  }
});

router.get('/account', async (req, res) => {
  try {
    const user = requireUser(req);
    const creds = getBinanceCredentialsForUser(user.user.id);
    if (!creds) return res.json({ ok: true, configured: false, scope: 'tradfi', balance: { totalEq: null, usdtEq: null, availBal: null }, openPnl: 0, historyPnl: null, records: [] });
    const [book, catalog] = await Promise.all([accountBook(creds), getCatalog()]);
    const symbols = new Set(catalog.symbols.map((row) => row.symbol));
    const records = book.records.filter((row) => symbols.has(row.instId));
    res.json({ ...book, scope: 'tradfi', records, openPnl: records.filter((row) => row.kind === 'position').reduce((sum, row) => sum + Number(row.openUpl || 0), 0) });
  } catch (err) { res.status(err.status || 502).json({ error: err.message || 'TradFi 交易账户加载失败', code: err.code }); }
});

router.post('/ai/analyze', async (req, res) => {
  try {
    const user = requireUser(req);
    const key = getRawAiKey(user.user.id, 'deepseek');
    if (!key?.apiKey) throw Object.assign(new Error('请先在 API 设置中配置 DeepSeek API Key'), { status: 400 });
    res.json({ ok: true, ...await analyzeTradfiAi(user.user.id, key.apiKey, req.body?.symbol, req.body?.mode) });
  } catch (err) {
    console.error('[POST /api/tradfi/ai/analyze]', req.body?.symbol, req.body?.mode, err.message);
    res.status(err.status || 502).json({ error: err.message || 'TradFi AI 分析失败' });
  }
});

router.post('/ai/preview', async (req, res) => {
  try {
    const user = requireUser(req);
    const creds = getBinanceCredentialsForUser(user.user.id);
    const preview = await previewTradfiAi(user.user.id, req.body?.analysisId);
    res.json({ ok: true, configured: Boolean(creds), monitorReady: tradfiAiMonitorRunning(), simulated: creds?.simulated ?? null, preview, fingerprint: previewFingerprint(preview) });
  } catch (err) { res.status(err.status || 502).json({ error: err.message || '整套挂单预览失败' }); }
});

router.post('/ai/place', async (req, res) => {
  try {
    const user = requireUser(req);
    if (req.body?.confirm !== true) throw Object.assign(new Error('请先确认整套挂单'), { status: 400 });
    const creds = getBinanceCredentialsForUser(user.user.id);
    if (!creds) throw Object.assign(new Error('请先在 API 设置中配置币安 API 密钥'), { status: 400 });
    res.json(await placeTradfiAi(creds, user.user.id, req.body?.analysisId, req.body?.fingerprint));
  } catch (err) { res.status(err.status || 502).json({ error: err.message || '整套挂单提交失败', code: err.code }); }
});

router.post('/ai/place-stream', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  const writeEvent = (event, data) => {
    if (!res.writableEnded && !res.destroyed) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  try {
    const user = requireUser(req);
    if (req.body?.confirm !== true) throw Object.assign(new Error('请先确认整套挂单'), { status: 400 });
    const creds = getBinanceCredentialsForUser(user.user.id);
    if (!creds) throw Object.assign(new Error('请先在 API 设置中配置币安 API 密钥'), { status: 400 });
    const result = await placeTradfiAi(creds, user.user.id, req.body?.analysisId, req.body?.fingerprint, (stage) => writeEvent('stage', stage));
    writeEvent('done', result);
  } catch (err) {
    writeEvent('error', { error: err.message || '整套挂单提交失败', code: err.code });
  } finally {
    if (!res.writableEnded) res.end();
  }
});

module.exports = router;
