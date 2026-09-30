# SPEC_QUESTIONS.md
# v1.0.1 Final Implementation Clarifications

本文件用于消除 Frozen Backtest Specification v1.0.1 中剩余的实现歧义。

本文件：

- 不增加新的交易条件；
- 不改变 A/B 的研究假设；
- 不进行参数优化；
- 只冻结时序、执行、统计和数据完整性口径。

若本文件与 v1.0 / v1.0.1 存在实现细节冲突：

> 以本文件为准。

---

# Q1. Data Gap 后的 Equity Curve 应如何处理？

## 问题

不能因为一笔交易后来进入：

```text
DATA_GAP_IN_POSITION
```

就把它在缺口之前已经真实模拟发生的：

```text
entry fee
unrealized loss
unrealized profit
```

从历史账户路径中删除。

否则会形成：

> 根据未来数据是否完整，事后筛选权益曲线。

---

## 冻结约定

必须生成两类完全不同的曲线。

### A. Evaluable-Subset Equity Curve

名称必须明确：

```text
evaluable_subset_realized_equity
evaluable_subset_mtm_equity
```

它只使用最终完整可评价的交易。

用途：

> 比较 A/B 在可完整评价样本中的策略表现。

不得称为：

```text
continuous account equity
real account equity
```

---

### B. Continuous Account Path

另外维护：

```text
continuous_account_path
```

模拟时严格按时间推进。

一旦某个已开仓交易遇到：

```text
DATA_GAP_IN_POSITION
```

则从数据缺口开始：

```text
continuous_equity_known = false
```

该时间之后：

不得把未知持仓简单删除，

也不得把数据缺口前后的两段账户曲线直接拼接。

必须：

```text
continuous_account_path = INDETERMINATE
```

直到研究数据能够重新初始化独立测试段。

---

## 报告要求

必须分别报告：

```text
Evaluable subset performance
```

以及：

```text
Continuous-account coverage
```

至少包含：

```text
first_indeterminate_timestamp
number_of_indeterminate_segments
fraction_of_time_equity_known
```

---

# Q2. DATA_GAP_IN_POSITION 前已经发生的成本如何处理？

已经实际发生：

```text
entry fee
```

的交易，即使后来不可评价：

不得从 raw simulation ledger 中删除。

必须保存：

```text
realized_cost_before_gap
unrealized_pnl_at_last_known_close
last_known_mark_price
gap_timestamp
```

但这些数据：

不得用于伪造完整最终 PnL。

最终：

```text
trade_final_pnl = null
```

同时保存：

```text
trade_partial_path_valid = true
```

---

# Q3. MAE/MFE 的退出边界谁优先？

退出时点规则拥有最高优先级。

例如 SHORT：

```text
entry = 100
stop_trigger = 110
bar.high = 125
```

模型认为交易在：

```text
110附近
```

已经退出。

因此：

```text
125
```

不能作为：

```text
known MAE
```

因为 110 以后的行情已经发生在模拟退出之后。

---

# Q4. MAE/MFE Known 部分定义

所有 excursion 统计必须先确定：

```text
model_entry_time
model_exit_time
```

然后再计算。

原则：

> 只有在指定执行模型下能够确定发生在 entry 之后、exit 之前的价格路径，才能进入 known excursion。

执行优先级：

```text
ENTRY
↓
INTRABAR EXIT TRIGGER
↓
TRADE ENDED
↓
IGNORE ALL LATER INTRABAR EXTREMES FOR KNOWN METRIC
```

---

# Q5. 模拟滑点超出 OHLC 怎么处理？

允许：

```text
simulated_fill_price
```

超出该 K线原始：

```text
high / low
```

例如 Gap Stop + slippage。

因此：

所有 excursion 区间必须同时考虑：

```text
OHLC prices
simulation fill prices
```

但报告中禁止称其为：

```text
true MAE range
true MFE range
```

必须称：

> 指定 OHLC + execution model 下的 excursion estimate / bound。

---

# Q6. 时间示例统一

禁止写：

> “12:25 close 确认，12:30 next bar”

因为 timestamp 语义容易混淆。

统一按照：

```text
bar_open_time
bar_close_time
```

描述。

例如：

```text
signal bar:
[12:25, 12:30)

signal becomes known:
12:30

entry bar:
[12:30, 12:35)

entry time:
12:30 open
```

因此：

```text
signal_time = 12:30
entry_time  = 12:30
```

二者 timestamp 可以相同，

但含义不同：

```text
signal_time = previous bar close
entry_time  = next bar open
```

必须通过字段名区分。

---

# Q7. 同一 timestamp 的全局处理顺序

整个引擎必须使用唯一的 deterministic event loop。

