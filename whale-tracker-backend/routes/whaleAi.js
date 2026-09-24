const express = require('express');
const { requireUser } = require('../lib/authStore');
const {
  DEFAULT_PROVIDER,
  getAiKeyStatus,
  upsertAiKey,
  deleteAiKey,
  getRawAiKey,
} = require('../lib/userAiKeys');
const {
  verifyDeepseekKey,
  analyzeWithDeepseek,
  streamAnalyzeWithDeepseek,
  analyzeMarketBrief,
  streamAnalyzeMarketBrief,
  chatMarketBrief,
  streamChatMarketBrief,
} = require('../lib/deepseekClient');
const { buildMarketBriefContext, contextToPrompt, buildAnalyzeMarketSnippet, normalizeCoin } = require('../lib/marketBrief');

const router = express.Router();

function sendErr(res, err) {
  const status = Number(err.status) || 500;
  res.status(status).json({ error: err.message || 'AI 分析请求失败' });
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

function resolveAnalyzeCoin(body = {}) {
  const meta = body.meta && typeof body.meta === 'object' ? body.meta : {};
  const raw = body.coin || meta.coin || meta.symbol || '';
  return normalizeCoin(raw) || 'BTC';
}

async function enrichAnalyzeMeta(source, body) {
  const meta =
    body.meta && typeof body.meta === 'object' ? { ...body.meta } : body.meta ? { raw: body.meta } : {};
  if (source === 'whale') return { meta, coin: null };
  const coin = resolveAnalyzeCoin(body);
  try {
    const ctx = await buildMarketBriefContext(coin, { forceRefresh: false });
    meta.marketContext = buildAnalyzeMarketSnippet(ctx);
    meta.coin = coin;
  } catch (err) {
    meta.marketContext = `市场上下文暂不可用：${err.message || 'unknown'}`;
    meta.coin = coin;
  }
  return { meta, coin };
}

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
    const source =
      body.source === 'macro' ? 'macro' : body.source === 'whale' ? 'whale' : 'x';
    const title = String(body.title || '').trim();
    const content = String(body.content || '').trim();
    if (!title && !content) {
      const err = new Error('缺少待分析内容');
      err.status = 400;
      throw err;
    }
    const { meta } = await enrichAnalyzeMeta(source, body);
    const result = await analyzeWithDeepseek(cred.apiKey, {
      source,
      title,
      content,
      meta,
    });
    res.json({ ok: true, source, ...result });
  } catch (err) {
    sendErr(res, err);
  }
});

/** POST /api/whale-ai/analyze-stream — SSE 流式分析（新闻 / 宏观 / 巨鲸） */
router.post('/analyze-stream', async (req, res) => {
  if (!assertLogin(req, res)) return;

  const cred = getRawAiKey(req.user.user.id, DEFAULT_PROVIDER);
  if (!cred?.apiKey) {
    return res.status(400).json({ error: '请先配置 DeepSeek API Key' });
  }

  const body = req.body || {};
  const source =
    body.source === 'macro' ? 'macro' : body.source === 'whale' ? 'whale' : 'x';
  const title = String(body.title || '').trim();
  const content = String(body.content || '').trim();
  if (!title && !content) {
    return res.status(400).json({ error: '缺少待分析内容' });
  }

  const abort = new AbortController();
  const onClientGone = () => {
    if (!res.writableEnded) abort.abort();
  };
  res.on('close', onClientGone);

  initSse(res);
  if (source !== 'whale') {
    sseWrite(res, 'status', { stage: 'market', message: '正在拉取短线压力与资金流向…' });
  } else {
    sseWrite(res, 'status', { stage: 'analyze', message: 'DeepSeek 正在分析…' });
  }

  try {
    const { meta, coin } = await enrichAnalyzeMeta(source, body);
    if (abort.signal.aborted || res.writableEnded) return;
    if (source !== 'whale') {
      sseWrite(res, 'status', {
        stage: 'analyze',
        message: coin ? `DeepSeek 正在分析（${coin}）…` : 'DeepSeek 正在分析…',
      });
    }
    const result = await streamAnalyzeWithDeepseek(
      cred.apiKey,
      {
        source,
        title,
        content,
        meta,
      },
      {
        signal: abort.signal,
        onDelta: (text) => {
          if (abort.signal.aborted || res.writableEnded) return;
          sseWrite(res, 'delta', { text });
        },
      },
    );
    if (abort.signal.aborted || res.writableEnded) return;
    sseWrite(res, 'done', {
      ok: true,
      source,
      coin: coin || undefined,
      analysis: result.analysis,
      model: result.model,
      usage: result.usage,
    });
    res.end();
  } catch (err) {
    if (abort.signal.aborted) {
      try {
        if (!res.writableEnded) res.end();
      } catch (_) {
        /* ignore */
      }
      return;
    }
    try {
      if (!res.headersSent) {
        sendErr(res, err);
        return;
      }
      sseWrite(res, 'error', { error: err.message || '分析失败' });
      res.end();
    } catch (_) {
      if (!res.headersSent) sendErr(res, err);
    }
  } finally {
    res.removeListener('close', onClientGone);
  }
});

