const assert = require('node:assert/strict');
const test = require('node:test');
const { normalizeAnalysisResult } = require('../lib/analysisResult');
const { computeEventReaction } = require('../lib/marketBrief');

test('缺乏方向时不再默认做多', () => {
  const output = normalizeAnalysisResult({
    short_term: { direction: '观望', summary: '证据不足' },
    personal_stance: { short: { action: '观望', execution: '现在可开', entry: 100, leverage: 20, stop: 90, take_profit: 110 } },
  }).result;
  assert.equal(output.personal_stance.short.action, '观望');
  assert.equal(output.personal_stance.short.execution, '禁止下单');
  assert.equal(output.personal_stance.short.leverage, 10);
});

test('AI 入场价的多维验证随结构化结果保存', () => {
  const output = normalizeAnalysisResult({
    short_term: { direction: '偏多', summary: '回踩待确认' },
    mid_long_term: { direction: '偏多' },
    personal_stance: { short: { action: '做多', execution: '等待触发', entry: 95, leverage: 5, stop: 90, take_profit: 110,
      entry_validation: { technical: '95 支撑', sentiment: '费率温和', news_macro: '暂无事件', positioning: '大户偏多', decision: '支持' } } },
  }).result;
  assert.equal(output.personal_stance.short.entry_validation.decision, '支持');
  assert.equal(output.personal_stance.short.entry_validation.technical, '95 支撑');
});

test('只在有可对齐公布时间和 K 线时给出事件后价格反应', () => {
  const eventAt = Date.now() - 20 * 60 * 1000;
  const shanghai = new Date(eventAt + 8 * 60 * 60 * 1000).toISOString();
  const date = shanghai.slice(0, 10);
  const time = shanghai.slice(11, 16);
  const bars = [
    { t: eventAt - 5 * 60 * 1000, c: 100, h: 101, l: 99 },
    { t: eventAt, c: 99, h: 100, l: 98 },
    { t: eventAt + 5 * 60 * 1000, c: 102, h: 103, l: 99 },
  ];
  const tech = { m5: { source: 'binance-fapi', chart: { candles: bars } } };
  const reaction = computeEventReaction([{ title: '非农就业', date, time, forecast: '100K', actual: '80K' }], tech);
  assert.equal(reaction.first5mLowPct, -2);
  assert.equal(reaction.latestClosePct, 2);
  assert.equal(computeEventReaction([{ title: '非农就业', date, time, actual: '' }], tech), null);
});
