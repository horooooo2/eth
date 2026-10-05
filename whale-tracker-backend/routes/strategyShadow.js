const express = require('express');
const { requireUser } = require('../lib/authStore');
const { getTradFiKlines } = require('../lib/tradfiMarkets');
const { getRadarNews } = require('../lib/tradfiIntel');
const { DEFAULT_PROVIDER, getRawAiKey } = require('../lib/userAiKeys');
const { deepseekFetch } = require('../lib/deepseekClient');
const { getStore } = require('../lib/strategyShadowStore');
const { PROMPT_VERSION, SYSTEM, validSymbol, detectEvent, freezeNews, buildPrompt, parseJudgment, bad } = require('../lib/strategyShadow');
const router = express.Router();
const activeUsers = new Set();
const uid = req => String(requireUser(req).user.id);
const fail = (res, error) => res.status(error.status || 500).json({ error: error.public ? error.message : error.status === 401 ? '请先登录' : '旁路观察服务暂不可用' });
router.post('/observe', async (req, res) => {
  try {
    const userId = uid(req), symbol = validSymbol(req.body?.symbol);
    if (req.body?.mode && req.body.mode !== 'LIVE') throw bad('不支持用实时新闻分析历史回放');
    const result = detectEvent(symbol, await getTradFiKlines(symbol, '1h'));
    if (result.event) result.event = getStore().observe(userId, result.event);
    res.json(result);
  } catch (error) { fail(res, error); }
});
router.get('/history', (req, res) => {
  try {
    const userId = uid(req), symbol = validSymbol(req.query.symbol);
    const records = getStore().history(userId, symbol).map(r => ({ id: r.id, eventId: r.eventId, symbol: r.symbol, status: r.status, createdAt: r.createdAt, decisionAt: r.decisionAt, model: r.model, verdict: r.judgment?.verdict, summary: r.judgment?.summary, error: r.error }));
    res.json({ records });
  } catch (error) { fail(res, error); }
});
router.get('/records/:id', (req, res) => {
  try { const record = getStore().record(uid(req), req.params.id); if (!record) throw bad('记录不存在', 404); res.json(record); }
  catch (error) { fail(res, error); }
});
router.post('/analyze', async (req, res) => {
  let userId, record, store, ownsLock = false;
  try {
    userId = uid(req); store = getStore();
    // No user-supplied market snapshot, prompt, news, model or execution instruction is accepted.
    const event = store.event(userId, String(req.body?.eventId || ''));
    if (!event) throw bad('事件不存在，请先检查当前行情', 404);
    const attempts = store.attempts(userId, event.id);
    const done = attempts.find(r => ['COMPLETED', 'INSUFFICIENT'].includes(r.status));
    if (done) return res.json({ ...done, reused: true });
    const now = Date.now();
    if (now > event.expiresAt || now - event.createdAt > 15 * 60000) throw bad('事件快照已超过15分钟，不能用新新闻重解释旧快照；等待下一事件', 409);
    if (activeUsers.has(userId)) throw bad('已有旁路分析正在运行，请稍后刷新记录', 429);
    const running = attempts.find(r => r.status === 'RUNNING');
    if (running && now - running.createdAt < 120000) return res.status(202).json(running);
    if (running) store.update(userId, running, { status: 'FAILED', error: '上次分析中断或超时，未形成有效结论' });
    if (attempts.length >= 3) throw bad('该事件已达到3次尝试上限', 429);
    if (attempts.length && now - attempts[0].createdAt < 30000) throw bad('请至少间隔30秒再重试', 429);
    const apiKey = getRawAiKey(userId, DEFAULT_PROVIDER)?.apiKey;
    if (!apiKey) throw bad('请先在 AI 分析设置中配置 DeepSeek API Key');
    activeUsers.add(userId); ownsLock = true;
    record = store.create(userId, event, now);
    let newsData;
    try { newsData = await getRadarNews(event.symbol); } catch { newsData = { stale: true, items: [] }; }
    const decisionAt = Date.now(), news = freezeNews(newsData, decisionAt);
    const prompt = buildPrompt(event, news, decisionAt);
    record = store.update(userId, record, { decisionAt, news, prompt, systemPrompt: SYSTEM, promptVersion: PROMPT_VERSION,
      requestedModel: 'deepseek-chat', modelSettings: { temperature: .1, max_tokens: 1800 } });
    if (!news.items.length) {
      record = store.update(userId, record, { status: 'INSUFFICIENT', model: null, aiCalled: false,
        judgment: { verdict: 'INSUFFICIENT', summary: '缺少带有效时间戳的近期新闻，未调用 AI；这不代表没有基本面原因。',
          evidence: [], counterEvidence: ['无法区分暂时抛压与持续重新定价'], missingData: ['新鲜且可追溯的新闻资料'], invalidation: ['获得新的可靠资料后在新事件重新评估'] } });
    } else {
      record = store.update(userId, record, { aiCalled: true });
      const response = await deepseekFetch(apiKey, '/chat/completions', { method: 'POST', timeoutMs: 90000,
        body: { model: 'deepseek-chat', temperature: .1, max_tokens: 1800, response_format: { type: 'json_object' },
          messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: prompt }] } });
      const raw = String(response?.choices?.[0]?.message?.content || '');
      record = store.update(userId, record, { rawOutput: raw.slice(0, 24000), model: response?.model || 'deepseek-chat', usage: response?.usage || null, aiCalled: true });
      const judgment = parseJudgment(raw, news);
      record = store.update(userId, record, { status: 'COMPLETED', judgment });
    }
    res.json(record);
  } catch (error) {
    if (record) {
      const message = error.public ? error.message : 'AI 服务失败，本次未形成有效结论；请检查配置或稍后重试';
      try { record = store.update(userId, record, { status: 'FAILED', error: message }); } catch { return fail(res, new Error('Archive unavailable')); }
      return res.status(502).json({ error: message, record });
    }
    fail(res, error);
  } finally { if (ownsLock) activeUsers.delete(userId); }
});
module.exports = router;
