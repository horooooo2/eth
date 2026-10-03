/**
 * DeepSeek OpenAI-compatible API 客户端
 */
const axios = require('axios');
const { Readable } = require('node:stream');
const { HttpsProxyAgent } = require('https-proxy-agent');
const DEEPSEEK_BASE = 'https://api.deepseek.com';
const DEFAULT_MODEL = 'deepseek-chat';
const MARKET_BRIEF_MAX_TOKENS = 8192;

/** Node 20 的原生 fetch 不读取 HTTP(S)_PROXY；本地配置了代理时用代理 Agent 转发并保持 Web Response 接口。 */
async function deepseekHttpFetch(url, options = {}) {
  const proxyUrl = String(process.env.HTTPS_PROXY || process.env.https_proxy || '').trim();
  if (!proxyUrl) return fetch(url, options);

  const agent = new HttpsProxyAgent(proxyUrl);
  try {
    const response = await axios.request({
      url,
      method: options.method || 'GET',
      headers: options.headers,
      data: options.body,
      signal: options.signal,
      httpsAgent: agent,
      proxy: false,
      responseType: 'stream',
      validateStatus: () => true,
    });
    response.data?.once('close', () => agent.destroy());
    const body = response.status === 204 || response.status === 304 || !response.data
      ? null
      : Readable.toWeb(response.data);
    return new Response(body, { status: response.status });
  } catch (error) {
    agent.destroy();
    throw error;
  }
}

