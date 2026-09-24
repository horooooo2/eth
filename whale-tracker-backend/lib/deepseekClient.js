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
  markdownFallbackToResult,
  normalizeAnalysisResult,
} = require('./analysisResult');

/**
 * 统一 AnalysisResult JSON Schema（流式与非流式同一套）
 */
function buildMarketBriefMessages({
  coin,
  contextText,
  equityLike = false,
  capability,
  forceTradeDecision = false,
} = {}) {
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

  const tradeModeHint = [
    '【强制开单模式 · 永久生效】',
    '- personal_stance 三档 action 只能是「做多」或「做空」，禁止「观望」。',
    '- 每档必须给出 entry（建议开仓价）、leverage（整数如 5/10/20）、stop、take_profit。',
    '- note 用开单口吻，并写明依据（宏观定价、仓位/费率、K线位置）。',
    '',
    '【智能定价与市场心理 · 必须结合】',
    '1) 综合最新新闻、宏观日历（预期/前值/实际）、站内巨鲸仓位、资金费率、爆仓与主动买卖再定方向。',
    '2) 事件交易要区分「尚未公布」与「已公布」：',
    '   - 未公布：用预期 vs 前值 + 盘面是否已提前计价；假设现在距公布还有一段时间，评估波动窗口。',
    '   - 已公布：用实际 vs 预期判断超预期/不及预期，但不要机械跟字面利多利空。',
    '3) 常见反身性：若市场普遍预期利空并已大跌，数据兑现后可能「利空出尽」反弹；若普遍预期利好并已大涨，兑现后可能高开低走。开仓方向要写清是「顺预期冲击」还是「逆向博弈已计价」。',
    '4) 超短线更看公布前后波动与盘口；中长期更看趋势与政策路径，但仍禁止观望。',
  ].join('\n');

  const userPrompt = [
    `请基于下列上下文给出 ${symbol} 交易研究简报。`,
    assetHint,
    capHint,
    tradeModeHint,
    '硬性要求：',
    '1) 只用给定材料；unavailable/empty 必须直说，禁止用其他维替代编造。',
    '2) 用中文，简洁专业。关键结论请用 **双星号** 包裹，便于前端高亮。',
    '3) 只输出一个 JSON 对象（不要 Markdown 解释），字段：',
    '{',
    '  "short_term": { "direction": "偏多|震荡|偏空|观望", "confidence": "低|中|高", "summary": "..." },',
    '  "mid_long_term": { "direction": "...", "summary": "..." },',
    '  "technical": { "m5": "...", "hourly": "...", "daily": "..." },',
    '  "derivatives": { "funding": "...", "liquidations": "...", "taker": "...", "details": "..." },',
    '  "whales": { "site": "...", "external": "...", "details": "..." },',
    '  "news_analysis": { "sentiment": "利好|中性|利空|混合", "details": "..." },',
    '  "market_sentiment": { "long_short_ratio": "...", "funding_rate": "...", "liquidations": "...", "details": "..." },',
    '  "personal_stance": {',
    '    "headline": "仓位建议",',
    '    "basis": ["市场情绪", "新闻内容", "小时线走势"],',
    '    "ultra_short": { "action": "做多|做空", "entry": 数字, "leverage": 数字, "stop": 数字, "take_profit": 数字, "note": "..." },',
    '    "short": { "action": "做多|做空", "entry": 数字, "leverage": 数字, "stop": 数字, "take_profit": 数字, "note": "..." },',
    '    "mid_long": { "action": "做多|做空", "entry": 数字, "leverage": 数字, "stop": 数字, "take_profit": 数字, "note": "..." }',
    '  },',
    '  "key_evidence": ["..."],',
    '  "risks_and_invalidation": ["..."],',
    '  "disclaimer": "以上内容仅供研究参考，不构成投资建议。"',
    '}',
    '4) short_term.direction / confidence / summary 必填。',
    '5) 强制开单：三档必须做多或做空，并给出 entry/leverage/stop/take_profit；禁止观望与 null 价位。',
    '6) personal_stance.basis 必填：3~6 个短标签，表示本次开单依据维度（如「市场情绪」「新闻内容」「小时线走势」「宏观日历」「巨鲸仓位」「资金费率」），不要写长句或免责声明。',
    '7) technical.m5 / hourly / daily 分别写对应周期，不要混写；disclaimer 不可省略。',
    '',
    '—— 上下文开始 ——',
    String(contextText || ''),
    '—— 上下文结束 ——',
  ]
    .filter(Boolean)
    .join('\n');

  const system = equityLike
    ? '你是兼具衍生品与公司研究能力的投研助手。严格依据用户材料；区分5分钟超短线、短期与中长期；给出带止损止盈的仓位建议；强调风险；不输出真实下单指令。'
    : '你是加密衍生品研究助手。严格依据用户材料；区分5分钟超短线、短期与中长期；给出带止损止盈的仓位建议；强调费率、爆仓与流动性风险；不输出真实下单指令。';

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
  { coin, contextText, equityLike = false, capability, forceTradeDecision = false } = {},
) {
  const { messages } = buildMarketBriefMessages({
    coin,
    contextText,
    equityLike,
    capability,
    forceTradeDecision,
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
  { coin, contextText, equityLike = false, capability, forceTradeDecision = false } = {},
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
    forceTradeDecision,
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
    leg.action = '做多';
    if (!leg.note) leg.note = '强制开单：模型未给出方向时默认做多，请结合盘面自检。';
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
