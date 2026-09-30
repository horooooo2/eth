# 情绪过冲 / 衰竭确认策略
# Frozen Backtest Specification v1.0

你现在需要实现一套严谨、可复现、无未来函数的 Python 回测框架。

这是一个**研究程序，不是参数优化程序**。

本版本的核心研究问题是：

> 在完全相同的一批“统计异常价格事件”上，比较：
>
> A. Extreme Maker：异常出现后，在更极端价格提前挂逆向 Maker 单；
>
> B. Exhaustion Confirmation：等待有效回撤、反弹失败、结构破坏后再逆向入场；
>
> 哪种执行方式在扣除手续费、滑点后，拥有更好的 Event EV、Trade EV、MAE、尾部损失和最大回撤表现？

禁止自行增加指标、优化参数或修改规则。

---

# 0. 总原则

必须遵守以下原则：

1. 所有规则只能使用当时已经完整收盘的数据。
2. 禁止未来函数。
3. 禁止事后选择高点、低点。
4. 禁止根据最终走势重新定义事件。
5. A、B 使用完全相同的 event_id。
6. 一个策略在一个 event_id 上最多交易一次。
7. 禁止加仓。
8. 禁止马丁。
9. 禁止同一事件止损后重新进场。
10. 未成交、未确认、超时事件全部保留。
11. Event EV 的分母是全部异常事件，不是成交交易。
12. A-K3、A-K4、A-K5、A-K6 必须全部报告。
13. 禁止只挑历史表现最好的 K。
14. 暂时不使用 VWAP、OI、Funding、主动买卖流、订单簿、情绪评分。
15. 本版本只研究 OHLCV 价格结构。

所有时间统一：

UTC。

---

# 1. 技术栈

使用：

- Python 3.11+
- pandas
- numpy
- pyarrow
- pydantic 或 dataclass
- pytest
- matplotlib

允许使用 scipy。

不要构建 Web UI。

输出：

- parquet
- csv
- json
- markdown/html 报告
- png 图表

推荐项目结构：

```text
emotion_backtest/
    config/
        v1_0.yaml

    src/
        data.py
        resample.py
        indicators.py
        events.py
        strategy_extreme_maker.py
        strategy_exhaustion.py
        execution.py
        position_sizing.py
        metrics.py
        reporting.py
        models.py
        engine.py
        cli.py

    tests/
        test_atr.py
        test_event_detection.py
        test_no_lookahead.py
        test_exhaustion_state_machine.py
        test_maker_execution.py
        test_exit_execution.py
        test_event_ev.py
        test_pairing.py

    results/

    README.md
```

---

# 2. 原始数据

v1.0 最低输入周期：

5 分钟 K 线。

每行：

```text
symbol
timestamp
open
high
low
close
volume
```

要求：

```text
timestamp = K线开盘时间
timezone = UTC
```

数据必须按：

```text
symbol, timestamp
```

排序。

不得有重复 timestamp。

---

# 3. 1H K线生成

不要直接混用来源不同的 1H 数据。

从 5m K线内部重采样得到 1H：

```text
open  = 第一根5m open
high  = max(high)
low   = min(low)
close = 最后一根5m close
volume = sum(volume)
```

一根有效 1H K 线必须完整包含：

12 根连续 5m K线。

缺少任意一根：

```text
valid_1h = false
```

该 1H K线：

- 不允许触发事件；
- 不允许进入 ATR；
- 不允许进入历史分位数。

---

# 4. ATR_pre 定义

周期：

```text
ATR_PERIOD = 20
```

使用 1H K线。

True Range：

```text
TR[t] = max(
    high[t] - low[t],
    abs(high[t] - close[t-1]),
    abs(low[t] - close[t-1])
)
```

v1.0 不使用递归 Wilder ATR。

使用简单平均：

```text
ATR_pre[t] =
mean(TR[t-20 : t])
```

注意：

这里不包含事件候选当前 1H K线 `t`。

即：

事件小时自身绝对不能进入 ATR_pre。

这是硬性要求。

---

# 5. 历史异常分位数

历史窗口：

```text
RETURN_LOOKBACK_HOURS = 2160
```

即约 90 天。

1H return：

```text
return_1h[t] =
close[t] / close[t-1] - 1
```

计算当前 t 的分位数时：

只能使用：