const {
  createAnalysis,
  updateAnalysis,
  getAnalysis,
  newContextSnapshotId,
  listVersions,
  pushVersion,
  nextVersionLabel,
  buildContextDiff,
  snapshotForDiff,
} = require('../lib/briefAnalysisStore');

function buildContextSummary(context) {
  return {
    price: context.market.price,
    fundingPct: context.market.fundingPct,
    newsCount: context.news.length,
    webNewsCount: context.webNews?.length || 0,
    newsMode: context.newsMode,
    macroCount: context.macro.length,
    whaleLong: context.whales.longCount,
    whaleShort: context.whales.shortCount,
    exchangeLongPct: context.sentiment?.exchangeLongAccountPct ?? null,
    exchangeShortPct: context.sentiment?.exchangeShortAccountPct ?? null,
    hasTech: Boolean(context.tech?.available),
    hasLiq: Boolean(context.sentiment?.liquidations?.totalUsd),
    liqTotalUsd: context.sentiment?.liquidations?.totalUsd ?? null,
    alertCount: context.alerts.length,
    hasDefi: Boolean(context.defi),
    equityLike: Boolean(context.equityLike),
    assetType: context.asset?.assetType || null,
    status: context.status || null,
    statusMeta: context.statusMeta || null,
    capability: context.capability || null,
    hasExternalCrowd: Boolean(
      context.sentiment?.external?.binanceTopAccount ||
        context.sentiment?.external?.bybitAccount ||
        context.sentiment?.external?.onchainWhales?.length,
    ),
    sources: context.sources,
    asOf: context.asOf,
    forceRefresh: Boolean(context.forceRefresh),
    charts: {
      m5: context.tech?.m5?.chart || null,
      hour: context.tech?.hour?.chart || null,
      day: context.tech?.day?.chart || null,
    },
  };
}

function initSse(res) {
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
}

function sseWrite(res, event, data) {
  if (res.writableEnded) return;
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
  if (typeof res.flush === 'function') res.flush();
}

async function runBriefPipeline({ apiKey, coin, userId, forceRefresh }) {
  const analysis = createAnalysis({ coin, userId, forceRefresh });
  updateAnalysis(analysis.analysisId, { status: 'running' });

  const context = await buildMarketBriefContext(coin, { forceRefresh });
  const contextSnapshotId = newContextSnapshotId();
  const contextText = contextToPrompt(context);
  const contextSummary = buildContextSummary(context);
  const snap = snapshotForDiff(context);
  const versions = listVersions(coin, userId);
  const prevSnap = versions[0]?.contextSnapshot || null;
  const contextDiff = buildContextDiff(prevSnap, snap);
  const version = nextVersionLabel(coin, userId);

  updateAnalysis(analysis.analysisId, {
    contextSnapshotId,
    contextSummary,
    capability: context.capability,
    contextDiff,
    version,
    status: 'running',
  });

  return {
    analysisId: analysis.analysisId,
    contextSnapshotId,
    context,
    contextText,
    contextSummary,
    contextDiff,
    version,
    snap,
  };
}

function persistDone({
  analysisId,
  coin,
  userId,
  version,
  contextSnapshotId,
  contextSummary,
  contextDiff,
  snap,
  result,
  capability,
}) {
  const row = {
    analysisId,
    contextSnapshotId,
    version,
    createdAt: Date.now(),
    result: result.analysisResult || result.structured,
    analysis: result.analysis,
    structured: result.structured,
    contextSummary,
    contextDiff,
    contextSnapshot: snap,
    capability,
    model: result.model,
  };
  pushVersion(coin, userId, row);
  updateAnalysis(analysisId, {
    status: 'done',
    version,
    result: row.result,
    analysisMarkdown: result.analysis,
    contextSummary,
    contextDiff,
    capability,
    model: result.model,
    error: null,
  });
  return row;
}

