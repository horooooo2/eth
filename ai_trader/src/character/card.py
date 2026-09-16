"""Character card load / validate / apply."""
from __future__ import annotations

import json
import re
import tempfile
from pathlib import Path
from typing import Any

REQUIRED_FIELDS = (
    "id",
    "name",
    "traits_baseline",
    "behavior_modes",
    "decision_rules",
    "prompts",
)

PROMPT_KEYS = (
    "system",
    "user_decision",
    "user_event",
    "user_daily_open",
    "user_daily_close",
    "user_news_check",
    "user_deadline_evaluation",
)


class CharacterCardError(ValueError):
    """Invalid or missing character card."""


def normalize_card(card: dict[str, Any]) -> dict[str, Any]:
    """
    Accept V2 cards that nest identity under `profile` and ambient under
    `event_impacts.ambient_events.events`. Returns a shallow-copied card with
    top-level fields expected by engines / UI.
    """
    out = dict(card)
    profile = out.get("profile")
    if isinstance(profile, dict):
        for key in ("name", "age", "occupation", "location", "gender", "education"):
            if key not in out or out[key] in (None, ""):
                if key in profile and profile[key] not in (None, ""):
                    out[key] = profile[key]
        if ("family" not in out or out["family"] in (None, "")) and "family" in profile:
            fam = profile["family"]
            if isinstance(fam, dict):
                bits = [
                    str(fam.get("marital_status") or ""),
                    str(fam.get("spouse") or ""),
                    str(fam.get("children") or ""),
                ]
                out["family"] = " · ".join(b for b in bits if b) or json.dumps(fam, ensure_ascii=False)
            else:
                out["family"] = fam
        if ("background" not in out or out["background"] in (None, "")) and profile.get(
            "personality_summary"
        ):
            out["background"] = str(profile["personality_summary"])
        past = profile.get("past")
        if isinstance(past, dict) and ("background" not in out or not out.get("background")):
            out["background"] = str(past.get("trauma_note") or past.get("trauma") or "")

    if "tags" not in out or not out["tags"]:
        # Derive light tags from profile summary if missing
        summary = str((out.get("profile") or {}).get("personality_summary") or out.get("background") or "")
        if summary:
            out["tags"] = ["自律", "清醒"]

    ei = out.get("event_impacts")
    if isinstance(ei, dict):
        ei = dict(ei)
        ambient = ei.get("ambient_events")
        if isinstance(ambient, dict) and "events" in ambient and isinstance(ambient["events"], dict):
            # Flatten { note, events: { NAME: impacts } } → { NAME: impacts }
            flat: dict[str, Any] = {}
            for name, impacts in ambient["events"].items():
                if isinstance(impacts, dict):
                    flat[name] = dict(impacts)
            # Keep note only if no event keys collided
            if ambient.get("note") and "note" not in flat:
                pass  # drop narrative note from runtime pool
            ei["ambient_events"] = flat
            out["event_impacts"] = ei
    return out


def sanitize_owner(owner: str | None) -> str:
    """Safe folder name for per-login-account character scope."""
    raw = (owner or "").strip()
    if not raw:
        return ""
    cleaned = re.sub(r"[^A-Za-z0-9_\-@.]", "_", raw)[:64]
    return cleaned


def owner_config_root(config_dir: Path, owner: str | None = None) -> Path:
    """
    Per-account config root.
    Empty owner → legacy shared config_dir (scheduler / standalone).
    Logged-in account → config/users/{owner}/
    """
    oid = sanitize_owner(owner)
    if not oid:
        return Path(config_dir)
    return Path(config_dir) / "users" / oid


def characters_dir(config_dir: Path, owner: str | None = None) -> Path:
    return owner_config_root(config_dir, owner) / "characters"


def character_defaults_dir(config_dir: Path) -> Path:
    return Path(config_dir) / "character_defaults"


def get_active_character(config_dir: Path, owner: str | None = None) -> str:
    """Read active character id. Empty = none imported/selected."""
    path = owner_config_root(config_dir, owner) / "active_character.txt"
    if not path.exists():
        return ""
    return path.read_text(encoding="utf-8").strip()


def set_active_character(character_id: str, config_dir: Path, owner: str | None = None) -> None:
    root = owner_config_root(config_dir, owner)
    root.mkdir(parents=True, exist_ok=True)
    path = root / "active_character.txt"
    path.write_text(str(character_id).strip() + "\n", encoding="utf-8")


def clear_imported_characters(config_dir: Path, owner: str | None = None) -> None:
    """Remove all imported cards for this owner (keep _template-style files)."""
    folder = characters_dir(config_dir, owner)
    if not folder.is_dir():
        return
    for path in folder.glob("*.json"):
        if path.name.startswith("_"):
            continue
        try:
            path.unlink()
        except OSError:
            pass


