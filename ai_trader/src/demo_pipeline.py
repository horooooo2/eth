"""End-to-end demo: OHLCV -> signals -> personality -> decisions."""
from __future__ import annotations

import json
import random
from datetime import datetime, timedelta, timezone
from pathlib import Path

from .behavior_classifier import BehaviorClassifier
from .decision_engine import DecisionEngine
from .person_state import PersonStateEngine
from .signal_engine import SignalEngine

ROOT = Path(__file__).resolve().parent.parent
EVENT_CONFIG = ROOT / "config" / "event_impacts.json"
MODE_CONFIG = ROOT / "config" / "behavior_modes.json"
SIGNAL_CONFIG = ROOT / "config" / "signal_rules.json"
DECISION_CONFIG = ROOT / "config" / "decision_rules.json"


def make_ohlcv(seed: int = 42, n: int = 120) -> list[dict]:
    """Synthetic bars with breakout / pullback / flow setups near the end."""
    rng = random.Random(seed)
    start = datetime(2026, 9, 16, 0, 0, tzinfo=timezone.utc)
    bars: list[dict] = []
    price = 100.0
    for i in range(n):
        # mild drift then patterned tail
        if i < n - 30:
            delta = rng.uniform(-0.15, 0.25)
            vol = rng.uniform(800, 1200)
        elif i < n - 8:
            # build uptrend for EMA / pullback context
            delta = rng.uniform(0.05, 0.35)
            vol = rng.uniform(900, 1300)
        elif i < n - 4:
            # mild pullback toward local mean
            delta = rng.uniform(-0.40, -0.05)
            vol = rng.uniform(900, 1200)
        else:
            # final breakout + flow: strong up + volume spike
            delta = rng.uniform(0.80, 1.60)
            vol = rng.uniform(2500, 4000)
        open_p = price
        close_p = max(1.0, price + delta)
        high_p = max(open_p, close_p) + rng.uniform(0.05, 0.25)
        low_p = min(open_p, close_p) - rng.uniform(0.05, 0.25)
        bars.append(
            {
                "timestamp": (start + timedelta(minutes=i)).isoformat(),
                "open": round(open_p, 4),
                "high": round(high_p, 4),
                "low": round(low_p, 4),
                "close": round(close_p, 4),
                "volume": round(vol, 2),
            }
        )
        price = close_p
    return bars


def _print_state(engine: PersonStateEngine, classifier: BehaviorClassifier) -> None:
    snap = engine.snapshot()
    print("  state:")
    for k, v in snap.items():
        print(f"    {k}={v:.3f}")
    behavior = classifier.classify(engine.state)
    print(
        f"  behavior: primary={behavior.primary_mode} "
        f"modifiers={behavior.modifiers} "
        f"threshold_adj={behavior.threshold_adjustment:+.3f}"
    )


def _run_phase(
    title: str,
    bars: list[dict],
    person: PersonStateEngine,
    classifier: BehaviorClassifier,
    signals_engine: SignalEngine,
    decision_engine: DecisionEngine,
) -> None:
    print("\n" + "=" * 60)
    print(title)
    print("=" * 60)
    _print_state(person, classifier)
    behavior = classifier.classify(person.state)
    # fresh history each phase for readable raw->score mapping
    signals_engine.history = {name: [] for name in signals_engine.rules}
    signals = signals_engine.generate_signals(bars, symbol="BTC-USDT")
    print(f"\n  signals ({len(signals)}):")
    if not signals:
        print("    (none)")
        return
    for sig in signals:
        print(
            f"    [{sig.rule_name}] {sig.direction} "
            f"raw={sig.raw_score:.3f} score={sig.score:.3f} | {sig.reason}"
        )
        decision = decision_engine.decide(sig, person.state, behavior)
        print(
            f"      -> {decision.action}  "
            f"threshold={decision.threshold:.3f}  "
            f"mult={decision.position_multiplier:.3f}"
        )
        print("      decision_reason=")
        print("      " + json.dumps(decision.decision_reason, ensure_ascii=False, indent=2).replace("\n", "\n      "))


def main() -> None:
    bars = make_ohlcv()
    person = PersonStateEngine(EVENT_CONFIG)
    classifier = BehaviorClassifier(MODE_CONFIG)
    signals_engine = SignalEngine(SIGNAL_CONFIG)
    decision_engine = DecisionEngine(DECISION_CONFIG)

    print("=== AI Trader · Signal + Decision pipeline demo ===")
    print(f"OHLCV bars={len(bars)}  last_close={bars[-1]['close']:.2f}")

    _run_phase(
        "阶段 1：初始状态（NORMAL）",
        bars,
        person,
        classifier,
        signals_engine,
        decision_engine,
    )

    person.apply_events(
        [
            {"name": "ARGUMENT_WITH_WIFE", "type": "atomic"},
            {"name": "STOP_LOSS_TRIGGERED", "type": "atomic"},
            {"name": "STOP_LOSS_TRIGGERED", "type": "atomic"},
            {"name": "STOP_LOSS_TRIGGERED", "type": "atomic"},
            {"name": "LOSS_STREAK_3", "type": "compound"},
        ]
    )

    _run_phase(
        "阶段 2：争吵 + 连续止损（期望 REVENGE_TRADING）",
        bars,
        person,
        classifier,
        signals_engine,
        decision_engine,
    )
    print("\n=== demo_pipeline 结束 ===")


if __name__ == "__main__":
    main()
