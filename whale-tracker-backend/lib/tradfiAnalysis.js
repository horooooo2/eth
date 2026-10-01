const crypto = require('node:crypto');
const { getCatalog, getTradFiMarketContext } = require('./tradfiMarkets');
const { getIntel } = require('./tradfiIntel');
const { buildDirectionResult, ENGINE_VERSION } = require('./tradfiDirection');

const PROMPT_VERSION = 'tradfi-direction-v2.2';

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}
function stableJson(value) { return JSON.stringify(stableValue(value)); }
function nullableNumber(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
function makeContextHash({ symbol, marketContext, intel, directionResult }) {
  const klines = Object.fromEntries(Object.entries(marketContext.klines || {}).map(([interval, data]) => [interval, {
    available: data.available, stale: data.stale, latestBarTime: data.latestBarTime,
  }]));
  const quote = marketContext.quote ? {
    lastPrice: nullableNumber(marketContext.quote.lastPrice),
    priceChangePercent: nullableNumber(marketContext.quote.priceChangePercent),
  } : null;
  const signature = {
    symbol, quote, klines,
    fundamentalsUpdatedAt: intel.fundamentals?.updatedAt || null,
    fundamentalsRows: intel.fundamentals?.rows || [],
    eventsUpdatedAt: intel.events?.updatedAt || null,
    events: intel.events?.items || [],
    newsUpdatedAt: intel.news?.updatedAt || null,
    news: intel.news?.items || [],
    engineVersion: ENGINE_VERSION,
    promptVersion: PROMPT_VERSION,
    direction: directionResult,
  };
  return crypto.createHash('sha256').update(stableJson(signature)).digest('hex');
}

async function buildTradFiSnapshot(symbol) {
  const catalog = await getCatalog();
  if (!catalog.symbols.some((item) => item.symbol === String(symbol).toUpperCase())) {
    const error = new Error('该交易对不是当前可用的 TradFi 合约');
    error.status = 404;
    throw error;
  }
  const [marketContext, intel] = await Promise.all([
    getTradFiMarketContext(symbol),
    getIntel(symbol),
  ]);
  const directionResult = buildDirectionResult({ marketContext, fundamentals: intel.fundamentals, events: intel.events, news: intel.news });
  const contextHash = makeContextHash({ symbol, marketContext, intel, directionResult });
  return { symbol, marketContext, intel, directionResult, contextHash, promptVersion: PROMPT_VERSION, engineVersion: ENGINE_VERSION };
}

function buildExplanationPrompt(snapshot) {
  return [
    `Prompt 版本：${PROMPT_VERSION}`,
    '你只负责解释后端确定性方向引擎，不得自行判断或修改任何方向、分数、置信度和数据状态。',
    '后端 directionResult 是唯一方向来源。directionAllowed=true 时，即使基本面、新闻、宏观事件、SEC、ETF、Funding 或 OI 缺失，也必须围绕引擎给出的方向解释，不能改成方向不明。',
    '未来经济事件尚未公布只是事件风险，不是当前方向不可判断的理由。公司财报缺失主要限制中长期基本面确认，不能否定短周期价格方向。只有 directionAllowed=false 的周期才可以描述为数据不足。',
    '只能从输入的 bullEvidenceCandidates、bearEvidenceCandidates、neutralFacts、missingAuxData、missingCoreData 和 invalidationCandidates 中挑选、合并或引用；不得发明价格、财务数据、新闻、事件或证据。中性事实不得改写成多头或空头证据。',
    '请只返回合法 JSON，不要 Markdown，结构：{"summary":"...","bullEvidence":[],"bearEvidence":[],"neutralFacts":[],"dataLimitations":[],"attention":[]}。数组最多各 4 条，句子简洁。',
    '如果所有周期均 INSUFFICIENT，摘要只说明缺少的核心价格结构，不罗列辅助资料缺失。不得提供买卖、入场、止盈止损、杠杆、仓位或执行建议。',
    `市场方向结果：${stableJson(snapshot.directionResult)}`,
    `市场数据摘要：${stableJson({ symbol: snapshot.symbol, quote: snapshot.marketContext.quote, fundamentals: snapshot.intel.fundamentals, events: snapshot.intel.events, news: snapshot.intel.news })}`,
  ].join('\n');
}

function parseExplanation(rawInput) {
  const raw = String(rawInput || '').trim();
  const jsonText = raw.match(/\{[\s\S]*\}/)?.[0];
  let parsed;
  try { parsed = jsonText ? JSON.parse(jsonText) : null; } catch { parsed = null; }
  if (!parsed || typeof parsed !== 'object' || typeof parsed.summary !== 'string' || !parsed.summary.trim()) return null;
  const list = (key) => Array.isArray(parsed[key]) ? parsed[key].filter((item) => typeof item === 'string' && item.trim()).slice(0, 4) : [];
  return {
    summary: parsed.summary.trim().slice(0, 1200),
    bullEvidence: list('bullEvidence'),
    bearEvidence: list('bearEvidence'),
    neutralFacts: list('neutralFacts'),
    dataLimitations: list('dataLimitations'),
    attention: list('attention'),
  };
}

function defaultExplanation(directionResult) {
  const frames = Object.values(directionResult.timeframes || {});
  const missing = [...new Set(frames.flatMap((item) => item.missingCoreData || []))];
  return {
    summary: missing.length ? `当前缺少建立价格结构所需的数据：${missing.join('；')}。` : '当前市场数据可用于价格方向分析。',
    bullEvidence: [], bearEvidence: [],
    neutralFacts: [...new Set(frames.flatMap((item) => item.neutralFacts || []))].slice(0, 4),
    dataLimitations: missing.slice(0, 4), attention: ['等待核心 K 线数据恢复后再次分析。'],
  };
}

module.exports = { PROMPT_VERSION, stableJson, makeContextHash, buildTradFiSnapshot, buildExplanationPrompt, parseExplanation, defaultExplanation };
