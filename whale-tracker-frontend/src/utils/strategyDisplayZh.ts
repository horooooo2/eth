/** User-facing Chinese. Internal codes stay English. */

export const REASON_ZH: Record<string, string> = {
  S9_DATA_5M_STALE: '5分钟方向数据已过期',
  S9_DATA_1M_STALE: '1分钟K线数据已过期',
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
  S9_DIRECTION_NEUTRAL: '5分钟方向为中性，暂不开仓',
  S9_NO_BREAKOUT: '尚未出现有效突破',
  S9_SIGNAL_ALREADY_USED: '同一根已收盘1分钟K线已使用过信号',
  S9_ORDERBOOK_STALE: '盘口数据已过期',
  S9_TRADES_STALE: '成交数据已过期',
  S9_DATA_DEGRADED: '微观结构数据不完整',
  S9_DIRECTION_FLIP_EXIT: '短周期方向已翻转，执行主动退出',
  S9_TIME_EXIT: '持仓时间达到上限，执行主动退出',
  S9_EXPECTED_SLIPPAGE_TOO_HIGH: '预期滑点超过允许范围',
  S9_TRADE_FREQUENCY_HOUR: '滚动一小时开仓次数已达上限',
  S9_TRADE_FREQUENCY_DAY: '当日开仓次数已达上限',
  S9_COOLDOWN: '策略冷却中，暂不开仓',
  SPREAD_WINDOW_WARMING_UP: '价差样本仍在预热，暂不开仓',
  SYMBOL_OWNERSHIP_CONFLICT: '当前交易对仍由其他策略持有',
  DUST_RESIDUAL_POSITION: '交易所仍存在残余仓位',
  UNRESOLVED_DUST_POSITION: '残余仓位暂时无法自动清理',
  ORPHAN_PROTECTIVE_STOP: '仍存在遗留保护止损',
  ORPHAN_PROTECTIVE_STOP_CLEANUP_FAILED: '遗留保护止损自动清理失败',
  MANUAL_REVIEW_REQUIRED: '需要人工检查交易所状态',
  ENGINE_OWNER_NOT_BOUND: '尚未绑定交易操作用户',
  MARKET_DATA_WARMING_UP: '行情数据预热中',
  MARKET_DATA_STALE: '行情数据过期',
  ALPHA_OPENINGS_PAUSED: '新开仓已暂停',
  S6_ENTRIES_BLOCKED: '安全模块已阻止新开仓',
  TAKE_PROFIT: '已达到1.5R止盈',
};

export const STATUS_ZH: Record<string, string> = {
  READY: '就绪',
  NOT_READY: '未就绪',
  BLOCKED: '已阻止',
  RESEARCH: '研究中',
  PRODUCTION: '生产',
  DEMO_VALIDATION: '模拟盘验证',
  WARMING_UP: '预热中',
  STALE: '数据过期',
  OFFLINE: '离线',
  ONLINE: '在线',
  PAUSED: '已暂停',
  RUNNING: '运行中',
  DEGRADED: '降级',
  OFF: '关闭',
  HEALTHY: '健康',
  FLAT: '空仓',
  MATCHED: '已对齐',
  EXECUTE: '可执行',
  SHADOW: '影子模式',
  OKX_DEMO: 'OKX 模拟盘',
  OKX_LIVE: 'OKX 实盘',
  BULLISH: '看多',
  BEARISH: '看空',
  NEUTRAL: '中性',
  ALLOW: '允许',
  NO_TRADE: '无交易',
  CANDIDATE: '候选',
  ACTIVE: '活跃',
  CONNECTED: '已连接',
};

export const EVENT_ZH: Record<string, string> = {
  STRATEGY_NO_TRADE: '策略未开仓',
  STRATEGY_CANDIDATE: '策略信号候选',
  STRATEGY_SELECTED: '已选择策略',
  S9_DIRECTION: 'S9 方向判定',
  S9_NO_TRADE: 'S9 未开仓',
  S9_CANDIDATE: 'S9 信号候选',
  S9_TRADE_INTENT_CREATED: 'S9 交易意图已创建',
  S9_ORDER_INTENT_CREATED: 'S9 订单意图已创建',
  ORDER_SUBMITTED: '订单已提交',
  ORDER_PARTIALLY_FILLED: '订单部分成交',
  ORDER_FILLED: '订单已成交',
  POSITION_OPENED: '仓位已开立',
  POSITION_REDUCED: '仓位已减少',
  POSITION_CLOSED: '仓位已平仓',
  S5_RISK_CHANGED: 'S5 风险占用变化',
  RECONCILIATION_MISMATCH: '对账不一致',
  RECONCILIATION_MATCHED: '对账一致',
};

export function reasonZh(code?: string | null): string {
  const key = String(code || '').trim();
  if (!key) return '';
  return REASON_ZH[key] || `未识别的策略状态（${key}）`;
}

export function statusZh(value?: string | null): string {
  const key = String(value || '').trim();
  if (!key) return '';
  return STATUS_ZH[key.toUpperCase()] || STATUS_ZH[key] || key;
}

export function eventZh(eventType?: string | null): string {
  const key = String(eventType || '').trim();
  if (!key) return '';
  return EVENT_ZH[key] || `未识别的策略状态（${key}）`;
}

export const SECTION_ZH: Record<string, string> = {
  basic: '基本信息',
  market: '市场配置',
  signal: '信号参数',
  risk: '风险管理',
  stop: '止损规则',
  exit: '退出规则',
  dependencies: '依赖模块',
};