```text
return_1h[t-2160 : t]
```

绝对禁止包含：

```text
return_1h[t]
```

需要完整历史样本。

样本不足：

不得产生事件。

---

# 6. 异常事件定义

参数冻结：

```text
UP_QUANTILE   = 0.995
DOWN_QUANTILE = 0.005

MIN_ATR_MULTIPLE = 3.0
```

首先：

```text
atr_pct =
ATR_pre / close[t-1]
```

## 6.1 异常上涨事件

当前完整 1H K线收盘后：

同时满足：

```text
return_1h[t] >= historical_quantile_99_5
```

以及：

```text
return_1h[t] / atr_pct >= 3.0
```

则生成：

```text
direction = UP
```

后续研究交易方向：

```text
SHORT
```

---

# 7. 异常下跌事件

同时满足：

```text
return_1h[t] <= historical_quantile_0_5
```

以及：

```text
abs(return_1h[t]) / atr_pct >= 3.0
```

生成：

```text
direction = DOWN
```

后续交易方向：

```text
LONG
```

上涨、下跌结果必须分别报告。

不得默认两者统计性质相同。

---

# 8. event_id

事件 ID 必须唯一且确定性生成。

例如：

```text
BTCUSDT_20260101T120000_UP
```

保存：

```text
event_id
symbol
direction
event_trigger_time
event_trigger_close
reference_price
ATR_pre
atr_pct
return_1h
historical_quantile
return_atr_multiple
```

定义：

```text
reference_price = close[t-1]
event_trigger_close = close[t]
```

注意二者不同。

---

# 9. 事件观察窗口

事件触发发生在完整 1H K线收盘后。

策略从：

```text
event_trigger_time + 1 hour
```

之后的第一根 5m K线开始观察。

冻结：

```text
EVENT_OBSERVATION_BARS = 24
```

即：

```text
24 × 5min = 120min
```

这是 v1.0 研究常量。

不是经过优化得到的最佳值。

事件观察期结束后：

未成交或未确认：

```text
trade_pnl = 0
```

但事件仍必须出现在结果数据中。

---

# 10. 事件冷却

为避免事件重叠：

一个 symbol 触发事件后：

未来：

```text
2小时
```

禁止生成新的 event_id。

即：

```text
EVENT_COOLDOWN_HOURS = 2
```

被抑制的候选异常可以记录 diagnostics：

```text
suppressed_candidate = true
```

但不创建正式 event_id。

---

# 11. Event High / Event Low

上涨事件：

```text
event_high
```

初始化：

```text
event_high = event_trigger_close
```

观察窗口内：

```text
event_high =
max(previous_event_high, current_5m.high)
```

下跌镜像：

```text
event_low =
min(previous_event_low, current_5m.low)
```

创新高或创新低：

不得创建新事件。

不得重置：

```text
event_id
ATR_pre
reference_price
risk budget
```

---

# 12. Strategy A：Extreme Maker

Strategy A 不允许等待衰竭确认。

它研究的问题是：

> 异常已经发生以后，如果等待价格进一步产生极端延伸，直接逆向 Maker 入场是否具有统计优势？

实现四个完全独立版本：

```text
A_K3
A_K4
A_K5
A_K6
```

其中：

```text
K ∈ {3,4,5,6}
```

---

# 13. A组 Maker 挂单价格

重要：

禁止把 Maker 单假设成在异常事件发生以前已经挂好。

否则会出现未来条件选择。

因此 Maker 单只能在异常事件已经确认以后生成。

上涨事件做空：

```text
limit_price =
event_trigger_close + K * ATR_pre
```

下跌事件做多：

```text
limit_price =
event_trigger_close - K * ATR_pre
```

订单开始有效时间：

异常 1H K线收盘之后第一根 5m bar。

订单有效到：

```text
event observation window
```

结束。

超时未成交：

```text
NO_FILL
PnL = 0
```

---

# 14. Maker 成交规则

上涨事件做空：

若订单已经在当前 5m bar 开始前存在，并满足：

```text
bar.high >= limit_price
```

认为成交。

成交价格：

```text
entry_fill_price = limit_price
```

手续费：

```text
maker fee
```

entry slippage：

```text
0
```

下跌事件镜像：

```text
bar.low <= limit_price
```

成交。

---

# 15. Strategy B：Exhaustion Confirmation

