# Frozen Backtest Specification v1.0.1

## 0. 本文件的法律地位

本文件是 v1.0 的强制覆盖补丁。

若本文件与 v1.0 任意章节冲突：

> **以 v1.0.1 为准。**

除本文件明确修改的内容外，v1.0 其他策略条件保持不变。

禁止借 v1.0.1：

- 增加新的交易指标；
- 增加 VWAP / OI / Funding 信号；
- 优化参数；
- 添加加仓；
- 添加再入场；
- 改变 A/B 的研究问题。

---

# 1. 研究范围重新声明

v1.0.1 只研究：

> **单个 1H 周期出现统计异常收益以后，在随后固定观察窗口内进行逆向交易。**

当前版本不研究：

- 连续多日缓慢上涨；
- 连续多日缓慢下跌；
- 长期震荡后的首次突破；
- 第二次趋势脉冲；
- 日线级情绪周期。

因此最终报告只能评价：

> `1H extreme return event → short-horizon reversal`

这一类事件。

不得将结果解释成：

> 原始“情绪策略”整体成立或失败。

README 和 report 必须明确写出该限制。

---

# 2. 时间字段彻底拆分

禁止再使用一个模糊的 `event_trigger_time` 同时表达多个含义。

每个事件必须保存：

```text
source_bar_open_time
source_bar_close_time
event_detected_at
order_active_at
observation_start_time
observation_end_time
```

所有时间 UTC。

---

# 3. 时间示例

假设异常 1H K线为：

```text
12:00:00 <= time < 13:00:00
```

则：

```text
source_bar_open_time  = 12:00
source_bar_close_time = 13:00
event_detected_at     = 13:00
```

因为只有到了：

```text
13:00
```

才能知道 12:00—13:00 这一根 1H K线最终收盘结果。

绝对禁止：

```text
event_detected_at = 12:00
```

---

# 4. A组订单生效时间

v1.0.1 冻结执行假设：

```text
MAKER_ACTIVATION_DELAY_BARS = 0
```

因此：

```text
order_active_at = event_detected_at
```

即：

13:00 检测事件后，

允许 A 组订单参与：

```text
13:00—13:05
```

这一根 5m K线。

这是：

> 零 5m-bar 延迟的事件驱动执行假设。

它不是对真实网络延迟的模拟。

报告必须注明这一点。

---

# 5. 观察窗口定义

如果：

```text
event_detected_at = 13:00
```

则第 1 根观察 K线：

```text
13:00—13:05
```

第 24 根：

```text
14:55—15:00
```

因此：

```text
observation_start_time = 13:00
observation_end_time   = 15:00
```

窗口采用：

```text
[start, end)
```

语义处理 K线开盘时间。

A 组 Maker 挂单可以在第 24 根观察 K线内成交。

第 24 根结束以后未成交：

```text
NO_FILL
```

---

# 6. B组最后一根观察 K线

B 的：

```text
signal
```

允许在第 24 根观察 K线收盘时确认。

例如：

```text
14:55—15:00
```

收盘于 15:00 时满足结构破坏。

则：

```text
signal_time = 15:00
```

下一根：

```text
15:00—15:05
```

的 open 仍允许作为实际入场。

即：

> 观察窗口限制的是“信号生成时间”，不是已经生成信号后的 next-bar execution。

如果下一根不存在或缺失：

```text
DATA_GAP_PENDING_ENTRY
```

不得假设成交。

---

# 7. 历史窗口使用真实时间，不压缩时间轴

历史 2160 小时窗口定义为：

```text
[t - 2160 hours, t)
```

而不是：

> 向前找 2160 根有效 K线。

禁止删除缺失小时后，把更早的数据向前压缩补满 2160 个样本。

ATR_pre 的 20 根小时 K线也必须是：

> 候选事件前连续的 20 个真实小时。

若其中存在缺失：

```text
candidate_event_invalid = HISTORY_GAP
```

不得生成正式事件。

历史分位数同样使用固定 wall-clock window。

v1.0.1 为保证口径纯净：

如果这 2160 小时窗口存在小时级数据缺失，

则该候选事件：

```text
HISTORY_GAP
```

不进入正式 event dataset。

不得插值。

---

# 8. 缺失数据规则彻底修改

删除 v1.0：

> “观察窗口出现任何缺失，所有策略 PnL=0”

这一规则。

数据无法判断：

**不等于策略主动不交易。**

---

# 9. 缺失数据：入场前

如果某策略仍处于：