async function deepseekFetch(apiKey, path, { method = 'GET', body, timeoutMs = 60_000 } = {}) {
  const key = String(apiKey || '').trim();
  if (!key) {
    const err = new Error('缺少 DeepSeek API Key');
    err.status = 400;
    throw err;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await deepseekHttpFetch(`${DEEPSEEK_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { raw: text };
    }
    if (!res.ok) {
      const msg =
        data?.error?.message || data?.message || text?.slice(0, 200) || `HTTP ${res.status}`;
      const err = new Error(msg);
      err.status = res.status >= 400 && res.status < 600 ? res.status : 502;
      throw err;
    }
    return data;
  } catch (err) {
    if (err.name === 'AbortError') {
      const e = new Error('DeepSeek 请求超时');
      e.status = 504;
      throw e;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** 轻量校验 Key 是否可用 */
async function verifyDeepseekKey(apiKey) {
  await deepseekFetch(apiKey, '/models', { method: 'GET', timeoutMs: 20_000 });
  return true;
}

function clip(text, max = 4000) {
  const s = String(text || '');
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…`;
}

function buildAnalyzeMessages({ source, title, content, meta } = {}) {
  const src = source === 'macro' ? 'macro' : source === 'whale' ? 'whale' : 'x';
  const label =
    src === 'macro' ? '宏观数据事件' : src === 'whale' ? '巨鲸持仓与行为数据' : 'X（Twitter）动态';
  const metaObj = meta && typeof meta === 'object' ? meta : null;
  const metaForJson = metaObj
    ? Object.fromEntries(Object.entries(metaObj).filter(([k]) => k !== 'marketContext'))
    : null;
  const metaText = metaForJson
    ? clip(JSON.stringify(metaForJson, null, 0), 2000)
    : clip(meta, 2000);

  const statsHint =
    metaObj && (metaObj.statsLine || metaObj.volumeLine)
      ? [
          '【必须引用的账户业绩/成交数据】',
          metaObj.volumeLine ? `成交活跃度：${metaObj.volumeLine}` : '',
          metaObj.statsLine ? `盈亏与胜率：${metaObj.statsLine}` : '',
          '分析「方向倾向」时务必点名引用上述月盈亏、累计、胜率、笔数等数字，并提醒统计口径可能仅覆盖已平仓、未计入浮亏。',
        ]
          .filter(Boolean)
          .join('\n')
      : '';

  const taskHint =
    src === 'whale'
      ? [
          '请分析该巨鲸当前持仓结构与潜在交易含义。',
          '输出要求（严格 Markdown）：',
          '1) 用中文，简洁专业；勿编造未见数据；不构成投资建议。',
          '2) 必须按下列标题分节（标题原样）：',
          '## 一、仓位结构',
          '## 二、方向倾向',
          '## 三、风险点',
          '## 四、可观察信号',
          '## 五、巨鲸可靠度',
          '3) 每节用 `- ` 列表；关键数字、金额、百分比、强平价用 **加粗**。',
          '4) 「方向倾向」必须结合【账户指标】里的月盈亏、累计盈亏、胜率、成交笔数展开讨论。',
          '5) 「巨鲸可靠度」必须引用参考等级（高/中/待观察/低）、胜率、笔数、最大回撤，并说明是否值得跟单观察；若疑似扛单或样本不足要明确降权。',
        ].join('\n')
      : [
          `请分析以下${label}对加密市场（尤其 BTC/ETH）的潜在影响。`,
          '输出要求（严格 Markdown）：',
          '1) 用中文，简洁专业；勿编造事实。若附加信息含实际值，必须引用实际 vs 预期/前值，禁止写「实际值暂缺」。',
          '2) 必须按下列标题分节：',
          '## 一、要点摘要',
          '## 二、方向倾向',
          '## 三、信心与关注点',
          '## 四、风险提示',
          '## 五、走向预判',
          '3) 每节用 `- ` 列表；关键数字、百分比用 **加粗**。',
          '4) 「走向预判」必须综合：事件预测/公布相对前值的超预期或不及预期、对加密货币影响方向、【市场上下文】中的短期 K 线压力位/支撑位、资金费率、爆仓与主动买卖（资金流向）、大户多空；并判断市场是否已提前计价（利空出尽/利好出尽）；给出短线偏向（偏多/震荡/偏空）与关键价位观察点；上下文缺失时直说，禁止编造。',
        ].join('\n');

  const reliabilityHint =
    src === 'whale' && metaObj && (metaObj.referenceLabel || metaObj.referenceTier)
      ? [
          '【巨鲸可靠度输入】',
          metaObj.referenceLabel
            ? `参考等级：${metaObj.referenceLabel}${metaObj.referenceShort ? `（${metaObj.referenceShort}）` : ''}`
            : '',
          metaObj.reliabilityLine ? `统计摘要：${metaObj.reliabilityLine}` : '',
        ]
          .filter(Boolean)
          .join('\n')
      : '';

  const marketHint =
    src !== 'whale' && metaObj?.marketContext
      ? ['【市场上下文 · 供走向预判引用】', clip(String(metaObj.marketContext), 2800)].join('\n')
      : '';

  const userPrompt = [
    taskHint,
    '',
    statsHint,
    reliabilityHint,
    marketHint,
    '',
    `标题：${clip(title, 300) || '（无）'}`,
    `内容：${clip(content, 6000) || '（无）'}`,
    metaText ? `附加信息：${metaText}` : '',
  ]
    .filter((line) => line !== undefined && line !== null)
    .join('\n');

  const system =
    src === 'whale'
      ? '你是加密衍生品巨鲸仓位分析助手。只基于给定持仓与统计材料推断，不确定时明确说明；必须引用账户业绩与可靠度指标；不下单指令。'
      : '你是加密市场宏观与舆情分析助手。只基于给定材料与市场上下文做推断，不确定时明确说明；走向预判需结合预测数值、K线压力与资金流向。';

  return {
    src,
    system,
    userPrompt,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: userPrompt },
    ],
  };
}

async function analyzeWithDeepseek(apiKey, { source, title, content, meta } = {}) {
  const { messages } = buildAnalyzeMessages({ source, title, content, meta });

  const data = await deepseekFetch(apiKey, '/chat/completions', {
    method: 'POST',
    timeoutMs: 90_000,
    body: {
      model: DEFAULT_MODEL,
      messages,
      temperature: 0.4,
      max_tokens: 1600,
    },
  });

  const analysis = String(data?.choices?.[0]?.message?.content || '').trim();
  if (!analysis) {
    const err = new Error('DeepSeek 未返回有效分析内容');
    err.status = 502;
    throw err;
  }
  return {
    analysis,
    model: data?.model || DEFAULT_MODEL,
    usage: data?.usage || null,
  };
}