核心状态机：

```text
EVENT_ACTIVE
    ↓
EFFECTIVE_PULLBACK
    ↓
PULLBACK_WINDOW
    ↓
PULLBACK_LOW_FIXED
    ↓
REBOUND_STARTED
    ↓
LOWER_HIGH_CONFIRMED
    ↓
STRUCTURE_BREAK
    ↓
ENTRY_NEXT_BAR
```

不得跳过状态。

---

# 16. 有效回撤

冻结：

```text
PULLBACK_ATR = 0.5
```

上涨事件：

当完整 5m K线收盘满足：

```text
event_high - close
>=
0.5 * ATR_pre
```

首次进入：

```text
EFFECTIVE_PULLBACK
```

只使用收盘价确认。

盘中 low 触及但收盘未满足：

不得确认。

---

# 17. Pullback Low 固定规则

这是防止事后挑低点的关键。

冻结：

```text
PULLBACK_WINDOW_BARS = 3
```

从第一次满足有效回撤的 5m K线开始：

收集连续 3 根完整 5m K线。

定义：

```text
pullback_low =
min(low of these 3 bars)
```

完成三根之后：

```text
pullback_low
```

永久冻结。

不得因为后面价格更低而修改。

---

# 18. Pullback Window 内创新高

上涨事件：

如果这三根 K线中的任何一根：

```text
high > previous event_high
```

则：

更新：

```text
event_high
```

同时：

```text
取消当前 pullback
清空 pullback_low
重新进入 EVENT_ACTIVE
```

等待下一次：

```text
0.5 ATR_pre
```

有效回撤。

这不是新 event。

---

# 19. 反弹开始

pullback_low 固定之后：

至少必须观察到一根完整 5m K线满足：

```text
current_close > previous_close
```

才定义：

```text
REBOUND_STARTED
```

如果价格一路向下：

没有出现：

```text
close > previous close
```

则：

不允许产生 B 入场。

即使价格已经大幅下跌也不追空。

---

# 20. Rebound High

反弹开始后：

```text
rebound_high =
max(high)
```

直到：

- 结构破坏；
- 创新 event high；
- 或事件超时。

---

# 21. 反弹阶段创新高

上涨事件：

如果：

```text
current_high > event_high
```

说明原来的衰竭结构失效。

执行：

```text
event_high = current_high

clear pullback state
clear pullback_low
clear rebound_high

state = EVENT_ACTIVE
```

仍然属于同一个：

```text
event_id
```

---

# 22. B组最终做空触发

必须满足完整顺序：

```text
1. 异常事件成立
2. 出现 0.5 ATR_pre 有效回撤
3. 固定3根K线 pullback window
4. 得到 pullback_low
5. 至少出现一根 close > previous close
6. 反弹没有创新 event_high
7. 随后的完整5m K线：
   close < pullback_low
```

第 7 条第一次发生时：

```text
signal_time = 当前5m K线 close
```

不得在该收盘价假设成交。

---

# 23. B组实际入场

实际入场：

下一根有效 5m K线：

```text
open
```

使用 Market/Taker 模拟。

上涨事件做空：

```text
entry_fill =
next_bar.open *
(1 + entry_slippage_bps / 10000)
```

因为做空时，更高成交价格不是不利；但为了统一“市场单滑点方向”，应基于真实交易方向处理：

做空卖出开仓的不利滑点是成交价格偏低。

因此正确实现：

```text
SHORT entry:
entry_fill =
open * (1 - entry_slippage_bps / 10000)
```

做多买入：

```text
LONG entry:
entry_fill =
open * (1 + entry_slippage_bps / 10000)
```

必须写单元测试验证方向。

B组 entry fee：

```text
taker fee
```

---

# 24. 下跌事件镜像

DOWN → LONG。

所有逻辑镜像。

有效反弹：

```text
close - event_low >= 0.5 ATR_pre
```

定义：

```text
pullback_high
```

形成向下反抽失败结构。

最终：

```text
close > pullback_high
```

触发 LONG。

必须独立编写测试。

不得通过简单乘以 -1 后不测试。

---

# 25. v1.0 退出规则

为了把研究重点放在：

```text
入场方法
```

而不是：

```text
复杂止盈优化
```

A 和 B 使用完全相同的退出距离。

冻结：