```text
等待Maker成交
等待pullback
等待rebound
等待structure break
```

期间遇到缺失的预期 5m K线：

该策略在该 event 上：

```text
status = DATA_GAP_PRE_ENTRY
```

并停止继续模拟。

此时：

```text
PnL = null
R   = null
```

不是：

```text
0
```

---

# 10. 缺失数据：信号后、入场前

例如 B：

结构破坏已经在 12:25 close 确认，

但 12:30 的 next bar 缺失。

结果：

```text
DATA_GAP_PENDING_ENTRY
```

```text
PnL = null
R   = null
```

不得使用 12:35 的 open 替代。

---

# 11. 缺失数据：持仓期间

交易已经实际入场以后，

如果在平仓前遇到缺失 K线：

```text
status = DATA_GAP_IN_POSITION
```

此时该交易结果属于：

```text
INDETERMINATE
```

保存：

```text
entry_time
entry_fill
qty
stop
target
```

但：

```text
exit_time = null
PnL = null
R = null
```

不得：

- 假设没有亏损；
- 假设按最后价格平仓；
- 把结果记成 0；
- 继续越过数据缺口模拟。

---

# 12. 缺失发生在交易已经平仓以后

例如：

13:10 入场，

13:30 止损完成，

14:10 才发生数据缺口。

则：

> 13:30 已经完成的交易结果必须保留。

不得因为未来缺数据而删除此前亏损或盈利。

但是：

如果未来 24H path metrics 因缺数据无法完整计算，

则：

```text
event_path_metrics_valid = false
```

对应：

```text
event_adverse_extension = null
event_max_reversion = null
```

交易 PnL 不受影响。

---

# 13. Event EV 分母重新定义

必须区分：

## Strategy No-Trade

例如：

```text
NO_FILL
NO_CONFIRMATION
EVENT_TIMEOUT
SKIP_SIZE_CONSTRAINT
SKIP_POSITION_BUSY
```

这些属于：

> 策略在有效数据环境下选择或无法产生交易。

它们：

```text
PnL = 0
R = 0
```

并进入 Event EV 分母。

---

## Data-Invalid

例如：

```text
DATA_GAP_PRE_ENTRY
DATA_GAP_PENDING_ENTRY
DATA_GAP_IN_POSITION
```

这些不是策略结果。

它们：

```text
PnL = null
R = null
```

不得用 0 填充。

Primary Event EV：

```text
sum(valid_strategy_pnl)
/
evaluable_event_count
```

其中：

```text
evaluable_event_count
=
TRADED
+
valid strategy no-trade
```

不包含 Data-Invalid。

---

# 14. 必须额外报告 Coverage

每个策略输出：

```text
total_formal_events
evaluable_events
data_invalid_events
evaluation_coverage_rate
```

其中：

```text
evaluation_coverage_rate
=
evaluable_events / total_formal_events
```

禁止一个策略通过大量 Data-Invalid 获得虚假的 Event EV 优势。

---

# 15. A/B 配对比较的数据集合

比较：

```text
B vs A_K3
```

时，

Primary Paired Dataset 只允许包含：

> A_K3 与 B 两边都属于 evaluable 的 event_id。

同理：

```text
B vs A_K4
B vs A_K5
B vs A_K6
```

分别构造交集。

同时报告：

```text
paired_event_count
pair_coverage_rate
excluded_due_to_A_data_gap
excluded_due_to_B_data_gap
excluded_due_to_both_data_gap
```

不得把不可判断的结果当 0 配对。

---

# 16. Maker 模型重新定义

A 组明确使用：

```text
OHLC touch + full fill + small simulated order assumption
```

它不是订单簿级真实成交模型。

报告必须显示：

```text
maker_fill_model =
OHLC_TOUCH_FULL_FILL_NO_QUEUE_MODEL
```

并注明：

> 未模拟挂单排队位置、队列优先级、部分成交及盘口深度。

因此 A 组结论必须称为：

> 特定 OHLC Maker 成交假设下的结果。

---

# 17. Post Only 在激活时价格已经穿越挂单

只针对订单首次激活的那一刻判断。

SHORT Maker：

如果 activation bar：

```text
bar.open > limit_price
```

说明挂单提交时市场已经位于限价上方。

卖出 Post Only 挂单将具有立即成交/吃单风险。

因此 v1.0.1：

```text
POST_ONLY_REJECTED_ON_ACTIVATION
```

该 event 的该 A 策略版本：

