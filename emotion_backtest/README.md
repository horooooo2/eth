# 情绪过冲 / 衰竭确认研究与 TradFi 接入

实现依据：[方案](IMPLEMENTATION_PLAN.md)、[规格解释](SPEC_QUESTIONS.md)、`specs/` 中的三份用户原文。

## 当前交付

- Python A_K3/K4/K5/K6、B、Maker 同根止盈敏感性模型；上下方向独立记录。
- 因果状态机、固定风险与精度、缺口处理、原始账本、连续未知路径、可评价子集曲线、配对日聚类 bootstrap。
- 20 条人工路径、执行/统计/报告测试；Python 与 Node 的 80 组状态路径一致性验证。
- TradFi 新“情绪过冲策略”页面与 `/api/tradfi/emotion/{status,start,stop}`；当前仅 OBSERVE_ONLY，不调用签名下单。
- 旧网格禁止启动、补仓和重建；旧流水与存量管理保留，暂停的旧仓仍可通过主动平仓入口处理。

这是实现基线，不是已验证盈利的策略，也未标记 IMPLEMENTATION_FROZEN。真实历史研究、实际执行模型和模拟盘适配尚未完成。观察入口没有风险预算输入，因为它不会持仓；不要把观察信号当成模拟成交。

## 安装

推荐在独立环境安装，避免影响现有 Node 服务：

```powershell
cd E:\demo\Eth\emotion_backtest
python -m venv .venv
.venv\Scripts\python -m pip install -e '.[test]'
.venv\Scripts\python -m pytest -q -p no:cacheprovider
```

Node 必须在 PATH 中，供跨语言一致性测试使用。当前工作区另在 `.deps/` 安装了缺失的 Parquet/绘图依赖，临时本地使用可设置 `$env:PYTHONPATH='E:\demo\Eth\emotion_backtest\.deps'`；这些依赖不提交仓库。

## 回测输入与运行

输入 CSV/Parquet：symbol、timestamp、open、high、low、close、volume。timestamp 为 UTC 开盘时间，数字类型必须是 Unix 毫秒。数据必须从完整 5m 内部生成小时线；2161 个连续历史小时收盘是预热依赖，不可将缺口压缩掉。

交易所精度 CSV 示例表头：

```csv
symbol,tick_size,qty_step,min_qty,min_notional
```

配置 `config/v1_0_1.yaml` 中的 null 必须替换为明确的费用、滑点与风险预算，程序不会代填零或假设用户的费率。`sizing_entry_slippage_bps` 保留但当前不应用：A 的 limit 已知，B 用开盘模拟 actual fill 定仓。

```powershell
python -m src.cli run --config config/v1_0_1.yaml --input data/input.parquet --exchange-meta data/exchange_meta.csv --output results/v1_0_1
```

CLI 在任何真实输入处理前自动执行验收测试；失败则终止。产物包括 Parquet 原始记录、CSV/JSON 汇总、JSONL 状态 trace、Markdown/HTML 和七种 PNG 图表、包含输入/规格/源码 SHA256 的 manifest。

`results/` 不提交。可评价子集曲线含事后筛选，连续账户路径另存；持仓缺口后未知，不把历史费用删除，不自动拼接恢复后的资金曲线。当前运行采用单独 segment_001；重新初始化独立数据段需另起 run，不能拼接收益。资金费未计入，禁止解释成账户 ROI。

## 本地产品入口

前端 TradFi → 情绪过冲策略 → 启动观察。服务器仅在用户启用观察后加载对应 symbol 的公开 5m 数据，每批 1500 根，滚动预热约 90 天；具体状态显示历史不足或缺口。行情源明确为 Binance live public data，与用户密钥环境无关，也不使用密钥。

旧策略配置入口及旧网格回放已移除。历史持仓仍可在账户区查看和平仓，新策略不接管旧持仓；退役仅取消旧入场单并对并发成交进行归属核对，退出单及存量退出逻辑继续保留。

### 文件回放

TradFi → 策略回放，导入单标的 CSV/Parquet，选择原始周期 1m 或 5m，填写风险、费用、滑点及交易精度后运行。浏览器将文件提交当前后端，由同一 Python 基准引擎计算 A/B 结果；支持播放、单步、拖动时间轴、事件/状态明细与完整 JSON 导出。全样本对照统计仅在播放结束后显示。

上传不设文件大小及行数上限（实际受内存与计算时间约束），须登录；数字时间戳自动识别秒/毫秒/微秒/纳秒，文本时间按 UTC 处理。1m 仅将完整五根聚合为 5m，缺口不填充。每用户限一个运行任务、全服务限两个，任务超时 15 分钟；完成或取消的结果约 30 分钟后清理，需及时导出。服务重启会丢失内存中的任务索引。

后端必须能运行上述 Python 环境及验收测试。可用 `EMOTION_PYTHON` 指定 Python 可执行文件；本地默认优先 `.venv/Scripts/python.exe`，否则使用 PATH 的 python（Windows）或 python3。部署同步脚本包含 Python 源码、测试及规格，不包含虚拟环境，目标服务器仍需安装 `.[test]` 依赖。该回放是离线研究，不发送交易订单。

## 后续验收边界

1. 提供明确研究成本、风险预算、精度元数据和完整历史数据，跑固定参数真实样本；保留零事件/低覆盖事实。
2. 将实时观察 trace 与基准逐事件核对，确认断线、重启与时区边界行为。
3. 另行实现并验收 demo 执行：部分成交、订单幂等、保护单失败、保证金及组合风险限制、环境一致性。当前版本不开放 LIVE/DEMO 模式。
4. 发布继续走现有 GitHub Actions。本地修改不代表已发布；不运行旧 Python sidecar，不新增生产部署通道。
