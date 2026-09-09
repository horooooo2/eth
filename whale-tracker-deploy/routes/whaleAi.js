const express = require('express');
const { requireUser } = require('../lib/authStore');
const {
  DEFAULT_PROVIDER,
  getAiKeyStatus,
  upsertAiKey,
  deleteAiKey,
  getRawAiKey,
} = require('../lib/userAiKeys');
const { verifyDeepseekKey, analyzeWithDeepseek } = require('../lib/deepseekClient');
const {
  MAX_PER_USER,
  appendRuntimeLog,
  listRuntimeLogs,
} = require('../lib/whaleAiRuntimeLogs');

const router = express.Router();
router.use('/trade', require('./whaleAiTrade'));
router.use('/engine', require('./whaleAiEngine'));

function sendErr(res, err) {
  const status = Number(err.status) || 500;
  res.status(status).json({ error: err.message || '鲸鱼AI 请求失败' });
}

function assertLogin(req, res) {
  try {
    req.user = requireUser(req);
    return true;
  } catch (err) {
    sendErr(res, err);
    return false;
  }
}

/** GET /api/whale-ai/key */
router.get('/key', (req, res) => {
  if (!assertLogin(req, res)) return;
  res.json(getAiKeyStatus(req.user.user.id, DEFAULT_PROVIDER));
});

/** PUT /api/whale-ai/key */
router.put('/key', async (req, res) => {
  if (!assertLogin(req, res)) return;
  try {
    const body = req.body || {};
    const apiKey = String(body.apiKey || body.api_key || '').trim();
    if (!apiKey) {
      const err = new Error('请填写 DEEPSEEK_API_KEY');
      err.status = 400;
      throw err;
    }

    let verified = false;
    let warn = '';
    try {
      await verifyDeepseekKey(apiKey);
      verified = true;
    } catch (err) {
      const detail = String(err.message || err.code || '校验失败');
      const isTimeout = /timeout|ETIMEDOUT|ECONNABORTED|AbortError|超时/i.test(detail);
      if (isTimeout) {
        warn = 'DeepSeek 校验超时，密钥已保存；若密钥有误，分析时会失败。';
        console.warn('[whale-ai] deepseek key verify timeout, save anyway:', detail);
      } else {
        const wrapped = new Error(`DeepSeek API 校验失败：${detail}`);
        wrapped.status = 400;
        throw wrapped;
      }
    }

    const status = upsertAiKey(req.user.user.id, DEFAULT_PROVIDER, apiKey);
    res.json({ ok: true, verified, warn, ...status });
  } catch (err) {
    sendErr(res, err);
  }
});

/** DELETE /api/whale-ai/key */
router.delete('/key', (req, res) => {
  if (!assertLogin(req, res)) return;
  try {
    const status = deleteAiKey(req.user.user.id, DEFAULT_PROVIDER);
    res.json({ ok: true, ...status });
  } catch (err) {
    sendErr(res, err);
  }
});

/** POST /api/whale-ai/analyze */
router.post('/analyze', async (req, res) => {
  if (!assertLogin(req, res)) return;
  try {
    const cred = getRawAiKey(req.user.user.id, DEFAULT_PROVIDER);
    if (!cred?.apiKey) {
      const err = new Error('请先配置 DeepSeek API Key');
      err.status = 400;
      throw err;
    }
    const body = req.body || {};
    const source = body.source === 'macro' ? 'macro' : 'x';
    const title = String(body.title || '').trim();
    const content = String(body.content || '').trim();
    if (!title && !content) {
      const err = new Error('缺少待分析内容');
      err.status = 400;
      throw err;
    }
    const result = await analyzeWithDeepseek(cred.apiKey, {
      source,
      title,
      content,
      meta: body.meta,
    });
    res.json({ ok: true, source, ...result });
  } catch (err) {
    sendErr(res, err);
  }
});

/** GET /api/whale-ai/runtime-logs — per-user strategy console logs (max 1000) */
router.get('/runtime-logs', (req, res) => {
  if (!assertLogin(req, res)) return;
  try {
    const limit = Number(req.query.limit) || MAX_PER_USER;
    const logs = listRuntimeLogs(req.user.user.id, { limit });
    res.json({ ok: true, limit: MAX_PER_USER, count: logs.length, logs });
  } catch (err) {
    sendErr(res, err);
  }
});

/** POST /api/whale-ai/runtime-logs */
router.post('/runtime-logs', (req, res) => {
  if (!assertLogin(req, res)) return;
  try {
    const body = req.body || {};
    const row = appendRuntimeLog(req.user.user.id, {
      lvl: body.lvl,
      msg: body.msg,
      source: body.source || 'ui',
      ts: body.ts,
    });
    res.json({ ok: true, log: row });
  } catch (err) {
    sendErr(res, err);
  }
});

module.exports = router;