/** 流式通用分析（新闻 / 宏观 / 巨鲸） */
async function streamAnalyzeWithDeepseek(
  apiKey,
  { source, title, content, meta } = {},
  { onDelta, signal } = {},
) {
  const key = String(apiKey || '').trim();
  if (!key) {
    const err = new Error('缺少 DeepSeek API Key');
    err.status = 400;
    throw err;
  }

  const { messages } = buildAnalyzeMessages({ source, title, content, meta });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90_000);
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  let res;
  try {
    res = await deepseekHttpFetch(`${DEEPSEEK_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify({
        model: DEFAULT_MODEL,
        messages,
        temperature: 0.4,
        max_tokens: 1600,
        stream: true,
      }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
    if (err.name === 'AbortError') {
      const e = new Error('DeepSeek 请求已取消或超时');
      e.status = 504;
      throw e;
    }
    throw err;
  }

  if (!res.ok) {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
    const text = await res.text().catch(() => '');
    let msg = text.slice(0, 200) || `HTTP ${res.status}`;
    try {
      const j = JSON.parse(text);
      msg = j?.error?.message || j?.message || msg;
    } catch (_) {
      /* ignore */
    }
    const err = new Error(msg);
    err.status = res.status >= 400 && res.status < 600 ? res.status : 502;
    throw err;
  }

  const reader = res.body?.getReader();
  if (!reader) {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
    const err = new Error('DeepSeek 未返回流式响应');
    err.status = 502;
    throw err;
  }

  const decoder = new TextDecoder();
  let buffer = '';
  let raw = '';
  let model = DEFAULT_MODEL;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n');
      buffer = parts.pop() || '';
      for (const line of parts) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(':')) continue;
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === '[DONE]') continue;
        let json;
        try {
          json = JSON.parse(payload);
        } catch {
          continue;
        }
        if (json?.model) model = json.model;
        const delta = json?.choices?.[0]?.delta?.content;
        if (typeof delta === 'string' && delta) {
          raw += delta;
          if (typeof onDelta === 'function') onDelta(delta);
        }
      }
    }
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
    try {
      reader.releaseLock();
    } catch (_) {
      /* ignore */
    }
  }

  const analysis = String(raw || '').trim();
  if (!analysis) {
    const err = new Error('DeepSeek 未返回有效分析内容');
    err.status = 502;
    throw err;
  }
  return {
    analysis,
    model,
    usage: null,
  };
}

const {
  parseAnalysisResult,
  analysisResultToMarkdown,
  normalizeAnalysisResult,
} = require('./analysisResult');

/**
 * 统一 AnalysisResult JSON Schema（流式与非流式同一套）
 */
function buildMarketBriefMessages({ coin, contextText, equityLike = false, capability, directionAssessment } = {}) {
  const symbol = String(coin || 'BTC').toUpperCase();
  const system = equityLike
    ? '你是权益市场研究助手，只做方向研判与信息聚合。严格依据输入事实，不能输出交易执行建议。'
    : '你是加密市场研究助手，只做方向研判与信息聚合。严格依据输入事实，不能输出交易执行建议。';
  const userPrompt = [
    `请为 ${symbol} 生成完整的市场方向仪表盘 JSON，分析具体、简洁，避免重复。`,
    'JSON 顶层只输出 short_term:{direction,confidence,summary}、mid_long_term:{direction,summary}、direction_analysis、risks_and_invalidation、disclaimer。',
    'direction_analysis 结构：{summary,market_state:{trend,volatility,structure,phase,observation},horizons:{ultra_short:{analysis,bull_points:[],bear_points:[],focus},short_term:{...},medium_long:{...}},timeframes:{m5:{status,state,analysis,metrics:[]},hour:{...},day:{...}},module_analysis:{technical:{status,summary,facts:[],limitation},derivatives:{...},flow:{...},whales:{...},news:{...},cross:{...}},bull_evidence:[],bear_evidence:[],data_limitations:[]}。',
    '控制长度：总摘要不超过120字；每个周期分析不超过100字、看多和看空依据各最多2条、关注点不超过50字；市场状态每项不超过50字；每个周期分析不超过80字且指标最多2条；每个模块摘要不超过80字、事实最多2条、限制不超过50字；总多空证据各最多4条、数据限制最多5条。',
    '基于上下文中的实际数值，具体解释趋势、动能、波动、费率、爆仓、主动买卖、巨鲸、新闻和跨市场数据；不同时间尺度不能复制同一结论。未提供的指标明确写数据不足。timeframes 只填写实际可用周期，禁止插值和臆造。',
    'direction/confidence 必须原样采用后面的程序评估，不能自行更改；DATA_INSUFFICIENT 表示数据不足，不能改成中性或其他方向。所有数字方向分数、覆盖率和信心仅以程序评估为准；AI负责提供具体解释，不能伪造子模块分数。',
    '严禁输出买卖指令、入场价、挂单、杠杆、仓位、止损或止盈。区分可观测事实与推断；推断需用“可能/倾向/尚待验证”等措辞。新闻仅作事实摘要，不进入方向评分。',
    `能力状态：${JSON.stringify(capability || {})}`,
    `程序方向评估：${JSON.stringify(directionAssessment || {})}`,
    '—— 市场数据上下文开始 ——',
    String(contextText || ''),
    '—— 市场数据上下文结束 ——',
    '每个周期和六个分析模块都必须有简短说明；数据不可用时说明缺口。所有字符串保持简洁，确保 JSON 能完整闭合。',
  ].join('\n');
  return { system, userPrompt, messages: [{ role: 'system', content: system }, { role: 'user', content: userPrompt }] };
}

function finalizeAnalysis(rawText, directionAssessment) {
  const parsed = parseAnalysisResult(rawText);
  if (parsed.ok && parsed.result) {
    assertDashboardAnalysis(parsed.result);
    applyDirectionAssessment(parsed.result, directionAssessment);
    return {
      analysis: analysisResultToMarkdown(parsed.result),
      structured: parsed.result,
      analysisResult: parsed.result,
      parseMode: 'schema',
    };
  }
  if (parsed.result) {
    assertDashboardAnalysis(parsed.result);
    applyDirectionAssessment(parsed.result, directionAssessment);
    return {
      analysis: analysisResultToMarkdown(parsed.result),
      structured: parsed.result,
      analysisResult: parsed.result,
      parseMode: 'cleaned',
    };
  }
  const err = new Error('AI 返回的分析格式不完整，请重新分析');
  err.status = 502;
  throw err;
}

function assertDashboardAnalysis(result) {
  const d = result?.direction_analysis;
  const horizonKeys = ['ultra_short', 'short_term', 'medium_long'];
  const marketStateKeys = ['trend', 'volatility', 'structure', 'phase', 'observation'];
  const moduleKeys = ['technical', 'derivatives', 'flow', 'whales', 'news', 'cross'];
  const complete = Boolean(d?.summary?.trim()) &&
    horizonKeys.every((key) => Boolean(d?.horizons?.[key]?.analysis?.trim())) &&
    marketStateKeys.every((key) => Boolean(d?.market_state?.[key]?.trim())) &&
    moduleKeys.every((key) => Boolean(d?.module_analysis?.[key]?.summary?.trim()));
  if (!complete) {
    const err = new Error('AI 未返回完整的市场方向仪表盘分析，请重新分析');
    err.status = 502;
    throw err;
  }
}

function applyDirectionAssessment(result, assessment) {
  if (!assessment?.horizons) return result;
  const map = (direction) => direction === 'DATA_INSUFFICIENT' ? '数据不足' : direction;
  const conf = (n) => Number(n) >= 70 ? '高' : Number(n) >= 40 ? '中' : '低';
  const short = assessment.horizons.short_term;
  const mid = assessment.horizons.medium_long;
  const ultra = assessment.horizons.ultra_short;
  if (short) {
    result.short_term.direction = map(short.direction);
    result.short_term.bias = result.short_term.direction;
    result.short_term.confidence = conf(short.confidence);
    result.short_term.summary = `${result.short_term.summary}（程序方向评估：${result.short_term.direction}，覆盖率${Math.round((short.coverage || 0) * 100)}%，信心${short.confidence}%）`;
    result.short_term.reason = result.short_term.summary;
  }
  if (mid) {
    result.mid_long_term.direction = map(mid.direction);
    result.mid_long_term.bias = result.mid_long_term.direction;
    result.mid_long_term.summary = `${result.mid_long_term.summary || ''}（程序方向评估：${map(mid.direction)}，覆盖率${Math.round((mid.coverage || 0) * 100)}%，信心${mid.confidence}%）`;
    result.mid_long_term.reason = result.mid_long_term.summary;
  }
  const da = result.direction_analysis || {};
  const horizonCopy = { ...(da.horizons || {}) };
  for (const [key, row] of Object.entries({ ultra_short: ultra, short_term: short, medium_long: mid })) {
    if (!row) continue;
    horizonCopy[key] = {
      ...(horizonCopy[key] || {}),
      direction: map(row.direction),
      score: row.score,
      confidence: row.confidence,
      coverage: row.coverage,
    };
  }
  result.direction_analysis = { ...da, horizons: horizonCopy };
  result.direction_assessment = assessment;
  result.ultra_short_direction = ultra ? map(ultra.direction) : '数据不足';
  return result;
}

async function analyzeMarketBrief(
  apiKey,
  { coin, contextText, equityLike = false, capability, directionAssessment } = {},
) {
  const { messages } = buildMarketBriefMessages({
    coin,
    contextText,
    equityLike,
    capability,
    directionAssessment,
  });
  const baseBody = {
    model: DEFAULT_MODEL,
    messages,
    temperature: 0.35,
    max_tokens: MARKET_BRIEF_MAX_TOKENS,
  };

  let data;
  try {
    data = await deepseekFetch(apiKey, '/chat/completions', {
      method: 'POST',
      timeoutMs: 120_000,
      body: { ...baseBody, response_format: { type: 'json_object' } },
    });
  } catch (_) {
    data = await deepseekFetch(apiKey, '/chat/completions', {
      method: 'POST',
      timeoutMs: 120_000,
      body: baseBody,
    });
  }

  const raw = String(data?.choices?.[0]?.message?.content || '').trim();
  if (!raw) {
    const err = new Error('DeepSeek 未返回有效分析内容');
    err.status = 502;
    throw err;
  }

  if (data?.choices?.[0]?.finish_reason === 'length') {
    const err = new Error('AI 分析内容超出长度限制，请重新分析');
    err.status = 502;
    throw err;
  }
  return {
    ...finalizeAnalysis(raw, directionAssessment),
    model: data?.model || DEFAULT_MODEL,
    usage: data?.usage || null,
  };
}

/**
 * 流式诊币：同样输出 AnalysisResult JSON（与最终卡片同一套结果）
 */
async function streamAnalyzeMarketBrief(
  apiKey,
  { coin, contextText, equityLike = false, capability, directionAssessment } = {},
  { onDelta, signal } = {},
) {
  const key = String(apiKey || '').trim();
  if (!key) {
    const err = new Error('缺少 DeepSeek API Key');
    err.status = 400;
    throw err;
  }

  const { messages } = buildMarketBriefMessages({
    coin,
    contextText,
    equityLike,
    capability,
    directionAssessment,
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120_000);
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  let res;
  try {
    res = await deepseekHttpFetch(`${DEEPSEEK_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify({
        model: DEFAULT_MODEL,
        messages,
        temperature: 0.35,
        max_tokens: MARKET_BRIEF_MAX_TOKENS,
        stream: true,
        response_format: { type: 'json_object' },
      }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
    if (err.name === 'AbortError') {
      const e = new Error('DeepSeek 请求已取消或超时');
      e.status = 504;
      throw e;
    }
    // response_format 可能不被流式支持，回退无 format
    try {
      res = await deepseekHttpFetch(`${DEEPSEEK_BASE}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
        },
        body: JSON.stringify({
          model: DEFAULT_MODEL,
          messages,
          temperature: 0.35,
          max_tokens: MARKET_BRIEF_MAX_TOKENS,
          stream: true,
        }),
        signal: controller.signal,
      });
    } catch (err2) {
      if (err2.name === 'AbortError') {
        const e = new Error('DeepSeek 请求已取消或超时');
        e.status = 504;
        throw e;
      }
      throw err2;
    }
  }

  if (!res.ok) {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
    const text = await res.text().catch(() => '');
    let msg = text.slice(0, 200) || `HTTP ${res.status}`;
    try {
      const j = JSON.parse(text);
      msg = j?.error?.message || j?.message || msg;
    } catch (_) {
      /* ignore */
    }
    const err = new Error(msg);
    err.status = res.status >= 400 && res.status < 600 ? res.status : 502;
    throw err;
  }

  const reader = res.body?.getReader();
  if (!reader) {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
    const err = new Error('DeepSeek 未返回流式响应');
    err.status = 502;
    throw err;
  }

  const decoder = new TextDecoder();
  let buffer = '';
  let raw = '';
  let model = DEFAULT_MODEL;
  let finishReason = null;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n');
      buffer = parts.pop() || '';
      for (const line of parts) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(':')) continue;
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === '[DONE]') continue;
        let json;
        try {
          json = JSON.parse(payload);
        } catch {
          continue;
        }
        if (json?.model) model = json.model;
        if (json?.choices?.[0]?.finish_reason) finishReason = json.choices[0].finish_reason;
        const delta = json?.choices?.[0]?.delta?.content;
        if (typeof delta === 'string' && delta) {
          raw += delta;
          if (typeof onDelta === 'function') onDelta(delta);
        }
      }
    }
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
    try {
      reader.releaseLock();
    } catch (_) {
      /* ignore */
    }
  }

  const text = String(raw || '').trim();
  if (!text) {
    const err = new Error('DeepSeek 未返回有效分析内容');
    err.status = 502;
    throw err;
  }
  if (finishReason === 'length') {
    const err = new Error('AI 分析内容超出长度限制，请重新分析');
    err.status = 502;
    throw err;
  }

  return {
    ...finalizeAnalysis(text, directionAssessment),
    model,
    usage: null,
  };
}

function buildMarketChatMessages({ coin, contextText, analysis, messages = [], message } = {}) {
  const symbol = String(coin || 'BTC').toUpperCase();
  const question = String(message || '').trim();
  if (!question) {
    const err = new Error('请输入要探讨的问题');
    err.status = 400;
    throw err;
  }

  const history = Array.isArray(messages)
    ? messages
        .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && String(m.content || '').trim())
        .slice(-12)
        .map((m) => ({
          role: m.role,
          content: clip(m.content, 2000),
        }))
    : [];

  const radarNewsMode = String(contextText || '').includes('【雷达相关新闻依据】');
  const system = [
    '你是市场合约研究助手，正在讨论虚拟资产或传统金融标的的行情变化。',
    '规则：优先依据「简报」与「上下文」；区分观测事实与可能解释；没有新闻证据时不要断言具体事件是涨跌原因；信息不足时明确说明；用中文简洁回答；不构成投资建议，不给下单指令。',
    radarNewsMode ? '雷达分析专属要求：给出有信息量、分层清楚的事件归因，采用“先说结论—主要催化—其他背景—风险与不确定性—总结”的结构，可按证据多少合并章节，不要为凑结构编造内容。优先综合上下文里的相关新闻标题、摘要、媒体来源、发布时间，再说明这些事件如何可能影响该标的；每个新闻事实都必须用对应编号引用，如[新闻1]，编号严格对应上下文新闻顺序，并只引用实际提供的新闻。若新闻来源有冲突，指出冲突和日期；若仅有标题、缺少正文佐证，要明确其证据有限。可以用具体事件和数字，但必须能在新闻摘要/标题或行情数据中找到依据。严禁补造机构评级、目标价、估值、公司表态、发射任务细节或未提供的任何事实。没有可靠相关新闻时，直说暂时找不到充分的新闻解释。不要进行技术分析，不讨论K线形态、均线、指标、支撑阻力、成交量形态等术语。用自然、亲切、有判断但不武断的中文写成几段清楚的解释；区分已报道事实与“这可能是市场在交易的逻辑”，说明新闻和涨跌之间未必存在已证实因果。最后简短点明主要风险或仍待确认的消息，不给买卖指令。不要假装自己是人。' : '',
  ].join('');

  const bootstrap = [
    `标的：${symbol}`,
    '',
    '【行情分析】',
    clip(analysis, 6000) || '（暂无）',
    '',
    '【站内上下文摘要】',
    clip(contextText, 6000) || '（暂无）',
  ].join('\n');

  return {
    symbol,
    question,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: bootstrap },
      {
        role: 'assistant',
        content: '已读完行情资料与上下文。我会基于现有材料回答，并标明不确定之处。',
      },
      ...history,
      { role: 'user', content: clip(question, 1500) },
    ],
  };
}

/**
 * 诊币后追问：基于简报 + 上下文继续对话
 */
async function chatMarketBrief(
  apiKey,
  { coin, contextText, analysis, messages = [], message } = {},
) {
  const built = buildMarketChatMessages({ coin, contextText, analysis, messages, message });
  const data = await deepseekFetch(apiKey, '/chat/completions', {
    method: 'POST',
    timeoutMs: 90_000,
    body: {
      model: DEFAULT_MODEL,
      messages: built.messages,
      temperature: 0.4,
      max_tokens: 1200,
    },
  });

  const reply = String(data?.choices?.[0]?.message?.content || '').trim();
  if (!reply) {
    const err = new Error('DeepSeek 未返回有效回复');
    err.status = 502;
    throw err;
  }
  return {
    reply,
    model: data?.model || DEFAULT_MODEL,
    usage: data?.usage || null,
  };
}

/**
 * 诊币追问 SSE：流式输出纯文本回复
 */
async function streamChatMarketBrief(
  apiKey,
  { coin, contextText, analysis, messages = [], message } = {},
  { onDelta, signal } = {},
) {
  const key = String(apiKey || '').trim();
  if (!key) {
    const err = new Error('缺少 DeepSeek API Key');
    err.status = 400;
    throw err;
  }

  const built = buildMarketChatMessages({ coin, contextText, analysis, messages, message });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90_000);
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  let res;
  try {
    res = await deepseekHttpFetch(`${DEEPSEEK_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify({
        model: DEFAULT_MODEL,
        messages: built.messages,
        temperature: 0.4,
        max_tokens: 1200,
        stream: true,
      }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
    if (err.name === 'AbortError') {
      const e = new Error('DeepSeek 请求已取消或超时');
      e.status = 504;
      throw e;
    }
    throw err;
  }

  if (!res.ok) {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
    const text = await res.text().catch(() => '');
    let msg = text.slice(0, 200) || `HTTP ${res.status}`;
    try {
      const j = JSON.parse(text);
      msg = j?.error?.message || j?.message || msg;
    } catch (_) {
      /* ignore */
    }
    const err = new Error(msg);
    err.status = res.status >= 400 && res.status < 600 ? res.status : 502;
    throw err;
  }

  const reader = res.body?.getReader();
  if (!reader) {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
    const err = new Error('DeepSeek 未返回流式响应');
    err.status = 502;
    throw err;
  }

  const decoder = new TextDecoder();
  let buffer = '';
  let raw = '';
  let model = DEFAULT_MODEL;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n');
      buffer = parts.pop() || '';
      for (const line of parts) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(':')) continue;
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === '[DONE]') continue;
        let json;
        try {
          json = JSON.parse(payload);
        } catch {
          continue;
        }
        if (json?.model) model = json.model;
        const delta = json?.choices?.[0]?.delta?.content;
        if (typeof delta === 'string' && delta) {
          raw += delta;
          if (typeof onDelta === 'function') onDelta(delta);
        }
      }
    }
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
    try {
      reader.releaseLock();
    } catch (_) {
      /* ignore */
    }
  }

  const reply = String(raw || '').trim();
  if (!reply) {
    const err = new Error('DeepSeek 未返回有效回复');
    err.status = 502;
    throw err;
  }
  return {
    reply,
    model,
    usage: null,
  };
}

const HORIZON_LABELS = {
  ultra_short: '超短线(5分钟)',
  short: '短期',
  mid_long: '中长期',
};

/**
 * 仅刷新仓位建议某一档（不重跑整份诊币）
 */
async function analyzeStanceLeg(
  apiKey,
  { coin, horizon, contextText, equityLike = false, existingAnalysis = '' } = {},
) {
  const key = String(horizon || '').trim();
  if (!HORIZON_LABELS[key]) {
    const err = new Error('无效的仓位周期');
    err.status = 400;
    throw err;
  }
  const symbol = String(coin || 'BTC').toUpperCase();
  const label = HORIZON_LABELS[key];
  const system = equityLike
    ? '你是衍生品与公司研究助手。只输出指定周期的仓位建议 JSON。'
    : '你是加密衍生品研究助手。只输出指定周期的仓位建议 JSON。';
  const userPrompt = [
    `请仅更新 ${symbol} 的「${label}」仓位建议。`,
    '硬性要求：',
    '1) 只输出一个 JSON 对象，不要 Markdown：',
    '{ "action": "做多|做空", "entry": 数字, "leverage": 整数, "stop": 数字, "take_profit": 数字, "note": "..." }',
    '2) action 只能做多或做空，禁止观望；必须给出 entry、leverage、stop、take_profit。',
    '3) 结合新闻/宏观（预期·前值·实际）、巨鲸仓位与费率；考虑是否已提前计价（利空出尽/利好出尽）。',
    '4) 只用给定材料，勿编造未见数据。',
    '',
    '—— 现有简报（可参考） ——',
    clip(existingAnalysis, 2500) || '（无）',
    '',
    '—— 最新上下文 ——',
    clip(contextText, 5000) || '（无）',
  ].join('\n');

  const data = await deepseekFetch(apiKey, '/chat/completions', {
    method: 'POST',
    timeoutMs: 60_000,
    body: {
      model: DEFAULT_MODEL,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.35,
      max_tokens: 600,
    },
  });

  const raw = String(data?.choices?.[0]?.message?.content || '').trim();
  if (!raw) {
    const err = new Error('DeepSeek 未返回仓位建议');
    err.status = 502;
    throw err;
  }
  const { extractJsonObject, normalizeStanceLeg } = require('./analysisResult');
  const parsed = extractJsonObject(raw) || {};
  const leg = normalizeStanceLeg(parsed);
  if (!leg.action || leg.action === '观望') {
    const err = new Error('AI 未给出明确开仓方向，请重新分析');
    err.status = 502;
    throw err;
  }
  return {
    horizon: key,
    leg,
    model: data?.model || DEFAULT_MODEL,
    usage: data?.usage || null,
    raw,
  };
}

module.exports = {
  deepseekFetch,
  verifyDeepseekKey,
  analyzeWithDeepseek,
  streamAnalyzeWithDeepseek,
  analyzeMarketBrief,
  streamAnalyzeMarketBrief,
  analyzeStanceLeg,
  chatMarketBrief,
  streamChatMarketBrief,
  DEFAULT_MODEL,
};
