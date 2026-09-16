"""Unit tests for PaperExecutionEngine."""
from __future__ import annotations

import sys
import traceback
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from src.decision_engine import Decision
from src.paper_execution import PaperExecutionEngine
from src.risk_engine import MarketSnapshot, RiskCheckResult
from src.trade_intent import STATUS_PENDING_RISK, STATUS_RISK_APPROVED, TradeIntent

RISK_CONFIG = ROOT / "config" / "risk_rules.json"
TS = "2026-01-01T00:00:30+00:00"


def _decision() -> Decision:
    return Decision(
        action="OPEN_LONG",
        signal_score=0.8,
        threshold=0.7,
        position_multiplier=1.0,
        decision_reason={},
        rule_version="1.2.0",
        timestamp="2026-01-01T00:00:00+00:00",
    )


def _approved_intent(direction: str = "LONG") -> TradeIntent:
    intent = TradeIntent.create(
        _decision(),
        symbol="BTC",
        direction=direction,
        leverage=3.0,
        now=datetime(2026, 1, 1, tzinfo=timezone.utc),
        ttl_seconds=60,
    )
    intent.transition_to(STATUS_PENDING_RISK)
    intent.transition_to(STATUS_RISK_APPROVED)
    intent.risk_result = RiskCheckResult(
        approved=True,
        position_size=0.01,
        margin=200.0,
        stop_price=66000.0,
        take_profit=69000.0,
        risk_amount=20.0,
        risk_pct=0.001,
        leverage=3.0,
        notional=600.0,
        reject_reason=None,
        checks={},
    )
    return intent


def _market(price: float = 67000.0) -> MarketSnapshot:
    return MarketSnapshot(price=price, atr=50.0, timestamp=TS)


def test_execution_filled() -> None:
    eng = PaperExecutionEngine(RISK_CONFIG, seed=1)
    result = eng.execute(_approved_intent(), _market())
    assert result.status == "FILLED"
    assert result.entry_price > 0
    assert result.fees > 0


def test_execution_rejected_when_expired() -> None:
    eng = PaperExecutionEngine(RISK_CONFIG, seed=1)
    intent = _approved_intent()
    intent.expires_at = (
        datetime(2026, 1, 1, tzinfo=timezone.utc) - timedelta(seconds=1)
    ).isoformat()
    market = MarketSnapshot(
        price=67000.0,
        atr=50.0,
        timestamp="2026-01-01T00:01:00+00:00",
    )
    result = eng.execute(intent, market)
    assert result.status == "REJECTED"
    assert result.reject_reason == "INTENT_EXPIRED"


def test_execution_rejected_when_invalid_status() -> None:
    eng = PaperExecutionEngine(RISK_CONFIG, seed=1)
    intent = TradeIntent.create(
        _decision(),
        symbol="BTC",
        direction="LONG",
        now=datetime(2026, 1, 1, tzinfo=timezone.utc),
    )
    intent.transition_to(STATUS_PENDING_RISK)
    result = eng.execute(intent, _market())
    assert result.status == "REJECTED"
    assert result.reject_reason == "INVALID_STATUS"


def test_slippage_direction() -> None:
    mid = 67000.0
    eng = PaperExecutionEngine(RISK_CONFIG, seed=99)
    long_fill = eng.execute(_approved_intent("LONG"), _market(mid))
    eng = PaperExecutionEngine(RISK_CONFIG, seed=99)
    short_fill = eng.execute(_approved_intent("SHORT"), _market(mid))
    assert long_fill.status == "FILLED"
    assert short_fill.status == "FILLED"
    assert long_fill.entry_price > mid
    assert short_fill.entry_price < mid


def test_fees_calculation() -> None:
    eng = PaperExecutionEngine(RISK_CONFIG, seed=1)
    result = eng.execute(_approved_intent(), _market())
    assert result.status == "FILLED"
    assert abs(result.fees - result.notional * 0.0005) < 1e-9


def run() -> int:
    tests = [
        test_execution_filled,
        test_execution_rejected_when_expired,
        test_execution_rejected_when_invalid_status,
        test_slippage_direction,
        test_fees_calculation,
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
    print("=== test_paper_execution ===")
    for line in details:
        print(line)
    print(f"---\npassed={passed} failed={failed} total={len(tests)}")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    raise SystemExit(run())