def list_characters(config_dir: Path, owner: str | None = None) -> list[dict[str, Any]]:
    """List imported character cards for owner (characters/*.json, skip _*)."""
    folder = characters_dir(config_dir, owner)
    if not folder.is_dir():
        return []
    out: list[dict[str, Any]] = []
    for path in sorted(folder.glob("*.json")):
        if path.name.startswith("_"):
            continue
        try:
            data = normalize_card(json.loads(path.read_text(encoding="utf-8")))
        except (json.JSONDecodeError, OSError):
            continue
        out.append(
            {
                "id": str(data.get("id") or path.stem),
                "name": str(data.get("name") or path.stem),
                "tags": list(data.get("tags") or []),
            }
        )
    return out


def validate_card(card: dict[str, Any]) -> None:
    """Raise CharacterCardError if required fields are missing."""
    card = normalize_card(card)
    missing = [k for k in REQUIRED_FIELDS if k not in card or card[k] in (None, "")]
    if missing:
        raise CharacterCardError(f"missing required fields: {', '.join(missing)}")
    prompts = card.get("prompts")
    if not isinstance(prompts, dict):
        raise CharacterCardError("prompts must be an object")
    for key in ("system", "user_decision", "user_event"):
        if key not in prompts:
            raise CharacterCardError(f"prompts missing key: {key}")
    baseline = card.get("traits_baseline")
    if not isinstance(baseline, dict) or not baseline:
        raise CharacterCardError("traits_baseline must be a non-empty object")
    if not isinstance(card.get("behavior_modes"), dict):
        raise CharacterCardError("behavior_modes must be an object")
    if not isinstance(card.get("decision_rules"), dict):
        raise CharacterCardError("decision_rules must be an object")
    if "baseline_bounds" in card:
        bb = card["baseline_bounds"]
        if not isinstance(bb, dict):
            raise CharacterCardError("baseline_bounds must be an object")
        for trait, pair in bb.items():
            if not isinstance(pair, (list, tuple)) or len(pair) != 2:
                raise CharacterCardError(f"baseline_bounds.{trait} must be [lo, hi]")
            try:
                lo, hi = float(pair[0]), float(pair[1])
            except (TypeError, ValueError) as exc:
                raise CharacterCardError(f"baseline_bounds.{trait} invalid") from exc
            if lo > hi:
                raise CharacterCardError(f"baseline_bounds.{trait}: lo > hi")
    if "trauma_events" in card and not isinstance(card["trauma_events"], dict):
        raise CharacterCardError("trauma_events must be an object")
    if "deadline" in card:
        dl = card["deadline"]
        if not isinstance(dl, dict):
            raise CharacterCardError("deadline must be an object")
        if "total_days" in dl:
            try:
                if int(dl["total_days"]) <= 0:
                    raise CharacterCardError("deadline.total_days must be > 0")
            except (TypeError, ValueError) as exc:
                raise CharacterCardError("deadline.total_days invalid") from exc
    ei = card.get("event_impacts")
    if isinstance(ei, dict) and "ambient_events" in ei:
        ambient = ei["ambient_events"]
        if not isinstance(ambient, dict):
            raise CharacterCardError("event_impacts.ambient_events must be an object")


def load_character(
    character_id: str,
    config_dir: Path,
    owner: str | None = None,
) -> dict[str, Any]:
    """
    Load character card by id.
    Prefer owner's imported cards under characters/, then (global only)
    character_defaults/, then legacy files.
    """
    config_dir = Path(config_dir)
    cid = (character_id or "").strip()
    if not cid:
        raise CharacterCardError("character id is empty")

    imported = characters_dir(config_dir, owner) / f"{cid}.json"
    if imported.exists():
        card = json.loads(imported.read_text(encoding="utf-8"))
        card = normalize_card(card)
        validate_card(card)
        return card

    # Defaults / legacy only for unscoped (engine) loads
    if not sanitize_owner(owner):
        default_path = character_defaults_dir(config_dir) / f"{cid}.json"
        if default_path.exists():
            card = json.loads(default_path.read_text(encoding="utf-8"))
            card = normalize_card(card)
            validate_card(card)
            return card

        if not characters_dir(config_dir).is_dir():
            return _legacy_card(cid, config_dir)
    raise CharacterCardError(f"character not found: {cid}")


def resolve_runtime_character(
    config_dir: Path,
    owner: str | None = None,
) -> dict[str, Any]:
    """
    Character for engines/scheduler.
    Uses active imported card; if none, falls back to shipped default (zhangming).
    """
    config_dir = Path(config_dir)
    active = get_active_character(config_dir, owner)
    imported = list_characters(config_dir, owner)
    if active and any(c["id"] == active for c in imported):
        return load_character(active, config_dir, owner=owner)
    if imported:
        return load_character(imported[0]["id"], config_dir, owner=owner)
    # Engine fallback only — UI still treats this as "not imported"
    return load_character("zhangming", config_dir)