```text
STOP_ATR   = 1.0
TARGET_ATR = 1.0
```

这是研究常量。

不是已验证最佳参数。

---

# 26. SHORT 退出

入场后立即冻结：

```text
stop_trigger =
entry_fill + 1.0 * ATR_pre

target_trigger =
entry_fill - 1.0 * ATR_pre
```

之后：

不得改变。

ATR_live 增加也不得扩大 stop。

---

# 27. LONG 退出

```text
stop_trigger =
entry_fill - 1.0 * ATR_pre

target_trigger =
entry_fill + 1.0 * ATR_pre
```

冻结。

---

# 28. 最大持有时间

冻结：

```text
MAX_HOLDING_BARS = 24
```

即：

2小时。

这是研究参数。

不是已验证最优。

如果到第24根 5m K线结束仍未止盈止损：

在该 bar close：

Market exit。

记录：

```text
exit_reason = TIME
```

---

# 29. 止损成交

止损视为：

```text
market/taker
```

SHORT：

```text
stop_fill =
stop_trigger *
(1 + exit_slippage_bps / 10000)
```

因为买入平空，价格更高更差。

LONG：

```text
stop_fill =
stop_trigger *
(1 - exit_slippage_bps / 10000)
```

因为卖出平多，价格更低更差。

---

# 30. 止盈成交

v1.0 也按：

```text
market/taker
```

处理。

SHORT target：

买入平空：

```text
target_fill =
target_trigger *
(1 + exit_slippage_bps / 10000)
```

LONG target：

卖出平多：

```text
target_fill =
target_trigger *
(1 - exit_slippage_bps / 10000)
```

全部计：

```text
taker fee
```

---

# 31. 同一根K线同时触及 Stop 和 Target

OHLC 无法知道盘中顺序。

使用保守规则：

```text
STOP FIRST
```

即：

同一根 K线：

```text
high >= stop
```

同时：

```text
low <= target
```

则按止损处理。

必须固定。

---

# 32. A组成交当根K线的特殊规则

Maker 成交发生在某根 K线盘中。

因为不知道：

```text
low
```

发生在 Maker 成交以前还是以后，

所以：

A组成交当根 K线：

允许触发 Stop。

但：

禁止在成交当根 K线触发 Target。

Target 最早从：

下一根完整 5m K线

开始计算。

这是为了避免乐观偏差。

---

# 33. B组入场当根K线

B 在 next bar open 入场。

因为已知入场位于该 K线开盘：

本根 K线可以同时检测：

```text
stop
target
```

如果两者同时触发：

```text
STOP FIRST
```

---

# 34. 手续费和滑点

禁止在代码中假设某个 Binance VIP 等级。

必须从：

```text
config/v1_0.yaml
```

读取：

```text
maker_fee_bps
taker_fee_bps
entry_slippage_bps
exit_slippage_bps
```

如果缺失：

程序直接报错。

禁止默认为 0。

---

# 35. 风险预算

配置：

```text
risk_budget_usdt
```

例如用户以后可以设：

```text
100
```

但代码不得硬编码 100。

风险预算表示：

```text
计划止损情况下的估算亏损
```

并不表示实际亏损绝对不会超过该值。

---

# 36. 仓位计算

首先模拟计划止损成交价。

计算每单位仓位：

```text
gross_price_loss
+
entry_fee
+
estimated_stop_exit_fee
```

再求：

```text
qty =
risk_budget_usdt
/
planned_loss_per_unit
```

如果计入滑点后的 stop fill 更差：

必须按滑点后的价格计算。

禁止简单使用：

```text
risk_budget / ATR
```

而忽略手续费。

---

# 37. 交易所精度

config 必须支持每个 symbol：

```text
tick_size
qty_step
min_qty
min_notional
```

所有价格：

按 tick_size 合法化。

所有数量：

向下按 qty_step 取整。

如果：

```text
qty < min_qty
```

或：

```text
notional < min_notional
```

则：

```text
SKIP_SIZE_CONSTRAINT
```

Event PnL = 0。

---

# 38. 单仓限制

每个：

```text
strategy + symbol
```

同一时间最多有：

一个未平仓仓位。

如果新 event 到来时旧仓位仍在：

该 event 继续保留。

该策略该 event：

```text
trade_status = SKIP_POSITION_BUSY
PnL = 0
```