```text
PnL = 0
R = 0
```

不自动重新挂单。

---

LONG Maker：

如果：

```text
bar.open < limit_price
```

同样：

```text
POST_ONLY_REJECTED_ON_ACTIVATION
```

---

如果：

```text
bar.open == limit_price
```

v1.0.1 允许订单进入 OHLC touch 模型。

---

# 18. 已经成功挂入订单后的 Gap

Post Only Reject 只在：

> 首次提交时

判断。

如果订单上一根 K线已经处于 resting 状态，

下一根 K线直接跳过限价：

SHORT：

```text
bar.open > limit_price
```

LONG：

```text
bar.open < limit_price
```

则视为：

> 原 resting order 已被成交。

成交价仍保守记为：

```text
limit_price
```

不给予跳空产生的价格改善。

---

# 19. Maker 普通 Touch 成交

SHORT：

订单已经有效且：

```text
bar.open <= limit_price
bar.high >= limit_price
```

则：

```text
fill = limit_price
```

LONG 镜像。

假设整笔成交。

---

# 20. A组成交当根 K线不能简单称为“保守模型”

删除：

> 禁止同根止盈是保守处理

这样的表述。

正确表述：

> 由于 5m OHLC 无法知道 Maker fill 与该 K线低点/高点发生的先后顺序，因此同 K 线存在执行顺序不确定性。

---

# 21. A组 Primary 同根规则

Primary Model 保持：

### SHORT

Maker fill 当根：

如果：

```text
high >= stop_trigger
```

允许 Stop。

原因：

在 activation / resting price 位于 limit 以下或等于 limit 的正常 touch 情形中，

价格若继续达到更高 stop，

必然已经经过 entry。

但是：

如果：

```text
low <= target_trigger
```

不得直接假定 Target 一定发生在 fill 后。

Primary：

```text
same_bar_target_not_executed
```

---

LONG 完全镜像。

---

# 22. A组必须额外跑 Execution Sensitivity

不能只给 Primary。

另外运行一个：

```text
A_SAME_BAR_TARGET_ALLOWED
```

执行敏感性版本。

这不是新的交易策略。

它只改变：

> Maker fill 当根 K线，target touch 是否被认为发生在成交以后。

输出时禁止和：

```text
A_K3
A_K4
...
```

混成新策略参数。

只作为：

```text
Execution Sensitivity
```

报告。

这样可以看到：

> A/B 结论是否严重依赖第一根 K线的 OHLC 顺序假设。

如果 Primary 与 Sensitivity 得出明显不同方向的结论，

报告必须标记：

```text
EXECUTION_ASSUMPTION_SENSITIVE = true
```

---

# 23. Stop/Target 普通 K线同根触及

如果已经持仓，

某根非 Gap K线同时：

```text
stop touched
target touched
```

Primary：

```text
STOP_FIRST
```

同时记录：

```text
intrabar_order_ambiguous = true
```

禁止把 STOP_FIRST 描述成真实盘中顺序。

它只是：

> v1.0.1 的固定保守执行约定。

---

# 24. Gap 穿越止损

这是 v1.0 缺失的重要规则。

SHORT：

如果某根持仓 K线：

```text
bar.open >= stop_trigger
```

则不能按：

```text
stop_trigger
```

成交。

实际基准成交价：

```text
execution_base_price = bar.open
```

然后：

```text
actual_exit_fill =
bar.open *
(1 + actual_exit_slippage_bps / 10000)
```

LONG：

如果：

```text
bar.open <= stop_trigger
```

则：

```text
actual_exit_fill =
bar.open *
(1 - actual_exit_slippage_bps / 10000)
```

---

# 25. Gap 穿越 Target

同样定义。

SHORT：

若：

```text
bar.open <= target_trigger
```

则：

```text
execution_base_price = bar.open
actual_fill =
bar.open *
(1 + actual_exit_slippage_bps / 10000)
```

LONG：

若：

```text
bar.open >= target_trigger
```

则：

```text
actual_fill =
bar.open *
(1 - actual_exit_slippage_bps / 10000)
```

不给 target_trigger 强制成交。

---

# 26. Planned Execution 与 Actual Execution 分开

config 删除模糊字段：

```text
entry_slippage_bps
exit_slippage_bps
```

改为：

```yaml
execution:
  maker_fee_bps: REQUIRED
  taker_fee_bps: REQUIRED

  sizing_entry_slippage_bps: REQUIRED
  sizing_stop_slippage_bps: REQUIRED

  actual_entry_slippage_bps: REQUIRED
  actual_exit_slippage_bps: REQUIRED
```

