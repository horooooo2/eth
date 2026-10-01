const ENGINE_VERSION = '2.2-provisional';

const PERIODS = {
  ultraShort: { label: '超短线', main: '5m', confirms: ['15m', '1h'], minBars: 50, targetBars: 120 },
  shortTerm: { label: '短线', main: '1h', confirms: ['15m', '4h'], minBars: 50, targetBars: 120 },
  mediumLong: { label: '中长期', main: '1d', confirms: ['4h'], minBars: 60, targetBars: 120 },
};

const clamp = (value, min = -1, max = 1) => Math.max(min, Math.min(max, value));
const average = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
function validBar(bar) {
  return bar && [bar.openTime, bar.open, bar.high, bar.low, bar.close, bar.volume, bar.closeTime].every(Number.isFinite)
    && bar.open > 0 && bar.high > 0 && bar.low > 0 && bar.close > 0 && bar.volume >= 0;
}
function sma(values, size) { return values.length >= size ? average(values.slice(-size)) : null; }
function ema(values, size) {
  if (values.length < size) return null;
  const alpha = 2 / (size + 1);
  let value = average(values.slice(0, size));
  for (const item of values.slice(size)) value = item * alpha + value * (1 - alpha);
  return value;
}
function rsi14(closes) {
  if (closes.length < 15) return null;
  let gains = 0; let losses = 0;
  for (let i = closes.length - 14; i < closes.length; i += 1) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) gains += change; else losses -= change;
  }
  const avgGain = gains / 14; const avgLoss = losses / 14;
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}
function macdHistogram(closes) {
  if (closes.length < 35) return null;
  const fast = []; const slow = [];
  const calcEmaSeries = (values, size) => {
    const alpha = 2 / (size + 1); let current = average(values.slice(0, size));
    const series = Array(size - 1).fill(null); series.push(current);
    for (const value of values.slice(size)) { current = value * alpha + current * (1 - alpha); series.push(current); }
    return series;
  };
  const e12 = calcEmaSeries(closes, 12); const e26 = calcEmaSeries(closes, 26);
  const line = closes.map((_x, i) => e12[i] == null || e26[i] == null ? null : e12[i] - e26[i]);
  const valid = line.filter(Number.isFinite);
  if (valid.length < 10) return null;
  const signalSeries = calcEmaSeries(valid, 9);
  return valid[valid.length - 1] - signalSeries[signalSeries.length - 1];
}
function pivots(bars, field, kind) {
  const result = [];
  for (let i = Math.max(1, bars.length - 80); i < bars.length - 1; i += 1) {
    const value = bars[i][field];
    const isPivot = kind === 'high'
      ? value >= bars[i - 1][field] && value > bars[i + 1][field]
      : value <= bars[i - 1][field] && value < bars[i + 1][field];
    if (isPivot) result.push({ index: i, value });
  }
  return result;
}

function marketStructure(bars) {
  const recent = bars.slice(-20);
  const close = bars[bars.length - 1].close;
  const highs = pivots(bars, 'high', 'high').slice(-2);
  const lows = pivots(bars, 'low', 'low').slice(-2);
  let score = 0;
  const highTrend = highs.length === 2 ? (highs[1].value - highs[0].value) / highs[0].value : null;
  const lowTrend = lows.length === 2 ? (lows[1].value - lows[0].value) / lows[0].value : null;
  if (highTrend != null) score += clamp(highTrend / 0.025) * 0.35;
  if (lowTrend != null) score += clamp(lowTrend / 0.025) * 0.35;
  const rangeHigh = Math.max(...recent.slice(0, -1).map((bar) => bar.high));
  const rangeLow = Math.min(...recent.slice(0, -1).map((bar) => bar.low));
  if (close > rangeHigh) score += 0.3;
  else if (close < rangeLow) score -= 0.3;
  else if (rangeHigh > rangeLow) {
    const position = (close - rangeLow) / (rangeHigh - rangeLow);
    score += position > 0.7 ? 0.12 : position < 0.3 ? -0.12 : 0;
  }
  const facts = [];
  if (highTrend != null && lowTrend != null) {
    if (highTrend > 0.002 && lowTrend > 0.002) facts.push('最近摆动高点与低点同步抬高。');
    else if (highTrend < -0.002 && lowTrend < -0.002) facts.push('最近摆动高点与低点同步下移。');
    else facts.push('近期摆动高低点方向不一致。');
  }
  if (close > rangeHigh) facts.push('最新收盘价突破此前 19 根 K 线区间上沿。');
  if (close < rangeLow) facts.push('最新收盘价跌破此前 19 根 K 线区间下沿。');
  return { score: clamp(score), facts, rangeHigh, rangeLow };
}