对于每一个 5m timestamp `T`：

按以下顺序执行。

## Step 1

处理所有上一根 K线在 `T` 收盘后才可确认的：

```text
1H event detection
B structure-break signals
time-expiry signals
```

---

## Step 2

建立：

```text
newly detected formal events
```

并创建 A orders。

---

## Step 3

处理 timestamp `T` 开盘时应发生的：

```text
pending B next-bar entries
gap stop exits
gap target exits
time-based open executions
```

已有持仓的退出检查优先于新仓位占用判断。

---

## Step 4

更新：

```text
position occupancy
```

---

## Step 5

处理新 event / 新 entry 是否遇到：

```text
SKIP_POSITION_BUSY
```

---

## Step 6

随后处理：

```text
[T, T+5m)
```

这一根 K线内部的：

```text
Maker touches
Stop/Target touches
B state transitions
```

---

# Q8. 新事件与旧 B 入场同时发生怎么办？

例如：

```text
15:00
```

同时：

- 旧 event 的 B signal 在前一根收盘确认；
- 新的 1H extreme event 在 15:00 被检测；
- 冷却条件允许新事件。

冻结处理：

### 先执行已经确认的 pending entry

然后更新持仓占用。

再创建新 event。

如果新 event 对同 strategy+symbol 后续需要交易，

而旧 B 已经持仓：

未来按正常：

```text
SKIP_POSITION_BUSY
```

规则处理。

理由：

> 旧信号在逻辑时间上已经早于新 event 的交易机会确定。

---

# Q9. Event Cooldown 如何计算？

Cooldown 基于：

```text
event_detected_at
```

而不是：

```text
source_bar_open_time
```

如果：

```text
previous_event_detected_at = 13:00
cooldown = 2h
```

则：

```text
next formal event allowed at >= 15:00
```

15:00 整点允许。

---

# Q10. B 的仓位什么时候计算？

B 不允许在 signal bar close 就冻结最终 qty。

因为真实 entry price 是：

```text
next bar open
```

冻结规则：

在：

```text
entry bar open
```

知道可交易 open price 后，

执行以下顺序。

---

# Q11. B Entry / Stop / Qty 计算顺序

严格按照：

```text
1. raw_entry_reference = next_bar.open

2. calculate actual_entry_fill
   using actual_entry_slippage

3. legalize entry_fill to tick_size
   using adverse-direction rounding

4. derive raw_stop_trigger
   from legalized entry price
   and ATR_pre

5. legalize stop_trigger
   using adverse-direction rounding

6. derive target_trigger

7. legalize target_trigger

8. calculate planned stop fill
   using sizing execution assumptions

9. calculate planned loss per raw unit

10. calculate raw_qty

11. floor qty to qty_step

12. check min_qty

13. check min_notional

14. if valid:
       enter position
```

---

# Q12. Price rounding 必须采用 adverse rounding

不得使用普通：

```text
round()
```

---

## SHORT

Entry sell：

为了不虚增收益，

实际模拟 entry price：

```text
round DOWN to tick
```

Stop buy：

```text
round UP
```

Target buy：

```text
round UP
```

---

## LONG

Entry buy：

```text
round UP
```

Stop sell：

```text
round DOWN
```

Target sell：

```text
round DOWN
```

目标是：

> 所有价格离散化默认不产生有利于策略的虚假改善。

---

# Q13. A Maker limit price 的取整

SHORT Maker：

```text
raw_limit =
event_trigger_close + K * ATR_pre
```

为了保持：

> 至少达到设定 extreme threshold

使用：

```text
round UP to tick
```

LONG：

```text
round DOWN to tick
```

---

# Q14. A 的 Qty 什么时候计算？

不得在 event creation 时计算最终数量。

Maker order 可以先挂：

```text
limit_price
```

但 qty 在订单创建时可以根据已知 limit price 和计划 stop 模型计算。

因为 A 的 entry price 已经事先确定为：

```text
legalized limit price
```

所以：

```text
qty
```

在 Maker order creation 时冻结。

成交以后不得重新根据实际未来价格调整 qty。

---

# Q15. A planned stop 怎么定义？

A order 创建时：

SHORT：

```text
planned_stop =
legalized_limit_price + STOP_ATR * ATR_pre
```

LONG 镜像。

价格合法化以后再进行 risk sizing。

---

# Q16. B 的 risk sizing 与 actual entry slippage

B 仓位计算发生于：

```text
next bar open
```

因此：

actual entry fill 已经可以根据 frozen execution rule 得出。

这不是未来信息。

所以 B risk sizing：

使用该：

```text
actual entry fill
```

作为 entry reference，

再使用：

```text
sizing_stop_slippage_bps
```

