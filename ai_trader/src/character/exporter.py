"""Export character cards to JSON."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from .card import load_character


SENSITIVE_KEYS = {"api_key", "secret_key", "passphrase", "okx_api_key", "deepseek_api_key"}


def _strip_secrets(obj: Any) -> Any:
    if isinstance(obj, dict):
        return {
            k: ("***" if k.lower() in SENSITIVE_KEYS else _strip_secrets(v))
            for k, v in obj.items()
        }
    if isinstance(obj, list):
        return [_strip_secrets(v) for v in obj]
    return obj


def export_to_json(
    character_id: str,
    config_dir: Path,
    *,
    strip_secrets: bool = True,
    owner: str | None = None,
) -> str:
    """Return formatted JSON string for a character card."""
    card = load_character(character_id, Path(config_dir), owner=owner)
    if strip_secrets:
        card = _strip_secrets(card)
    return json.dumps(card, ensure_ascii=False, indent=2) + "\n"


def export_to_file(
    character_id: str,
    config_dir: Path,
    output_path: Path,
    *,
    strip_secrets: bool = True,
    owner: str | None = None,
) -> Path:
    text = export_to_json(
        character_id, config_dir, strip_secrets=strip_secrets, owner=owner
    )
    out = Path(output_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(text, encoding="utf-8")
    return out
