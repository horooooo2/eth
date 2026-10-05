export const goldStrategy = {
  id: 'gold-range' as const, name: '区间回归策略', subtitle: '周度选向 · 日内分档 · 单向回归', version: 'weekly-daily-ladder-v3.0', minimum: 10081,
  description: '此前七根完整日线选择方向；当日涨跌分档限价，累计额度补仓；跨日预算不重置，整体回归退出。',
};
export function createReplayWorker(): Worker {
  return new Worker(new URL('./replay.worker.ts', import.meta.url), { type: 'module' });
}

export function isGoldStrategyReport(report: { strategyId?: string; strategyName: string }): boolean {
  return report.strategyId ? report.strategyId === goldStrategy.id : ['黄金震荡＋补仓', goldStrategy.name].includes(report.strategyName);
}
