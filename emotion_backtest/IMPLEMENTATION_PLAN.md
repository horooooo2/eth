# TradFi 情绪过冲 / 衰竭确认策略实施与迁移方案

日期：2026-09-30。状态：IMPLEMENTATION_BASELINE；本次交付为方案，尚未实现或完成验收。

后续实施记录（同日）：已按此方案新增 Python 回测基准、人工路径与报告、Node 一致性状态核心、TradFi 观察接口/页面、旧策略退役入口和存量兼容。当前通过 31 项 Python 测试及 55 项后端回归测试，前端构建通过，人工数据 CLI 全流程通过。用户将稍后导入真实 K 线，M4 真实研究与 M6 demo 执行尚未完成；M5 已接入观察入口，仍需实时样本核对。详见 [README](README.md)。下文为原始分阶段方案，不表示全部里程碑已经完成。

## 1. 目标与边界

将现有 TradFi 震荡循环策略逐步替换为基于异常事件的策略。先建设独立、可复现的 Python 回测基准，再将通过验证的规则接入现有 Node/Vue 系统。不能仅更换页面名称、入场判断，继续沿用旧策略的补仓与循环开仓行为。

研究主策略为 B：异常发生后，等待有效回撤、固定窗口、真实反弹、反弹失败和结构破坏，下一根开盘入场。A_K3/K4/K5/K6 是独立对照组。第一阶段同时实现上下两个方向并分开报告；不预先承诺 B 更优，也不根据收益选择 K。

新策略每事件最多交易一次，禁止加仓、马丁和事件内重新入场。原有周末模式、双向常驻仓、固定网格、手动补仓不继承为新策略条件。风险预算替代“按补仓保证金放大头寸”的决策方式；杠杆只是后续执行约束，不能改变风险预算。

本阶段不启动服务器、不连接交易密钥、不改生产数据库、不下单。研究引擎不建设 Web UI；后期产品接入复用现有页面。

## 2. 规格依据

优先级：用户最终澄清 > v1.0.1 补丁 > v1.0。原文保存在：

- [原始规格](specs/FROZEN_BACKTEST_SPEC_v1.0.md)
- [强制覆盖补丁](specs/FROZEN_BACKTEST_SPEC_v1.0.1.md)
- [最终实现澄清](specs/FINAL_IMPLEMENTATION_CLARIFICATIONS.md)

具体冲突、建议解释和结果解释的阻塞范围见 [SPEC_QUESTIONS.md](SPEC_QUESTIONS.md)。方案中的工程选择不冒充用户已经冻结的交易规则。尚有冲突不妨碍数据层、状态机和人工测试开发；涉及冲突的真实结果不能先作解释。

## 3. 工程分层与目录

在仓库根目录新增 `emotion_backtest/`，独立于现有交易服务。采用 Python 3.11+、pandas、numpy、pyarrow、dataclass、pytest、matplotlib；配置解析依赖显式声明并锁定版本。

计划新增：

```text
emotion_backtest/
  specs/                       # 三份用户原文，不在实现过程中改写
  IMPLEMENTATION_PLAN.md
  SPEC_QUESTIONS.md
  README.md
  pyproject.toml
  config/v1_0_1.yaml            # 研究常量与显式必填执行参数
  src/
    models.py                  # 数据契约、枚举、不可变记录
    data.py                    # 输入校验、缺口、元数据
    resample.py                # 5m -> 完整 1H
    indicators.py              # 历史 ATR、分位数
    events.py                  # 正式事件与冷却
    strategy_extreme_maker.py
    strategy_exhaustion.py
    execution.py               # 成交模型、价格离散化、退出
    position_sizing.py
    accounting.py              # 原始账本、连续路径、独立区段
    engine.py                  # 唯一时钟及处理阶段
    metrics.py                 # 可评价样本、配对统计
    reporting.py
    cli.py
  tests/
    synthetic_paths/           # PATH 01–20 与预期 trace
    fixtures/
  results/                     # 运行产物，不提交大体积历史数据
```

数据流：输入校验 → 完整小时线 → 事前指标 → 统一正式事件 → 各策略/执行场景 → 订单与成交账本 → 可评价状态 → 指标与报告。24H 事件路径统计单独计算，不回流到任何交易决定。

## 4. 数据契约与可复现性

