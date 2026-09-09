"""Edge / expected R estimator with hierarchical cold-start policy."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Dict, List, Mapping, Optional, Sequence

_EPS = 1e-12


@dataclass
class TradeSample:
    win: bool
    r_multiple: float
    strategy_id: str
    symbol: str
    regime: str = "unknown"
    timestamp: Optional[datetime] = None


@dataclass
class EdgeEstimate:
    prob_win: float
    avg_win_R: float
    avg_loss_R: float
    expected_edge_after_cost_R: float
    scope_used: str
    sample_count: int
    age_minutes: float
    available: bool
    paper_only: bool
    risk_multiplier: float
    reason: Optional[str] = None
    extras: Dict[str, Any] = field(default_factory=dict)


class EdgeEstimator:
    def __init__(self, config: Mapping[str, Any]) -> None:
        self.config = config
        self.cm = config.get("cost_model", {})
        self.cfg = self.cm.get("edge_estimator", {})
        self.samples: List[TradeSample] = []
        self.validated_oos_prior: Dict[str, Any] = dict(self.cfg.get("validated_oos_prior") or {})
        self._last_estimate_at: Optional[datetime] = None

    def set_validated_prior(self, prior: Mapping[str, Any]) -> None:
        self.validated_oos_prior = dict(prior)

    def add_sample(self, sample: TradeSample) -> None:
        self.samples.append(sample)

    def estimate(
        self,
        *,
        strategy_id: str,
        symbol: str,
        regime: str,
        round_trip_cost_R: float,
        now: Optional[datetime] = None,
    ) -> EdgeEstimate:
        now = now or datetime.now(timezone.utc)
        cold = self.cfg.get("cold_start", {})
        scopes = self.cfg.get(
            "estimation_scope_priority",
            [
                "strategy_symbol_regime",
                "strategy_symbol",
                "strategy_regime",
                "strategy_global",
                "validated_oos_prior",
            ],
        )
        min_local = int(self.cfg.get("minimum_local_samples", 30))
        max_age = float(self.cfg.get("maximum_estimator_age_minutes", 60))

        chosen: Optional[Sequence[TradeSample]] = None
        scope_used = "validated_oos_prior"
        for scope in scopes:
            if scope == "validated_oos_prior":
                continue
            filtered = self._filter(strategy_id, symbol, regime, scope)
            if len(filtered) >= min_local:
                chosen = filtered
                scope_used = scope
                break

        paper_only = False
        risk_mult = 1.0
        reason = None

        if chosen is None:
            if not self.validated_oos_prior:
                miss = cold.get("if_validated_prior_missing", {})
                return EdgeEstimate(
                    prob_win=0.5,
                    avg_win_R=1.0,
                    avg_loss_R=1.0,
                    expected_edge_after_cost_R=-1.0,
                    scope_used="none",
                    sample_count=0,
                    age_minutes=0.0,
                    available=False,
                    paper_only=bool(miss.get("paper_trading_only", True)),
                    risk_multiplier=0.0,
                    reason=miss.get("reason", "NO_VALIDATED_EDGE_PRIOR"),
                )
            scope_used = "validated_oos_prior"
            prior = self.validated_oos_prior
            prob = float(prior.get("prob_win", 0.5))
            avg_win = float(prior.get("avg_win_R", 1.0))
            avg_loss = float(prior.get("avg_loss_R", 1.0))
            n = int(prior.get("sample_count", 0))
            live_min = int(cold.get("live_sample_minimum", 30))
            live_n = len(self._filter(strategy_id, symbol, regime, "strategy_global"))
            if live_n < live_min:
                risk_mult = float(cold.get("risk_multiplier_before_live_sample_minimum", 0.25))
        else:
            n = len(chosen)
            prob = self._beta_binomial_prob(chosen)
            avg_win = self._ewma_avg([s.r_multiple for s in chosen if s.win], win=True)
            avg_loss = self._ewma_avg([abs(s.r_multiple) for s in chosen if not s.win], win=False)
            live_min = int(cold.get("live_sample_minimum", 30))
            if n < live_min:
                risk_mult = float(cold.get("risk_multiplier_before_live_sample_minimum", 0.25))

        edge = (prob * avg_win) - ((1.0 - prob) * avg_loss) - float(round_trip_cost_R)
        self._last_estimate_at = now
        age = 0.0
        available = True
        if age > max_age:
            stale = self.cfg.get("missing_or_stale_estimate_policy", {})
            available = False
            paper_only = bool(stale.get("paper_trading_allowed", True))
            reason = stale.get("reason", "EDGE_ESTIMATE_UNAVAILABLE_OR_STALE")

        return EdgeEstimate(
            prob_win=prob,
            avg_win_R=avg_win,
            avg_loss_R=avg_loss,
            expected_edge_after_cost_R=edge,
            scope_used=scope_used,
            sample_count=n,
            age_minutes=age,
            available=available,
            paper_only=paper_only,
            risk_multiplier=risk_mult,
            reason=reason,
        )

    def _filter(
        self, strategy_id: str, symbol: str, regime: str, scope: str
    ) -> List[TradeSample]:
        out: List[TradeSample] = []
        for s in self.samples:
            if s.strategy_id != strategy_id:
                continue
            if scope == "strategy_symbol_regime" and (s.symbol != symbol or s.regime != regime):
                continue
            if scope == "strategy_symbol" and s.symbol != symbol:
                continue
            if scope == "strategy_regime" and s.regime != regime:
                continue
            if scope == "strategy_global":
                pass
            out.append(s)
        lookback = int(self.cfg.get("lookback_trades", 100))
        return out[-lookback:]

    def _beta_binomial_prob(self, samples: Sequence[TradeSample]) -> float:
        pw = self.cfg.get("prob_win", {})
        alpha = float(pw.get("fallback_prior_alpha", 10.0))
        beta = float(pw.get("fallback_prior_beta", 10.0))
        if self.validated_oos_prior:
            alpha = float(self.validated_oos_prior.get("prior_alpha", alpha))
            beta = float(self.validated_oos_prior.get("prior_beta", beta))
        wins = sum(1 for s in samples if s.win)
        losses = len(samples) - wins
        return (wins + alpha) / max(wins + losses + alpha + beta, _EPS)

    def _ewma_avg(self, values: Sequence[float], win: bool) -> float:
        key = "avg_win_R" if win else "avg_loss_R"
        block = self.cfg.get(key, {})
        min_samples = int(block.get("minimum_samples", 10))
        fallback_key = "avg_win_R" if win else "avg_loss_R"
        fallback = float(self.validated_oos_prior.get(fallback_key, 1.0)) if self.validated_oos_prior else 1.0
        if len(values) < min_samples:
            return fallback
        # EWMA over lookback
        alpha = 2.0 / (min(len(values), int(block.get("lookback_trades", 100))) + 1)
        ewma = float(values[0])
        for v in values[1:]:
            ewma = alpha * float(v) + (1 - alpha) * ewma
        return ewma
