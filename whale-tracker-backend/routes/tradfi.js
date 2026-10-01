const express = require('express');
const { getCatalog, getQuotes } = require('../lib/tradfiMarkets');
const { getIntel } = require('../lib/tradfiIntel');
const { getWhaleActivity, getAllWhaleActivity } = require('../lib/tradfiWhales');
const { requireUser } = require('../lib/authStore');
const { DEFAULT_PROVIDER, getRawAiKey } = require('../lib/userAiKeys');
const { deepseekFetch } = require('../lib/deepseekClient');

const router = express.Router();

router.post('/analyze', async (req, res) => {
  try {
    const user = requireUser(req);
    const apiKey = getRawAiKey(user.user.id, DEFAULT_PROVIDER)?.apiKey;
    if (!apiKey) return res.status(400).json({ error: '请先在 AI 分析设置中配置 DeepSeek API Key' });
    const symbol = String(req.body?.symbol || '').trim().toUpperCase();
    if (!symbol) return res.status(400).json({ error: '缺少 TradFi 标的代码' });
    const catalog = await getCatalog();
    const market = catalog.symbols.find((item) => item.symbol === symbol);
    if (!market) return res.status(404).json({ error: '该标的不是当前可用的 TradFi 合约' });
    const [quoteResult, intelResult] = await Promise.allSettled([getQuotes(symbol), getIntel(symbol)]);
    const quote = quoteResult.status === 'fulfilled' ? quoteResult.value.quotes.find((item) => item.symbol === symbol) || null : null;
    const intel = intelResult.status === 'fulfilled' ? intelResult.value : {
      fundamentals: { rows: [], note: '基础面数据源暂不可用。', source: null, stale: true },
      events: { items: [], source: null, stale: true },
      news: { items: [], source: null, stale: true },
    };
    const context = {
      symbol,
      name: market.name,
      category: market.category,
      quote: quote ? { lastPrice: quote.lastPrice, change24hPct: quote.priceChangePercent, stale: quote.stale, source: quote.source } : null,
      fundamentals: {
        rows: (intel.fundamentals.rows || []).slice(0, 12),
        note: intel.fundamentals.note,
        source: intel.fundamentals.source,
        stale: intel.fundamentals.stale,
      },
      events: {
        items: (intel.events.items || []).slice(0, 6),
        source: intel.events.source,
        stale: intel.events.stale,
      },
      news: {
        items: (intel.news.items || []).slice(0, 8).map(({ title, category, publishedAt, source, summary }) => ({ title, category, publishedAt, source, summary })),
        source: intel.news.source,
        stale: intel.news.stale,
      },
    };
    const prompt = [
      '请基于以下 TradFi 标的市场资料做谨慎的方向观察。只根据提供的数据，不得补造价格、宏观数据或事件结果。',
      '这只是研究信息，不得给出买卖、入场、止损、止盈、杠杆或仓位建议。数据不足时明确标注方向不明/不可评估。',
      '请只返回合法 JSON，不要 Markdown，结构为：',
      '{"direction":"偏多|偏空|中性|方向不明","confidence":"高|中|低|不可评估","summary":"简短中文摘要","periods":{"ultraShort":"偏多|偏空|中性|数据不足","short":"偏多|偏空|中性|数据不足","mediumLong":"偏多|偏空|中性|数据不足"},"supportingFactors":["..."],"opposingFactors":["..."]}',
      '中长期没有足够基本面数据时必须返回数据不足。不要把单一基本面数值直接解释成上涨或下跌原因；需说明依据和数据限制。',
      `市场资料：${JSON.stringify(context).slice(0, 9000)}`,
    ].join('\n');
    const result = await deepseekFetch(apiKey, '/chat/completions', {
      method: 'POST', timeoutMs: 90_000,
      body: { model: 'deepseek-chat', temperature: 0.2, max_tokens: 1100, messages: [
        { role: 'system', content: '你是传统金融市场信息分析助手。保持审慎、区分事实与推断，严格按用户给定 JSON 格式返回。' },
        { role: 'user', content: prompt },
      ] },
    });
    const raw = String(result?.choices?.[0]?.message?.content || '').trim();
    const jsonText = raw.match(/\{[\s\S]*\}/)?.[0];
    let analysis;
    try { analysis = jsonText ? JSON.parse(jsonText) : null; } catch { analysis = null; }
    if (!analysis || typeof analysis !== 'object' || !analysis.direction || !analysis.confidence || !analysis.summary) {
      return res.status(502).json({ error: 'AI 返回内容无法解析，请稍后重试' });
    }
    res.json({ ok: true, symbol, analysis, model: result.model || 'deepseek-chat', usage: result.usage || null, analyzedAt: new Date().toISOString() });
  } catch (err) {
    console.error('[POST /api/tradfi/analyze]', err.message);
    res.status(err.status || 500).json({ error: err.message || 'TradFi AI 分析失败' });
  }
});

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

module.exports = router;
