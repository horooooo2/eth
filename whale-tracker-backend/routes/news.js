const express = require('express');
const { getNews, getNewsDetail } = require('../lib/newsService');
const { getCalendar } = require('../lib/calendar');
const { readConfig, writeConfig } = require('../lib/config');

const router = express.Router();

/** GET /api/news — 加密新闻 + 金十快讯，已做关键词匹配 */
router.get('/', async (req, res) => {
  try {
    const force = req.query.refresh === '1';
    const data = await getNews(force);
    res.json(data);
  } catch (err) {
    console.error('[GET /api/news]', err);
    res.status(502).json({ error: err.message || '新闻获取失败' });
  }
});

/** GET /api/news/calendar — 本地配置 + ForexFactory API 合并 */
router.get('/calendar', async (req, res) => {
  try {
    const force = req.query.refresh === '1';
    const data = await getCalendar(force);
    res.json(data);
  } catch (err) {
    console.error('[GET /api/news/calendar]', err);
    res.status(502).json({ error: err.message || '事件日历获取失败' });
  }
});

/** GET /api/news/detail — 弹窗内抓取快讯/文章正文 */
router.get('/detail', async (req, res) => {
  try {
    const data = await getNewsDetail(req.query.id, req.query.url);
    res.json(data);
  } catch (err) {
    const status = err.status || 502;
    console.error('[GET /api/news/detail]', err);
    res.status(status).json({ error: err.message || '快讯详情获取失败' });
  }
});

/** PUT /api/news/keywords — 更新高亮关键词 */
router.put('/keywords', (req, res) => {
  const keywords = req.body?.keywords;
  if (!Array.isArray(keywords)) {
    return res.status(400).json({ error: 'keywords 必须是字符串数组' });
  }
  const current = readConfig();
  const saved = writeConfig({
    ...current,
    keywords: keywords.map((item) => String(item).trim()).filter(Boolean),
  });
  res.json({ keywords: saved.keywords });
});

module.exports = router;