输入为 UTC 5m OHLCV，唯一键为 `(symbol, bar_open_time)`；不同 symbol 可以具有相同 timestamp。拒绝同键重复、非法价格、负成交量、非 5m 对齐时间。不得填充价格后冒充真实 K 线。

1H 按 UTC 整点重采样，要求 12 根连续 5m 全部存在。按真实日历窗口查依赖，不能删除缺失行后用“最近 N 行”替代 N 小时。

ATR_pre 使用事件前 20 个 TR 的简单平均，依赖连续 21 个历史小时。2160 个事前小时收益率依赖连续 2161 个历史收盘价。候选事件小时也必须完整；分位数和 ATR 都不含当前候选小时。初始数据不足与中间历史缺口分别保留诊断原因。

主要记录：

- `RunManifest`：规格版本、代码版本/工作区指纹、输入和配置 SHA256、依赖版本、交易所精度来源、随机种子、执行场景、冲突解释版本。
- `EventRecord`：确定性 event_id、symbol、方向、source_bar_open/close、event_detected_at、reference_price、trigger_close、冻结 ATR、历史区间、观察期限、路径有效性。
- `StrategyEventResult`：event_id、strategy_id、execution_scenario、终态、是否可评价、跳过原因、订单/信号/成交时间、计划风险、实际损益、费用与歧义标记。
- `Order/FillRecord`：创建、激活、拒单、成交、取消、价格精度与数量计算依据；盘中模拟记录 bar 和执行阶段，不伪造精确成交秒数。
- `LedgerRecord`：现金成本、已实现价格损益、未实现损益、最后有效价格、缺口时间、区段 ID、路径是否已知。
- `StateTrace`：旧状态、新状态、known_at、bar_open/close、phase、reset_reason、event_id、冻结阈值。

各 A 版本和敏感性场景有独立仓位占用，不能合成一个账户。运行数据保存 symbol、方向和场景维度，研究实例唯一键不依赖全局可变状态。

## 5. 事件与 B 状态机

异常上涨：小时正收益达到事前 99.5% 分位且价格涨幅至少 3 ATR_pre；下跌镜像使用负收益与 0.5% 分位。ATR 非正或依赖不完整不得生成正式事件。

事件基准价为上一小时收盘；A 挂单基点为本次异常小时收盘，二者不能混用。高/低点从 trigger_close 初始化，只随之后完整 5m 更新。创新高/低不改变 event_id、ATR、观察期限或风险预算。

同 symbol 冷却从 event_detected_at 算起，间隔恰好 2 小时允许新正式事件。观察 24 根 5m；24H 路径评价 288 根 5m；二者独立。

B 做空状态：

```text
EVENT_ACTIVE
  -> PULLBACK_WINDOW         # 完整收盘回撤 >= 0.5 ATR，当前根计第 1 根
  -> WAIT_REBOUND            # 连续第 3 根收盘后冻结三根最低价
  -> REBOUND_ACTIVE          # 后续一根 close > previous_close 且 > pullback_low
  -> SIGNAL_CONFIRMED        # 再后续收盘 < pullback_low，且 rebound_high < event_high
  -> ENTRY_PENDING
  -> IN_POSITION
  -> TERMINAL
```

窗口第 3 根不能兼作反弹开始。固定 low 不因随后下跌而追踪下移。WAIT_REBOUND 首先检查 high >= 旧 event_high；等高也取消候选，不允许同根启动旧反弹。新高先用 old_event_high 判断再更新。反弹阶段等高或新高同样失效；DOWN/LONG 独立镜像测试。

重置只清除候选结构，不产生新交易预算。第 24 根收盘可以确认信号，允许第 25 根开盘成交；若该预期 K 线缺失，不顺延到“下一根存在的数据”。完整无反弹路径以 NO_CONFIRMATION 终结。终态事件不重入。

## 6. 唯一逻辑时钟与无未来函数

以 `T` 为当前 5m 开盘时间，上一根为 `[T-5m,T)`。建议用明确阶段消除 Q7/Q8 的顺序冲突：

