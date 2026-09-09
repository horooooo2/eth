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

module.exports = {
  verifyDeepseekKey,
  analyzeWithDeepseek,
  DEFAULT_MODEL,
};