function trendSignal(bars) {
  const closes = bars.map((bar) => bar.close);
  const ma7 = sma(closes, 7); const ma25 = sma(closes, 25);
  const previousMa25 = closes.length >= 30 ? average(closes.slice(-30, -5)) : null;
  if (ma7 == null || ma25 == null || previousMa25 == null) return { score: 0, facts: [], ma7, ma25 };
  const slope = (ma25 - previousMa25) / previousMa25;
  let score = 0;
  if (closes.at(-1) > ma7 && ma7 > ma25 && slope > 0) score = 0.9;
  else if (closes.at(-1) < ma7 && ma7 < ma25 && slope < 0) score = -0.9;
  else {
    const maGap = (ma7 - ma25) / ma25;
    score = clamp(maGap / 0.02) * 0.35 + clamp(slope / 0.015) * 0.45;
  }
  return { score: clamp(score), facts: [score > 0.2 ? '价格与短期均线排列偏强。' : score < -0.2 ? '价格与短期均线排列偏弱。' : '短期均线方向混合或较平缓。'], ma7, ma25, slope };
}

function momentumSignal(bars) {
  const closes = bars.map((bar) => bar.close);
  const rsi = rsi14(closes); const histogram = macdHistogram(closes);
  if (rsi == null) return { score: 0, facts: [], rsi, histogram };
  const rsiScore = clamp((rsi - 50) / 25);
  const macdScore = histogram == null ? 0 : clamp(histogram / (closes.at(-1) * 0.004));
  const score = clamp(rsiScore * (histogram == null ? 1 : 0.65) + macdScore * (histogram == null ? 0 : 0.35));
  return { score, facts: [score > 0.2 ? `动量指标偏强（RSI14 ${rsi.toFixed(1)}）。` : score < -0.2 ? `动量指标偏弱（RSI14 ${rsi.toFixed(1)}）。` : `RSI14 为 ${rsi.toFixed(1)}，动量方向不突出。`], rsi, histogram };
}

function volumeSignal(bars, directionProxy) {
  if (bars.length < 21) return { score: 0, facts: [], ratio: null };
  const base = average(bars.slice(-21, -1).map((bar) => bar.volume));
  const ratio = base > 0 ? bars.at(-1).volume / base : null;
  if (ratio == null) return { score: 0, facts: [], ratio: null };
  if (ratio < 0.8) return { score: directionProxy * 0.15, facts: [`成交量低于近期均值（量比 ${ratio.toFixed(2)}），价格方向确认减弱。`], ratio };
  if (ratio >= 1.2 && Math.abs(directionProxy) > 0.12) return { score: Math.sign(directionProxy) * clamp((ratio - 1) / 1.5, 0, 0.6), facts: [`成交量高于近期均值（量比 ${ratio.toFixed(2)}），确认当前价格方向。`], ratio };
  return { score: 0, facts: [`成交量量比 ${ratio.toFixed(2)}，未构成明确的方向确认。`], ratio };
}