/** POST /api/whale-ai/market-brief  { coin, forceRefresh? } */
router.post('/market-brief', async (req, res) => {
  if (!assertLogin(req, res)) return;
  try {
    const cred = getRawAiKey(req.user.user.id, DEFAULT_PROVIDER);
    if (!cred?.apiKey) {
      const err = new Error('请先配置 DeepSeek API Key（侧栏币种偏好里可绑定）');
      err.status = 400;
      throw err;
    }
    const body = req.body || {};
    const coin = normalizeCoin(body.coin) || 'BTC';
    const forceRefresh = Boolean(body.forceRefresh);
    const forceTradeDecision = Boolean(body.forceTradeDecision);
    const userId = req.user.user.id;
    const pipe = await runBriefPipeline({
      apiKey: cred.apiKey,
      coin,
      userId,
      forceRefresh,
    });
    const result = await analyzeMarketBrief(cred.apiKey, {
      coin,
      contextText: pipe.contextText,
      equityLike: Boolean(pipe.context.equityLike),
      capability: pipe.context.capability,
      forceTradeDecision,
    });
    const saved = persistDone({
      analysisId: pipe.analysisId,
      coin,
      userId,
      version: pipe.version,
      contextSnapshotId: pipe.contextSnapshotId,
      contextSummary: pipe.contextSummary,
      contextDiff: pipe.contextDiff,
      snap: pipe.snap,
      result,
      capability: pipe.context.capability,
    });
    res.json({
      ok: true,
      coin,
      analysisId: pipe.analysisId,
      contextSnapshotId: pipe.contextSnapshotId,
      version: pipe.version,
      analysis: result.analysis,
      structured: result.structured || null,
      analysisResult: result.analysisResult || result.structured,
      contextText: pipe.contextText,
      contextDiff: pipe.contextDiff,
      capability: pipe.context.capability,
      model: result.model,
      usage: result.usage,
      contextSummary: pipe.contextSummary,
      savedAt: saved.createdAt,
    });
  } catch (err) {
    sendErr(res, err);
  }
});

