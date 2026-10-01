'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildDirectionAssessment, grade } = require('../lib/directionEngine');
const { normalizeAnalysisResult } = require('../lib/analysisResult');

test('direction score bands are disjoint and deterministic at boundaries', () => {
  assert.equal(grade(0.55), '强烈偏多');
  assert.equal(grade(0.2), '偏多');
  assert.equal(grade(0), '中性');
  assert.equal(grade(-0.2), '中性');
  assert.equal(grade(-0.2001), '偏空');
  assert.equal(grade(-0.55), '强烈偏空');
});

test('missing modules produce DATA_INSUFFICIENT instead of neutral', () => {
  const result = buildDirectionAssessment({ coin: 'ETH', asOf: Date.now(), statusMeta: {}, status: {} });
  for (const horizon of Object.values(result.horizons)) {
    assert.equal(horizon.direction, 'DATA_INSUFFICIENT');
    assert.equal(horizon.coverage, 0);
    assert.equal(horizon.confidence, 0);
  }
});

test('available technical observations produce normalized bounded scores', () => {
  const now = Date.now();
  const ctx = {
    coin: 'ETH', asOf: now,
    status: { tech_klines: 'ok' },
    statusMeta: {
      technical: { fetchedAt: now, status: 'ok' },
      derivatives: { fetchedAt: now, status: 'ok' },
      whales: { fetchedAt: now, status: 'empty' },
    },
    tech: {
      m5: { tf: '5m', structure: '偏多', last: 110, ma7: 108, ma25: 105, rsi14: 62, changeRecentPct: 2 },
      hour: { tf: '1h', structure: '偏多', last: 110, ma7: 108, ma25: 105, rsi14: 62, changeRecentPct: 2 },
      day: null,
    },
    sentiment: { fundingPct: 0.01, external: { binanceTaker: { buySellRatio: 1.1 } } },
    whales: {}, benchmarks: { status: 'unavailable' },
  };
  const result = buildDirectionAssessment(ctx);
  const horizon = result.horizons.short_term;
  assert.notEqual(horizon.direction, 'DATA_INSUFFICIENT');
  assert.ok(horizon.score >= -1 && horizon.score <= 1);
  assert.ok(horizon.coverage > 0 && horizon.coverage <= 1);
  assert.equal(result.modules.news.quality, 0);
});

test('AI dashboard analysis fields survive validation with factual evidence groups', () => {
  const { ok, result } = normalizeAnalysisResult({
    short_term: { direction: '偏多', confidence: '中', summary: '小时结构偏强，但主动买卖尚未确认。' },
    direction_analysis: {
      summary: '短线结构偏强，衍生品信号混合。',
      market_state: { trend: '上行', volatility: '中等', structure: '高点抬升', phase: '整理', observation: '关注小时线能否守住均线。' },
      horizons: { short_term: { analysis: '价格在均线之上。', bull_points: ['MA7 高于 MA25'], bear_points: ['资金费率偏高'], focus: '观察放量延续' } },
      module_analysis: { technical: { status: '可用', summary: '小时线偏强。', facts: ['MA7 > MA25'], limitation: '缺少 4h 周期' } },
      bull_evidence: ['价格位于 MA25 之上'], bear_evidence: ['资金费率偏正'],
      data_limitations: ['未提供 OI 变化率'],
    },
  });
  assert.equal(ok, true);
  assert.equal(result.direction_analysis.market_state.trend, '上行');
  assert.equal(result.direction_analysis.horizons.short_term.bull_points[0], 'MA7 高于 MA25');
  assert.equal(result.direction_analysis.module_analysis.technical.limitation, '缺少 4h 周期');
  assert.equal(result.direction_analysis.bear_evidence[0], '资金费率偏正');
});