不得删除事件。

---

# 39. PnL

必须记录：

```text
gross_pnl
entry_fee
exit_fee
total_fee
net_pnl
```

SHORT：

```text
gross_pnl =
(entry_fill - exit_fill) * qty
```

LONG：

```text
gross_pnl =
(exit_fill - entry_fill) * qty
```

然后：

```text
net_pnl =
gross_pnl
- entry_fee
- exit_fee
```

---

# 40. R Multiple

定义：

```text
R =
net_pnl / risk_budget_usdt
```

即使用：

计划风险预算

作为分母。

实际 stop 由于滑点超过 -1R 是允许的。

不能强制裁剪成：

```text
-1R
```

---

# 41. Trade MAE

从实际入场之后开始统计。

SHORT：

```text
trade_MAE_price =
max(high after entry before exit)
- entry_fill
```

LONG：

```text
trade_MAE_price =
entry_fill
- min(low after entry before exit)
```

同时输出：

```text
trade_MAE_ATR =
trade_MAE_price / ATR_pre
```

以及：

```text
trade_MAE_R
```

---

# 42. Trade MFE

SHORT：

```text
entry_fill
-
min(low after entry before exit)
```

LONG：

```text
max(high after entry before exit)
-
entry_fill
```

同样输出：

```text
price
ATR
R
```

三个版本。

---

# 43. Event Adverse Extension

它和 Trade MAE 完全分开。

固定观察窗口：

```text
EVENT_EVALUATION_BARS = 288
```

即：

24小时。

从异常事件触发后的第一根 5m K线开始。

上涨事件：

```text
event_adverse_extension =
max(high during next 288 bars)
- event_trigger_close
```

下跌：

```text
event_adverse_extension =
event_trigger_close
- min(low)
```

输出：

```text
price
percent
ATR_pre multiple
```

---

# 44. Event Maximum Reversion

同一个固定 24H 评价窗口。

上涨事件：

先计算：

```text
max_high
```

然后计算该窗口内：

```text
max_high - subsequent_min_low
```

下跌镜像。

该指标用于回答：

> 异常以后最终出现过多大的反向运动？

这不是策略实际 PnL。

必须明确区分。

---

# 45. Missed Opportunity

对于：

```text
NO_FILL
NO_CONFIRMATION
TIMEOUT
SKIP_POSITION_BUSY
```

等零交易事件：

仍继续计算未来 24H：

```text
event_adverse_extension
event_max_reversion
```

从而可以分析：

> B 是过滤了坏行情，
> 还是同时错过了大量本来会回归的行情？

---

# 46. Event EV

对于每个策略版本：

所有正式 event_id 都必须有一行结果。

未交易：

```text
net_pnl = 0
R = 0
```

定义：

```text
Event_EV_USDT =
sum(net_pnl) / total_events
```

```text
Event_EV_R =
sum(R) / total_events
```

注意：

分母是：

```text
total_events
```

不是：

```text
trade_count
```

---

# 47. Trade EV

只计算实际成交交易：

```text
Trade_EV_USDT =
sum(net_pnl of trades) / trade_count
```

```text
Trade_EV_R =
mean(R of trades)
```

---

# 48. Participation Rate

```text
participation_rate =
trade_count / total_events
```

A组额外报告：

```text
maker_fill_rate
```

B组额外报告：

```text
confirmation_rate
```

以及：

```text
confirmation_to_trade_rate
```

---

# 49. 必须输出的总体指标

每一个：

```text
A_K3
A_K4
A_K5
A_K6
B
```

分别输出：

```text
total_events
trade_count
participation_rate

net_profit
gross_profit
gross_loss

event_ev_usdt
event_ev_r

trade_ev_usdt
trade_ev_r

win_rate
loss_rate

average_win_r
average_loss_r

profit_factor

max_drawdown_usdt
max_drawdown_r

max_consecutive_wins
max_consecutive_losses

stop_rate
target_rate
time_exit_rate

mean_hold_bars
median_hold_bars
```

---

# 50. 尾部统计

必须输出 Trade MAE：

```text
P50
P75
P90
P95
P99
MAX
```

Event Adverse Extension：

```text
P50
P75
P90
P95
P99
MAX
```

实际亏损 R：

```text
P01
P05
P10
median
```

