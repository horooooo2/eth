"""S7 strategy health scoring."""

from __future__ import annotations

from typing import Any, Dict, List, Mapping, Sequence

_EPS = 1e-12


class S7HealthMonitor:
    def __init__(self, config: Mapping[str, Any]) -> None:
        self.config = config
        self.cfg = config.get("S7_health", {})
        self.trade_history: Dict[str, List[Dict[str, Any]]] = {"S1": [], "S2": [], "S4": []}

    def add_trade(self, strategy_id: str, trade: Mapping[str, Any]) -> None:
        self.trade_history.setdefault(strategy_id, []).append(dict(trade))

    def _clip(self, x: float, lo: float = 0.0, hi: float = 1.0) -> float:
        return max(lo, min(hi, x))

    def score_strategy(self, strategy_id: str) -> Dict[str, Any]:
        trades = self.trade_history.get(strategy_id, [])
        windows = self.cfg.get("windows", {})
        fast_n = int(windows.get("fast_trades", 30))
        recent = trades[-fast_n:]
        if not recent:
            # healthy prior until evidence
            return {"strategy_id": strategy_id, "health_score": 80.0, "state": "ON", "risk_multiplier": 1.0}

        rs = [float(t.get("r_multiple", 0.0)) for t in recent]
        expectancy = sum(rs) / max(len(rs), 1)
        # crude drawdown in R
        equity = 0.0
        peak = 0.0
        max_dd = 0.0
        for r in rs:
            equity += r
            peak = max(peak, equity)
            max_dd = max(max_dd, peak - equity)

        slip_ratios = [float(t.get("slippage_vs_model_ratio", 1.0)) for t in recent]
        slip = sum(slip_ratios) / max(len(slip_ratios), 1)
        regimes = {t.get("regime", "unknown") for t in recent}
        profitable_regimes = {
            t.get("regime") for t in recent if float(t.get("r_multiple", 0)) > 0
        }
        valid = max(len(regimes), 1)

        expectancy_c = self._clip((expectancy + 0.10) / 0.40)
        drawdown_c = self._clip(1 - max_dd / 15.0)
        execution_c = self._clip(1 - max(slip - 1.0, 0.0) / 2.0)
        regime_c = self._clip(len(profitable_regimes) / valid)
        score = 100.0 * (0.35 * expectancy_c + 0.25 * drawdown_c + 0.20 * execution_c + 0.20 * regime_c)

        min_trades = int(self.cfg.get("minimum_trades_before_statistical_pause", 20))
        state = "ON"
        risk_mult = 1.0
        for st in self.cfg.get("states", []):
            if float(st["min_score"]) <= score <= float(st["max_score"]):
                state = st["state"]
                risk_mult = float(st["risk_multiplier"])
                break
        if len(recent) < min_trades and score < 60:
            # avoid early pause noise
            state = "REDUCED"
            risk_mult = 0.75

        return {
            "strategy_id": strategy_id,
            "health_score": score,
            "state": state,
            "risk_multiplier": risk_mult,
        }

    def evaluate(self, context: Dict[str, Any]) -> Dict[str, Any]:
        if not self.cfg.get("enabled", True):
            result = {sid: {"health_score": 80.0, "state": "ON", "risk_multiplier": 1.0} for sid in ("S1", "S2", "S4")}
            context["S7"] = result
            return result
        result = {}
        for sid in ("S1", "S2", "S4"):
            result[sid] = self.score_strategy(sid)
            context[f"S7.{sid}_health_score"] = result[sid]["health_score"]
        context["S7"] = result
        return result