仓位计算：

使用：

```text
sizing_*
```

真正回测成交：

使用：

```text
actual_*
```

两组数值允许相同，

但概念必须完全分离。

---

# 27. Risk Budget 的正确含义

```text
risk_budget_usdt
```

定义为：

> 在计划 Stop 价格、计划手续费和 sizing execution cost 假设下计算的预计最大计划损失。

不是：

> 实际亏损绝对上限。

---

# 28. 超过 -1R 必须来自真实执行机制

禁止人为：

```text
if R < -1:
    ...
```

也禁止故意随机扩大损失来制造尾部。

R < -1 应自然来自：

- Gap 穿越 stop；
- actual execution cost 高于 sizing assumption；
- 交易所价格离散化；
- 费用差异。

---

# 29. Test 11 修改

旧 Test 11 删除。

新 Test：

构造 SHORT：

```text
entry = 100
stop_trigger = 110
```

下一根：

```text
open = 120
```

则必须按：

```text
120 + actual slippage
```

附近退出，

并验证：

```text
R < -1
```

在合适的风险参数下成立。

不得裁剪。

---

# 30. B组状态机重新冻结

上涨事件 SHORT 使用：

```text
EVENT_ACTIVE
PULLBACK_WINDOW
WAIT_REBOUND
REBOUND_ACTIVE
SIGNAL_CONFIRMED
```

删除：

```text
LOWER_HIGH_CONFIRMED
```

这个独立状态。

Lower High 改为：

> Structure Break 发生时检查的必要条件。

---

# 31. B组处理顺序

每一根新的完整 5m bar：

第一步必须保存：

```text
old_event_high = event_high
```

然后判断：

```text
made_new_high =
bar.high > old_event_high
```

禁止：

先：

```text
event_high = max(event_high, bar.high)
```

再执行：

```text
bar.high > event_high
```

这种永远为 false 的逻辑。

必须有单元测试。

---

# 32. EVENT_ACTIVE

处理当前 bar：

```text
event_high =
max(old_event_high, bar.high)
```

然后按该更新后的 event_high 计算：

```text
event_high - bar.close
```

如果：

```text
>= 0.5 * ATR_pre
```

则当前 bar 本身作为：

```text
pullback_window_bar_1
```

进入：

```text
PULLBACK_WINDOW
```

因此允许：

> 同一根 5m K线先创事件新高，再收盘形成有效回撤。

这是因果一致的，因为判断发生在该 bar 收盘。

---

# 33. PULLBACK_WINDOW

从有效回撤首次确认的 bar 开始，

固定收集：

```text
3根完整5m K线
```

包括：

> 首次满足有效回撤的那根。

期间如果后续 bar：

```text
bar.high > event_high_before_bar
```

则原 pullback candidate 失效。

执行：

```text
event_high = bar.high

clear pullback bars
clear pullback_low
clear rebound state

reset_count += 1
state = EVENT_ACTIVE
```

然后：

在该 bar 收盘时，

允许基于新的：

```text
event_high
```

重新检查一次：

```text
event_high - bar.close >= 0.5 ATR_pre
```

如果仍满足，

该 bar 可以立刻成为：

```text
新的 pullback_window_bar_1
```

不得创建新 event_id。

---

# 34. pullback_low

三根固定窗口结束后：

```text
pullback_low =
min(low of exactly those 3 bars)
```

永久固定。

之后任何更低价格：

不得修改这个 pullback_low。

进入：

```text
WAIT_REBOUND
```

---

# 35. Rebound 检测不能与 Pullback Window 重叠

反弹检测最早从：

> pullback window 完成后的下一根完整 5m bar

开始。

第三根 pullback K线本身：

即使：

```text
close > previous close
```

也不算 rebound 开始。

---

# 36. WAIT_REBOUND

上涨事件做空：

反弹开始必须同时满足：

```text
current_close > previous_close
```

以及：

```text
current_close > pullback_low
```

这样避免：

价格已经跌破 pullback_low 后，

仅仅出现一个仍位于 pullback_low 下方的小幅上涨，

就被当作有效反弹。

满足后：

```text
state = REBOUND_ACTIVE
rebound_start_time = current_bar.close_time
rebound_high = current_bar.high
```

---

# 37. WAIT_REBOUND 期间创新高

如果：

```text
bar.high > event_high
```

则：