1. 完成上一根的成交/账务与收盘状态转换，计算在 T 才已知的小时候选事件、B 信号、到期事项；新事件先作为候选，不占用仓位。
2. 按已确认的时间退出口径结算旧仓；对存续旧仓处理 T 开盘 gap stop/target。
3. 执行旧事件已确认、应在 T 入场的 B pending entry，再更新占用。
4. 创建本次正式事件，保留统一 event_id；按策略现有占用给出 SKIP_POSITION_BUSY 或建立 A 订单/B 观察状态。忙碌事件保留零收益，不等待空仓后复活。
5. 模拟 `[T,T+5m)` 的触价与退出。当前 high/low/close 只能在本根结束阶段提供给 B 状态机，不能参与 T 开盘仓位计算。
6. 记录费用、持仓、MTM 和 trace；进入下一时间点。

“信号 T 时刻已知、下一根 T 开盘成交”是显式零延迟研究假设，不能据此保证线上相同价格成交。时间退出 close/open 歧义单独保留，不能用价格相等测试掩盖。

无未来验证：完整数据和每个历史截断前缀的截至当时状态一致；扰动未来 K 线不得改变过去事件、信号、订单和账本；只有最终可评价标签与事后统计可以变化。

## 7. 执行、风险与离散化

A 四个 K 都运行。订单价 trigger_close ± K×ATR_pre，做空向上取 tick，做多向下取 tick。在订单创建时按合法限价、冻结止损和计划退出成本确定数量，成交后不重算数量。

A 首次激活做空 open > limit 拒绝，等于允许；已 resting 的订单跨价开盘按 limit 成交，不重新拒绝、不改善价格。主模型为触价全额成交的小额订单近似，没有队列优先权证明。A 入场当根主场景允许止损、禁止止盈；另跑同根允许止盈的执行敏感性场景。

B 在预期下一根 open 按 actual_entry_slippage 模拟成交，先按不利方向合法化价格，再推导 ±1 ATR 的 stop/target，再计算计划单位损失并向下取 qty_step。做空卖出向下取 tick、买入退出向上；做多镜像。使用 Decimal/整 tick 运算，避免浮点误差造成越界。

单位计划风险包括价差损失、入场费和计划止损退出费。quantity = floor_to_step(risk_budget / unit_planned_loss)，随后检查 min_qty/min_notional。不能用 risk_budget/ATR 简化。记录预算、取整后计划损失、实际损失及 R；跳空可导致 R < -1。

stop/target 从合法入场价冻结，不能跟随 ATR_live 放宽；持仓最多 24 根，入场根计第 1 根。退出均按 taker，不利滑点随买卖方向处理。旧持仓开盘跳过 stop/target 按 open 计价；盘中双触及 STOP_FIRST，标记 intrabar_order_ambiguous。新成交 A 跨越止损的开盘组合需补充专门用例，不能直接复用“已有持仓”的假设。

费用、四类 sizing/actual 滑点、风险预算和精度缺失均报错，不能默认零。B 根据最终澄清使用已模拟 actual entry，不再次叠加 sizing_entry 滑点；保留该配置的适用性说明。价格/止损无效、零单位风险、数量不合法必须明确失败，不通过扩大仓位修正。

## 8. 缺口、账本与账户路径

数据问题与策略不参与分开。DATA_GAP_PRE_ENTRY、DATA_GAP_PENDING_ENTRY、DATA_GAP_IN_POSITION 的最终损益为 null；完整 NO_FILL、NO_CONFIRMATION、BUSY、SIZE 等为 0。已完成结果不受后来缺口影响。数据末尾截断同样不能假造退出。

持仓缺口发生前的费用、最后已知浮动损益与 mark 必须留在 raw ledger。缺口之后连续账户路径 INDETERMINATE，不释放未知仓位后继续生成一条假想完整账户曲线。独立区段从零开始，重新检查历史依赖，不拼接区段权益；账户组合中任何组成持仓未知，组合权益也未知。

同时输出：

- evaluable_subset_realized_equity 与 evaluable_subset_mtm_equity：事后完整样本比较，明确是筛选后的子集。
- continuous_account_path：因果顺序账本，含 known 标志、首个未知时刻、未知区段数、已知时间比例。

费用在发生时落账，平仓汇总不能再重复扣 entry fee。5m 收盘 MTM 无法代表逐笔盘中最低权益。没有账户本金与组合资本约束，不生成账户 ROI；跨 symbol 曲线注明 unconstrained_experimental_equity。

## 9. 指标和报告

