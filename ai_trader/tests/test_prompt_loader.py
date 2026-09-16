"""Tests for external prompt loading and rendering."""
from __future__ import annotations

import json
import sys
import tempfile
import traceback
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from src.narrator.prompt_builder import PromptBuilder, PromptConfigError
from src.narrator.narrator import Narrator

PROMPTS_DIR = ROOT / "config" / "prompts"
NARRATOR_CFG = ROOT / "config" / "narrator_config.json"


def test_load_required_templates() -> None:
    builder = PromptBuilder(PROMPTS_DIR)
    assert "system" in builder.templates
    assert "user_decision" in builder.templates
    assert "user_event" in builder.templates
    assert len(builder.version) == 8


def test_render_replaces_variables() -> None:
    builder = PromptBuilder(PROMPTS_DIR)
    text = builder.render(
        "user_decision",
        {
            "stress": 0.76,
            "risk_appetite": 0.6,
            "patience": 0.3,
            "focus": 0.5,
            "self_doubt": 0.4,
            "sleep_debt": 4.2,
            "primary_mode": "REVENGE_TRADING",
            "modifiers": "EXHAUSTED",
            "recent_events": "和妻子争吵",
            "symbol": "BTC",
            "direction": "LONG",
            "signal_score": 0.73,
            "threshold": 0.57,
            "signal_rule": "BREAKOUT",
            "signal_reason": "突破",
            "decision": "OPEN_LONG",
        },
    )
    assert "0.76" in text
    assert "REVENGE_TRADING" in text
    assert "OPEN_LONG" in text
    assert "{{" not in text


def test_missing_variable_becomes_empty() -> None:
    builder = PromptBuilder(PROMPTS_DIR)
    text = builder.render("user_event", {"event_name": "RENT_DUE"})
    assert "RENT_DUE" in text
    assert "{{event_description}}" not in text


def test_missing_required_file_raises() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        d = Path(tmp)
        (d / "system.md").write_text("hi {{name}}", encoding="utf-8")
        # missing user_decision.md / user_event.md
        try:
            PromptBuilder(d)
            raise AssertionError("should raise PromptConfigError")
        except PromptConfigError:
            pass


def test_empty_required_file_raises() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        d = Path(tmp)
        (d / "system.md").write_text("sys {{x}}", encoding="utf-8")
        (d / "user_decision.md").write_text("   \n", encoding="utf-8")
        (d / "user_event.md").write_text("evt {{y}}", encoding="utf-8")
        try:
            PromptBuilder(d)
            raise AssertionError("should raise PromptConfigError")
        except PromptConfigError:
            pass


def test_single_brace_placeholder_raises() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        d = Path(tmp)
        (d / "system.md").write_text("ok {{name}}", encoding="utf-8")
        (d / "user_decision.md").write_text("bad {stress}", encoding="utf-8")
        (d / "user_event.md").write_text("ok {{event_name}}", encoding="utf-8")
        try:
            PromptBuilder(d)
            raise AssertionError("should raise PromptConfigError")
        except PromptConfigError:
            pass


def test_prompt_hash_stable_then_changes() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        d = Path(tmp)
        (d / "system.md").write_text("sys {{a}}", encoding="utf-8")
        (d / "user_decision.md").write_text("dec {{b}}", encoding="utf-8")
        (d / "user_event.md").write_text("evt {{c}}", encoding="utf-8")
        b1 = PromptBuilder(d)
        b2 = PromptBuilder(d)
        assert b1.version == b2.version
        (d / "system.md").write_text("sys2 {{a}}", encoding="utf-8")
        b3 = PromptBuilder(d)
        assert b3.version != b1.version


def test_from_narrator_config() -> None:
    builder = PromptBuilder.from_narrator_config(NARRATOR_CFG, ROOT)
    system, user = builder.build_decision_prompt(
        stress=0.5,
        risk_appetite=0.5,
        patience=0.5,
        focus=0.5,
        self_doubt=0.4,
        sleep_debt=1.0,
        primary_mode="NORMAL",
        modifiers="",
        recent_events="无",
        symbol="ETH",
        direction="SHORT",
        signal_score=0.6,
        threshold=0.7,
        signal_rule="FLOW",
        signal_reason="放量",
        decision="SKIP",
    )
    assert "张明" in system
    assert "ETH" in user
    assert "SKIP" in user


def test_narrator_fallback_includes_prompt_version() -> None:
    narrator = Narrator(NARRATOR_CFG, project_root=ROOT, api_key="")
    assert narrator.enabled is False
    result = narrator.narrate_decision(
        {
            "stress": 0.8,
            "primary_mode": "REVENGE_TRADING",
            "decision": "OPEN_LONG",
            "modifiers": "",
        }
    )
    assert result.source == "fallback"
    assert result.prompt_version == narrator.prompt_version
    assert result.psychology_text


def run() -> int:
    tests = [
        test_load_required_templates,
        test_render_replaces_variables,
        test_missing_variable_becomes_empty,
        test_missing_required_file_raises,
        test_empty_required_file_raises,
        test_single_brace_placeholder_raises,
        test_prompt_hash_stable_then_changes,
        test_from_narrator_config,
        test_narrator_fallback_includes_prompt_version,
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
    print("=== test_prompt_loader ===")
    for line in details:
        print(line)
    print(f"---\npassed={passed} failed={failed} total={len(tests)}")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    raise SystemExit(run())