```text
event_high = bar.high
clear entire pullback/rebound candidate
state = EVENT_ACTIVE
reset_count += 1
```

并允许在该 bar close：

重新判断有效回撤。

---

# 38. REBOUND_ACTIVE

持续更新：

```text
rebound_high =
max(rebound_high, bar.high)
```

如果：

```text
bar.high > event_high
```

则：

更新 event_high，

整个结构 reset。

---

# 39. Equal High 的处理

为了让：

```text
lower high
```

具有严格含义，

如果 REBOUND_ACTIVE 期间：

```text
bar.high >= event_high
```

则当前 lower-high candidate 失效。

其中：

- `>`：更新 event_high 后 reset；
- `==`：event_high 不变，但清空当前 pullback/rebound candidate 并回到 EVENT_ACTIVE。

不得把：

```text
rebound_high == event_high
```

称为 lower high。

---

# 40. SHORT Structure Break

只有在已经：

```text
REBOUND_ACTIVE
```

以后，

某个后续完整 5m bar 首次：

```text
close < pullback_low
```

并且：

```text
rebound_high < event_high
```

才确认：

```text
SIGNAL_CONFIRMED
```

注意：

产生 rebound 的那根 K线：

```text
close > pullback_low
```

因此不可能和 structure break 为同一根 K线。

这强制形成：

```text
回撤
→ 固定低点
→ 真正反弹回到该低点上方
→ 较低高点
→ 再次跌破原低点
```

---

# 41. SIGNAL_CONFIRMED 后

保存：

```text
signal_time
```

停止修改该信号。

实际入场：

```text
next available expected 5m bar open
```

如果该 bar 缺失：

```text
DATA_GAP_PENDING_ENTRY
```

---

# 42. 下跌事件 LONG 严格镜像

DOWN event：

使用：

```text
event_low
pullback_high
rebound_low
```

有效反弹：

```text
bar.close - event_low
>=
0.5 * ATR_pre
```

固定三根窗口：

```text
pullback_high =
max(high of exactly 3 bars)
```

随后等待向下 counter-move。

开始条件：

```text
current_close < previous_close
AND
current_close < pullback_high
```

进入：

```text
REBOUND_ACTIVE
```

这里的名字仍可复用 generic state。

持续记录：

```text
rebound_low
```

最终 LONG signal：

```text
close > pullback_high
AND
rebound_low > event_low
```

如果过程中：

```text
bar.low <= event_low
```

则当前 higher-low candidate 失效。

`<` 更新新的 event_low。

`==` 清空 candidate。

必须为 DOWN 方向单独写测试。

---

# 43. 第24根产生 Signal 的行为

明确冻结：

如果：

```text
signal_time
```

正好等于：

```text
observation_end_time
```

允许：

```text
next-bar open entry
```

只要 next bar 数据存在。

因此：

```text
signal deadline
```

和：

```text
entry deadline
```

不是同一个概念。

---

# 44. Trade MAE/MFE 不能再假装精确

因为 5m OHLC 不包含盘中路径，

删除单一的：

```text
trade_MAE
trade_MFE
```

作为“精确真值”的说法。

改为输出：

```text
trade_mae_known
trade_mae_ohlc_upper_bound

trade_mfe_known
trade_mfe_ohlc_upper_bound
```

---

# 45. Known Excursion

`known` 只使用：

- 明确发生在入场以后的完整 K线；
- 明确发生在平仓以前的完整 K线；
- entry price；
- exit price；
- 由 stop/target 触发所必然达到的价格。

不把无法确认是在 entry 前还是 exit 后的 boundary-bar 极值当成确定事实。

---

# 46. OHLC Upper Bound

`ohlc_upper_bound`：

允许把 entry bar 和 exit bar 的完整 high/low 纳入，

作为：

> 在 OHLC 数据下可能达到的更极端范围。

它不是实际发生顺序的证明。

因此真实 MAE/MFE 被描述为：

```text
known <= true excursion <= OHLC-compatible bound
```

具体方向按 LONG/SHORT 分别实现。

---

# 47. B 组 Entry Bar

B 在：

```text
next bar open
```

入场。

如果不是同 bar exit，

则该 bar 从 open 以后整个 high/low 都属于：

> 入场后价格路径。

因此可以进入 known excursion。

如果该 bar 同时触发 exit，

仍存在：

> exit 之后 extreme

的不确定性。

超过 exit 所需的部分只能进入 OHLC bound。

---

# 48. A组 Entry Bar

Maker 是盘中成交。