function classify(score) {
  if (score >= 0.55) return 'STRONG_BULLISH';
  if (score >= 0.2) return 'BULLISH';
  if (score > -0.2) return 'NEUTRAL';
  if (score > -0.55) return 'BEARISH';
  return 'STRONG_BEARISH';
}
function confidenceLevel(score) { return score >= 0.75 ? 'HIGH' : score >= 0.55 ? 'MEDIUM' : 'LOW'; }
function auxAvailability({ fundamentals, events, news }, timeframe) {
  const relevant = timeframe === 'mediumLong'
    ? [Boolean(fundamentals?.status === 'ok' && fundamentals?.rows?.length), Boolean(events?.source), Boolean(news?.source)]
    : [Boolean(events?.source), Boolean(news?.source)];
  const available = relevant.filter(Boolean).length;
  return { coverage: available / relevant.length, missing: relevant.map((ok, index) => !ok ? (timeframe === 'mediumLong' ? ['公司/行业基本面', '经济日历', '相关新闻'][index] : ['经济日历', '相关新闻'][index]) : null).filter(Boolean) };
}

function analyzeTimeframe(timeframe, config, input) {
  const main = input.marketContext?.klines?.[config.main];
  const bars = Array.isArray(main?.bars) ? main.bars.filter(validBar) : [];
  const missingCoreData = [];
  if (!main?.available) missingCoreData.push(`${config.main} K 线不可用`);
  else if (bars.length < config.minBars) missingCoreData.push(`${config.main} 有效 K 线不足 ${config.minBars} 根（当前 ${bars.length} 根）`);
  if (bars.length < config.minBars) {
    return {
      status: 'INSUFFICIENT', directionAllowed: false, direction: null, score: null,
      confidenceScore: null, confidenceLevel: null, coreCoverage: bars.length / config.minBars,
      auxCoverage: 0, technical: null, bullEvidenceCandidates: [], bearEvidenceCandidates: [], neutralFacts: [],
      missingCoreData, missingAuxData: [], invalidationCandidates: [], mainInterval: config.main,
    };
  }

  const structure = marketStructure(bars);
  const trend = trendSignal(bars);
  const momentum = momentumSignal(bars);
  const directionProxy = structure.score * 0.5 + trend.score * 0.3 + momentum.score * 0.2;
  const volume = volumeSignal(bars, directionProxy);
  const scores = { structure: structure.score, trend: trend.score, momentum: momentum.score, volume: volume.score };
  let score = clamp(scores.structure * 0.45 + scores.trend * 0.25 + scores.momentum * 0.15 + scores.volume * 0.15);
  const confirms = config.confirms.map((interval) => {
    const data = input.marketContext?.klines?.[interval];
    const valid = Array.isArray(data?.bars) ? data.bars.filter(validBar) : [];
    if (!data?.available || valid.length < 25) return null;
    return marketStructure(valid).score * 0.5 + trendSignal(valid).score * 0.3 + momentumSignal(valid).score * 0.2;
  }).filter(Number.isFinite);
  if (confirms.length) score = clamp(score * 0.8 + average(confirms) * 0.2);

  const aux = auxAvailability(input, timeframe);
  const stale = Boolean(main?.stale);
  const status = aux.coverage >= 0.75 ? 'FULL' : aux.coverage > 0 ? 'PARTIAL' : 'PRICE_ONLY';
  const coreCoverage = Math.min(1, bars.length / config.targetBars);
  const subScores = Object.values(scores);
  const mean = average(subScores);
  const agreement = clamp(1 - average(subScores.map((value) => Math.abs(value - mean))) / 1.5, 0, 1);
  const dataQuality = stale ? 0.55 : Math.min(1, 0.65 + coreCoverage * 0.35);
  const coverage = coreCoverage * 0.75 + aux.coverage * 0.25;
  const stability = 0.55;
  let confidenceScore = 0.35 * agreement + 0.3 * dataQuality + 0.2 * coverage + 0.15 * stability;
  if (status === 'PARTIAL' || status === 'PRICE_ONLY') confidenceScore = Math.min(confidenceScore, 0.74);
  if (stale) confidenceScore = Math.min(confidenceScore, 0.54);
  const direction = classify(score);
  const components = [
    { score: structure.score, facts: structure.facts },
    { score: trend.score, facts: trend.facts },
    { score: momentum.score, facts: momentum.facts },
    { score: volume.score, facts: volume.facts },
  ];
  const bullEvidenceCandidates = score > -0.2 ? components.filter((item) => item.score > 0.12).flatMap((item) => item.facts) : [];
  const bearEvidenceCandidates = score < 0.2 ? components.filter((item) => item.score < -0.12).flatMap((item) => item.facts) : [];
  const neutralFacts = [];
  const changeRaw = input.marketContext?.quote?.priceChangePercent;
  const change24h = changeRaw == null || changeRaw === '' ? null : Number(changeRaw);
  if (change24h != null && Number.isFinite(change24h) && Math.abs(change24h) < 0.05) neutralFacts.push(`24h 涨跌 ${change24h.toFixed(3)}%，接近平盘，不作为方向支持。`);
  if (volume.ratio != null && volume.ratio < 0.8) neutralFacts.push('当前成交量偏低，方向确认能力有限。');
  const missingAuxData = [...aux.missing];
  if (stale) missingAuxData.push(`${config.main} K 线使用缓存数据`);
  if (!input.marketContext?.quote || input.marketContext.quote.lastPrice == null) missingAuxData.push('当前行情报价不可用');
  return {
    status, directionAllowed: true, direction, score, confidenceScore,
    confidenceLevel: confidenceLevel(confidenceScore), coreCoverage, auxCoverage: aux.coverage,
    technical: { ...scores, ma7: trend.ma7, ma25: trend.ma25, rsi14: momentum.rsi, macdHistogram: momentum.histogram, volumeRatio: volume.ratio },
    bullEvidenceCandidates, bearEvidenceCandidates, neutralFacts,
    missingCoreData, missingAuxData,
    invalidationCandidates: [
      Number.isFinite(structure.rangeHigh) ? `价格结构观察上沿 ${structure.rangeHigh}` : null,
      Number.isFinite(structure.rangeLow) ? `价格结构观察下沿 ${structure.rangeLow}` : null,
    ].filter(Boolean), mainInterval: config.main,
  };
}

