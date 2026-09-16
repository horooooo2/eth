"""Import character cards from JSON."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from .card import (
    CharacterCardError,
    character_defaults_dir,
    characters_dir,
    clear_imported_characters,
    normalize_card,
    set_active_character,
    validate_card,
)


def _unwrap_card_payload(data: Any) -> dict[str, Any]:
    """
    Accept common wrappers from UI / chat exports.
    - raw card object
    - { "card": { ... } }
    - { "character": { ... } }
    - { "data": { ... } }
    """
    if not isinstance(data, dict):
        raise CharacterCardError("root must be a JSON object")
    if data.get("id") or data.get("traits_baseline") or data.get("profile"):
        return data
    for key in ("card", "character", "data", "payload"):
        inner = data.get(key)
        if isinstance(inner, dict) and (
            inner.get("id") or inner.get("traits_baseline") or inner.get("profile")
        ):
            return inner
    keys = ", ".join(sorted(data.keys())[:20]) or "(empty)"
    raise CharacterCardError(
        "missing required fields: id, name, traits_baseline, behavior_modes, "
        f"decision_rules, prompts (got top-level keys: {keys}). "
        "请导入完整角色卡 JSON（含 id / traits_baseline / prompts），"
        "或使用「导入默认张明」。"
    )


def validate_before_import(card: dict[str, Any]) -> None:
    validate_card(card)


def import_from_json(
    json_str: str,
    config_dir: Path,
    *,
    force: bool = False,
    activate: bool = True,
    owner: str | None = None,
    replace_all: bool = True,
) -> Path:
    """Parse JSON and save under owner's characters/{id}.json (single card by default)."""
    text = (json_str or "").strip()
    if text.startswith("\ufeff"):
        text = text.lstrip("\ufeff")
    # Allow fenced markdown dumps from chat
    if text.startswith("```"):
        lines = text.splitlines()
        if lines and lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        text = "\n".join(lines).strip()
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError as exc:
        raise CharacterCardError(f"invalid JSON: {exc}") from exc
    card = _unwrap_card_payload(parsed)
    return _save(
        card,
        Path(config_dir),
        force=force,
        activate=activate,
        owner=owner,
        replace_all=replace_all,
    )


def import_default_character(
    config_dir: Path,
    *,
    character_id: str = "zhangming",
    owner: str | None = None,
    force: bool = True,
) -> Path:
    """Import shipped default card from character_defaults/ (no upload needed)."""
    path = character_defaults_dir(config_dir) / f"{character_id}.json"
    if not path.exists():
        raise CharacterCardError(f"default character not found: {character_id}")
    return import_from_file(
        path,
        config_dir,
        force=force,
        activate=True,
        owner=owner,
        replace_all=True,
    )


def import_from_file(
    path: Path,
    config_dir: Path,
    *,
    force: bool = False,
    activate: bool = True,
    owner: str | None = None,
    replace_all: bool = True,
) -> Path:
    text = Path(path).read_text(encoding="utf-8")
    return import_from_json(
        text,
        config_dir,
        force=force,
        activate=activate,
        owner=owner,
        replace_all=replace_all,
    )


def _save(
    card: dict[str, Any],
    config_dir: Path,
    *,
    force: bool,
    activate: bool,
    owner: str | None,
    replace_all: bool,
) -> Path:
    card = normalize_card(card)
    validate_before_import(card)
    cid = str(card["id"]).strip()
    if not cid:
        raise CharacterCardError("id must be non-empty")

    # One personality per account: clear previous cards before write
    if replace_all:
        clear_imported_characters(config_dir, owner)

    folder = characters_dir(config_dir, owner)
    folder.mkdir(parents=True, exist_ok=True)
    dest = folder / f"{cid}.json"
    if dest.exists() and not force and not replace_all:
        raise CharacterCardError(f"character already exists: {cid} (pass force=true to overwrite)")
    dest.write_text(json.dumps(card, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    if activate:
        set_active_character(cid, config_dir, owner)
    return dest
