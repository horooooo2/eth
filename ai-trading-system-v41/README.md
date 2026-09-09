# AI Multi-Strategy Trading System V4.1

基于确定性事件驱动引擎的加密货币永续合约量化交易系统（研究/模拟盘优先）。

## 功能概览

- 按 `engine_contract.decision_order` 执行 11 步决策流水线
- 规则引擎解析配置中的 conditions（fail-closed）
- S1–S7 策略：趋势、反转、市场状态、执行确认、风险预算、异常熔断、健康度
- TradeIntent 生命周期与价格漂移/过期校验
- OKX 适配器（ccxt），paper 模式支持纯 mock，无需 API Key
- 系统异常手动恢复：`POST /api/v1/system/resume`

## 目录结构

```
config/system_config.json
src/core/          # data_pool / rule_evaluator / signal_lifecycle / orchestrator / edge_estimator
src/strategies/    # S1–S7
src/adapters/      # OKX + reconciler
src/utils/         # logger + manual_resume
scripts/run_paper.py
scripts/run_live.py
tests/
```

## 安装

```bash
cd ai-trading-system-v41
python -m venv .venv
# Windows
.venv\Scripts\activate
pip install -r requirements.txt
```

## 模拟盘（推荐先跑）

无需 API Key，使用 mock K 线与账户：

```bash
python scripts/run_paper.py
```

## 单元测试

```bash
pytest -q
```

## 实盘入口

1. 在项目根目录创建 `.env`：

```
OKX_API_KEY=...
OKX_API_SECRET=...
OKX_PASSPHRASE=...
TRADE_SYMBOL=BTC/USDT:USDT
```

2. 确认 `config/system_config.json` 中 `meta.live_trading_allowed`。当前默认 **`false`**，实盘下单会被拦截并告警。

```bash
python scripts/run_live.py
```

## 手动恢复 API

```bash
uvicorn src.utils.manual_resume:app --reload
```

更常见的方式是在代码中通过 `create_resume_app(s6_detector)` 挂载，并携带：

```
Authorization: Bearer dev-token
```

调用 `POST /api/v1/system/resume`。

## 安全说明

- 默认禁止实盘（`live_trading_allowed=false`）
- 无 validated edge prior 时强制 paper_only
- S6 Level≥2 禁止新开仓；硬系统事件需人工审计恢复