并单独报告：

```text
worst_10_trades
worst_20_events
```

---

# 51. A组参数报告

禁止输出：

```text
best_K = ...
```

禁止写：

```text
K5 is optimal
```

必须并列：

```text
A_K3
A_K4
A_K5
A_K6
```

报告。

可以绘制：

```text
K vs Event EV
K vs Trade EV
K vs Fill Rate
K vs MAE
K vs Max Drawdown
```

但不能自动选冠军。

---

# 52. A/B 配对比较

因为 event_id 完全一致：

按 event_id merge。

分别比较：

```text
B - A_K3
B - A_K4
B - A_K5
B - A_K6
```

针对每个 event：

计算：

```text
delta_net_pnl
delta_R
```

输出：

```text
mean delta
median delta
P10
P25
P75
P90
```

另外报告：

```text
B赢的event比例
A赢的event比例
双方均未交易比例
A交易/B未交易比例
B交易/A未交易比例
双方交易比例
```

这不是胜率。

不要混淆。

---

# 53. 分组分析

必须分别输出：

## Direction

```text
UP -> SHORT
DOWN -> LONG
```

不得只给 combined。

## Symbol

每个 symbol 单独。

## 时间

至少：

```text
year
quarter
month
```

用于观察稳定性。

---

# 54. Equity Curve

使用：

```text
固定 risk_budget
```

不复利。

即每笔计划风险不随着历史盈利增加。

分别绘制：

```text
A_K3
A_K4
A_K5
A_K6
B
```

累计：

```text
net PnL
```

不得把不同策略资金混在一起。

---

# 55. 最大回撤

按实际交易退出时间排序生成 equity curve。

计算：

```text
running_peak
drawdown
max_drawdown
```

同时输出：

```text
USDT
risk-budget R units
```

---

# 56. Event Dataset

输出：

```text
results/events.parquet
```

至少包含：

```text
event_id
symbol
direction

event_trigger_time
event_trigger_close
reference_price

ATR_pre
atr_pct

return_1h
historical_quantile_threshold
return_atr_multiple

event_high_or_low
event_adverse_extension
event_max_reversion

observation_end_time
evaluation_end_time
```

---

# 57. Strategy Result Dataset

每个 event × strategy 必须一行。

例如：

```text
event_id
strategy

status

order_price
order_time

signal_time

entry_time
entry_fill

stop_trigger
target_trigger

exit_time
exit_fill
exit_reason

qty

gross_pnl
entry_fee
exit_fee
net_pnl

R

trade_MAE_price
trade_MAE_ATR
trade_MFE_price
trade_MFE_ATR

holding_bars
```

未交易：

这些字段保持 null。

但是：

```text
net_pnl = 0
R = 0
```

---

# 58. B组额外调试字段

必须输出：

```text
effective_pullback_time
pullback_window_start
pullback_window_end

pullback_low_or_high

rebound_start_time
rebound_high_or_low

structure_break_time

reset_count_due_to_new_extreme
```

这样可以人工检查状态机。

---

# 59. 状态 / 原因代码

至少支持：

```text
TRADED_TARGET
TRADED_STOP
TRADED_TIME

NO_FILL
NO_CONFIRMATION
EVENT_TIMEOUT

SKIP_SIZE_CONSTRAINT
SKIP_POSITION_BUSY
SKIP_MISSING_DATA
```

不要用模糊字符串。

使用 Enum。

---

# 60. 缺失数据

如果 event observation window 内有缺失 5m K线：

该 event 对所有策略：

```text
SKIP_MISSING_DATA
```

PnL = 0。

不要插值价格。

不要 forward fill OHLC。

---

# 61. 禁止未来函数

重点检查：

ATR：

不得包含事件 K线。

历史 quantile：

不得包含当前 return。

B：

不得使用未来最低点定义 pullback_low。

Signal：

只能在结构破坏 K线 close 后成立。

Entry：

必须下一根 K线 open。

Event extension：

只能作为统计结果。

绝对不能进入交易决策。

---

# 62. 禁止做的事情

v1.0 中禁止：

```text
参数优化
网格搜索最佳参数
Optuna
遗传算法

机器学习分类器

VWAP过滤
成交量过滤
主动买入数据
OI
Funding
order book

移动止损
追踪止盈
加仓
减仓

DCA
Martingale

二次入场
同event重新入场

动态扩大止损

看到未来最高价后改变Maker价格

根据最终结果删除事件
```

