const { getAnalysis } = require('./briefAnalysisStore');

function invalid(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

function validatedAiOrder(input, userId, readAnalysis = getAnalysis) {
  const body = input || {};
  const row = readAnalysis(body.analysisId);
  if (!row || row.status !== 'done' || String(row.userId) !== String(userId)) {
    throw invalid('找不到本次 AI 分析，请重新分析');
  }
  if (Date.now() - Number(row.createdAt) > 20 * 60_000 || Date.now() - Number(row.contextSummary?.asOf) > 20 * 60_000) {
    throw invalid('AI 分析和行情已过期，请重新分析');
  }
  const horizon = body.horizon === 'short' || body.horizon === 'mid_long' ? body.horizon : null;
  if (!horizon) throw invalid('请选择短线或长线计划');
  const chart = horizon === 'short' ? row.contextSummary?.charts?.hour : row.contextSummary?.charts?.day;
  if (!chart || row.capability?.shortTerm?.status !== 'ok') throw invalid('对应周期行情数据不足，请重新分析');
  const leg = row.result?.personal_stance?.[horizon];
  const orderMode = body.orderMode === 'pending' ? 'pending' : 'direct';
  if (!leg || !['做多', '做空'].includes(leg.action) || (orderMode === 'pending' ? leg.execution !== '等待触发' : leg.execution !== '现在可开')) {
    throw invalid('该 AI 方案尚未达到开单条件，请重新分析');
  }
  if (orderMode === 'pending') {
    const broadDirection = String(row.result?.mid_long_term?.direction || '');
    if (leg.action === '做多' ? broadDirection !== '偏多' : broadDirection !== '偏空') {
      throw invalid('挂单方向必须与 AI 的中长期方向一致');
    }
    const validation = leg.entry_validation;
    if (validation?.decision !== '支持' || !validation.technical || !validation.sentiment || !validation.news_macro || !validation.positioning) {
      throw invalid('AI 尚未完成入场价的技术、情绪、新闻宏观和仓位验证，请重新分析');
    }
    if (![validation.sentiment, validation.news_macro, validation.positioning].some((item) => !/暂无|缺失|无数据|unavailable|未接入/i.test(String(item)))) {
      throw invalid('挂单价缺少技术之外的有效佐证，请重新分析');
    }
  }
  const entry = Number(leg.entry);
  const stop = Number(leg.stop);
  const takeProfit = Number(leg.take_profit);
  const leverage = 10;
  if (![entry, stop, takeProfit, leverage].every((n) => Number.isFinite(n) && n > 0)) {
    throw invalid('AI 建议缺少有效的入场价、止盈止损或杠杆');
  }
  if (leg.action === '做多' ? !(stop < entry && takeProfit > entry) : !(takeProfit < entry && stop > entry)) {
    throw invalid('AI 止盈止损方向与挂单价不符');
  }
  return {
    coin: row.coin, action: leg.action, execution: leg.execution, orderMode,
    entry, stop, takeProfit, leverage, amountUsd: body.amountUsd,
    expectedPrice: body.expectedPrice,
  };
}

module.exports = { validatedAiOrder };
