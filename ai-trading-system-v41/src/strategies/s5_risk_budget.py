"""S5 risk budget allocator (V4.1 multi + V4.2 single-active-alpha)."""

from __future__ import annotations

from typing import Any, Dict, Mapping

from src.runtime.risk_usage import attach_usage_to_s5, empty_risk_usage, strategy_initial_risk_cap

_EPS = 1e-12


class S5RiskBudgetAllocator:
    def __init__(self, config: Mapping[str, Any]) -> None:
        self.config = config
        self.cfg = config.get("S5_risk_budget", {})

    def _health_multiplier(self, score: float) -> float:
        table = self.cfg.get("health_multipliers", {})
        for key, mult in table.items():
            parts = str(key).split("_")
            if len(parts) != 2:
                continue
            lo, hi = float(parts[0]), float(parts[1])
            if lo <= score <= hi:
                return float(mult)
        return 0.0

    def allocate(
        self,
        *,
        regime: str,
        health_scores: Mapping[str, float],
        context: Dict[str, Any],
    ) -> Dict[str, Any]:
        if not self.cfg.get("enabled", True):
            return {"final_shares": {}, "strategy_risk_budget_pct_equity": {}}

        mode = str(self.cfg.get("allocation_mode") or "multi_strategy")
        if mode == "single_active_alpha":
            return self._allocate_single_active(regime=regime, health_scores=health_scores, context=context)
        return self._allocate_multi(regime=regime, health_scores=health_scores, context=context)

    def _portfolio_budget(self, context: Dict[str, Any]) -> float:
        global_risk = self.config.get("global_risk", {})
        portfolio_cap = float(global_risk.get("max_initial_risk_all_open_positions_pct_equity", 0.02))
        s3_mult = float(context.get("S3.risk_multiplier", context.get("S3", {}).get("risk_multiplier", 1.0)))
        dd_mult = float(context.get("global_drawdown_multiplier", 1.0))
        daily_mult = float(context.get("daily_loss_multiplier", 1.0))
        # Intentionally do NOT multiply S6 here — S6 gates entries separately.
        return portfolio_cap * dd_mult * daily_mult * s3_mult

    def _allocate_single_active(
        self,
        *,
        regime: str,
        health_scores: Mapping[str, float],
        context: Dict[str, Any],
    ) -> Dict[str, Any]:
        reserve = float(self.cfg.get("reserve_fraction", 0.15))
        if not (0.0 <= reserve < 1.0):
            raise ValueError("S5 reserve_fraction must be in [0, 1)")

        base_active = 1.0 - reserve
        max_share = float(self.cfg.get("active_strategy_max_share", base_active))
        capped_base = min(base_active, max_share)
        if capped_base > base_active + 1e-12:
            raise ValueError("active_strategy_max_share exceeds 1-reserve")

        active = str(
            context.get("active_strategy_id")
            or context.get("strategy_runtime", {}).get("active_strategy_id")
            or self.config.get("strategy_runtime", {}).get("default_active_strategy_id")
            or "S1"
        )
        if active not in ("S1", "S2", "S9"):
            active = "S1"

        regime_mults = self.cfg.get("regime_multipliers", {}).get(regime, {})
        rm = float(regime_mults.get(active, 1.0))
        score = float(health_scores.get(active, 80.0))
        hm = self._health_multiplier(score)
        raw_active = capped_base * rm * hm
        # Contract-only: multipliers may shrink, never renormalize unused risk back up
        final_active = min(capped_base, raw_active)

        final = {"S1": 0.0, "S2": 0.0, "S9": 0.0}
        raw = {"S1": 0.0, "S2": 0.0, "S9": 0.0}
        final[active] = final_active
        raw[active] = raw_active

        portfolio_budget = self._portfolio_budget(context)
        # Allocated share budget is informational. Hard opening caps come from
        # S1/S2/S9 strategy_initial_risk_cap_pct_equity — not the
        # missing global_risk.per_strategy_initial_risk_cap_pct_equity map.
        strategy_budget = {"S1": 0.0, "S2": 0.0, "S9": 0.0}
        strategy_caps = {
            "S1": strategy_initial_risk_cap(self.config, "S1"),
            "S2": strategy_initial_risk_cap(self.config, "S2"),
            "S9": strategy_initial_risk_cap(self.config, "S9"),
        }
        for sid, share in final.items():
            budget = portfolio_budget * share
            cap = strategy_caps.get(sid)
            if cap:
                budget = min(budget, float(cap))
            strategy_budget[sid] = budget

        usage = context.get("risk_usage") or empty_risk_usage()
        result = attach_usage_to_s5(
            {
                "allocation_mode": "single_active_alpha",
                "active_strategy_id": active,
                "raw_shares": raw,
                "scale": 1.0,  # no renormalize-up
                "final_shares": final,
                "unused_share": 1.0 - final_active,
                "reserve_fraction": reserve,
                "capped_base_share": capped_base,
                "regime_multiplier": rm,
                "health_multiplier": hm,
                "execution_engine_is_allocation_target": False,
                "portfolio_risk_budget_pct_equity": portfolio_budget,
                "strategy_risk_budget_pct_equity": strategy_budget,
                "strategy_risk_cap_pct_equity": strategy_caps,
            },
            usage,
            self.config,
        )
        context["S5"] = result
        return result

    def _allocate_multi(
        self,
        *,
        regime: str,
        health_scores: Mapping[str, float],
        context: Dict[str, Any],
    ) -> Dict[str, Any]:
        """Legacy V4.1 multi-strategy shares (kept for historical config)."""
        reserve = float(self.cfg.get("reserve_fraction", 0.15))
        base = dict(self.cfg.get("base_strategy_shares", {}))
        # Defensive: never treat S4 as allocation target even in legacy path if flagged
        if self.cfg.get("execution_engine_is_allocation_target") is False:
            base.pop("S4", None)
        regime_mults = self.cfg.get("regime_multipliers", {}).get(regime, {})
        raw: Dict[str, float] = {}
        for sid, base_share in base.items():
            if sid == "S4" and self.cfg.get("execution_engine_is_allocation_target") is False:
                continue
            rm = float(regime_mults.get(sid, 1.0))
            score = float(health_scores.get(sid, 80.0))
            hm = self._health_multiplier(score)
            raw[sid] = float(base_share) * rm * hm

        raw_sum = sum(raw.values())
        max_alloc = 1.0 - reserve
        scale = min(1.0, max_alloc / max(raw_sum, _EPS))
        final = {sid: v * scale for sid, v in raw.items()}
        assert sum(final.values()) <= max_alloc + 1e-9

        portfolio_budget = self._portfolio_budget(context)
        strategy_budget = {sid: portfolio_budget * share for sid, share in final.items()}
        usage = context.get("risk_usage") or empty_risk_usage()
        result = attach_usage_to_s5(
            {
                "allocation_mode": "multi_strategy",
                "raw_shares": raw,
                "scale": scale,
                "final_shares": final,
                "unused_share": 1.0 - sum(final.values()),
                "reserve_fraction": reserve,
                "portfolio_risk_budget_pct_equity": portfolio_budget,
                "strategy_risk_budget_pct_equity": strategy_budget,
            },
            usage,
            self.config,
        )
        context["S5"] = result
        return result