---

# 63. config/v1_0.yaml

建立配置文件：

```yaml
version: "1.0"

timeframe:
  base: "5m"
  background: "1h"

event:
  atr_period: 20
  return_lookback_hours: 2160
  up_quantile: 0.995
  down_quantile: 0.005
  min_atr_multiple: 3.0
  observation_bars_5m: 24
  cooldown_hours: 2
  evaluation_bars_5m: 288

exhaustion:
  pullback_atr: 0.5
  pullback_window_bars: 3

extreme_maker:
  k_values:
    - 3
    - 4
    - 5
    - 6

exit:
  stop_atr: 1.0
  target_atr: 1.0
  max_holding_bars_5m: 24

execution:
  maker_fee_bps: REQUIRED
  taker_fee_bps: REQUIRED
  entry_slippage_bps: REQUIRED
  exit_slippage_bps: REQUIRED

risk:
  risk_budget_usdt: REQUIRED

bootstrap:
  enabled: true
  seed: 42
  samples: 10000
```

`REQUIRED` 未被用户替换：

程序直接报错。

---

# 64. Bootstrap

实现配对 bootstrap。

不要对单笔交易独立随机抽样。

按：

```text
UTC calendar day
```

作为 block。

保持同一天里的事件聚集关系。

固定：

```text
seed = 42
samples = 10000
```

对：

```text
B - A_K3
B - A_K4
B - A_K5
B - A_K6
```

输出 Event EV delta 的：

```text
mean
2.5 percentile
97.5 percentile
```

称为：

```text
bootstrap interval
```

不要自动把它表述成策略已被证明有效。

---

# 65. 必须编写单元测试

至少写以下测试。

## Test 1

当前事件 K线绝不能进入 ATR_pre。

---

## Test 2

当前事件 return 绝不能进入自身历史 quantile。

---

## Test 3

B结构破坏发生于：

```text
12:25 close
```

则最早：

```text
12:30 open
```

才能入场。

---

## Test 4

有效回撤后：

pullback_low 只能来自固定3根 K线。

后面出现更低 low：

不得修改 pullback_low。

---

## Test 5

Pullback / Rebound 过程中创新 event high：

状态必须 reset。

event_id 不变。

---

## Test 6

如果价格有效回撤以后一路下跌，从未出现：

```text
close > previous close
```

B：

不得入场。

---

## Test 7

A组 Maker order 未被价格触及：

```text
NO_FILL
PnL = 0
```

---

## Test 8

A成交当根 K线：

即使 low 穿过 target：

不得 target exit。

---

## Test 9

A成交当根 K线：

如果 high 穿过 stop：

允许 stop exit。

---

## Test 10

B next-open entry bar：

同时触及 target 和 stop：

STOP FIRST。

---

## Test 11

止损实际滑点可以导致：

```text
R < -1
```

代码不得裁剪。

---

## Test 12

Event EV：

必须包含未交易 event 的：

```text
0 PnL
```

---

## Test 13

同一个事件：

A_K3/A_K4/A_K5/A_K6/B

event_id 必须完全一致。

---

## Test 14

每个：

```text
event_id + strategy
```

最多一笔交易。

---

## Test 15

缺5m K线：

不得 forward fill。

---

## Test 16

SHORT/LONG 的滑点方向必须分别正确。

---

# 66. Synthetic Test Case

额外制作人工 K线测试数据。

例如上涨：

```text
事件触发 close = 100
ATR_pre = 10

event_high = 120

价格回撤：
115
114
113

三根窗口：
low分别：
112
110
111

pullback_low = 110

随后：
close 114
close 116

确认反弹。

随后：
close 109
```

此时：

```text
structure_break signal
```

必须在：

```text
close = 109
```

该K线结束后产生。

不得成交在109。

必须：

下一根 open

成交。

---

# 67. 输出报告

生成：

```text
results/report.md
```

以及：

```text
results/report.html
```

报告顺序：

## 1. 数据摘要

```text
symbols
start date
end date
5m bars
valid 1h bars
missing bars
```

## 2. Event摘要

```text
total events
UP events
DOWN events
events/year
events/symbol
```

## 3. A组

并排：

