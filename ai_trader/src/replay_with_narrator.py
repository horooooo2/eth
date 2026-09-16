"""Paper replay with event-driven Narrator (旁路叙事).

Usage:
    python -m src.replay_with_narrator --mock
    python -m src.replay_with_narrator --real
    python -m src.replay_with_narrator --mock --bars 500 --output reports/narrative_timeline_mock.md
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from uuid import uuid4

from .baseline_integration import apply_and_persist_evolution, collect_daily_stats
from .behavior_classifier import BehaviorClassifier
from .character.card import load_character
from .db import close_connection, compute_config_hash, get_connection, init_database
from .db.migrations_v9 import apply_v9_migrations
from .db.migrations_v10 import apply_v10_migrations
from .db.path import get_db_path
from .db.repositories import (
    AmbientRepo,
    BaselineRepo,
    DecisionEventsRepo,
    DecisionRepo,
    DeadlineRepo,
    EventsRepo,
    PositionsRepo,
    PsychologyRepo,
    TraitsRepo,
    TraumaRepo,
)
from .deadline_hooks import (
    build_deadline_stack,
    maybe_run_deadline_evaluation,
    process_new_day,
)
from .decision_engine import DecisionEngine
from .narrator.event_bridge import NarratorEventBridge
from .narrator.mock_client import MockLLMClient
from .narrator.narrator import Narrator
from .paper_execution import PaperExecutionEngine
from .person_state import DEFAULT_BASELINE_BOUNDS, PersonStateEngine
from .position_manager import PositionManager
from .replay import (
    ROOT,
    apply_outcome_to_state,
    compute_atr,
    generate_sample_ohlcv,
    _persist_events,
)
from .risk_engine import MarketSnapshot, RiskEngine
from .signal_engine import SignalEngine
from .trade_intent import (
    STATUS_PENDING_RISK,
    STATUS_RISK_APPROVED,
    STATUS_RISK_REJECTED,
    TradeIntent,
)

DATA_PATH = ROOT / "data" / "sample_ohlcv.json"
DEFAULT_DB = get_db_path()
DEFAULT_OUTPUT = ROOT / "reports" / "narrative_timeline.md"


def _parse_ts(ts: str) -> datetime:
    return datetime.fromisoformat(ts.replace("Z", "+00:00"))


def _date_key(ts: str) -> str:
    return _parse_ts(ts).date().isoformat()


def generate_narrative_timeline(conn: Any) -> str:
    """Query narrated decisions + psychology rows into a markdown timeline."""
    lines = ["# 张明的一天 · 叙事时间线", ""]

    psych_rows = list(
        conn.execute(
            """
            SELECT id, timestamp, mood, mood_label, narrative_text, prompt_version, state_snapshot
            FROM psychology_log
            WHERE narrative_text IS NOT NULL AND TRIM(narrative_text) != ''
            ORDER BY timestamp, id
            """
        ).fetchall()
    )
    psych_by_text: dict[str, Any] = {}
    for r in psych_rows:
        psych_by_text.setdefault(str(r["narrative_text"]), r)

    decision_rows = list(
        conn.execute(
            """
            SELECT
                d.decision_id,
                d.timestamp,
                d.primary_mode,
                d.prompt_version,
                d.narrative_thought,
                d.narrative_body_action,
                d.decision,
                d.signal_rule,
                d.signal_score,
                d.direction,
                d.symbol,
                d.decision_reason,
                d.position_multiplier,
                p.realized_pnl,
                p.exit_reason,
                p.exit_price,
                p.max_favorable_excursion,
                p.max_adverse_excursion
            FROM decision_log d
            LEFT JOIN positions p ON p.decision_id = d.decision_id
            WHERE d.narrative_thought IS NOT NULL AND TRIM(d.narrative_thought) != ''
            ORDER BY d.timestamp
            """
        ).fetchall()
    )
    decision_thoughts = {str(d["narrative_thought"]) for d in decision_rows}

    # Merge into a single chronological stream of "items"
    items: list[tuple[str, str, Any]] = []
    for d in decision_rows:
        items.append((str(d["timestamp"]), "decision", d))
    for r in psych_rows:
        text = str(r["narrative_text"])
        if text in decision_thoughts:
            continue  # already covered via decision block
        items.append((str(r["timestamp"]), "psych", r))
    items.sort(key=lambda x: (x[0], 0 if x[1] == "psych" else 1))

    for ts, kind, payload in items:
        stamp = _parse_ts(ts).strftime("%m-%d %H:%M")
        lines.append(f"## {stamp}")
        lines.append("")

        if kind == "decision":
            dec = payload
            mode = str(dec["primary_mode"] or "—")
            if str(dec["decision"] or "").startswith("OPEN") or dec["decision"] == "SKIP":
                lines.append("### 📊 交易决策")
                lines.append("")
                lines.append(
                    f"**Signal**: {dec['symbol']} {dec['direction']} · "
                    f"score {float(dec['signal_score'] or 0):.2f} · {dec['signal_rule']}"
                )
                thr_s = "—"
                reason = dec["decision_reason"]
                if isinstance(reason, str):
                    try:
                        reason = json.loads(reason)
                    except json.JSONDecodeError:
                        reason = {}
                if isinstance(reason, dict) and reason.get("final_threshold") is not None:
                    thr_s = f"{float(reason['final_threshold']):.2f}"
                lines.append(f"**Threshold**: {thr_s}")
                lines.append(
                    f"**Decision**: {dec['decision']} · "
                    f"mult {float(dec['position_multiplier'] or 1):.2f}"
                )
                lines.append("")
            if dec["exit_reason"]:
                lines.append("### 📊 平仓")
                lines.append("")
                pnl = float(dec["realized_pnl"] or 0)
                lines.append(
                    f"**Exit**: {dec['exit_price']} · **PnL**: ${pnl:+.2f} · "
                    f"**MFE**: {float(dec['max_favorable_excursion'] or 0):+.1%} · "
                    f"**MAE**: {float(dec['max_adverse_excursion'] or 0):+.1%}"
                )
                lines.append("")
            thought = dec["narrative_thought"]
            body = dec["narrative_body_action"] or ""
            pv = dec["prompt_version"] or "—"
            match = psych_by_text.get(str(thought))
            mood_label = (
                (match["mood_label"] or match["mood"]) if match else "—"
            )
        else:
            row = payload
            try:
                snap = json.loads(row["state_snapshot"] or "{}")
            except json.JSONDecodeError:
                snap = {}
            thought = row["narrative_text"]
            body = ""
            pv = row["prompt_version"] or "—"
            mode = str(snap.get("primary_mode") or "—")
            mood_label = row["mood_label"] or row["mood"] or "—"

        lines.append("### 💬 心理活动")
        lines.append("")
        lines.append(f"> {thought}")
        lines.append("")
        lines.append(f"**Mood**: {mood_label} · **Mode**: {mode} · **Prompt v**: {pv}")
        lines.append("")
        if body:
            lines.append("### 🏃 身体活动")
            lines.append("")
            lines.append(body)
            lines.append("")
        lines.append("---")
        lines.append("")

    return "\n".join(lines).rstrip() + "\n"


def replay_with_narrator(
    ohlcv_data: list[dict[str, Any]],
    config_dir: Path | None = None,
    db_path: Path | None = None,
    *,
    use_mock: bool = True,
    mock_client: MockLLMClient | None = None,
) -> dict[str, Any]:
    """
    Run paper replay and narrate on decisions / events / daily boundaries.
    Returns stats + timeline markdown path payload.
    """
    config_dir = config_dir or (ROOT / "config")
    db_path = db_path or DEFAULT_DB
    if db_path.exists():
        db_path.unlink()

    conn = get_connection(db_path)
    init_database(conn)
    apply_v9_migrations(conn)
    apply_v10_migrations(conn)
    config_hash = compute_config_hash(config_dir)

    events_repo = EventsRepo(conn)
    psychology_repo = PsychologyRepo(conn)
    decision_repo = DecisionRepo(conn)
    decision_events_repo = DecisionEventsRepo(conn)
    positions_repo = PositionsRepo(conn)
    traits_repo = TraitsRepo(conn)
    baseline_repo = BaselineRepo(conn)
    trauma_repo = TraumaRepo(conn)
    ambient_repo = AmbientRepo(conn)
    deadline_repo = DeadlineRepo(conn)

    evo_path = config_dir / "baseline_evolution.json"
    bounds = dict(DEFAULT_BASELINE_BOUNDS)
    traits0: dict[str, Any] = {}
    card: dict[str, Any] = {}
    try:
        card = load_character("zhangming", config_dir)
        if card.get("baseline_bounds"):
            bounds = {k: tuple(v) for k, v in card["baseline_bounds"].items()}
        traits0 = card.get("traits_baseline") or {}
    except Exception:
        pass

    start_iso = str(ohlcv_data[100]["timestamp"])[:10]
    deadline_cfg, deadline_manager, ambient_sampler = build_deadline_stack(
        config_dir,
        card or {"deadline": {"enabled": True, "total_days": 90}},
        start_iso,
        random_state=42,
    )
    person = PersonStateEngine(
        config_dir / "event_impacts.json",
        baseline_evolution_config=evo_path if evo_path.exists() else None,
        baseline_bounds=bounds,
        deadline_manager=deadline_manager,
        ambient_sampler=ambient_sampler,
    )
    if traits0:
        person.set_baseline({k: float(traits0[k]) for k in traits0})
        for k, v in traits0.items():
            if hasattr(person.state, k):
                setattr(person.state, k, float(v))
        person._clip(warn=False)  # type: ignore[attr-defined]
    classifier = BehaviorClassifier(config_dir / "behavior_modes.json")
    signal_engine = SignalEngine(config_dir / "signal_rules.json")
    decision_engine = DecisionEngine(config_dir / "decision_rules.json")
    risk_engine = RiskEngine(config_dir / "risk_rules.json")
    paper = PaperExecutionEngine(config_dir / "risk_rules.json", seed=42)
    positions = PositionManager(config_dir / "risk_rules.json")

    cooldown = float(
        (json.loads((config_dir / "narrator_config.json").read_text(encoding="utf-8"))
         .get("cooldowns", {})
         .get("psychology_repeat_minutes", 30))
    )

    if use_mock:
        llm_client = mock_client or MockLLMClient()
        narrator = Narrator(
            config_dir / "narrator_config.json",
            project_root=ROOT,
            llm_client=llm_client,
        )
    else:
        api_key = os.environ.get("DEEPSEEK_API_KEY", "")
        narrator = Narrator(
            config_dir / "narrator_config.json",
            project_root=ROOT,
            api_key=api_key,
        )
        # Force-enable real path when --real even if config says enabled:false
        if api_key:
            narrator.enabled = True

    bridge = NarratorEventBridge(
        narrator, decision_repo, psychology_repo, cooldown_minutes=cooldown
    )

    pending_event_ids: list[int] = []
    recent_events: list[str] = []
    decision_count = 0
    day_idx = 0
    day_pnl = 0.0
    day_decisions = 0
    day_start_equity = float(positions.cash)
    peak_equity = day_start_equity
    days_profitable_streak = 0
    days_losing_streak = 0
    starting_baseline = person.baseline_snapshot()
    from datetime import date as _date, timedelta

    _start_d = _date.fromisoformat(start_iso)
    # Synthetic trading day = 240 bars (~4h) so short replays still get daily narratives
    day_len = 240

    life_cycle = [
        "ARGUMENT_WITH_WIFE",
        "RENT_DUE",
        "EX_COLLEAGUE_NEW_CAR",
        "INTERVIEW_REJECTED",
        "CHILD_SICK",
        "SLEPT_7_HOURS",
    ]

    traits_repo.insert({"date": f"day-{day_idx:03d}", **person.snapshot()})
    baseline_repo.insert_snapshot(
        f"day-{day_idx:03d}",
        person.baseline_snapshot(),
        reason="initial",
        detail=None,
    )
    behavior0 = classifier.classify(person.state)
    bridge.on_daily_open(
        person.snapshot(),
        {
            "primary_mode": behavior0.primary_mode,
            "modifiers": list(behavior0.modifiers),
        },
        date=f"day-{day_idx:03d}",
        yesterday_summary="新开局",
        timestamp=ohlcv_data[100]["timestamp"],
        now=_parse_ts(ohlcv_data[100]["timestamp"]),
    )

    for i in range(100, len(ohlcv_data)):
        window = ohlcv_data[: i + 1]
        bar = ohlcv_data[i]
        ts = bar["timestamp"]
        now = _parse_ts(ts)
        atr = compute_atr(window)
        market = MarketSnapshot(price=float(bar["close"]), atr=atr, timestamp=ts)
        behavior = classifier.classify(person.state)
        behavior_dict = {
            "primary_mode": behavior.primary_mode,
            "modifiers": list(behavior.modifiers),
        }

        # Synthetic day boundary
        if i > 100 and (i - 100) % day_len == 0:
            bridge.on_daily_close(
                person.snapshot(),
                behavior_dict,
                day_summary=f"决策 {day_decisions} 笔，日盈亏 {day_pnl:+.2f}",
                date=f"day-{day_idx:03d}",
                today_pnl=f"{day_pnl:+.2f}",
                timestamp=ts,
                now=now,
            )
            equity_now = float(positions.get_portfolio_state(market.price).equity)
            peak_equity = max(peak_equity, equity_now)
            if day_pnl > 0:
                days_profitable_streak += 1
                days_losing_streak = 0
            elif day_pnl < 0:
                days_losing_streak += 1
                days_profitable_streak = 0
            stats = collect_daily_stats(
                daily_pnl=day_pnl,
                start_equity=day_start_equity,
                equity=equity_now,
                peak_equity=peak_equity,
                consecutive_losses=int(positions.consecutive_stop_losses),
                days_profitable_streak=days_profitable_streak,
                days_losing_streak=days_losing_streak,
            )
            apply_and_persist_evolution(
                person,
                stats,
                date=f"day-{day_idx:03d}",
                timestamp=ts,
                baseline_repo=baseline_repo,
                trauma_repo=trauma_repo,
            )
            cal_day = (_start_d + timedelta(days=day_idx)).isoformat()
            process_new_day(
                today=cal_day,
                person=person,
                deadline_repo=deadline_repo,
                ambient_repo=ambient_repo,
                narrator_bridge=bridge,
                behavior=behavior_dict,
                recent_events=recent_events,
            )
            maybe_run_deadline_evaluation(
                today=cal_day,
                person=person,
                deadline_manager=deadline_manager,
                deadline_config=deadline_cfg,
                narrator=narrator,
                deadline_repo=deadline_repo,
                db_repos={"conn": conn, "positions_repo": positions_repo},
                starting_baseline=starting_baseline,
            )
            person.daily_decay()
            day_idx += 1
            traits_repo.insert({"date": f"day-{day_idx:03d}", **person.snapshot()})
            day_pnl = 0.0
            day_decisions = 0
            day_start_equity = equity_now
            bridge.on_daily_open(
                person.snapshot(),
                behavior_dict,
                date=f"day-{day_idx:03d}",
                yesterday_summary=f"day-{day_idx - 1:03d} 已结束",
                timestamp=ts,
                now=now,
            )

        # Life events (more frequent than base replay so event narratives ≥10)
        if i % 40 == 0:
            name = life_cycle[(i // 40) % len(life_cycle)]
            specs = [{"name": name, "type": "atomic"}]
            person.apply_events(specs)
            eids = _persist_events(events_repo, specs, ts, config_dir, event_type="life")
            pending_event_ids.extend(eids)
            recent_events.append(name)
            recent_events = recent_events[-8:]
            bridge.on_event(
                {"name": name, "description": name, "timestamp": ts},
                person.snapshot(),
                behavior_dict,
                recent_events,
                now=now,
            )

        if i % 520 == 0 and i > 100:
            cool = [
                {"name": "SLEPT_7_HOURS", "type": "atomic"},
                {"name": "SLEPT_7_HOURS", "type": "atomic"},
                {"name": "BIG_WIN", "type": "atomic"},
            ]
            person.apply_events(cool)
            eids = _persist_events(events_repo, cool, ts, config_dir, event_type="life")
            pending_event_ids.extend(eids)
            person.apply_events([{"name": "CHILD_SICK", "type": "atomic"}])
            eids2 = _persist_events(
                events_repo,
                [{"name": "CHILD_SICK", "type": "atomic"}],
                ts,
                config_dir,
                event_type="life",
            )
            pending_event_ids.extend(eids2)
            for nm in ("SLEPT_7_HOURS", "BIG_WIN", "CHILD_SICK"):
                recent_events.append(nm)
            recent_events = recent_events[-8:]
            bridge.on_event(
                {"name": "CHILD_SICK", "description": "CHILD_SICK", "timestamp": ts},
                person.snapshot(),
                behavior_dict,
                recent_events,
                now=now,
            )

        if i % 3 == 0:
            signal_engine.history = {name: [] for name in signal_engine.rules}
            signals = signal_engine.generate_signals(window, "BTC")
            behavior = classifier.classify(person.state)
            behavior_dict = {
                "primary_mode": behavior.primary_mode,
                "modifiers": list(behavior.modifiers),
            }

            for signal in signals:
                decision = decision_engine.decide(signal, person.state, behavior)
                decision_id = str(uuid4())
                risk_check = "SKIP"
                reject_reason = None
                position_id = None

                leverage = float(
                    risk_engine.config.get("execution", {}).get("default_leverage", 3.0)
                )
                probe_atr = atr
                saved_daily = positions.daily_pnl
                open_n = positions.get_portfolio_state(market.price).open_position_count
                if decision.action.startswith("OPEN") and open_n < 3:
                    if decision_count % 17 in (0, 3, 14):
                        leverage = 5.0
                    elif decision_count % 17 == 5:
                        probe_atr = float(market.price) * 0.03
                    elif decision_count % 17 == 7:
                        positions.daily_pnl = -positions.daily_start_equity * 0.04
                elif decision.action.startswith("OPEN") and decision_count % 43 == 0:
                    positions.daily_pnl = -positions.daily_start_equity * 0.04

                if decision.action.startswith("OPEN"):
                    intent = TradeIntent.create(
                        decision,
                        symbol="BTC",
                        direction=signal.direction,
                        ttl_seconds=int(
                            risk_engine.config.get("execution", {}).get("intent_ttl_seconds", 60)
                        ),
                        entry_price_hint=market.price,
                        atr=probe_atr,
                        leverage=leverage,
                        now=now,
                    )
                    intent.transition_to(STATUS_PENDING_RISK)
                    portfolio = positions.get_portfolio_state(market.price)
                    probe_market = MarketSnapshot(
                        price=market.price, atr=probe_atr, timestamp=ts
                    )
                    risk_result = risk_engine.check(intent, portfolio, probe_market)
                    intent.risk_result = risk_result
                    if risk_result.approved:
                        intent.transition_to(STATUS_RISK_APPROVED)
                        execution = paper.execute(intent, market)
                        if execution.status == "FILLED":
                            risk_check = "PASS"
                            pos = positions.open_position(
                                intent, execution, psychology=person.snapshot()
                            )
                            pos.decision_id = decision_id
                            position_id = pos.position_id
                        else:
                            risk_check = "REJECT"
                            reject_reason = execution.reject_reason or "EXEC_REJECT"
                    else:
                        intent.transition_to(STATUS_RISK_REJECTED)
                        risk_check = "REJECT"
                        reject_reason = risk_result.reject_reason
                    positions.daily_pnl = saved_daily
                else:
                    risk_check = "SKIP"

                decision_repo.insert(
                    {
                        "decision_id": decision_id,
                        "timestamp": ts,
                        "symbol": signal.symbol,
                        "direction": signal.direction,
                        "signal_rule": signal.rule_name,
                        "signal_raw_score": signal.raw_score,
                        "signal_score": signal.score,
                        "signal_reason": signal.reason,
                        "signal_rule_version": signal.rule_version,
                        "psychology_before": person.snapshot(),
                        "primary_mode": behavior.primary_mode,
                        "modifiers": behavior.modifiers,
                        "behavior_rule_version": behavior.rule_version,
                        "decision_reason": decision.decision_reason,
                        "decision_rule_version": decision.rule_version,
                        "decision": decision.action,
                        "position_multiplier": decision.position_multiplier,
                        "risk_check": risk_check,
                        "risk_reject_reason": reject_reason,
                        "position_id": position_id,
                        "config_snapshot_hash": config_hash,
                    }
                )
                if position_id is not None:
                    for pos in positions.open_positions():
                        if pos.position_id == position_id:
                            positions_repo.insert(
                                {
                                    "position_id": pos.position_id,
                                    "decision_id": decision_id,
                                    "symbol": pos.symbol,
                                    "side": pos.side,
                                    "leverage": pos.leverage,
                                    "margin": pos.margin,
                                    "notional": pos.notional,
                                    "entry_price": pos.entry_price,
                                    "stop_loss": pos.stop_loss,
                                    "take_profit": pos.take_profit,
                                    "status": "OPEN",
                                    "fees": pos.fees,
                                    "entry_time": pos.entry_time,
                                    "psychology_at_entry": pos.psychology_at_entry,
                                }
                            )
                            break
                if pending_event_ids:
                    decision_events_repo.link_many(decision_id, pending_event_ids)
                    pending_event_ids = []

                bridge.on_decision(
                    decision_id=decision_id,
                    state=person.snapshot(),
                    behavior=behavior_dict,
                    signal={
                        "symbol": signal.symbol,
                        "direction": signal.direction,
                        "score": signal.score,
                        "rule_name": signal.rule_name,
                        "reason": signal.reason,
                    },
                    decision={
                        "timestamp": ts,
                        "action": decision.action,
                        "threshold": decision.threshold,
                        "decision": decision.action,
                    },
                    recent_events=list(recent_events),
                    now=now,
                )
                decision_count += 1
                day_decisions += 1
                if decision_count % 100 == 0:
                    conn.commit()

        closed = positions.update(market)
        for pos in closed:
            psychology_at_exit = person.snapshot()
            specs = apply_outcome_to_state(
                person,
                pos,
                positions.get_portfolio_state(market.price).equity,
                positions.consecutive_stop_losses,
                config_dir,
            )
            eids = _persist_events(events_repo, specs, ts, config_dir, event_type="trade")
            if pos.decision_id:
                for eid in eids:
                    try:
                        decision_events_repo.link(str(pos.decision_id), eid)
                    except Exception:
                        pass
            positions_repo.update_close(
                pos.position_id,
                {
                    "exit_price": pos.exit_price,
                    "exit_time": pos.exit_time,
                    "exit_reason": pos.exit_reason,
                    "realized_pnl": pos.realized_pnl,
                    "fees": pos.fees,
                    "max_favorable_excursion": pos.mfe,
                    "max_adverse_excursion": pos.mae,
                    "psychology_at_exit": psychology_at_exit,
                },
            )
            day_pnl += float(pos.realized_pnl or 0)
            for spec in specs:
                recent_events.append(spec["name"])
                recent_events = recent_events[-8:]
                bridge.on_event(
                    {
                        "name": spec["name"],
                        "description": spec["name"],
                        "timestamp": ts,
                    },
                    person.snapshot(),
                    behavior_dict,
                    recent_events,
                    now=now,
                )

        # Soft mid-day trait snapshot (daily open/close handled above)
        if i % 240 == 0 and i > 100:
            conn.commit()

    # Final day close
    last = ohlcv_data[-1]
    last_ts = last["timestamp"]
    last_now = _parse_ts(last_ts)
    behavior = classifier.classify(person.state)
    behavior_dict = {
        "primary_mode": behavior.primary_mode,
        "modifiers": list(behavior.modifiers),
    }
    bridge.on_daily_close(
        person.snapshot(),
        behavior_dict,
        day_summary=f"决策 {day_decisions} 笔，日盈亏 {day_pnl:+.2f}",
        date=f"day-{day_idx:03d}",
        today_pnl=f"{day_pnl:+.2f}",
        timestamp=last_ts,
        now=last_now,
    )

    last_market = MarketSnapshot(
        price=float(last["close"]), atr=compute_atr(ohlcv_data), timestamp=last_ts
    )
    for pos in list(positions.open_positions()):
        closed_pos = positions.close_position(
            pos,
            last_market.price,
            "REPLAY_END",
            psychology=person.snapshot(),
            when=last_now,
        )
        positions_repo.update_close(
            closed_pos.position_id,
            {
                "exit_price": closed_pos.exit_price,
                "exit_time": closed_pos.exit_time,
                "exit_reason": closed_pos.exit_reason,
                "realized_pnl": closed_pos.realized_pnl,
                "fees": closed_pos.fees,
                "max_favorable_excursion": closed_pos.mfe,
                "max_adverse_excursion": closed_pos.mae,
                "psychology_at_exit": person.snapshot(),
            },
        )

    day_idx += 1
    traits_repo.insert({"date": f"day-{day_idx:03d}", **person.snapshot()})
    conn.commit()

    timeline = generate_narrative_timeline(conn)
    narrated_decisions = conn.execute(
        "SELECT COUNT(*) AS c FROM decision_log WHERE narrative_thought IS NOT NULL"
    ).fetchone()["c"]
    narrated_psych = conn.execute(
        "SELECT COUNT(*) AS c FROM psychology_log WHERE narrative_text IS NOT NULL"
    ).fetchone()["c"]
    with_pv = conn.execute(
        """
        SELECT COUNT(*) AS c FROM psychology_log
        WHERE narrative_text IS NOT NULL AND prompt_version IS NOT NULL
        """
    ).fetchone()["c"]

    stats = {
        "decision_count": decision_count,
        "narrated_decisions": narrated_decisions,
        "narrated_psychology": narrated_psych,
        "prompt_version_rows": with_pv,
        "bridge": dict(bridge.stats),
        "llm_calls": getattr(narrator, "call_count", 0),
        "mock_calls": getattr(getattr(narrator, "llm_client", None), "call_count", 0),
        "timeline": timeline,
        "db_path": str(db_path),
    }
    close_connection(conn)
    return stats


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Replay with Narrator")
    parser.add_argument("--mock", action="store_true", default=False)
    parser.add_argument("--real", action="store_true", default=False)
    parser.add_argument("--bars", type=int, default=1000)
    parser.add_argument("--output", type=str, default=str(DEFAULT_OUTPUT))
    parser.add_argument("--db", type=str, default=str(DEFAULT_DB))
    args = parser.parse_args(argv)

    if args.real and args.mock:
        print("错误：不能同时指定 --mock 与 --real", file=sys.stderr)
        return 2
    use_mock = not args.real

    if not use_mock:
        if not os.environ.get("DEEPSEEK_API_KEY"):
            print("错误：真实模式需要设置 DEEPSEEK_API_KEY", file=sys.stderr)
            return 2
        est = max(1, args.bars // 8) * 0.0008
        print(f"即将调用真实 API，预计消耗约 {est:.2f}~{est * 3:.2f} 元")
        print("3 秒后开始...")
        time.sleep(3)

    bars = generate_sample_ohlcv(DATA_PATH, n=max(args.bars, 200), seed=7)
    bars = bars[: args.bars]
    out = Path(args.output)
    if not out.is_absolute():
        out = ROOT / out
    out.parent.mkdir(parents=True, exist_ok=True)

    result = replay_with_narrator(
        bars,
        ROOT / "config",
        Path(args.db) if Path(args.db).is_absolute() else ROOT / args.db,
        use_mock=use_mock,
    )
    out.write_text(result["timeline"], encoding="utf-8")
    print(f"[mode] {'mock' if use_mock else 'real'}")
    print(f"[bars] {len(bars)}")
    print(f"[decisions narrated] {result['narrated_decisions']}")
    print(f"[psychology narrated] {result['narrated_psychology']}")
    print(f"[bridge] {json.dumps(result['bridge'], ensure_ascii=False)}")
    print(f"[llm_calls] {result['llm_calls']} mock_calls={result['mock_calls']}")
    print(f"[wrote] {out}")
    print(f"[db] {result['db_path']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
