"""Narrator real/mock mode resolution tests."""
from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from src.narrator.mock_client import MockLLMClient  # noqa: E402
from src.narrator.mode import resolve_narrator_mode  # noqa: E402
from src.narrator.narrator import Narrator  # noqa: E402


def _write_cfg(path: Path, enabled: bool) -> None:
    path.write_text(
        json.dumps(
            {
                "enabled": enabled,
                "model": "deepseek-chat",
                "timeout_seconds": 5,
                "fallback_on_error": "mock",
                "prompts": {
                    "dir": str(ROOT / "config" / "prompts"),
                    "required_files": ["system.md", "user_decision.md", "user_event.md"],
                    "optional_files": [],
                    "reload_on_change": False,
                },
                "cooldowns": {},
            }
        ),
        encoding="utf-8",
    )


def test_mock_when_disabled() -> None:
    tmp = Path(tempfile.mkdtemp())
    cfg = tmp / "narrator_config.json"
    _write_cfg(cfg, False)
    mode, use_mock = resolve_narrator_mode(config_path=cfg, api_key="sk-test")
    assert mode == "disabled"
    assert use_mock is True


def test_mock_when_no_key() -> None:
    tmp = Path(tempfile.mkdtemp())
    cfg = tmp / "narrator_config.json"
    _write_cfg(cfg, True)
    old = os.environ.pop("DEEPSEEK_API_KEY", None)
    try:
        mode, use_mock = resolve_narrator_mode(config_path=cfg, api_key="")
        assert mode == "mock"
        assert use_mock is True
    finally:
        if old is not None:
            os.environ["DEEPSEEK_API_KEY"] = old


def test_real_when_enabled_and_key_present() -> None:
    tmp = Path(tempfile.mkdtemp())
    cfg = tmp / "narrator_config.json"
    _write_cfg(cfg, True)
    mode, use_mock = resolve_narrator_mode(config_path=cfg, api_key="sk-test")
    assert mode == "real"
    assert use_mock is False


def test_cli_override_mock() -> None:
    tmp = Path(tempfile.mkdtemp())
    cfg = tmp / "narrator_config.json"
    _write_cfg(cfg, True)
    mode, use_mock = resolve_narrator_mode(
        config_path=cfg, mock_override=True, api_key="sk-test"
    )
    assert mode == "mock"
    assert use_mock is True


def test_fallback_on_llm_error() -> None:
    tmp = Path(tempfile.mkdtemp())
    cfg = tmp / "narrator_config.json"
    _write_cfg(cfg, True)

    class Boom:
        def complete(self, system: str, user: str):
            raise RuntimeError("timeout")

    n = Narrator(cfg, project_root=ROOT, llm_client=Boom(), api_key="sk")
    result = n.narrate_decision(
        {
            "primary_mode": "NORMAL",
            "decision": "SKIP",
            "timestamp": "2026-01-01T00:00:00Z",
        }
    )
    assert result.source == "fallback"
    assert result.psychology_text


if __name__ == "__main__":
    test_mock_when_disabled()
    test_mock_when_no_key()
    test_real_when_enabled_and_key_present()
    test_cli_override_mock()
    test_fallback_on_llm_error()
    print("ok")