def _legacy_card(character_id: str, config_dir: Path) -> dict[str, Any]:
    prompts_dir = config_dir / "prompts"
    card = {
        "id": character_id,
        "version": "1.0.0",
        "name": character_id,
        "age": 0,
        "occupation": "",
        "location": "",
        "family": "",
        "background": "",
        "tags": [],
        "traits_baseline": {
            "risk_appetite": 0.55,
            "patience": 0.50,
            "focus": 0.60,
            "self_doubt": 0.40,
            "stubbornness": 0.65,
            "stress": 0.30,
            "sleep_debt": 1.0,
        },
        "traits_bounds": {},
        "event_impacts": json.loads((config_dir / "event_impacts.json").read_text(encoding="utf-8")),
        "behavior_modes": json.loads((config_dir / "behavior_modes.json").read_text(encoding="utf-8")),
        "decision_rules": json.loads((config_dir / "decision_rules.json").read_text(encoding="utf-8")),
        "prompts": {
            key: (prompts_dir / f"{key}.md").read_text(encoding="utf-8")
            if (prompts_dir / f"{key}.md").exists()
            else ""
            for key in PROMPT_KEYS
        },
    }
    validate_card(card)
    return card


def materialize_card_configs(
    card: dict[str, Any],
    dest_dir: Path | None = None,
    *,
    project_root: Path | None = None,
) -> Path:
    """
    Write card sections to a temp (or dest) config directory for engine constructors.
    Returns the directory path.
    """
    validate_card(card)
    root = Path(dest_dir) if dest_dir else Path(tempfile.mkdtemp(prefix="ai_trader_char_"))
    root.mkdir(parents=True, exist_ok=True)
    (root / "event_impacts.json").write_text(
        json.dumps(card.get("event_impacts") or {}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    (root / "behavior_modes.json").write_text(
        json.dumps(card["behavior_modes"], ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    (root / "decision_rules.json").write_text(
        json.dumps(card["decision_rules"], ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    prompts_dir = root / "prompts"
    prompts_dir.mkdir(exist_ok=True)
    for key, text_ in (card.get("prompts") or {}).items():
        (prompts_dir / f"{key}.md").write_text(str(text_), encoding="utf-8")

    project = Path(project_root) if project_root else Path(__file__).resolve().parents[2]
    narrator: dict[str, Any] | None = None
    proj_narr = project / "config" / "narrator_config.json"
    if proj_narr.exists():
        try:
            narrator = json.loads(proj_narr.read_text(encoding="utf-8"))
            prompts_cfg = dict(narrator.get("prompts") or {})
            prompts_cfg["dir"] = str(prompts_dir)
            narrator["prompts"] = prompts_cfg
        except (json.JSONDecodeError, OSError):
            narrator = None
    if narrator is None:
        narrator = {
            "version": "1.0.1",
            "provider": "deepseek",
            "model": "deepseek-chat",
            "timeout_seconds": 8,
            "max_retries": 2,
            "temperature": 0.7,
            "enabled": True,
            "fallback_on_error": "mock",
            "prompts": {
                "dir": str(prompts_dir),
                "required_files": ["system.md", "user_decision.md", "user_event.md"],
                "optional_files": [
                    "user_daily_open.md",
                    "user_daily_close.md",
                    "user_deadline_evaluation.md",
                    "user_news_check.md",
                ],
                "reload_on_change": False,
            },
            "cooldowns": {
                "large_unrealized_loss_minutes": 15,
                "small_unrealized_loss_minutes": 30,
                "psychology_repeat_minutes": 30,
            },
        }
    (root / "narrator_config.json").write_text(
        json.dumps(narrator, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return root


def apply_to_engines(card: dict[str, Any], *, project_root: Path | None = None) -> dict[str, Any]:
    """
    Instantiate engines from a character card.
    Returns dict with person, classifier, decision_engine, config_dir, card.
    """
    from ..behavior_classifier import BehaviorClassifier
    from ..decision_engine import DecisionEngine
    from ..person_state import PersonState, PersonStateEngine, TRAIT_KEYS

    validate_card(card)
    project = Path(project_root) if project_root else Path(__file__).resolve().parents[2]
    config_dir = materialize_card_configs(card, project_root=project)
    baseline = card["traits_baseline"]
    evo_path = None
    if (project / "config" / "baseline_evolution.json").exists():
        evo_path = project / "config" / "baseline_evolution.json"
    person = PersonStateEngine(
        config_dir / "event_impacts.json",
        baseline_evolution_config=evo_path,
        baseline_bounds=card.get("baseline_bounds"),
    )
    person.set_baseline({k: float(baseline[k]) for k in TRAIT_KEYS if k in baseline})
    if card.get("traits_bounds"):
        person.set_trait_bounds(card["traits_bounds"])
    for key in TRAIT_KEYS:
        if key in baseline:
            setattr(person.state, key, float(baseline[key]))
    person._clip(warn=False)  # type: ignore[attr-defined]
    classifier = BehaviorClassifier(config_dir / "behavior_modes.json")
    decision_engine = DecisionEngine(config_dir / "decision_rules.json")
    return {
        "card": card,
        "config_dir": config_dir,
        "person": person,
        "classifier": classifier,
        "decision_engine": decision_engine,
        "baseline": PersonState(
            **{k: float(baseline.get(k, getattr(PersonState(), k))) for k in TRAIT_KEYS}
        ),
        "project_root": project_root,
    }