估算计划止损损失。

---

# Q17. Rebound 第一根碰到 Event High

必须立即处理。

上涨事件 SHORT：

处于：

```text
WAIT_REBOUND
```

的当前 K线首先检查：

```text
bar.high >= event_high
```

然后再判断 rebound start。

如果：

```text
bar.high > event_high
```

执行：

```text
new event_high
reset candidate
```

如果：

```text
bar.high == event_high
```

执行：

```text
reset candidate
```

event_high 不变。

当前 K线：

不得同时成为有效：

```text
REBOUND_START
```

即使：

```text
close > previous_close
```

也不允许。

---

# Q18. WAIT_REBOUND 的处理优先级

严格：

```text
1. Check >= event_high invalidation

2. If invalidated:
       reset
       optionally evaluate new effective pullback
       STOP processing rebound logic for old candidate

3. Otherwise check:
       close > previous_close
       AND
       close > pullback_low

4. Then enter REBOUND_ACTIVE
```

---

# Q19. DOWN/LONG 镜像

WAIT_REBOUND 中：

首先检查：

```text
bar.low <= event_low
```

若：

```text
<
```

更新 event_low + reset。

若：

```text
==
```

candidate reset。

当前 K线不得同时开始有效 counter-move。

---

# Q20. ATR 历史完整性额外依赖

计算：

```text
20 True Range
```

需要：

```text
20 event-prior hourly bars
+
the close immediately before those 20 bars
```

因此实际需要连续：

```text
21 hourly bars
```

的数据依赖。

例如 ATR 使用：

```text
TR[t-20 : t]
```

则必须存在：

```text
close[t-21]
```

用于第一根 TR。

缺少：

```text
HISTORY_GAP
```

---

# Q21. Return Quantile 历史依赖

2160 个历史 1H return：

```text
return[h] =
close[h] / close[h-1] - 1
```

因此要获得完整：

```text
2160 return observations
```

必须存在连续：

```text
2161 hourly closes
```

位于事件候选小时以前。

不得只有 2160 个 close。

---

# Q22. History Completeness

正式事件产生以前：

必须同时满足：

```text
ATR history dependency complete
AND
quantile history dependency complete
```

任何一个不完整：

```text
candidate_status = HISTORY_GAP
```

不得产生正式 event_id。

---

# Q23. A 组低成交率如何解释？

当前事件本身已经要求：

```text
abs(event return)
>= 3 * ATR_pre
```

随后 A 又等待：

```text
event_trigger_close ± K*ATR_pre
K = 3,4,5,6
```

因此 A 测试的是：

> 已经异常以后，再发生非常大的进一步延伸。

这是 v1.0.1 有意测试的特定假设。

不得因为 A：

```text
fill_rate 很低
```

就直接写：

```text
A没有优势
```

---

# Q24. A 的最低证据报告

每个 K 必须输出：

```text
formal_event_count
maker_eligible_count
maker_fill_count
maker_fill_rate

trade_count

event_ev
trade_ev

bootstrap_interval

effective_trade_sample_size
```

如果样本很少，

报告只能写：

> 当前样本对该 K 的交易后收益证据有限。

不得写：

> 该 K 无效。

---

# Q25. 禁止使用固定“最小样本数”自动判断有效/无效

v1.0.1 不设置：

```text
if n < 30: invalid
```

之类任意统计阈值。

程序只报告：

```text
N
coverage
interval width
```

由研究者解释证据强弱。

---

# Q26. Continuous Equity 的 restart

如果原始数据存在明显独立的完整数据区段：

允许划分：

```text
continuous_segment_id
```

例如：

```text
segment_001
segment_002
```

每个 segment：

从零重新计算 standalone continuous equity。

不得：

```text
segment_001 ending equity
+
segment_002
```

拼接为一条连续账户收益曲线。

---

# Q27. 人工路径测试优先于真实数据回测

在运行任何真实市场数据以前，

必须首先通过：

```text
tests/synthetic_paths/
```

中的人工路径测试。

至少建立以下场景。

---

## PATH 01 — Normal Maker Touch

验证：

```text
order activation
touch
fill
target
```

---

## PATH 02 — Post Only Reject

Activation bar：

SHORT：

```text
open > limit
```

验证 Reject。

---

## PATH 03 — Resting Order Gap Fill

订单已 resting。

下一根：

```text
open > short limit
```

验证：

成交，不 Reject。

---

## PATH 04 — Maker Fill + Same-Bar Reversal

验证：

Primary 与 Same-Bar-Target sensitivity

产生不同结果。

---

## PATH 05 — Gap Through Stop

验证：

```text
actual loss > planned loss
R < -1
```

---

## PATH 06 — B Perfect Exhaustion

