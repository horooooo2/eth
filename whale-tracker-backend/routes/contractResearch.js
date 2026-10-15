'use strict';
const express = require('express');
const { requireUser } = require('../lib/authStore');
const { getRawAiKey, DEFAULT_PROVIDER } = require('../lib/userAiKeys');
const { deepseekFetch, deepseekHttpFetch } = require('../lib/deepseekClient');
const { collectResearch } = require('../lib/contractResearchWeb');
const { getRadarAvailableContracts } = require('../lib/tradfiMarkets');
const service = require('../lib/contractResearch');
const { VERSION, parseAnalysis, buildAlerts } = require('../lib/contractResearchRules');
const store = require('../lib/contractResearchStore');
const router = express.Router();
const jobs = new Map(), saveTimes = new Map();
router.use((req, res, next) => {
  try { req.researchUser = requireUser(req).user.id; res.set('Cache-Control', 'no-store'); next(); }
  catch (e) { res.status(e.status || 401).json({ error: e.message }); }
});
function fail(res, error) { return res.status(error.status || 500).json({ error: error.message || '研判服务暂不可用' }); }
function selectedSnapshot(req) {
  const snapshot = service.findSnapshot(String(req.body?.snapshotId || ''));
  if (!snapshot) throw Object.assign(new Error('快照已过期，请先刷新资料再分析或保存'), { status: 409 });
  return snapshot;
}
router.get('/catalog', async (_req, res) => {
  try { const result = await getRadarAvailableContracts(); res.json({ contracts: result.contracts.filter(row => /^[A-Z0-9]{1,26}USDT$/.test(row.symbol)), updatedAt: result.updatedAt, stale: Boolean(result.stale) }); }
  catch { res.status(503).json({ error: '合约目录暂不可用，请稍后重试' }); }
});
router.get('/snapshot', async (req, res) => { try { res.json(await service.getSnapshot(req.query)); } catch (e) { fail(res, e); } });
router.get('/context', async (_req, res) => { try { res.json(await service.getMacroContext()); } catch (e) { fail(res, e); } });
router.get('/latest', (req, res) => {
  try { const { symbol, horizon } = service.normalize(req.query); res.json({ item: store.latest(req.researchUser, symbol, horizon, VERSION) }); }
  catch (e) { fail(res, e); }
});
router.post('/alerts', (req, res) => {
  try {
    const saved = req.body?.recordId ? store.get(req.body.recordId, req.researchUser) : null;
    const snapshot = saved?.snapshot.id === req.body?.snapshotId && saved.snapshot.version === VERSION ? saved.snapshot : selectedSnapshot(req);
    const row = saved?.snapshot.id === snapshot.id ? saved : store.find(req.researchUser, snapshot.id, true, 'COMPLETED') || store.find(req.researchUser, snapshot.id, false, 'COMPLETED');
    res.json(buildAlerts(snapshot, row?.analysis));
  } catch (e) { fail(res, e); }
});
router.get('/history', (req, res) => { try { const { symbol } = service.normalize(req.query); res.json({ items: store.list(req.researchUser, symbol) }); } catch (e) { fail(res, e); } });
router.get('/history/:id', (req, res) => {
  try { const row = store.get(req.params.id, req.researchUser); if (!row) return res.status(404).json({ error: '研判记录不存在' }); res.json(row); }
  catch (e) { fail(res, e); }
});
router.post('/save', (req, res) => {
  try {
    const snapshot = selectedSnapshot(req), existing = store.find(req.researchUser, snapshot.id, false, 'SAVED');
    if (existing) return res.json(existing);
    const previous = saveTimes.get(req.researchUser) || 0;
    if (Date.now() - previous < 5000) return res.status(429).json({ error: '保存过于频繁，请稍后再试' });
    saveTimes.delete(req.researchUser); saveTimes.set(req.researchUser, Date.now());
    while (saveTimes.size > 1000) saveTimes.delete(saveTimes.keys().next().value);
    res.json(store.create(req.researchUser, snapshot));
  } catch (e) { fail(res, e); }
});
router.post('/analyze', (req, res) => {
  try {
    const snapshot = selectedSnapshot(req), userId = req.researchUser, web = req.body?.web === true;
    const completed = store.find(userId, snapshot.id, web, 'COMPLETED');
    if (completed) return res.json({ ...completed, reused: true });
    const running = jobs.get(userId);
    if (running) {
      if (running.snapshotId === snapshot.id && running.web === web) return res.status(202).json(store.get(running.id, userId));
      return res.status(429).json({ error: '你已有一个研判任务正在运行，请等待完成' });
    }
    if (jobs.size >= 2) return res.status(429).json({ error: 'AI 研判繁忙，请稍后重试' });
    const apiKey = getRawAiKey(userId, DEFAULT_PROVIDER)?.apiKey;
    if (!apiKey) return res.status(400).json({ error: '请先在设置中配置个人 DeepSeek API Key；查看行情和官方资料不需要 Key' });
    if (Date.now() - snapshot.generatedAt > 5 * 60000) return res.status(409).json({ error: '资料采样已超过 5 分钟，请刷新后再生成研判' });
    const row = store.create(userId, snapshot, 'RUNNING', web);
    jobs.set(userId, { id: row.id, snapshotId: snapshot.id, web });
    setImmediate(() => {
      void (async () => {
        let research = null;
        if (web) {
          try {
            research = await collectResearch({ apiKey, userId, snapshot, fetchImpl: deepseekHttpFetch });
          } catch { research = { sources: [], summary: '', warning: '站外搜索未取得可核实来源，本次仅分析已有快照。' }; }
        }
        const result = await deepseekFetch(apiKey, '/chat/completions', { method: 'POST', timeoutMs: 55000, body: {
          model: 'deepseek-chat', temperature: 0.1, max_tokens: 6500,
          messages: [{ role: 'system', content: '你是基于证据的合约研究助手，遵循来源和时间约束，只输出要求的JSON。' }, { role: 'user', content: service.buildPrompt(snapshot, research) }],
        } });
        const analysis = parseAnalysis(result?.choices?.[0]?.message?.content, snapshot, research);
        analysis.model = String(result?.model || 'deepseek-chat').slice(0, 100);
        store.finish(row.id, userId, { analysis, research });
      })().catch(error => {
        console.warn('[contract-research] analysis failed:', error.status || error.name);
        try { store.finish(row.id, userId, null, /格式|有效研判/.test(error.message || '') ? error.message : 'AI 分析失败或超时，请检查个人 Key 或稍后重试'); }
        catch { console.warn('[contract-research] unable to persist failed job'); }
      }).finally(() => { jobs.delete(userId); });
    });
    res.status(202).json(row);
  } catch (e) { fail(res, e); }
});
module.exports = router;
