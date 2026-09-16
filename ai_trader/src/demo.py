"""Demo: one day in Zhang Ming's psychological state."""
from __future__ import annotations

from pathlib import Path

from .behavior_classifier import BehaviorClassifier
from .person_state import PersonStateEngine

ROOT = Path(__file__).resolve().parent.parent
EVENT_CONFIG = ROOT / "config" / "event_impacts.json"
MODE_CONFIG = ROOT / "config" / "behavior_modes.json"


def _fmt_state(snapshot: dict[str, float]) -> str:
    parts = [f"{k}={v:.3f}" for k, v in snapshot.items()]
    return "  " + "\n  ".join(parts)


def _print_scene(title: str, engine: PersonStateEngine, classifier: BehaviorClassifier) -> None:
    print("---")
    print(title)
    snap = engine.snapshot()
    print(_fmt_state(snap))
    result = classifier.classify(engine.state)
    print(
        f"  primary_mode={result.primary_mode}  "
        f"modifiers={result.modifiers}  "
        f"threshold_adj={result.threshold_adjustment:+.3f}"
    )


def main() -> None:
    engine = PersonStateEngine(EVENT_CONFIG)
    classifier = BehaviorClassifier(MODE_CONFIG)

    print("=== AI Trader · 张明的一天（PersonState demo）===")
    _print_scene("初始状态", engine, classifier)

    print("\n=== 场景 1：与妻子争吵 ===")
    engine.apply_events([{"name": "ARGUMENT_WITH_WIFE", "type": "atomic"}])
    _print_scene("争吵后", engine, classifier)

    print("\n=== 场景 2：连续 3 笔止损 ===")
    engine.apply_events(
        [
            {"name": "STOP_LOSS_TRIGGERED", "type": "atomic"},
            {"name": "STOP_LOSS_TRIGGERED", "type": "atomic"},
            {"name": "STOP_LOSS_TRIGGERED", "type": "atomic"},
            {"name": "LOSS_STREAK_3", "type": "compound"},
        ]
    )
    _print_scene("连续止损后", engine, classifier)

    print("\n=== 场景 3：一夜未眠（手动调整） ===")
    engine.state.sleep_debt += 2.0
    engine.state.focus -= 0.15
    engine._clip(warn=True)
    engine.event_history.append(
        {
            "name": "MANUAL_SLEEP_DEBT",
            "type": "manual",
            "delta": {"sleep_debt": 2.0, "focus": -0.15},
        }
    )
    _print_scene("失眠后", engine, classifier)

    print("\n=== 场景 4：次日衰减 ===")
    engine.daily_decay()
    _print_scene("衰减后", engine, classifier)

    print("\n=== demo 结束 ===")


if __name__ == "__main__":
    main()