因此 boundary bar 需要特别处理。

SHORT Maker：

- 从 entry 到更高 adverse price 的路径，在正常 touch 情况下属于已入场以后，可用于 known MAE；
- 该 K线更低的 low 可能出现在 fill 前，因此不能自动计入 known MFE。

LONG 镜像。

必须写专门测试。

---

# 49. Exit Bar

若：

```text
TIME EXIT at bar close
```

则整根 exit bar 都发生于 exit 以前，

可以进入 known。

若：

```text
STOP/TARGET intrabar
```

则 bar 在触发后的剩余 high/low 顺序未知。

因此：

- 触发所必须达到的价位进入 known；
- 额外 extreme 只进入 upper bound。

---

# 50. 最大回撤拆成两套

必须同时输出：

```text
realized_equity_drawdown
mark_to_market_drawdown
```

---

# 51. Realized Equity

按交易实际 exit_time：

累计：

```text
realized pnl
```

得到：

```text
realized_equity_curve
```

该曲线用于衡量：

> 已实现收益路径。

但不能代表持仓期间扛单风险。

---

# 52. Mark-to-Market Equity

按每根 5m K线计算：

```text
equity_t =
cumulative_realized_pnl
+
sum(unrealized_pnl_of_open_positions_at_close)
```

手续费：

entry fee 在发生时扣除。

exit fee 在实际退出时扣除。

得到：

```text
mtm_equity_curve
```

计算：

```text
MTM max drawdown
```

这是研究：

> 实际持仓浮亏风险

的主要回撤指标。

---

# 53. Data-Invalid Trade 不允许偷偷进入 Equity

如果某交易：

```text
DATA_GAP_IN_POSITION
```

则该交易完整 PnL 无法确定。

Primary equity / drawdown 统计：

不得把它当 0。

只使用：

```text
evaluable trades
```

同时报告：

```text
equity_evaluation_coverage
indeterminate_open_trade_count
```

---

# 54. 多币种同时持仓的资金含义

v1.0.1 不设置：

- 总账户权益；
- 总保证金上限；
- 总组合风险上限；
- 最大跨 symbol 同时仓位。

因此：

不同 symbol 可以同时持有仓位。

所以生成的 aggregate equity curve 必须命名：

```text
unconstrained_experimental_equity
```

不得称为：

```text
real account return
account ROI
deployable portfolio return
```

---

# 55. 必须额外报告并发风险

输出：

```text
max_concurrent_positions
mean_concurrent_positions

peak_concurrent_planned_risk_usdt
```

其中：

```text
peak_concurrent_planned_risk_usdt
=
max(
    sum(risk_budget_usdt for all open evaluable positions)
)
```

这只是暴露潜在资本需求。

不改变交易规则。

---

# 56. Funding 处理

v1.0.1 仍不加入 Funding 数据。

但禁止把最终收益简单称为：

```text
net_pnl
```

Primary 字段更名为：

```text
pnl_after_fees_slippage_ex_funding
```

同时保存：

```text
funding_included = false
```

报告明确说明：

> 结果已经扣除本模型中的手续费和滑点，但未扣除永续合约资金费。

因此不能称为：

> 完整的永续合约净收益。

---

# 57. Event Path Metrics 与 Funding 无关

以下指标仍可正常计算：

```text
event_adverse_extension
event_max_reversion
```

但若固定 24H evaluation window 存在任何缺失：

```text
event_path_metrics_valid = false
```

两个指标：

```text
null
```

禁止缩短窗口后仍与完整 24H 样本混合。

---

# 58. Bootstrap 重新定义

Primary paired bootstrap：

按：

```text
UTC calendar day of event_detected_at
```

聚类。

每次：

随机有放回抽取 calendar day。

被抽到的 day：

将该日所有 paired events 整体加入 bootstrap sample。

---

# 59. Bootstrap Event EV Delta

禁止：

> 先算每天 Event EV，再平均每天 Event EV。

正确计算：

对于每次 bootstrap sample：

```text
delta_sum =
sum(B_pnl - A_pnl across all sampled paired events)
```

```text
n =
total paired event observations
in sampled days
```

然后：

```text
bootstrap_delta_event_ev =
delta_sum / n
```

如果某天被抽到两次：

该日所有事件也复制两次。

---

# 60. Bootstrap 限制

1日 block 只能部分处理：

> 日内事件聚类。

它无法完全消除：

- 跨日趋势依赖；
- 连续市场状态依赖；
- 24H event path window 重叠。

