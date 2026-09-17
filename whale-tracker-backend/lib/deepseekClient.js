/**
 * DeepSeek OpenAI-compatible API 客户端
 */
const DEEPSEEK_BASE = 'https://api.deepseek.com';
const DEFAULT_MODEL = 'deepseek-chat';

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
    const res = await fetch(`${DEEPSEEK_BASE}${path}`, {
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

async function analyzeWithDeepseek(apiKey, { source, title, content, meta } = {}) {
  const src = source === 'macro' ? 'macro' : 'x';
  const label = src === 'macro' ? '宏观数据事件' : 'X（Twitter）动态';
  const metaText =
    meta && typeof meta === 'object'
      ? clip(JSON.stringify(meta, null, 0), 1500)
      : clip(meta, 1500);

  const userPrompt = [
    `请分析以下${label}对加密市场（尤其 BTC/ETH）的潜在影响。`,
    '输出要求：用中文；分点说明（要点、方向倾向、信心、关注点）；简洁专业，勿编造事实。',
    '',
    `标题：${clip(title, 300) || '（无）'}`,
    `内容：${clip(content, 4000) || '（无）'}`,
    metaText ? `附加信息：${metaText}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  const data = await deepseekFetch(apiKey, '/chat/completions', {
    method: 'POST',
    timeoutMs: 90_000,
    body: {
      model: DEFAULT_MODEL,
      messages: [
        {
          role: 'system',
          content:
            '你是加密市场宏观与舆情分析助手。只基于给定材料做推断，不确定时明确说明。',
        },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.4,
      max_tokens: 1200,
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

const {
  parseAnalysisResult,
  analysisResultToMarkdown,
  markdownFallbackToResult,
  normalizeAnalysisResult,
} = require('./analysisResult');

/**
 * 统一 AnalysisResult JSON Schema（流式与非流式同一套）
 */
function buildMarketBriefMessages({ coin, contextText, equityLike = false, capability } = {}) {
  const symbol = String(coin || 'BTC').toUpperCase();
  const assetHint = equityLike
    ? [
        '资产类别：加密永续合约映射的公司/权益类标的。',
        '基本面与新闻按公司/A股事件驱动理解（业绩、减持、解禁、问询函、回购等）。',
        '注意：合约本身仍是 24/7 永续，可讨论资金费率与爆仓；但不要把 A股 T+1、涨跌停当成该合约的撮合规则。',
      ].join('')
    : ['资产类别：加密永续。', '强调 24/7、资金费率、爆仓、主动买卖与交易所大户多空。'].join('');

  const capHint = capability
    ? `分析能力：shortTerm=${capability.shortTerm?.status}；newsDriven=${capability.newsDriven?.status}；whaleAnalysis=${capability.whaleAnalysis?.status}。unavailable 的能力请在对应字段说明数据不足，不要硬编。`
    : '';

  const userPrompt = [
    `请基于下列上下文给出 ${symbol} 交易研究简报。`,
    assetHint,
    capHint,
    '硬性要求：',
    '1) 只用给定材料；unavailable/empty 必须直说，禁止用其他维替代编造。',
    '2) 用中文，简洁专业。',
    '3) 只输出一个 JSON 对象（不要 Markdown 解释），字段：',
    '{',
    '  "short_term": { "direction": "偏多|震荡|偏空|观望", "confidence": "低|中|高", "summary": "..." },',
    '  "mid_long_term": { "direction": "...", "summary": "..." },',
    '  "technical": { "hourly": "...", "daily": "..." },',
    '  "derivatives": { "funding": "...", "liquidations": "...", "taker": "...", "details": "..." },',
    '  "whales": { "site": "...", "external": "...", "details": "..." },',
    '  "news_analysis": { "sentiment": "利好|中性|利空|混合", "details": "..." },',
    '  "market_sentiment": { "long_short_ratio": "...", "funding_rate": "...", "liquidations": "...", "details": "..." },',
    '  "key_evidence": ["..."],',
    '  "risks_and_invalidation": ["..."],',
    '  "disclaimer": "以上内容仅供研究参考，不构成投资建议。"',
    '}',
    '4) short_term.direction / confidence / summary 必填。',
    '',
    '—— 上下文开始 ——',
    String(contextText || ''),
    '—— 上下文结束 ——',
  ]
    .filter(Boolean)
    .join('\n');

  const system = equityLike
    ? '你是兼具衍生品与公司研究能力的投研助手。严格依据用户材料；区分短期与中长期；强调风险；不输出下单指令。'
    : '你是加密衍生品研究助手。严格依据用户材料；区分短期与中长期；强调费率、爆仓与流动性风险；不输出下单指令。';

  return {
    system,
    userPrompt,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: userPrompt },
    ],
  };
}

function finalizeAnalysis(rawText) {
  const parsed = parseAnalysisResult(rawText);
  if (parsed.ok && parsed.result) {
    return {
      analysis: analysisResultToMarkdown(parsed.result),
      structured: parsed.result,
      analysisResult: parsed.result,
      parseMode: 'schema',
    };
  }
  if (parsed.result) {
    return {
      analysis: analysisResultToMarkdown(parsed.result),
      structured: parsed.result,
      analysisResult: parsed.result,
      parseMode: 'cleaned',
    };
  }
  const fallback = markdownFallbackToResult(rawText);
  return {
    analysis: String(rawText || analysisResultToMarkdown(fallback)),
    structured: fallback,
    analysisResult: fallback,
    parseMode: 'markdown_fallback',
  };
}

async function analyzeMarketBrief(
  apiKey,
  { coin, contextText, equityLike = false, capability } = {},
) {
  const { messages } = buildMarketBriefMessages({
    coin,
    contextText,
    equityLike,
    capability,
  });
  const baseBody = {
    model: DEFAULT_MODEL,
    messages,
    temperature: 0.35,
    max_tokens: 2200,
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

  return {
    ...finalizeAnalysis(raw),
    model: data?.model || DEFAULT_MODEL,
    usage: data?.usage || null,
  };
}

/**
 * 流式诊币：同样输出 AnalysisResult JSON（与最终卡片同一套结果）
 */
async function streamAnalyzeMarketBrief(
  apiKey,
  { coin, contextText, equityLike = false, capability } = {},
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
    res = await fetch(`${DEEPSEEK_BASE}/chat/completions`, {
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
        max_tokens: 2200,
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
      res = await fetch(`${DEEPSEEK_BASE}/chat/completions`, {
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
          max_tokens: 2200,
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

  const text = String(raw || '').trim();
  if (!text) {
    const err = new Error('DeepSeek 未返回有效分析内容');
    err.status = 502;
    throw err;
  }

  return {
    ...finalizeAnalysis(text),
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

  const system = [
    '你是加密资产研究助手，正在与用户讨论一份基于站内数据的诊币简报。',
    '规则：优先依据「简报」与「上下文」；不足时明确说明；用中文简洁回答；不构成投资建议；不下单指令。',
  ].join('');

  const bootstrap = [
    `标的：${symbol}`,
    '',
    '【诊币简报】',
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
        content: '已读完简报与上下文。请提出你想探讨的问题，我会基于这些材料回答。',
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
    res = await fetch(`${DEEPSEEK_BASE}/chat/completions`, {
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

module.exports = {
  verifyDeepseekKey,
  analyzeWithDeepseek,
  analyzeMarketBrief,
  streamAnalyzeMarketBrief,
  chatMarketBrief,
  streamChatMarketBrief,
  DEFAULT_MODEL,
};