每个正式事件 × 策略 × 场景均保留结果行。Event EV 分母为可评价正式事件，包含零收益不交易；Trade EV 仅交易。并列展示正式数、可评价数、缺失数、覆盖率和原因分布。

B vs 每个 A_K 使用双方可评价事件交集；不能将两组各自均值之差伪装成配对差异。按 event_detected_at 的 UTC 日聚类 bootstrap，10,000 次、seed 42，每次为总差额/总事件数。报告区间及日聚类数量，不宣称消除了跨日依赖。

MAE/MFE 分 known 和 OHLC+执行模型 bound；先确定模拟退出边界，退出后的 high/low 不进入 known。模拟 fill 可在 OHLC 外。不能将 bound 称为真实路径区间。24H 路径有缺口则 path metrics 为 null，即便交易本身完整。

每个 K 展示正式事件、eligible、fill、fill_rate、trade_count、Event EV、Trade EV、配对区间和证据数量。低成交率只限制证据强度；不设置 n<30 无效判定。effective_trade_sample_size 未定义的方法见问题清单。

报告同时给出参与率、胜率、平均盈亏、PF、连续亏损、尾部亏损、MAE/MFE、realized/MTM 回撤、并发仓位与峰值预算；按方向、symbol、月/季/年拆分。零交易/零亏损分母用 null/明示无定义，不能伪造有限数值。

输出 events.parquet、strategy_results.parquet、raw_ledger.parquet、state_trace、coverage、manifest、CSV/JSON 汇总、Markdown/HTML 报告与 PNG 图表。主收益名为 pnl_after_fees_slippage_ex_funding，funding_included=false。排序随同根止盈假设反转时在报告顶部说明执行模型敏感。

## 10. 开发顺序与验收

M0：归档原文、方案及冲突清单。本次完成，尚未通过任何实现验收。

M1：模型、配置校验、数据完整性、指标和统一时钟；实现确定性 A/B 状态机。仅使用人工数据。

M2：PATH 01–20 全通过，并保存可人工检查的 trace：

1. 普通 Maker 激活→成交→止盈。
2. 首次激活跨价 Post Only 拒绝。
3. 已 resting 订单跨价成交而非拒绝。
4. 同根反转主模型与敏感性模型差异。
5. 跳空止损允许 R < -1。
6. 完整 B 回撤、三根窗口、反弹、破位、下一根入场。
7. 无反弹直跌不确认。
8. 等高/等低反弹失效。
9. 窗口中新极值重置且 event_id 不变。
10. 第 24 根信号、第 25 根入场。
11. 入场前缺口。
12. pending entry 的预期下一根缺失。
13. 持仓缺口保留历史费用和 MTM，之后未知。
14. 交易完成后的未来缺口不删除损益。
15. 持仓浮亏后盈利，MTM 回撤大于 realized；路径不能穿越冻结止损却继续持有。
16. entry=100/stop=110/high=125，不把 125 计入 known MAE。
17. ATR 的 21 小时依赖缺口。
18. 分位数的 2161 收盘依赖缺口。
19. 同时刻旧 pending 先入场，新事件正确判 busy。
20. DOWN/LONG 全流程镜像。

M3：执行、精度、风险、账务、数据缺口和统计测试；补充不均衡日样本 ratio-of-sums、已知路径覆盖、未来扰动、时限边界、幂等复跑。收益曲线不能反过来修改测试预期。

M4：通过前述验收后才运行小规模真实历史 smoke test，再跑完整固定参数研究。记录真实数据覆盖和合约精度来源，不用模拟曲线冒充真实回测。禁止先跑参数比较再调代码。

计划命令（尚未实现）：

```bash
cd emotion_backtest
python -m pytest tests/synthetic_paths -q
python -m pytest -q
python -m src.cli run --config config/v1_0_1.yaml --input data/input.parquet --exchange-meta data/exchange_meta.csv --output results/v1_0_1
```

只有最终澄清 Q30 全部证据齐全，才标记 IMPLEMENTATION_FROZEN。成功产出不等于策略盈利；零优势也是有效研究结果。

## 11. 接入现有 TradFi 的改造位置

Python 是规则与统计基准；后续在 Node 实现纯状态核心，并对同一人工路径逐事件、逐状态、逐阈值做跨语言一致性检查。线上实际成交与 OHLC 模拟分别记录，不要求真实成交价机械等于模拟值。