因此报告中称：

```text
cluster-bootstrap interval
```

不得写：

```text
independence-adjusted proof
```

v1.0.1 Bootstrap 只用于：

```text
paired Event EV PnL difference
```

不用于 24H path metric 的显著性结论。

---

# 61. Status Enum 更新

至少：

```text
TRADED_TARGET
TRADED_STOP
TRADED_TIME

NO_FILL
NO_CONFIRMATION
EVENT_TIMEOUT

POST_ONLY_REJECTED_ON_ACTIVATION

SKIP_SIZE_CONSTRAINT
SKIP_POSITION_BUSY

DATA_GAP_PRE_ENTRY
DATA_GAP_PENDING_ENTRY
DATA_GAP_IN_POSITION
```

数据问题与策略 no-trade 必须分开。

---

# 62. Strategy Result Schema 更新

新增：

```text
source_bar_open_time
source_bar_close_time
event_detected_at

order_active_at
observation_start_time
observation_end_time

data_valid_for_strategy
data_gap_time

maker_fill_model
post_only_rejected

same_bar_target_ambiguous
intrabar_order_ambiguous

actual_entry_slippage_bps
actual_exit_slippage_bps

pnl_after_fees_slippage_ex_funding
funding_included

trade_mae_known
trade_mae_ohlc_upper_bound

trade_mfe_known
trade_mfe_ohlc_upper_bound
```

---

# 63. Event Dataset 更新

新增：

```text
history_window_start
history_window_end
history_complete

path_metrics_valid
path_data_gap_time
```

不得通过删除缺失时间压缩 history/evaluation window。

---

# 64. Primary 报告指标更新

每个策略版本必须报告：

```text
formal_events
evaluable_events
data_invalid_events
evaluation_coverage_rate

trade_count
strategy_no_trade_count

participation_rate

event_ev_ex_funding
trade_ev_ex_funding

realized_max_drawdown
mtm_max_drawdown

max_concurrent_positions
peak_concurrent_planned_risk
```

---

# 65. A组额外执行敏感性报告

每个 K：

至少显示：

```text
Primary OHLC execution
Same-bar-target-allowed sensitivity
```

比较：

```text
Event EV
Trade EV
Fill rate
Stop rate
Target rate
MTM drawdown
```

如果 A/B 排序随这一执行假设翻转：

必须在 report 顶部写：

```text
A/B conclusion is execution-model sensitive.
```

不得隐藏。

---

# 66. 新增单元测试：时间

## Test T1

1H source bar：

```text
open = 12:00
close = 13:00
```

必须：

```text
event_detected_at = 13:00
```

而不是12:00。

---

## Test T2

13:00 detection，

A 零-bar delay：

13:00—13:05 可以参与 Maker 模拟。

---

## Test T3

第24根 5m K线 close 才产生 B signal：

next bar open 仍允许 entry。

---

# 67. 新增单元测试：数据缺口

## Test D1

尚未入场遇到 gap：

```text
DATA_GAP_PRE_ENTRY
PnL = null
```

---

## Test D2

已平仓以后未来出现 gap：

原交易 PnL 不变。

---

## Test D3

持仓过程中 gap：

```text
DATA_GAP_IN_POSITION
PnL = null
```

不能记0。

---

## Test D4

Event EV：

Data-Invalid 不进入 evaluable denominator。

Strategy No-Trade 以0进入 denominator。

---

# 68. 新增单元测试：Maker

## Test M1

SHORT Post Only 首次激活：

```text
open > limit
```

必须：

```text
POST_ONLY_REJECTED_ON_ACTIVATION
```

---

## Test M2

订单已经 resting，

下一根：

```text
open > limit
```

不得 Post Only Reject。

应该视为成交。

---

## Test M3

A Maker fill bar：

target 被 touch，

Primary 不允许直接 same-bar target。

Sensitivity 版本允许。

---

## Test M4

A fill bar：

stop 被确认穿越，

Primary 可以止损。

---

# 69. 新增单元测试：Gap Stop

## Test G1

SHORT：

```text
stop = 110
next open = 120
```

必须以：

```text
120 + actual slippage
```

为基准退出。

不得110成交。

---

## Test G2

确保在适当 risk sizing 下：

```text
R < -1
```

自然出现。

---

# 70. 新增单元测试：B状态机

## Test B1

必须使用：

```text
old_event_high
```

判断新高。

---

## Test B2

Pullback Low 固定以后、

