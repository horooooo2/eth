const {sortRows}=require('../lib/radarSort');
const express = require('express');
const { getCatalog, getQuotes, getRadarCatalog, getRadarQuotes, getRadarMarketQuotes, getRadarAvailableContracts, getRadarMarketCap, getTradFiKlines } = require('../lib/tradfiMarkets');
const { getWhaleActivity, getAllWhaleActivity } = require('../lib/tradfiWhales');
const { requireUser } = require('../lib/authStore');
const { DEFAULT_PROVIDER, getRawAiKey } = require('../lib/userAiKeys');
const { deepseekFetch } = require('../lib/deepseekClient');
const { ENGINE_VERSION } = require('../lib/tradfiDirection');
const { PROMPT_VERSION, buildTradFiSnapshot, buildExplanationPrompt, parseExplanation, defaultExplanation } = require('../lib/tradfiAnalysis');
const analysisStore = require('../lib/tradfiAnalysisStore');
const { getRadarNews } = require('../lib/tradfiIntel');

const router = express.Router();
router.get('/radar/long-trends',(req,res)=>{
  const days=Number(req.query.days||90),direction=String(req.query.direction||'ALL'),assetType=String(req.query.assetType||'ALL');
  if(![30,60,90].includes(days)||!['TREND','ALL','UP','DOWN','TURN_UP','TURN_DOWN','NEUTRAL'].includes(direction)||!['ALL','CRYPTO','TRADFI'].includes(assetType))return res.status(400).json({error:'无效的趋势筛选参数'});
  const sort=String(req.query.sort||'score'),order=String(req.query.order||'desc');
  if(!['score','change','monthChange'].includes(sort)||!['asc','desc'].includes(order))return res.status(400).json({error:'无效排序参数'});
  try {res.set('Cache-Control','no-store').json(require('../lib/radarLongTrend').snapshot({sort,order,days,direction,assetType,search:req.query.search,page:Number(req.query.page||1),watchSymbols:String(req.query.watch||'').split(',').filter(s=>/^[A-Z0-9]{3,30}$/.test(s)).slice(0,30),focus:String(req.query.focus||'').slice(0,30)}));}
  catch {res.status(503).json({error:'长期趋势缓存暂不可用'});}
});
router.use('/strategy-shadow', require('./strategyShadow'));
const inFlightAnalyses = new Map();

router.post('/analyze', async (req, res) => {
  try {
    const user = requireUser(req);
    const apiKey = getRawAiKey(user.user.id, DEFAULT_PROVIDER)?.apiKey;
    if (!apiKey) return res.status(400).json({ error: '请先在 AI 分析设置中配置 DeepSeek API Key' });
    const symbol = String(req.body?.symbol || '').trim().toUpperCase();
    if (!symbol) return res.status(400).json({ error: '缺少 TradFi 标的代码' });
    const snapshot = await buildTradFiSnapshot(symbol);
    const key = [user.user.id, symbol, snapshot.contextHash, ENGINE_VERSION, PROMPT_VERSION].join(':');
    const saved = analysisStore.findByContext({ userId: user.user.id, symbol, contextHash: snapshot.contextHash, engineVersion: ENGINE_VERSION, promptVersion: PROMPT_VERSION });
    if (saved?.status === 'COMPLETED') return res.json({ ...saved, reused: true });
    if (saved && ['PENDING', 'RUNNING'].includes(saved.status) && !inFlightAnalyses.has(key)) {
      return res.status(202).json({ ...saved, reused: true });
    }
    let task = inFlightAnalyses.get(key);
    if (!task) {
      task = (async () => {
        const row = analysisStore.createPending({ userId: user.user.id, symbol, contextHash: snapshot.contextHash,
          engineVersion: ENGINE_VERSION, promptVersion: PROMPT_VERSION,
          context: { marketContext: snapshot.marketContext, intel: snapshot.intel }, directionResult: snapshot.directionResult });
        analysisStore.updateStatus(row.analysisId, 'RUNNING');
        try {
          let explanation; let model = 'deterministic-no-ai';
          const anyDirectionAvailable = Object.values(snapshot.directionResult.timeframes).some((frame) => frame.directionAllowed);
          if (anyDirectionAvailable) {
            const result = await deepseekFetch(apiKey, '/chat/completions', {
              method: 'POST', timeoutMs: 90_000,
              body: { model: 'deepseek-chat', temperature: 0.15, max_tokens: 900, messages: [
                { role: 'system', content: '你是传统金融市场分析解释助手。后端规则引擎负责所有方向与数据充分度，你只能解释已有数据，不能更改结论。' },
                { role: 'user', content: buildExplanationPrompt(snapshot) },
              ] },
            });
            explanation = parseExplanation(result?.choices?.[0]?.message?.content);
            model = result?.model || 'deepseek-chat';
            if (!explanation) throw Object.assign(new Error('AI 返回的解释内容无法解析，请稍后重试'), { status: 502 });
          } else explanation = defaultExplanation(snapshot.directionResult);
          return analysisStore.updateStatus(row.analysisId, 'COMPLETED', { explanation, model });
        } catch (err) {
          analysisStore.updateStatus(row.analysisId, 'FAILED', { error: err.message || 'TradFi AI 分析失败' });
          throw err;
        }
      })().finally(() => inFlightAnalyses.delete(key));
      inFlightAnalyses.set(key, task);
    }
    const result = await task;
    res.json({ ...result, reused: false });
  } catch (err) {
    console.error('[POST /api/tradfi/analyze]', err.message);
    res.status(err.status || 500).json({ error: err.message || 'TradFi AI 分析失败' });
  }
});

