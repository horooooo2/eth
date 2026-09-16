"""Import character cards from JSON."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from .card import (
    CharacterCardError,
    characters_dir,
    clear_imported_characters,
    normalize_card,
    set_active_character,
    validate_card,
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
    try:
        card = json.loads(json_str)
    except json.JSONDecodeError as exc:
        raise CharacterCardError(f"invalid JSON: {exc}") from exc
    if not isinstance(card, dict):
        raise CharacterCardError("root must be a JSON object")
    return _save(
        card,
        Path(config_dir),
        force=force,
        activate=activate,
        owner=owner,
        replace_all=replace_all,
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
