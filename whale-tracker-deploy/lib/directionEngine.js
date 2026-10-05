'use strict';

// Deterministic V2.1 direction layer. Provisional thresholds are explicit so
// they can be evaluated and revised from historical data rather than tuned by AI.
const WEIGHTS = {
  ultra_short: { technical: 0.3, derivatives: 0.25, flow: 0.25, whales: 0.1, news: 0.05, cross: 0.05 },
  short_term: { technical: 0.3, derivatives: 0.25, flow: 0.15, whales: 0.1, news: 0.1, cross: 0.1 },
  medium_long: { technical: 0.3, derivatives: 0.1, flow: 0.05, whales: 0.1, news: 0.2, cross: 0.25 },
};

const clamp = (n, lo = -1, hi = 1) => Math.max(lo, Math.min(hi, n));
const number = (v) => v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v);
const signScore = (v, scale) => v == null ? null : clamp(v / scale);

function grade(score) {
  if (score >= 0.55) return '强烈偏多';
  if (score >= 0.2) return '偏多';
  if (score >= -0.2) return '中性';
  if (score > -0.55) return '偏空';
  return '强烈偏空';
}

function qualityFor(ctx, key, expectedMs, completeness) {
  const meta = ctx.statusMeta?.[key] || {};
  const status = meta.status || ctx.status?.[key];
  if (status !== 'ok' && status !== 'empty') return 0;
  const fetchedAt = number(meta.fetchedAt);
  if (fetchedAt == null || fetchedAt <= 0 || fetchedAt > Date.now() + 5000) return 0;
  const age = Math.max(0, Date.now() - fetchedAt);
  const freshness = age <= expectedMs ? 1 : Math.exp(-(age - expectedMs) / expectedMs);
  const availability = status === 'ok' ? 1 : 0.25;
  return Number((availability * freshness * completeness).toFixed(3));
}

function technicalFeature(tf) {
  if (!tf) return null;
  const structure = String(tf.structure || '');
  const trend = /偏多/.test(structure) ? 1 : /偏空/.test(structure) ? -1 : 0;
  const last = number(tf.last); const ma7 = number(tf.ma7); const ma25 = number(tf.ma25);
  let ma = last && ma7 && ma25 ? (Number(last > ma7) + Number(ma7 > ma25) - 1) : 0;
  const recent = signScore(number(tf.changeRecentPct), 3);
  const rsi = number(tf.rsi14);
  const momentum = clamp((recent || 0) * 0.7 + (rsi == null ? 0 : clamp((rsi - 50) / 35)) * 0.3);
  const score = clamp(trend * 0.45 + ma * 0.25 + momentum * 0.3);
  const completeness = [tf.last, tf.ma7, tf.ma25, tf.rsi14, tf.changeRecentPct].filter((x) => x != null).length / 5;
  return { score, completeness, detail: `${tf.tf}结构 ${structure || '暂无'}；区间涨跌 ${tf.changeRecentPct ?? '—'}%；RSI ${tf.rsi14 ?? '—'}` };
}

