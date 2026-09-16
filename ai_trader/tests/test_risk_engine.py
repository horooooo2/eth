"""Unit tests for RiskEngine."""
from __future__ import annotations

import sys
import traceback
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from src.decision_engine import Decision
from src.risk_engine import MarketSnapshot, PortfolioState, RiskEngine
from src.trade_intent import STATUS_PENDING_RISK, TradeIntent

RISK_CONFIG = ROOT / "config" / "risk_rules.json"


def _decision(mult: float = 1.0) -> Decision:
    return Decision(
        action="OPEN_LONG",
        signal_score=0.8,
        threshold=0.7,
        position_multiplier=mult,
        decision_reason={},
        rule_version="1.2.0",
        timestamp="2026-01-01T00:00:00+00:00",
    )


def _intent(direction: str = "LONG", leverage: float = 3.0, mult: float = 1.0) -> TradeIntent:
    intent = TradeIntent.create(
        _decision(mult),
        symbol="BTC",
        direction=direction,
        leverage=leverage,
        atr=50.0,
        entry_price_hint=67000.0,
        now=datetime(2026, 1, 1, tzinfo=timezone.utc),
    )
    intent.transition_to(STATUS_PENDING_RISK)
    return intent


def _portfolio(**kwargs) -> PortfolioState:
    base = PortfolioState(equity=20000.0, cash=20000.0, open_position_count=0)
    for k, v in kwargs.items():
        setattr(base, k, v)
    return base


def _market(price: float = 67000.0, atr: float = 50.0) -> MarketSnapshot:
    return MarketSnapshot(price=price, atr=atr, timestamp="2026-01-01T00:00:00+00:00")


def test_risk_approved_within_limits() -> None:
    eng = RiskEngine(RISK_CONFIG)
    result = eng.check(_intent(), _portfolio(), _market())
    assert result.approved is True
    assert result.reject_reason is None
    assert result.risk_pct <= 0.01 + 1e-9


def test_reject_max_positions() -> None:
    eng = RiskEngine(RISK_CONFIG)
    result = eng.check(_intent(), _portfolio(open_position_count=3), _market())
    assert result.approved is False
    assert result.reject_reason == "MAX_POSITIONS_REACHED"


def test_reject_margin_too_large() -> None:
    eng = RiskEngine(RISK_CONFIG)

    def huge(equity, multiplier, leverage, stop_distance_pct):  # noqa: ARG001
        return equity * 0.5, equity * 0.2

    eng._compute_position_size = huge  # type: ignore[method-assign]
    result = eng.check(_intent(), _portfolio(), _market())
    assert result.approved is False
    assert result.reject_reason == "MARGIN_TOO_LARGE"


def test_reject_risk_too_large() -> None:
    eng = RiskEngine(RISK_CONFIG)

    def huge(equity, multiplier, leverage, stop_distance_pct):  # noqa: ARG001
        # Force notional that implies >1% risk at ~0.1% stop
        return equity * 0.5, equity * 0.05

    eng._compute_position_size = huge  # type: ignore[method-assign]
    # atr small so stop ok, but oversized notional fails risk
    result = eng.check(_intent(), _portfolio(), _market(atr=40))
    assert result.approved is False
    assert result.reject_reason in {"RISK_TOO_LARGE", "NOTIONAL_TOO_LARGE"}


def test_reject_leverage_exceeded() -> None:
    eng = RiskEngine(RISK_CONFIG)
    result = eng.check(_intent(leverage=5.0), _portfolio(), _market())
    assert result.approved is False
    assert result.reject_reason == "LEVERAGE_EXCEEDED"


def test_reject_daily_loss_limit() -> None:
    eng = RiskEngine(RISK_CONFIG)
    portfolio = _portfolio(daily_pnl=-700.0, daily_start_equity=20000.0)  # -3.5%
    result = eng.check(_intent(), portfolio, _market())
    assert result.approved is False
    assert result.reject_reason == "DAILY_LOSS_LIMIT"


def test_position_size_calculation() -> None:
    eng = RiskEngine(RISK_CONFIG)
    result = eng.check(_intent(mult=1.0), _portfolio(), _market(atr=50))
    assert result.approved
    equity = 20000.0
    assert result.margin <= equity * 0.05 + 1e-6
    assert result.notional <= equity * 0.15 + 1e-6
    assert result.risk_pct <= 0.01 + 1e-9
    assert abs(result.notional - result.margin * result.leverage) < 1e-6


def test_stop_price_long_short() -> None:
    eng = RiskEngine(RISK_CONFIG)
    entry = 67000.0
    atr = 100.0
    long_stop = eng._compute_stop_price("LONG", entry, atr)
    short_stop = eng._compute_stop_price("SHORT", entry, atr)
    assert long_stop < entry
    assert short_stop > entry
    # distance = max(1.5*ATR, entry*min_distance_pct)
    expected = max(1.5 * atr, entry * 0.005)
    assert abs((entry - long_stop) - expected) < 1e-6
    assert abs((short_stop - entry) - expected) < 1e-6


def run() -> int:
    tests = [
        test_risk_approved_within_limits,
        test_reject_max_positions,
        test_reject_margin_too_large,
        test_reject_risk_too_large,
        test_reject_leverage_exceeded,
        test_reject_daily_loss_limit,
        test_position_size_calculation,
        test_stop_price_long_short,
    ]
    passed = failed = 0
    details: list[str] = []
    for fn in tests:
        try:
            fn()
            passed += 1
            details.append(f"PASS  {fn.__name__}")
        except Exception as exc:  # noqa: BLE001
            failed += 1
            details.append(f"FAIL  {fn.__name__}: {exc}")
            details.append(traceback.format_exc())
    print("=== test_risk_engine ===")
    for line in details:
        print(line)
    print(f"---\npassed={passed} failed={failed} total={len(tests)}")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    raise SystemExit(run())
