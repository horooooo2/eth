"""Factory helpers to build ChatController for API / tests."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from ..behavior_classifier import BehaviorClassifier
from ..character.card import resolve_runtime_character
from ..conversation.chat import ChatController
from ..conversation.impact import ImpactClassifier
from ..conversation.llm import ConversationLLMClient, DynamicLLMClient
from ..conversation.memory import ConversationMemory
from ..conversation.prompt_builder import ConversationPromptBuilder
from ..db.repositories import ConversationRepo, PositionsRepo, TraitsRepo
from ..deadline_hooks import build_deadline_stack
from ..person_state import TRAIT_KEYS, PersonStateEngine


def build_chat_controller(
    *,
    config_dir: Path,
    conn: Any,
    project_root: Path,
    state_engine: Any | None = None,
    use_mock_llm: bool | None = None,
    llm_client: Any | None = None,
) -> tuple[ChatController, ConversationRepo, Any]:
    config_dir = Path(config_dir)
    conv_path = config_dir / "conversation_config.json"
    conv_cfg = json.loads(conv_path.read_text(encoding="utf-8")) if conv_path.exists() else {"enabled": True}

    card = resolve_runtime_character(config_dir)
    if state_engine is None:
        evo = config_dir / "baseline_evolution.json"
        event_path = config_dir / "event_impacts.json"
        # Prefer card event impacts if materialized later; use project event file
        if not event_path.exists():
            event_path = project_root / "config" / "event_impacts.json"
        deadline_cfg, deadline_manager, ambient_sampler = build_deadline_stack(
            config_dir, card, start_date=__import__("datetime").date.today().isoformat()
        )
        state_engine = PersonStateEngine(
            event_path,
            baseline_evolution_config=evo if evo.exists() else None,
            baseline_bounds=card.get("baseline_bounds"),
            deadline_manager=deadline_manager,
            ambient_sampler=ambient_sampler,
        )
        baseline = card.get("traits_baseline") or {}
        if baseline:
            state_engine.set_baseline({k: float(baseline[k]) for k in TRAIT_KEYS if k in baseline})
            for k, v in baseline.items():
                if k in TRAIT_KEYS:
                    setattr(state_engine.state, k, float(v))
            state_engine._clip(warn=False)  # type: ignore[attr-defined]
        # hydrate from latest traits row if present
        try:
            latest = TraitsRepo(conn).latest()
            if latest:
                for k in TRAIT_KEYS:
                    if latest.get(k) is not None:
                        setattr(state_engine.state, k, float(latest[k]))
                state_engine._clip(warn=False)  # type: ignore[attr-defined]
        except Exception:
            pass

    modes_path = config_dir / "behavior_modes.json"
    if not modes_path.exists():
        modes_path = project_root / "config" / "behavior_modes.json"
    classifier = BehaviorClassifier(modes_path)

    conv_repo = ConversationRepo(conn)
    max_turns = int((conv_cfg.get("short_term_memory") or {}).get("max_turns") or 20)
    memory = ConversationMemory(conv_repo, max_turns=max_turns)
    impact = ImpactClassifier(conv_cfg)
    prompt_builder = ConversationPromptBuilder(conv_cfg)

    if llm_client is None:
        if use_mock_llm is True:
            from ..narrator.mock_client import MockLLMClient

            llm_client = MockLLMClient()
        elif use_mock_llm is False:
            llm_client = ConversationLLMClient()
        else:
            # Hot-switch: DeepSeek when key present, else mock (no restart needed)
            llm_client = DynamicLLMClient(allow_mock=True)

    def account_provider() -> dict[str, Any]:
        out = {"equity": 20000.0, "today_pnl": 0.0, "position_count": 0}
        sync = getattr(conn, "_account_sync_ref", None)
        return out

    controller = ChatController(
        conv_cfg,
        llm_client,
        memory,
        prompt_builder,
        impact,
        state_engine,
        account_provider=None,
        position_repo=PositionsRepo(conn),
        deadline_manager=getattr(state_engine, "deadline_manager", None),
        behavior_classifier=classifier,
    )
    return controller, conv_repo, state_engine