function modules(ctx) {
  const tech = ctx.tech || {};
  const tfFeatures = [technicalFeature(tech.m5), technicalFeature(tech.hour), technicalFeature(tech.day)].filter(Boolean);
  const techFeature = tfFeatures.length ? {
    score: tfFeatures.reduce((a, b) => a + b.score, 0) / tfFeatures.length,
    completeness: tfFeatures.reduce((a, b) => a + b.completeness, 0) / 3,
    detail: tfFeatures.map((x) => x.detail).join('；'),
  } : null;

  const taker = ctx.sentiment?.external?.binanceTaker;
  const ratio = number(taker?.buySellRatio ?? taker?.buy_sell_ratio ?? taker?.ratio);
  const flow = ratio == null ? null : { score: signScore(ratio - 1, 0.25), completeness: 1, detail: `主动买卖比 ${ratio}` };

  const funding = number(ctx.sentiment?.fundingPct);
  const liquidations = ctx.sentiment?.liquidations;
  let derivScore = null; let derivCompleteness = 0; const derivNotes = [];
  if (funding != null) {
    // Crowded positive funding is a small contrarian pressure, not a standalone directional signal.
    derivScore = clamp(-(funding / 0.05) * 0.3); derivCompleteness += 0.55;
    derivNotes.push(`资金费率 ${funding}%`);
  }
  if (liquidations?.totalUsd > 0) {
    const imbalance = (Number(liquidations.shortUsd || 0) - Number(liquidations.longUsd || 0)) / Number(liquidations.totalUsd);
    derivScore = clamp((derivScore || 0) * (derivCompleteness ? 0.55 : 0) + imbalance * 0.45);
    derivCompleteness += 0.45; derivNotes.push(`爆仓多/空 ${liquidations.longUsd}/${liquidations.shortUsd} USD`);
  }
  const derivatives = derivCompleteness ? { score: derivScore, completeness: Math.min(1, derivCompleteness), detail: derivNotes.join('；') } : null;

  const longUsd = Number(ctx.whales?.longUsd || 0); const shortUsd = Number(ctx.whales?.shortUsd || 0);
  const whaleTotal = longUsd + shortUsd;
  const whales = whaleTotal > 0 ? { score: clamp((longUsd - shortUsd) / whaleTotal), completeness: 0.45, detail: `站内持仓快照多头 ${longUsd} USD / 空头 ${shortUsd} USD` } : null;

  const benchmark = number(ctx.benchmarks?.btc24hPct);
  const cross = benchmark == null || ctx.coin === 'BTC' ? null : { score: signScore(benchmark, 4), completeness: 0.4, detail: `BTC 24h ${benchmark}%（代理参考）` };

  const freshness = (key, ttl, f) => f ? { ...f, quality: qualityFor(ctx, key, ttl, f.completeness) } : null;
  return {
    technical: freshness('technical', 5 * 60_000, techFeature),
    derivatives: freshness('derivatives', 60_000, derivatives),
    flow: freshness('derivatives', 60_000, flow),
    whales: freshness('whales', 60_000, whales),
    news: null, // No deterministic, validated sentiment classifier is available.
    cross: cross ? { ...cross, quality: cross.completeness * (ctx.benchmarks?.status === 'ok' ? 1 : 0.5) } : null,
  };
}

function buildDirectionAssessment(ctx) {
  const m = modules(ctx);
  const horizons = {};
  for (const [name, weights] of Object.entries(WEIGHTS)) {
    const coverage = Object.entries(weights).reduce((sum, [key, weight]) => sum + weight * (m[key]?.quality || 0), 0);
    const effective = Object.entries(weights).reduce((sum, [key, weight]) => sum + weight * (m[key]?.quality || 0) * (m[key]?.score || 0), 0);
    const rawScore = coverage ? clamp(effective / coverage) : 0;
    const insufficient = coverage < 0.3;
    const agreement = Object.entries(weights).filter(([key]) => m[key]?.quality > 0.2).map(([key]) => Math.sign(m[key].score));
    const agreementScore = agreement.length ? agreement.filter((x) => x === Math.sign(rawScore)).length / agreement.length : 0;
    const confidence = insufficient ? 0 : Math.round(100 * clamp(coverage * (0.55 + agreementScore * 0.45), 0, 1));
    horizons[name] = {
      score: Number(rawScore.toFixed(3)), direction: insufficient ? 'DATA_INSUFFICIENT' : grade(rawScore),
      confidence, coverage: Number(coverage.toFixed(3)),
      evidence: Object.entries(weights).filter(([key]) => m[key]).map(([key]) => ({ module: key, score: Number(m[key].score.toFixed(3)), quality: m[key].quality, detail: m[key].detail })),
    };
  }
  const hourly = ctx.tech?.hour;
  const regime = !hourly ? '数据不足' : /偏多/.test(hourly.structure || '') ? '上行趋势' : /偏空/.test(hourly.structure || '') ? '下行趋势' : '区间/方向不明';
  return {
    version: '2.1-provisional', asOf: ctx.asOf || Date.now(), regime,
    thresholds: { strong: 0.55, directional: 0.2, minimumCoverage: 0.3 },
    horizons, modules: Object.fromEntries(Object.entries(m).map(([k, v]) => [k, v ? { quality: v.quality, detail: v.detail } : { quality: 0, detail: '暂无可验证数据' }])),
    note: '分数与阈值是可复现的研究基线；信心按覆盖率与有效模块方向一致性计算，不包含跨时点稳定性。新闻情绪和 OI 变化率因缺少可靠输入未参与评分。',
  };
}

module.exports = { buildDirectionAssessment, grade, WEIGHTS };