```text
K3
K4
K5
K6
```

## 4. B组

独立完整报告。

## 5. A/B Event-Level Pairing

## 6. MAE

## 7. Event Adverse Extension

## 8. Tail Loss

## 9. Drawdown

## 10. Missed Opportunities

## 11. 按方向

## 12. 按symbol

## 13. 按时间

## 14. 数据质量与限制

---

# 68. 图表

至少输出：

```text
equity_A_K3.png
equity_A_K4.png
equity_A_K5.png
equity_A_K6.png
equity_B.png

event_ev_by_strategy.png
trade_ev_by_strategy.png
participation_rate.png

mae_distribution.png
event_extension_distribution.png

drawdown.png

monthly_results.png
```

不要使用视觉上误导的截断坐标轴。

---

# 69. README 必须解释

README 要明确说明：

这不是：

```text
“高涨必跌”
```

策略。

研究假设是：

> 统计异常价格运动发生以后，某些事件会出现价格延续能力下降以及随后的回归。

A：

研究：

```text
直接等待更极端价格
```

B：

研究：

```text
等待价格结构出现衰竭确认
```

---

# 70. v1.0 不允许得出的结论

报告中禁止自动写：

```text
这个策略有效
K5最好
B优于A
这个参数最优
建议实盘
```

只允许描述：

```text
在当前数据样本和冻结规则下，
观察到……
```

并报告：

完整结果。

---

# 71. 实现阶段顺序

严格按以下顺序开发。

第一阶段：

```text
数据读取
5m验证
1h重采样
ATR_pre
historical quantile
event generation
```

运行测试。

第二阶段：

```text
Strategy A
Maker execution
```

运行测试。

第三阶段：

```text
Strategy B state machine
```

运行测试。

第四阶段：

```text
exit engine
fees
slippage
position sizing
```

运行测试。

第五阶段：

```text
event metrics
trade metrics
paired comparison
bootstrap
```

运行测试。

第六阶段：

```text
report
plots
CLI
README
```

---

# 72. CLI

最终应能够执行：

```bash
python -m src.cli run \
  --config config/v1_0.yaml \
  --input data/market_5m.parquet \
  --exchange-meta data/exchange_meta.csv \
  --output results/v1_0
```

测试：

```bash
pytest -q
```

---

# 73. 程序完成标准

只有同时满足以下条件才能认为 v1.0 完成：

```text
[ ] pytest全部通过

[ ] 没有未来函数

[ ] A/B使用完全相同event_id

[ ] K3/K4/K5/K6全部输出

[ ] 未成交事件被保留

[ ] 未确认事件被保留

[ ] Event EV分母为所有事件

[ ] Trade EV单独输出

[ ] Trade MAE与Event Extension分开

[ ] 手续费已经进入PnL

[ ] 滑点已经进入PnL

[ ] stop实际损失可以超过1R

[ ] B只能next-bar-open入场

[ ] pullback_low不能事后变化

[ ] 创新高会reset结构但不重建event

[ ] 一个event每个strategy最多交易一次

[ ] Stop/Target同bar采用STOP FIRST

[ ] A成交bar禁止立即Target

[ ] UP/DOWN分别报告

[ ] 每个symbol分别报告

[ ] 月度/季度结果已经输出

[ ] 生成events.parquet

[ ] 生成strategy_results.parquet

[ ] 生成report.md

[ ] 生成report.html
```

---

# 74. 最后要求

在开始写代码前：

先根据本规格生成：

```text
IMPLEMENTATION_PLAN.md
```

内容包括：

1. 数据模型；
2. Event 状态机；
3. B策略状态机；
4. Execution Engine；
5. 数据流；
6. 防未来函数设计；
7. 单元测试列表；
8. 最终输出文件。

然后再开始编码。

如果实现过程中发现本规格存在歧义：

**不要自行修改策略逻辑。**

把问题记录到：

```text
SPEC_QUESTIONS.md
```

同时采用：

```text
最保守、
最少未来信息、
最不利于产生虚假盈利
```

的实现方式。

不得自行添加“更聪明”的交易条件。

本次目标不是做出漂亮收益曲线。

本次目标是：

> 构建一个可以信任的、因果一致的实验框架，用于判断 Extreme Maker 和 Exhaustion Confirmation 两种入场逻辑是否真的存在统计差异。