function eventRisk(events = {}) {
  const now = Date.now();
  let nearest = Infinity;
  for (const event of events.items || []) {
    const time = Date.parse(`${event.date || ''}T${event.time || '23:59:59'}Z`);
    if (Number.isFinite(time) && time >= now) nearest = Math.min(nearest, time - now);
  }
  if (nearest <= 24 * 60 * 60 * 1000) return 'HIGH';
  if (nearest <= 72 * 60 * 60 * 1000) return 'MEDIUM';
  return 'LOW';
}

function buildDirectionResult(input = {}) {
  const timeframes = Object.fromEntries(Object.entries(PERIODS).map(([key, config]) => [key, analyzeTimeframe(key, config, input)]));
  const selected = timeframes.shortTerm.directionAllowed ? timeframes.shortTerm
    : timeframes.ultraShort.directionAllowed ? timeframes.ultraShort
      : timeframes.mediumLong.directionAllowed ? timeframes.mediumLong : null;
  return {
    version: ENGINE_VERSION,
    overall: selected ? { direction: selected.direction, score: selected.score, confidenceScore: selected.confidenceScore, confidenceLevel: selected.confidenceLevel, sourceTimeframe: selected.mainInterval } : { direction: null, score: null, confidenceScore: null, confidenceLevel: null, sourceTimeframe: null },
    eventRisk: eventRisk(input.events),
    timeframes,
  };
}

module.exports = { ENGINE_VERSION, PERIODS, buildDirectionResult, analyzeTimeframe, classify };