/** GET /api/whale-ai/market-brief-analysis/:analysisId — 断线恢复，不重跑模型 */
router.get('/market-brief-analysis/:analysisId', (req, res) => {
  if (!assertLogin(req, res)) return;
  const row = getAnalysis(req.params.analysisId);
  if (!row) return res.status(404).json({ error: '分析任务不存在' });
  res.json({
    ok: true,
    analysisId: row.analysisId,
    contextSnapshotId: row.contextSnapshotId,
    status: row.status,
    coin: row.coin,
    version: row.version,
    analysis: row.analysisMarkdown,
    structured: row.result,
    analysisResult: row.result,
    contextSummary: row.contextSummary,
    contextDiff: row.contextDiff,
    capability: row.capability,
    model: row.model,
    error: row.error,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
});

/** GET /api/whale-ai/market-brief-versions?coin=BTC */
router.get('/market-brief-versions', (req, res) => {
  if (!assertLogin(req, res)) return;
  const coin = normalizeCoin(req.query.coin) || 'BTC';
  const list = listVersions(coin, req.user.user.id).map((v) => ({
    analysisId: v.analysisId,
    contextSnapshotId: v.contextSnapshotId,
    version: v.version,
    createdAt: v.createdAt,
    contextDiff: v.contextDiff,
    direction: v.result?.short_term?.direction || v.result?.short_term?.bias,
    confidence: v.result?.short_term?.confidence,
  }));
  res.json({ ok: true, coin, versions: list });
});

/** POST /api/whale-ai/market-brief-stream  — SSE；body: { coin, forceRefresh?, analysisId? } */
router.post('/market-brief-stream', async (req, res) => {
  if (!assertLogin(req, res)) return;

  const cred = getRawAiKey(req.user.user.id, DEFAULT_PROVIDER);
  if (!cred?.apiKey) {
    return res.status(400).json({ error: '请先配置 DeepSeek API Key（侧栏币种偏好里可绑定）' });
  }

  const body = req.body || {};
  const coin = normalizeCoin(body.coin) || 'BTC';
  const forceRefresh = Boolean(body.forceRefresh);
  const forceTradeDecision = Boolean(body.forceTradeDecision);
  const resumeId = String(body.analysisId || '').trim();
  const userId = req.user.user.id;

  // 断线恢复：已有任务则直接回放状态，绝不自动重跑 DeepSeek
  if (resumeId) {
    const existing = getAnalysis(resumeId);
    if (!existing) return res.status(404).json({ error: '分析任务不存在' });
    initSse(res);
    sseWrite(res, 'status', {
      stage: existing.status,
      message: `恢复任务 ${existing.status}`,
      analysisId: existing.analysisId,
      contextSnapshotId: existing.contextSnapshotId,
    });
    if (existing.status === 'done') {
      sseWrite(res, 'done', {
        ok: true,
        coin: existing.coin,
        analysisId: existing.analysisId,
        contextSnapshotId: existing.contextSnapshotId,
        version: existing.version,
        analysis: existing.analysisMarkdown,
        structured: existing.result,
        analysisResult: existing.result,
        contextSummary: existing.contextSummary,
        contextDiff: existing.contextDiff,
        capability: existing.capability,
        model: existing.model,
      });
      return res.end();
    }
    if (existing.status === 'failed') {
      sseWrite(res, 'error', {
        error: existing.error || '上次分析失败，请手动重新分析',
        analysisId: existing.analysisId,
        allowRetry: true,
      });
      return res.end();
    }
    sseWrite(res, 'status', {
      stage: 'running',
      message: '任务仍在进行或结果未落盘，请稍后用同一 analysisId 查询，勿自动重跑',
      analysisId: existing.analysisId,
    });
    return res.end();
  }

  const abort = new AbortController();
  const onClientGone = () => {
    if (!res.writableEnded) abort.abort();
  };
  res.on('close', onClientGone);

  let analysisId = null;
  initSse(res);

  const heartbeat = setInterval(() => {
    if (res.writableEnded || abort.signal.aborted) return;
    sseWrite(res, 'status', {
      stage: 'context',
      message: '仍在汇总数据，请稍候…',
      analysisId,
    });
    try {
      res.write(': ping\n\n');
    } catch (_) {
      /* ignore */
    }
  }, 4000);

  try {
    const pipe = await runBriefPipeline({
      apiKey: cred.apiKey,
      coin,
      userId,
      forceRefresh,
    });
    analysisId = pipe.analysisId;
    sseWrite(res, 'status', {
      stage: 'context',
      message: '正在汇总行情、K 线与新闻…',
      analysisId: pipe.analysisId,
      contextSnapshotId: pipe.contextSnapshotId,
    });
    if (abort.signal.aborted) {
      clearInterval(heartbeat);
      if (!res.writableEnded) res.end();
      return;
    }

    sseWrite(res, 'meta', {
      coin,
      analysisId: pipe.analysisId,
      contextSnapshotId: pipe.contextSnapshotId,
      version: pipe.version,
      contextSummary: pipe.contextSummary,
      capability: pipe.context.capability,
      contextDiff: pipe.contextDiff,
      equityLike: Boolean(pipe.context.equityLike),
      // 不在 meta 下发完整 contextText，减少断线重传体积；done 时也不强制需要
    });
    sseWrite(res, 'status', {
      stage: 'model',
      message: 'DeepSeek 正在流式生成简报…',
      analysisId: pipe.analysisId,
      contextSnapshotId: pipe.contextSnapshotId,
    });

    const result = await streamAnalyzeMarketBrief(
      cred.apiKey,
      {
        coin,
        contextText: pipe.contextText,
        equityLike: Boolean(pipe.context.equityLike),
        capability: pipe.context.capability,
        forceTradeDecision,
      },
      {
        signal: abort.signal,
        onDelta: (text) => {
          sseWrite(res, 'delta', { text, analysisId: pipe.analysisId });
        },
      },
    );

    if (abort.signal.aborted) {
      clearInterval(heartbeat);
      if (!res.writableEnded) res.end();
      return;
    }

    persistDone({
      analysisId: pipe.analysisId,
      coin,
      userId,
      version: pipe.version,
      contextSnapshotId: pipe.contextSnapshotId,
      contextSummary: pipe.contextSummary,
      contextDiff: pipe.contextDiff,
      snap: pipe.snap,
      result,
      capability: pipe.context.capability,
    });

    sseWrite(res, 'done', {
      ok: true,
      coin,
      analysisId: pipe.analysisId,
      contextSnapshotId: pipe.contextSnapshotId,
      version: pipe.version,
      analysis: result.analysis,
      structured: result.structured || null,
      analysisResult: result.analysisResult || result.structured,
      contextSummary: pipe.contextSummary,
      contextDiff: pipe.contextDiff,
      capability: pipe.context.capability,
      model: result.model,
      usage: result.usage,
      parseMode: result.parseMode,
    });
    res.end();
  } catch (err) {
    if (analysisId) {
      updateAnalysis(analysisId, {
        status: 'failed',
        error: err?.message || '流式诊币失败',
      });
    }
    if (abort.signal.aborted) {
      if (!res.writableEnded) {
        try {
          res.end();
        } catch (_) {
          /* ignore */
        }
      }
      return;
    }
    const message = err?.message || '流式诊币失败';
    try {
      sseWrite(res, 'error', {
        error: message,
        status: Number(err.status) || 500,
        analysisId,
        allowRetry: true,
      });
      res.end();
    } catch (_) {
      if (!res.headersSent) sendErr(res, err);
    }
  } finally {
    clearInterval(heartbeat);
    res.removeListener('close', onClientGone);
  }
});

/** POST /api/whale-ai/market-chat */
router.post('/market-chat', async (req, res) => {
  if (!assertLogin(req, res)) return;
  try {
    const cred = getRawAiKey(req.user.user.id, DEFAULT_PROVIDER);
    if (!cred?.apiKey) {
      const err = new Error('请先配置 DeepSeek API Key');
      err.status = 400;
      throw err;
    }
    const body = req.body || {};
    const coin = normalizeCoin(body.coin) || 'BTC';
    const message = String(body.message || '').trim();
    if (!message) {
      const err = new Error('请输入要探讨的问题');
      err.status = 400;
      throw err;
    }
    const result = await chatMarketBrief(cred.apiKey, {
      coin,
      contextText: body.contextText,
      analysis: body.analysis,
      messages: body.messages,
      message,
    });
    res.json({
      ok: true,
      coin,
      reply: result.reply,
      model: result.model,
      usage: result.usage,
    });
  } catch (err) {
    sendErr(res, err);
  }
});

/** POST /api/whale-ai/market-chat-stream — SSE 追问 */
router.post('/market-chat-stream', async (req, res) => {
  if (!assertLogin(req, res)) return;

  const cred = getRawAiKey(req.user.user.id, DEFAULT_PROVIDER);
  if (!cred?.apiKey) {
    return res.status(400).json({ error: '请先配置 DeepSeek API Key' });
  }

  const body = req.body || {};
  const coin = normalizeCoin(body.coin) || 'BTC';
  const message = String(body.message || '').trim();
  if (!message) {
    return res.status(400).json({ error: '请输入要探讨的问题' });
  }

  const abort = new AbortController();
  const onClientGone = () => {
    if (!res.writableEnded) abort.abort();
  };
  res.on('close', onClientGone);

  initSse(res);
  sseWrite(res, 'status', { stage: 'chat', message: 'DeepSeek 正在回复…' });

  try {
    const result = await streamChatMarketBrief(
      cred.apiKey,
      {
        coin,
        contextText: body.contextText,
        analysis: body.analysis,
        messages: body.messages,
        message,
      },
      {
        signal: abort.signal,
        onDelta: (text) => {
          if (abort.signal.aborted || res.writableEnded) return;
          sseWrite(res, 'delta', { text });
        },
      },
    );
    if (abort.signal.aborted || res.writableEnded) return;
    sseWrite(res, 'done', {
      ok: true,
      coin,
      reply: result.reply,
      model: result.model,
      usage: result.usage,
    });
    res.end();
  } catch (err) {
    if (abort.signal.aborted) {
      try {
        if (!res.writableEnded) res.end();
      } catch (_) {
        /* ignore */
      }
      return;
    }
    try {
      if (!res.headersSent) {
        sendErr(res, err);
        return;
      }
      sseWrite(res, 'error', { error: err.message || '对话失败' });
      res.end();
    } catch (_) {
      if (!res.headersSent) sendErr(res, err);
    }
  } finally {
    res.removeListener('close', onClientGone);
  }
});

module.exports = router;