Rebound 开始以前出现新 event high：

必须 reset。

---

## Test B3

Pullback window 第三根上涨：

不得直接算 rebound start。

---

## Test B4

未来 bar：

```text
close > prev_close
```

但：

```text
close <= pullback_low
```

不得开始 rebound。

---

## Test B5

必须先出现：

```text
close > pullback_low
AND
close > previous close
```

之后，

后续另一根 bar：

```text
close < pullback_low
```

才可能触发 SHORT signal。

---

## Test B6

Rebound high：

```text
== event_high
```

不得作为 Lower High。

---

## Test B7

Signal 在最后观察 bar：

next bar open 允许 entry。

---

## Test B8

DOWN/LONG 方向完整镜像测试。

---

# 71. 新增 MAE/MFE 测试

构造：

A Maker 在 K线中间成交。

该 K线：

```text
high
low
```

分别位于 entry 两侧。

验证：

```text
known excursion
```

不会把无法确定发生在 fill 之后的 favorable extreme 当成确定值。

同时：

```text
ohlc_upper_bound
```

可以包含该 extreme。

---

# 72. 新增 Drawdown 测试

构造：

```text
entry
→ 浮亏很大
→ 最终盈利退出
```

必须出现：

```text
realized drawdown 很小
```

但：

```text
MTM drawdown 较大
```

确保两套回撤没有被错误实现成同一个指标。

---

# 73. 新增 Bootstrap 测试

假设：

Day 1：

```text
10 events
```

Day 2：

```text
1 event
```

必须验证：

Bootstrap replicate 使用：

```text
总 delta PnL / 总 event count
```

不能：

```text
(Day1 EV + Day2 EV) / 2
```

除非两天事件数量恰好相同。

---

# 74. 报告结论边界

报告允许写：

> 在当前 1H 异常事件定义、固定参数和指定 OHLC 执行模型下，观察到 B 与 A_Kx 在 Event EV、尾部风险或 MTM drawdown 上存在如下差异……

报告禁止写：

> 情绪策略整体有效。

禁止写：

> 等待衰竭一定优于提前挂单。

禁止写：

> Maker 实盘一定能获得这里的成交率。

禁止写：

> 这是账户实际可实现收益。

禁止写：

> 已经包含永续合约全部成本。

---

# 75. v1.0.1 最终验收新增项目

```text
[ ] 1H bar open / close / detection time完全分开

[ ] observation window没有错开1小时

[ ] history window按真实wall-clock时间计算

[ ] 数据缺口不会被当成0收益

[ ] 已完成交易不会因未来缺数据被删除

[ ] 持仓期间缺数据被标记为indeterminate

[ ] Post Only activation gap有明确处理

[ ] resting Maker跨bar gap有明确处理

[ ] A同bar target执行假设有Sensitivity报告

[ ] Gap stop按open而不是stop trigger成交

[ ] R可以自然小于-1

[ ] B状态机比较old event extreme

[ ] pullback window与rebound window不重叠

[ ] rebound必须真正回到pullback level上方/下方

[ ] lower high / higher low有严格定义

[ ] 第24根signal允许next-bar entry

[ ] MAE/MFE输出known与OHLC bound

[ ] realized drawdown与MTM drawdown同时输出

[ ] Funding明确未计入

[ ] 收益字段明确标记ex-funding

[ ] 多symbol equity明确标记unconstrained

[ ] Bootstrap按ratio-of-sums计算

[ ] Paired comparison只使用双方evaluable event

[ ] 数据覆盖率单独报告
```

---

# 76. v1.0.1 的研究问题最终冻结为

本版本只回答：

> 在相同的、数据完整且事前定义的 1H 极端价格事件中，在固定退出和固定风险预算下：
>
> 1. 进一步等待极端价格并以 Maker 方式逆势进入；
>
> 与
>
> 2. 等待“有效回撤 → 真实反弹 → 较低高点/较高低点 → 结构破坏”以后 next-bar 进入；
>
> 在指定 OHLC 执行模型下，二者的 Event EV、Trade EV、参与率、尾部损失、Trade MAE 范围及 Mark-to-Market Drawdown 有什么差异？

本版本：

> **允许最终结果证明 A 没有优势、B 没有优势、二者都没有优势，或者结论对执行假设高度敏感。**

这四种结果全部属于有效研究结果。

研究目标不是得到漂亮曲线。

研究目标是：

> 尽可能区分真正的价格结构优势，与 OHLC 回测执行假设制造出来的假优势。