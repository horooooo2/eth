/**
 * AnalysisResult schema 校验 / 清洗 / Markdown 降级
 */

const DIRECTIONS = new Set(['偏多', '震荡', '偏空', '观望', '承压', '中性']);
const CONF = new Set(['低', '中', '高']);
const ACTIONS = new Set(['做多', '做空', '观望']);

function asStr(v, max = 2000) {
  const s = String(v == null ? '' : v).trim();
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…`;
}

function asArr(v, maxItems = 12) {
  if (!Array.isArray(v)) return [];
  return v.map((x) => asStr(x, 240)).filter(Boolean).slice(0, maxItems);
}

function normalizeDirection(v) {
  const s = asStr(v, 20);
  if (DIRECTIONS.has(s)) return s;
  if (/偏多|看多|多头/.test(s)) return '偏多';
  if (/偏空|看空|空头|承压/.test(s)) return '偏空';
  if (/震荡|中性/.test(s)) return '震荡';
  if (/观望/.test(s)) return '观望';
  return s || '观望';
}

function normalizeConfidence(v) {
  const s = asStr(v, 8);
  if (CONF.has(s)) return s;
  if (/低/.test(s)) return '低';
  if (/高/.test(s)) return '高';
  return '中';
}

function normalizeAction(v) {
  const s = asStr(v, 12);
  if (ACTIONS.has(s)) return s;
  if (/做多|开多|偏多|看多|多/.test(s) && !/空/.test(s)) return '做多';
  if (/做空|开空|偏空|看空/.test(s)) return '做空';
  return '观望';
}

function normalizePrice(v) {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(/,/g, '').replace(/[^\d.eE+-]/g, ''));
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

function normalizeLeverage(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 1) return null;
  return 10;
}

function normalizeStanceLeg(raw) {
  const o = raw && typeof raw === 'object' ? raw : {};
  const validation = o.entry_validation && typeof o.entry_validation === 'object' ? o.entry_validation : {};
  return {
    action: normalizeAction(o.action || o.side || o.bias),
    execution: ['现在可开', '等待触发', '禁止下单'].includes(o.execution) ? o.execution : '禁止下单',
    trigger: asStr(o.trigger || o.entry_condition, 200),
    entry_validation: {
      technical: asStr(validation.technical, 240),
      sentiment: asStr(validation.sentiment, 240),
      news_macro: asStr(validation.news_macro, 240),
      positioning: asStr(validation.positioning, 240),
      decision: ['支持', '冲突', '数据不足'].includes(validation.decision) ? validation.decision : '数据不足',
    },
    entry: normalizePrice(o.entry ?? o.open ?? o.entry_price),
    leverage: normalizeLeverage(o.leverage ?? o.lev ?? o.x),
    stop: normalizePrice(o.stop ?? o.stop_loss ?? o.sl),
    take_profit: normalizePrice(o.take_profit ?? o.tp ?? o.target),
    note: asStr(o.note || o.rationale || o.reason || o.open_plan, 600),
  };
}

/** 保留模型的观望结论；不能在缺少证据时默认做多。 */
function coerceForcedStance(result) {
  if (!result?.personal_stance) return result;
  const dir = String(result.short_term?.direction || '');
  for (const key of ['ultra_short', 'short', 'mid_long']) {
    const leg = result.personal_stance[key];
    if (!leg) continue;
    if (leg.action === '观望') {
      leg.execution = '禁止下单';
      if (!leg.note) leg.note = `当前证据不足：${dir || '缺少明确方向'}。`;
    }
  }
  return result;
}

function extractJsonObject(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (_) {
    /* continue */
  }
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch (_) {
      /* continue */
    }
  }
  const cleaned = raw
    .replace(/^\uFEFF/, '')
    .replace(/,\s*([}\]])/g, '$1');
  try {
    return JSON.parse(cleaned);
  } catch (_) {
    /* continue */
  }
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(cleaned.slice(start, end + 1).replace(/,\s*([}\]])/g, '$1'));
    } catch (_) {
      return null;
    }
  }
  return null;
}

function normalizeBasis(raw) {
  const ALLOWED = [
    '市场情绪',
    '新闻内容',
    '宏观日历',
    '小时线走势',
    '5分钟走势',
    '日线走势',
    '巨鲸仓位',
    '资金费率',
    '爆仓数据',
    '主动买卖',
    'TVL',
  ];
  let items = [];
  if (Array.isArray(raw)) {
    items = raw.map((x) => asStr(x, 24));
  } else if (typeof raw === 'string' && raw.trim()) {
    items = raw
      .split(/[+＋、,，/|｜\n]+/)
      .map((x) => x.trim())
      .filter(Boolean);
  }
  const out = [];
  for (const s of items) {
    if (!s) continue;
    const hit = ALLOWED.find((a) => s === a || s.includes(a) || a.includes(s));
    const label = hit || s.replace(/分析依据|依据|策略/g, '').trim();
    if (label && label.length <= 12 && !out.includes(label)) out.push(label);
    if (out.length >= 6) break;
  }
  return out;
}

function emptyResult() {
  return {
    short_term: { direction: '观望', confidence: '低', summary: '数据不足，暂无法给出明确方向。' },
    mid_long_term: { direction: '观望', summary: '' },
    technical: { m5: '', hourly: '', daily: '' },
    derivatives: { funding: '', liquidations: '', taker: '', details: '' },
    whales: { site: '', external: '', details: '' },
    news_analysis: { sentiment: '中性', details: '' },
    market_sentiment: { long_short_ratio: '', funding_rate: '', liquidations: '', details: '' },
    event_reaction: '',
    key_evidence: [],
    risks_and_invalidation: [],
    direction_analysis: {
      summary: '',
      market_state: { trend: '', volatility: '', structure: '', phase: '', observation: '' },
      horizons: {
        ultra_short: { analysis: '', bull_points: [], bear_points: [], focus: '' },
        short_term: { analysis: '', bull_points: [], bear_points: [], focus: '' },
        medium_long: { analysis: '', bull_points: [], bear_points: [], focus: '' },
      },
      timeframes: {},
      module_analysis: {},
      bull_evidence: [],
      bear_evidence: [],
      data_limitations: [],
    },
    personal_stance: {
      headline: '仓位建议',
      basis: ['市场情绪', '新闻内容', '小时线走势'],
      ultra_short: { action: '观望', entry: null, leverage: null, stop: null, take_profit: null, note: '' },
      short: { action: '观望', entry: null, leverage: null, stop: null, take_profit: null, note: '' },
      mid_long: { action: '观望', entry: null, leverage: null, stop: null, take_profit: null, note: '' },
    },
    disclaimer: '以上内容仅供研究参考，不构成投资建议。',
  };
}

function normalizeDirectionAnalysis(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const state = source.market_state || {};
  const rawHorizons = source.horizons || {};
  const horizon = (key) => {
    const item = rawHorizons[key] || {};
    return {
      analysis: asStr(item.analysis || item.summary, 1200),
      bull_points: asArr(item.bull_points, 6),
      bear_points: asArr(item.bear_points, 6),
      focus: asStr(item.focus, 500),
      direction: '',
      score: null,
      confidence: null,
      coverage: null,
    };
  };
  const timeframes = {};
  for (const [key, item] of Object.entries(source.timeframes || {}).slice(0, 8)) {
    const value = item && typeof item === 'object' ? item : {};
    timeframes[key.slice(0, 12)] = {
      status: asStr(value.status, 40),
      state: asStr(value.state || value.bias, 40),
      analysis: asStr(value.analysis || value.summary, 800),
      metrics: asArr(value.metrics, 6),
    };
  }
  const moduleAnalysis = {};
  for (const key of ['technical', 'derivatives', 'flow', 'whales', 'news', 'cross']) {
    const item = source.module_analysis?.[key];
    if (!item || typeof item !== 'object') continue;
    moduleAnalysis[key] = {
      status: asStr(item.status, 40),
      summary: asStr(item.summary, 1000),
      facts: asArr(item.facts, 6),
      limitation: asStr(item.limitation, 400),
    };
  }
  return {
    summary: asStr(source.summary, 1600),
    market_state: {
      trend: asStr(state.trend, 240),
      volatility: asStr(state.volatility, 240),
      structure: asStr(state.structure, 400),
      phase: asStr(state.phase, 240),
      observation: asStr(state.observation, 800),
    },
    horizons: {
      ultra_short: horizon('ultra_short'),
      short_term: horizon('short_term'),
      medium_long: horizon('medium_long'),
    },
    timeframes,
    module_analysis: moduleAnalysis,
    bull_evidence: asArr(source.bull_evidence, 8),
    bear_evidence: asArr(source.bear_evidence, 8),
    data_limitations: asArr(source.data_limitations, 10),
  };
}

/**
 * 校验并规范化为 AnalysisResult；兼容旧字段 bias/reason
 */
function normalizeAnalysisResult(raw) {
  const base = emptyResult();
  if (!raw || typeof raw !== 'object') return { ok: false, result: base, errors: ['not_object'] };

  const errors = [];
  const st = raw.short_term || {};
  const direction = normalizeDirection(st.direction || st.bias);
  const confidence = normalizeConfidence(st.confidence);
  const summary = asStr(st.summary || st.reason, 1200);
  if (!summary) errors.push('short_term.summary_missing');

  const mid = raw.mid_long_term || {};
  const tech = raw.technical || {};
  const der = raw.derivatives || {};
  const wh = raw.whales || {};
  const news = raw.news_analysis || {};
  const sent = raw.market_sentiment || {};
  const stance = raw.personal_stance || raw.personalStance || {};

  const result = {
    short_term: { direction, confidence, summary: summary || '（无摘要）' },
    mid_long_term: {
      direction: normalizeDirection(mid.direction || mid.bias),
      summary: asStr(mid.summary || mid.reason, 1200),
    },
    technical: {
      m5: asStr(tech.m5 || tech.minute5 || tech.ultra_short, 800),
      hourly: asStr(tech.hourly, 800),
      daily: asStr(tech.daily, 800),
    },
    derivatives: {
      funding: asStr(der.funding || sent.funding_rate, 200),
      liquidations: asStr(der.liquidations || sent.liquidations, 240),
      taker: asStr(der.taker, 200),
      details: asStr(der.details, 800),
    },
    whales: {
      site: asStr(wh.site, 400),
      external: asStr(wh.external, 400),
      details: asStr(wh.details, 800),
    },
    news_analysis: {
      sentiment: asStr(news.sentiment, 20) || '中性',
      details: asStr(news.details, 1200),
    },
    market_sentiment: {
      long_short_ratio: asStr(sent.long_short_ratio, 200),
      funding_rate: asStr(sent.funding_rate || der.funding, 120),
      liquidations: asStr(sent.liquidations || der.liquidations, 200),
      details: asStr(sent.details, 800),
    },
    event_reaction: asStr(raw.event_reaction, 600),
    key_evidence: asArr(raw.key_evidence),
    risks_and_invalidation: asArr(raw.risks_and_invalidation),
    direction_analysis: normalizeDirectionAnalysis(raw.direction_analysis),
    personal_stance: {
      headline: asStr(stance.headline || stance.title, 40) || '仓位建议',
      basis: (() => {
        const fromAi = normalizeBasis(
          stance.basis || stance.strategy || stance.analysis_basis || stance.analysisBasis,
        );
        if (fromAi.length) return fromAi;
        // 按结果内容推断依据维度
        const inferred = [];
        if (asStr(sent.details || sent.long_short_ratio || sent.funding_rate, 20)) inferred.push('市场情绪');
        if (asStr(news.details || news.sentiment, 20)) inferred.push('新闻内容');
        if (asStr(tech.hourly, 20)) inferred.push('小时线走势');
        else if (asStr(tech.m5 || tech.minute5, 20)) inferred.push('5分钟走势');
        if (asStr(tech.daily, 20)) inferred.push('日线走势');
        if (asStr(wh.site || wh.external || wh.details, 20)) inferred.push('巨鲸仓位');
        if (asStr(der.funding || sent.funding_rate, 20)) inferred.push('资金费率');
        if (asStr(der.liquidations || sent.liquidations, 20)) inferred.push('爆仓数据');
        return inferred.length ? inferred.slice(0, 6) : ['市场情绪', '新闻内容', '小时线走势'];
      })(),
      ultra_short: normalizeStanceLeg(
        stance.ultra_short || stance.m5 || stance.scalp || stance.ultraShort,
      ),
      short: normalizeStanceLeg(stance.short || stance.short_term || stance.shortTerm),
      mid_long: normalizeStanceLeg(stance.mid_long || stance.mid_long_term || stance.midLong),
    },
    disclaimer: asStr(raw.disclaimer, 200) || base.disclaimer,
  };

  result.short_term.bias = result.short_term.direction;
  result.short_term.reason = result.short_term.summary;
  result.mid_long_term.bias = result.mid_long_term.direction;
  result.mid_long_term.reason = result.mid_long_term.summary;

  coerceForcedStance(result);

  const ok = errors.length === 0 || (summary && direction);
  return { ok, result, errors };
}

function parseAnalysisResult(text) {
  const json = extractJsonObject(text);
  if (!json) return { ok: false, result: null, errors: ['json_parse_failed'], raw: text };
  return { ...normalizeAnalysisResult(json), raw: text };
}

function fmtStanceLeg(label, leg) {
  if (!leg) return '';
  const parts = [`${label}：我会${leg.action || '观望'}`];
  if (leg.entry != null) parts.push(`开仓 ${leg.entry}`);
  if (leg.leverage != null) parts.push(`${leg.leverage}x`);
  if (leg.stop != null) parts.push(`止损 ${leg.stop}`);
  if (leg.take_profit != null) parts.push(`止盈 ${leg.take_profit}`);
  if (leg.note) parts.push(leg.note);
  return parts.join('｜');
}

function analysisResultToMarkdown(result) {
  const r = result || emptyResult();
  const da = r.direction_analysis || {};
  const horizons = da.horizons || {};
  const modules = da.module_analysis || {};
  const lines = [
    '# 市场方向研判',
    da.summary || r.short_term?.summary || '',
    '',
    '## 多周期解读',
    ...[
      ['超短线', horizons.ultra_short],
      ['短线', horizons.short_term],
      ['中长期', horizons.medium_long],
    ].flatMap(([label, item]) => item ? [
      `### ${label}｜${item.direction || '程序评估中'}｜评分 ${item.score ?? '—'}｜信心 ${item.confidence ?? '—'}%｜覆盖 ${item.coverage == null ? '—' : `${Math.round(item.coverage * 100)}%`}`,
      item.analysis || '',
      ...(item.bull_points || []).map((x) => `- 支持：${x}`),
      ...(item.bear_points || []).map((x) => `- 反向：${x}`),
      item.focus ? `观察重点：${item.focus}` : '',
      '',
    ] : []),
    '## 市场状态',
    ...Object.entries(da.market_state || {}).map(([key, value]) => `${key}：${value || '暂无'}`),
    '',
    '## 周期信号',
    ...Object.entries(da.timeframes || {}).flatMap(([key, item]) => [`### ${key}｜${item.state || item.status || '数据不足'}`, item.analysis || '', ...(item.metrics || []).map((x) => `- ${x}`)]),
    '',
    '## 多空证据',
    ...(da.bull_evidence || []).map((x) => `- 偏多：${x}`),
    ...(da.bear_evidence || []).map((x) => `- 偏空：${x}`),
    '',
    '## 分析模块',
    ...Object.entries(modules).flatMap(([key, item]) => [`### ${key}｜${item.status || '数据不足'}`, item.summary || '', ...(item.facts || []).map((x) => `- ${x}`), item.limitation ? `限制：${item.limitation}` : '']),
    '',
    '## 数据限制与风险',
    ...(da.data_limitations || []).map((x) => `- ${x}`),
    ...(r.risks_and_invalidation || []).map((x) => `- ${x}`),
    '',
    r.disclaimer,
  ];
  return lines.filter((line) => line != null).join('\n');
}
function markdownFallbackToResult(text) {
  const raw = String(text || '');
  const dir = (raw.match(/方向倾向[：:]\s*([^\s｜|]+)/) || [])[1];
  const conf = (raw.match(/信心[：:]\s*(低|中|高)/) || [])[1];
  const base = emptyResult();
  base.short_term.direction = normalizeDirection(dir);
  base.short_term.confidence = normalizeConfidence(conf);
  base.short_term.summary = asStr(raw.slice(0, 800), 800);
  base.short_term.bias = base.short_term.direction;
  base.short_term.reason = base.short_term.summary;
  return base;
}

module.exports = {
  emptyResult,
  extractJsonObject,
  normalizeAnalysisResult,
  normalizeStanceLeg,
  parseAnalysisResult,
  analysisResultToMarkdown,
  markdownFallbackToResult,
};