router.get('/analysis/:analysisId', (req, res) => {
  try {
    const user = requireUser(req);
    const result = analysisStore.getById(req.params.analysisId, user.user.id);
    if (!result) return res.status(404).json({ error: '分析记录不存在' });
    res.json(result);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || '读取分析记录失败' });
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

router.get('/radar/catalog', async (_req, res) => {
  try {
    const result = await getRadarCatalog(_req.query.symbols || '');
    res.json({ symbols: result.symbols, updatedAt: result.updatedAt, stale: Boolean(result.stale), source: 'Binance USDⓈ-M Futures' });
  } catch (err) {
    console.error('[GET /api/tradfi/radar/catalog]', err.message);
    res.status(502).json({ error: '雷达合约清单暂不可用', details: err.message });
  }
});

router.get('/radar/available', async (_req, res) => {
  try {
    const result = await getRadarAvailableContracts();
    res.json({ contracts: result.contracts, updatedAt: result.updatedAt, stale: Boolean(result.stale), source: 'Binance USDⓈ-M Futures' });
  } catch (err) {
    console.error('[GET /api/tradfi/radar/available]', err.message);
    res.status(502).json({ error: '可添加合约清单暂不可用', details: err.message });
  }
});

router.get('/radar/quotes', async (req, res) => {
  try {
    const interval = String(req.query.interval || '24h');
    if (!['24h', '1h', '5m'].includes(interval)) return res.status(400).json({ error: '不支持的榜单周期' });
    res.json(await getRadarQuotes(req.query.symbols, interval));
  } catch (err) {
    console.error('[GET /api/tradfi/radar/quotes]', err.message);
    res.status(502).json({ error: '雷达行情暂不可用', details: err.message });
  }
});

router.get('/radar/market', async (req, res) => {
  const interval = req.query.interval || '24h';
  if (!['24h', '1h', '5m'].includes(interval)) return res.status(400).json({ error: '不支持的榜单周期' });
  const sort=String(req.query.sort||'absoluteChange'),order=String(req.query.order||'desc');
  if(!['absoluteChange','price','change'].includes(sort)||!['asc','desc'].includes(order))return res.status(400).json({error:'无效排序参数'});
  try {
    const result = await getRadarMarketQuotes(interval);
    const quotes=sortRows(result.quotes,row=>{
      if(sort==='price')return row.lastPrice;
      const change=interval==='24h'?row.priceChangePercent:row.changes?.[interval];
      return sort==='absoluteChange'&&change!=null?Math.abs(Number(change)):change;
    },order);
    res.json({ quotes, sort, order, updatedAt: result.updatedAt, stale: Boolean(result.stale), source: 'Binance USDⓈ-M Futures' });
  } catch (err) {
    console.error('[GET /api/tradfi/radar/market]', err.message);
    res.status(502).json({ error: '雷达全市场行情暂不可用', details: err.message });
  }
});

router.get('/radar/market-cap', async (req, res) => {
  try {
    const symbol = String(req.query.symbol || '').trim().toUpperCase();
    if (!/^[A-Z0-9]{3,30}USDT$/.test(symbol)) return res.status(400).json({ error: '无效的雷达合约' });
    res.json(await getRadarMarketCap(symbol));
  } catch (err) {
    console.error('[GET /api/tradfi/radar/market-cap]', err.message);
    res.status(502).json({ error: '市值数据暂不可用', details: err.message });
  }
});

router.get('/radar/news', async (req, res) => {
  try {
    const symbol = String(req.query.symbol || '').trim().toUpperCase();
    if (!/^[A-Z0-9]{3,30}USDT$/.test(symbol)) return res.status(400).json({ error: '无效的雷达合约' });
    res.json(await getRadarNews(symbol));
  } catch (err) {
    console.error('[GET /api/tradfi/radar/news]', err.message);
    res.status(err.status || 502).json({ error: err.message || '相关新闻暂不可用' });
  }
});

router.get('/radar/klines', async (req, res) => {
  try {
    const symbol = String(req.query.symbol || '').trim().toUpperCase();
    const interval = String(req.query.interval || '1h');
    const catalog = await getRadarCatalog([symbol]);
    if (!catalog.symbols.some((item) => item.symbol === symbol)) return res.status(400).json({ error: '无效的雷达合约' });
    if (!['5m', '15m', '1h'].includes(interval)) return res.status(400).json({ error: '无效的走势图周期' });
    res.json(await getTradFiKlines(symbol, interval));
  } catch (err) {
    console.error('[GET /api/tradfi/radar/klines]', err.message);
    res.status(502).json({ error: '雷达走势图暂不可用', details: err.message });
  }
});

router.get('/intel', async (req, res) => {
  try {
    const symbol = String(req.query.symbol || '').trim().toUpperCase();
    const snapshot = await buildTradFiSnapshot(symbol);
    res.json({ ...snapshot.intel, marketContext: snapshot.marketContext, directionResult: snapshot.directionResult,
      contextHash: snapshot.contextHash,
      meta: { symbol, generatedAt: new Date().toISOString(), directionEngineVersion: ENGINE_VERSION } });
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
