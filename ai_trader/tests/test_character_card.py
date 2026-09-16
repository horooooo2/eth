"""Character card tests."""
from __future__ import annotations

import sys
import traceback
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from src.character.card import (
    CharacterCardError,
    apply_to_engines,
    list_characters,
    load_character,
    validate_card,
)

CONFIG = ROOT / "config"


def test_load_valid_card() -> None:
    card = load_character("zhangming", CONFIG)
    assert card["name"] == "张明"
    assert "behavior_modes" in card


def test_missing_field_raises() -> None:
    try:
        validate_card({"id": "x"})
        raise AssertionError("expected error")
    except CharacterCardError:
        pass


def test_apply_to_engines() -> None:
    card = load_character("zhangming", CONFIG)
    engines = apply_to_engines(card, project_root=ROOT)
    assert engines["person"].state.risk_appetite == card["traits_baseline"]["risk_appetite"]
    assert engines["decision_engine"] is not None
    assert engines["classifier"] is not None


def test_list_characters() -> None:
    # list_characters only scans config/characters/ (imported), not character_defaults/
    items = list_characters(CONFIG)
    assert isinstance(items, list)
    for item in items:
        assert "id" in item and "name" in item
    # Default card still loadable for engines / export source
    card = load_character("zhangming", CONFIG)
    assert card["name"] == "张明"


def test_normalize_profile_nested_card() -> None:
    from src.character.card import normalize_card

    nested = {
        "id": "nested_demo",
        "profile": {"name": "测试", "age": 30, "occupation": "工程师", "location": "上海"},
        "traits_baseline": {"risk_appetite": 0.5, "patience": 0.5, "focus": 0.5,
                            "self_doubt": 0.4, "stubbornness": 0.4, "stress": 0.3, "sleep_debt": 1.0},
        "behavior_modes": {"version": "1", "modes": {}},
        "decision_rules": {"version": "1"},
        "prompts": {"system": "s", "user_decision": "d", "user_event": "e"},
        "event_impacts": {
            "ambient_events": {
                "note": "x",
                "events": {"WIFE_QUIET_SIGH": {"stress": 0.02}},
            }
        },
    }
    out = normalize_card(nested)
    assert out["name"] == "测试"
    assert out["occupation"] == "工程师"
    assert "WIFE_QUIET_SIGH" in out["event_impacts"]["ambient_events"]
    validate_card(nested)


def main() -> None:
    tests = [
        test_load_valid_card,
        test_missing_field_raises,
        test_apply_to_engines,
        test_list_characters,
    ]
    failed = 0
    for fn in tests:
        try:
            fn()
            print(f"PASS {fn.__name__}")
        except Exception:
            failed += 1
            print(f"FAIL {fn.__name__}")
            traceback.print_exc()
    print(f"\n{len(tests) - failed}/{len(tests)} passed")
    raise SystemExit(failed)


if __name__ == "__main__":
    main()