- `whale-tracker-backend/lib/tradfiRangeStrategy.js`、`tradfiRangeCore.cjs`：迁移期仅服务旧持仓管理。新增独立 `tradfiEmotionCore.cjs` 与 `tradfiEmotionStrategy.js`，不在旧状态 JSON 上替换字段含义。
- `whale-tracker-backend/server.js`：新增策略显式启动开关，默认关闭；旧 worker 进入只管理存量的迁移状态后，不再自动产生新网格/补仓。
- `whale-tracker-backend/routes/tradfi.js`：新增版本明确的 `/emotion/*` 接口；旧 `/range/*` 不静默转发新语义。账户接口改为同时识别 legacy/new 归属。暂停入场、关闭策略和主动平仓分开。
- `whale-tracker-backend/lib/db.js`：新增策略实例、事件、订单关联与 trace 表；实例键包含 user、exchange/account、simulated、symbol、strategy_version。保留原 tradfi_range_* 及流水表，不覆盖历史。
- `whale-tracker-backend/lib/binanceTradfiTrade.js`：复用签名和下单适配，补充行情/精度/账户环境一致性；不让 demo 下单隐式混用无法追溯的 live 行情。
- `binanceAiLedger.js`、`binanceAiAccountBook.js`：新增版本化订单归属，兼容旧前缀；仓位归属不依赖 enabled=true，否则暂停后持仓会从管理视图消失。
- `whale-tracker-frontend/src/api/index.ts`、`src/components/TradFiBoard.vue`：新 DTO 和控制面板，展示预热/观察/回撤/反弹/确认/持仓/暂停/异常；移除新策略手动补仓入口；显示单事件预算、止损、剩余观察/持仓时间及不交易原因。
- `whale-tracker-frontend/src/views/TradFiReplay.vue`、`src/tradfi-replay/replay.worker.ts`：旧回放保留 legacy 标签。研究结果首先以 Python 输出为准，旧分钟级网格回放不能冒充新引擎。
- `whale-tracker-backend/scripts/sync-deploy.js`：后续将新增运行模块加入同步清单，deploy 目录不手工维护第二套实现。现有 main push 会触发部署，本次不提交推送或发布。

现有“仅数据、不自动交易”的旧项目规则与当前代码、此次替换目标不一致；进入接入阶段应明确更新规则适用范围，仍遵守现有 CI 部署路径和历史数据保留要求。

## 12. 迁移与运行验收

M5 为无下单 shadow：实时仅闭合 K 线检测，至少完成 2161 个历史小时依赖校验，输出决策与 Python 基准比较；不能把数据缺口当休市而填平。黄金/白银相关合约必须按实际输入连续性验证，不预设周末低波动或连续可交易。

M6 为独立 demo 执行适配：处理部分成交、超时重试、订单幂等、撤单成交竞态、重启恢复、交易所保护单、数据过期暂停、账户净额/双向持仓模式及精度变化。这些是研究规格之外的执行扩展，要版本化记录；不能以已通过 OHLC 回测代替验收。

上线候选暂按 B 设计，A 保留研究对照；正式选用方向、标的、账户组合风险上限、最大名义敞口/保证金、异常处置与实际成本模型另行形成运行配置。不能因为没有组合限制的研究曲线好看就自动启用实盘。

迁移顺序：盘点旧持仓与未成交单 → 禁止旧策略新增/补仓/重新入场 → 撤除旧入场单并核对撤单结果及并发成交 → 保留保护/平仓管理 → 存量独立退出 → 确认归属和订单一致 → 新策略才允许占用同账户同标的。

不自动平旧仓、不将旧仓成本改写成新策略入场价；存量未清前新策略可以观察但不交易同一账户标的。人工仓位也不能默认为新策略资产。回滚首先禁新入场、保留仓位保护和历史，不重新启动旧网格补仓。

接入验收必须证明：暂停后仍能查到并管理存量；同事件重启不重复下单；多 worker 不重复占用；过期信号不追单；行情/账户不同步不新开仓；任一方向处理中不会阻断另一存量方向的退出管理。

## 13. 本次交付核验

本次只新增方案、问题清单与三份原文归档；未修改现有策略、前端、接口或数据库。未运行真实历史研究，未声称 PATH 01–20 已通过。下一步从 M1 开始，先建立确定性引擎与人工路径证据。
