"""Resolve whether narrator should use mock or real LLM."""
from __future__ import annotations

import json
import logging
import os
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)


def load_narrator_config(config_path: Path) -> dict[str, Any]:
    if not config_path.exists():
        return {"enabled": False}
    try:
        data = json.loads(config_path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {"enabled": False}
    except (json.JSONDecodeError, OSError):
        return {"enabled": False}


def resolve_narrator_mode(
    *,
    config_path: Path,
    mock_override: bool | None = None,
    api_key: str | None = None,
) -> tuple[str, bool]:
    """
    Returns (mode, use_mock).
    mode: real | mock | disabled
    """
    cfg = load_narrator_config(config_path)
    key = (api_key if api_key is not None else os.environ.get("DEEPSEEK_API_KEY") or "").strip()

    if mock_override is True:
        return "mock", True
    if mock_override is False:
        if not key:
            logger.warning("--real-narrator 但 DEEPSEEK_API_KEY 缺失，回退 mock")
            return "mock", True
        return "real", False

    if not cfg.get("enabled", False):
        return "disabled", True

    if not key:
        logger.warning("narrator enabled 但 DEEPSEEK_API_KEY 缺失，回退到 mock 模式。")
        return "mock", True

    return "real", False