```text
event high
↓
0.5 ATR pullback
↓
3-bar fixed window
↓
rebound above pullback_low
↓
lower high
↓
close below pullback_low
↓
next-bar entry
```

---

## PATH 07 — Straight Collapse

有效回撤后一路下降。

没有 rebound。

验证：

```text
NO_CONFIRMATION
```

---

## PATH 08 — Rebound Touches Equal High

验证：

candidate reset。

不得留下 lower-high candidate。

---

## PATH 09 — New High During Pullback

验证：

event_id unchanged
candidate reset
event_high updated
```

---

## PATH 10 — Signal on Observation Bar 24

验证：

第24根可以 signal。

第25根 open 可以 entry。

---

## PATH 11 — Data Gap Before Entry

验证：

```text
DATA_GAP_PRE_ENTRY
```

---

## PATH 12 — Data Gap Pending B Entry

验证：

```text
DATA_GAP_PENDING_ENTRY
```

---

## PATH 13 — Data Gap In Position

验证：

交易变：

```text
INDETERMINATE
```

且缺口前费用和 MTM path 保留。

---

## PATH 14 — Trade Closes Before Later Data Gap

验证：

已完成 PnL 不会被未来 gap 删除。

---

## PATH 15 — Realized vs MTM Drawdown

构造：

```text
large unrealized loss
→ recovery
→ profitable exit
```

必须：

```text
MTM DD >> realized DD
```

---

## PATH 16 — MAE Exit Boundary

SHORT：

```text
entry 100
stop 110
bar high 125
```

验证：

known MAE 不得使用 125。

---

## PATH 17 — Historical Gap

21-hour ATR dependency 任一点缺失：

不得生成 event。

---

## PATH 18 — Quantile Dependency

2161 close dependency 缺失：

不得生成 event。

---

## PATH 19 — Same Timestamp Old Entry + New Event

验证：

pending old entry
→ position occupancy
→ new event handling
```

顺序固定。

---

## PATH 20 — DOWN/LONG Mirror

完整重复核心路径，

验证 LONG 方向不是错误的 SHORT copy。

---

# Q28. Synthetic Path 输出要求

每条人工测试路径除了 assert，

还必须输出 debug trace。

例如：

```text
12:00 EVENT_ACTIVE
12:05 PULLBACK_WINDOW_1
12:10 PULLBACK_WINDOW_2
12:15 PULLBACK_WINDOW_3
12:20 WAIT_REBOUND
12:25 REBOUND_ACTIVE
12:30 SIGNAL_CONFIRMED
12:35 ENTRY
```

发生 reset 时：

```text
RESET_REASON = NEW_EVENT_HIGH
```

这样可以人工检查程序状态。

---

# Q29. 在 Synthetic Tests 全部通过以前禁止运行参数比较

开发顺序必须：

```text
1. deterministic state engine

2. synthetic path tests

3. execution tests

4. accounting tests

5. data-gap tests

6. real historical data smoke test

7. full historical run
```

不得一开始就运行：

```text
A_K3/K4/K5/K6 vs B
```

然后根据曲线调代码。

---

# Q30. 最终实现冻结标准

只有以下全部完成，

才把规格从：

```text
implementation baseline
```

升级为：

```text
IMPLEMENTATION_FROZEN
```

检查：

```text
[ ] Continuous equity 与 evaluable-subset equity 分开

[ ] Data-gap trade 的缺口前路径不会消失

[ ] 无法判断账户路径不会被前后直接拼接

[ ] MAE/MFE 严格服从 simulated exit time

[ ] simulated fills 可以进入 excursion bound

[ ] signal bar / entry bar 时间定义统一

[ ] 全局 timestamp event-loop 顺序固定

[ ] pending entry 与新 event 同时发生的顺序固定

[ ] B position sizing 时点固定

[ ] A position sizing 时点固定

[ ] price rounding direction 固定

[ ] qty rounding 固定为 floor to step

[ ] WAIT_REBOUND 第一根 equal high/low 失效

[ ] ATR history dependency = 21 hourly bars

[ ] quantile dependency = 2161 hourly closes

[ ] A low fill rate 被作为证据强度问题报告

[ ] Synthetic PATH 01–20 全部通过

[ ] 所有状态转换均能输出 debug trace
```

---

# Final Rule

如果人工价格路径与程序输出不一致：

> 优先修程序，不允许修改人工路径以迎合程序。

如果规格与人工路径存在真正冲突：

记录：

```text
SPEC_CONFLICT
```

暂停相关真实数据结果解释。

不得为了让收益曲线更好看而选择某一种解释。

在所有 synthetic path tests 通过以前：

> 不讨论策略盈利性。