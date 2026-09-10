'use strict';

const REASON_ZH = {
  S9_DATA_5M_STALE: '5分钟方向数据已过期',
  S9_S3_DIRECTION_BLOCK: '市场方向强度不足',
  S9_VOLUME_NOT_EXPANDED: '成交量放大不足',
  S9_CANDLE_QUALITY_BLOCK: '突破K线质量不足',
  S9_VOLATILITY_TOO_LOW: '短周期波动不足',
  S9_VOLATILITY_TOO_HIGH: '短周期波动异常',
  S9_STRUCTURE_STOP_NOT_FOUND: '未找到有效的短周期结构止损',
  S9_STRUCTURE_STOP_TOO_TIGHT: '结构止损距离过近',
  S9_STRUCTURE_STOP_TOO_WIDE: '结构止损距离过远',
  S9_SPREAD_TOO_WIDE: '当前买卖价差过大',
  S9_INSUFFICIENT_BOOK_DEPTH: '当前盘口深度不足',
  S9_COST_DATA_UNAVAILABLE: '无法获取当前交易成本',
  S9_EXPECTED_MOVE_INSUFFICIENT_AFTER_COST: '扣除交易成本后预期空间不足',
  S9_TRADE_INTENT_EXPIRED: '交易机会已过期',
  S9_ENTRY_PRICE_DRIFT_EXCEEDED: '入场价格漂移超过允许范围',
  S9_EXPECTED_SLIPPAGE_TOO_HIGH: '预期滑点超过允许范围',
  S9_COOLDOWN: '策略冷却中，暂不开仓',
  SYMBOL_OWNERSHIP_CONFLICT: '当前交易对仍由其他策略持有',
  DUST_RESIDUAL_POSITION: '交易所仍存在残余仓位',
  UNRESOLVED_DUST_POSITION: '残余仓位暂时无法自动清理',
  ORPHAN_PROTECTIVE_STOP: '仍存在遗留保护止损',
  ORPHAN_PROTECTIVE_STOP_CLEANUP_FAILED: '遗留保护止损自动清理失败',
  MANUAL_REVIEW_REQUIRED: '需要人工检查交易所状态',
  ENGINE_OWNER_NOT_BOUND: '尚未绑定交易操作用户',
};

function reasonZh(code) {
  const key = String(code || '').trim();
  if (!key) return '';
  return REASON_ZH[key] || `未识别的策略状态（${key}）`;
}

module.exports = { REASON_ZH, reasonZh };
