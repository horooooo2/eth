"""Closed-loop paper replay with SQLite persistence."""
from __future__ import annotations

import json
import random
from datetime import datetime, timedelta, timezone
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
from .paper_execution import PaperExecutionEngine
from .person_state import DEFAULT_BASELINE_BOUNDS, PersonStateEngine
from .position_manager import Position, PositionManager
from .risk_engine import MarketSnapshot, RiskEngine
from .signal_engine import SignalEngine
from .trade_intent import (
    STATUS_PENDING_RISK,
    STATUS_RISK_APPROVED,
    STATUS_RISK_REJECTED,
    TradeIntent,
)

ROOT = Path(__file__).resolve().parent.parent
DATA_PATH = ROOT / "data" / "sample_ohlcv.json"
DB_PATH = get_db_path()
REPORT_PATH = ROOT / "reports" / "replay_report.md"


def compute_atr(bars: list[dict[str, Any]], period: int = 14) -> float:
    """Average True Range over the trailing window."""
    if len(bars) < 2:
        return abs(float(bars[-1]["high"]) - float(bars[-1]["low"])) if bars else 0.0
    trs: list[float] = []
    for i in range(1, len(bars)):
        high = float(bars[i]["high"])
        low = float(bars[i]["low"])
        prev_close = float(bars[i - 1]["close"])
        trs.append(max(high - low, abs(high - prev_close), abs(low - prev_close)))
    window = trs[-period:] if len(trs) >= period else trs
    return sum(window) / len(window) if window else 0.0


def generate_sample_ohlcv(path: Path, n: int = 3600, seed: int = 7) -> list[dict[str, Any]]:
    """Generate reproducible synthetic BTC 1m bars (multi-day)."""
    rng = random.Random(seed)
    start = datetime(2026, 9, 1, 0, 0, tzinfo=timezone.utc)
    price = 67000.0
    bars: list[dict[str, Any]] = []
    segments = [
        (400, 0.0, 25),
        (350, 0.55, 40),
        (300, 0.0, 30),
        (350, -0.55, 40),
        (300, 0.0, 30),
        (400, 0.65, 45),
        (300, 0.0, 28),
        (350, -0.4, 38),
        (300, 0.5, 42),
        (250, 0.0, 26),
    ]
    idx = 0
    for length, drift, vol in segments:
        for _ in range(length):
            if idx >= n:
                break
            noise = rng.gauss(0, vol)
            delta = drift + noise
            open_p = price
            close_p = max(1000.0, price + delta)
            wick = abs(rng.gauss(0, vol * 0.6))
            high_p = max(open_p, close_p) + wick
            low_p = min(open_p, close_p) - wick
            volume = abs(rng.gauss(1200, 250)) * (1.8 if abs(delta) > vol else 1.0)
            bars.append(
                {
                    "timestamp": (start + timedelta(minutes=idx)).isoformat(),
                    "open": round(open_p, 2),
                    "high": round(high_p, 2),
                    "low": round(low_p, 2),
                    "close": round(close_p, 2),
                    "volume": round(volume, 2),
                }
            )
            price = close_p
            idx += 1
        if idx >= n:
            break
    while idx < n:
        bars.append(
            {
                "timestamp": (start + timedelta(minutes=idx)).isoformat(),
                "open": round(price, 2),
                "high": round(price + 20, 2),
                "low": round(price - 20, 2),
                "close": round(price, 2),
                "volume": 1000.0,
            }
        )
        idx += 1
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(bars), encoding="utf-8")
    return bars


def load_ohlcv(path: Path = DATA_PATH, force_regen: bool = False) -> list[dict[str, Any]]:
    if force_regen or not path.exists():
        return generate_sample_ohlcv(path)
    bars = json.loads(path.read_text(encoding="utf-8"))
    if len(bars) < 3000:
        return generate_sample_ohlcv(path)
    return bars


def _impact_for(name: str, event_class: str, config_dir: Path) -> dict[str, float]:
    data = json.loads((config_dir / "event_impacts.json").read_text(encoding="utf-8"))
    table = data["atomic_events"] if event_class == "atomic" else data["compound_events"]
    return {k: float(v) for k, v in (table.get(name) or {}).items()}


def apply_outcome_to_state(
    engine: PersonStateEngine,
    position: Position,
    equity: float,
    consecutive_losses: int,
    config_dir: Path,
) -> list[dict[str, str]]:
    """Map trade outcome into psychological events; return applied event specs."""
    events: list[dict[str, str]] = []
    big_win_pct = float(
        json.loads((config_dir / "risk_rules.json").read_text(encoding="utf-8"))
        .get("outcome", {})
        .get("big_win_equity_pct", 0.005)
    )
    if position.realized_pnl > 0:
        if equity > 0 and position.realized_pnl / equity > big_win_pct:
            events.append({"name": "BIG_WIN", "type": "atomic"})
    else:
        events.append({"name": "STOP_LOSS_TRIGGERED", "type": "atomic"})
        if consecutive_losses >= 5:
            events.append({"name": "LOSS_STREAK_5", "type": "compound"})
        elif consecutive_losses >= 3:
            events.append({"name": "LOSS_STREAK_3", "type": "compound"})
    if events:
        engine.apply_events(events)
    return events


def _persist_events(
    events_repo: EventsRepo,
    specs: list[dict[str, str]],
    timestamp: str,
    config_dir: Path,
    event_type: str = "trade",
) -> list[int]:
    ids: list[int] = []
    for spec in specs:
        event_class = spec.get("type", "atomic")
        name = spec["name"]
        eid = events_repo.insert(
            {
                "timestamp": timestamp,
                "event_type": event_type,
                "event_subtype": name.lower(),
                "event_class": event_class,
                "compound_id": name if event_class == "compound" else None,
                "name": name,
                "description": name,
                "psychology_impact": _impact_for(name, event_class, config_dir),
            }
        )
        ids.append(eid)
    return ids


def generate_report_from_db(conn: Any) -> str:
    """Build markdown summary from persisted tables."""
    dec = conn.execute("SELECT COUNT(*) AS c FROM decision_log").fetchone()["c"]
    opens = conn.execute(
        "SELECT COUNT(*) AS c FROM decision_log WHERE decision LIKE 'OPEN_%'"
    ).fetchone()["c"]
    skips = conn.execute(
        "SELECT COUNT(*) AS c FROM decision_log WHERE decision = 'SKIP'"
    ).fetchone()["c"]
    ev = conn.execute("SELECT COUNT(*) AS c FROM events").fetchone()["c"]
    pos_n = conn.execute("SELECT COUNT(*) AS c FROM positions").fetchone()["c"]
    closed = conn.execute(
        "SELECT COUNT(*) AS c FROM positions WHERE status = 'CLOSED'"
    ).fetchone()["c"]
    stops = conn.execute(
        "SELECT COUNT(*) AS c FROM positions WHERE exit_reason = 'STOP_LOSS'"
    ).fetchone()["c"]
    rejects = conn.execute(
        """
        SELECT risk_reject_reason AS r, COUNT(*) AS c
        FROM decision_log
        WHERE risk_check = 'REJECT' AND risk_reject_reason IS NOT NULL
        GROUP BY risk_reject_reason
        """
    ).fetchall()
    modes = conn.execute(
        "SELECT primary_mode, COUNT(*) AS c FROM decision_log GROUP BY primary_mode"
    ).fetchall()
    traits_n = conn.execute("SELECT COUNT(*) AS c FROM traits_history").fetchone()["c"]
    psych_n = conn.execute("SELECT COUNT(*) AS c FROM psychology_log").fetchone()["c"]
    hash_row = conn.execute(
        "SELECT DISTINCT config_snapshot_hash FROM decision_log LIMIT 3"
    ).fetchall()
    pnl_row = conn.execute(
        "SELECT COALESCE(SUM(realized_pnl),0) AS pnl FROM positions WHERE status='CLOSED'"
    ).fetchone()
    start_eq = 20000.0
    end_eq = start_eq + float(pnl_row["pnl"] or 0.0)

    lines = [
        "# AI Trader Replay Report (from SQLite)",
        "",
        "## 总览",
        f"- events: **{ev}**",
        f"- decision_log: **{dec}** (OPEN {opens} / SKIP {skips})",
        f"- positions: **{pos_n}** (closed {closed}, stop {stops})",
        f"- psychology_log: **{psych_n}**",
        f"- traits_history: **{traits_n}**",
        f"- 起始净值: **${start_eq:,.2f}**",
        f"- 估算最终净值: **${end_eq:,.2f}**",
        f"- 已实现盈亏合计: **${float(pnl_row['pnl'] or 0):+,.2f}**",
        "",
        "## BehaviorMode",
        json.dumps({r["primary_mode"]: r["c"] for r in modes}, ensure_ascii=False),
        "",
        "## 风控拒绝",
        json.dumps({r["r"]: r["c"] for r in rejects}, ensure_ascii=False),
        "",
        "## config_snapshot_hash",
        json.dumps([r["config_snapshot_hash"] for r in hash_row], ensure_ascii=False),
        "",
    ]
    return "\n".join(lines)


def replay(
    ohlcv_data: list[dict[str, Any]],
    config_dir: Path | None = None,
    db_path: Path | None = None,
) -> str:
    """Run full paper loop and persist every causal step to SQLite."""
    config_dir = config_dir or (ROOT / "config")
    db_path = db_path or DB_PATH
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
    card: dict[str, Any] = {}
    try:
        card = load_character("zhangming", config_dir)
        if card.get("baseline_bounds"):
            bounds = {k: tuple(v) for k, v in card["baseline_bounds"].items()}
        traits0 = card.get("traits_baseline") or {}
    except Exception:
        traits0 = {}

    start_iso = str(ohlcv_data[100]["timestamp"])[:10]
    deadline_cfg, deadline_manager, ambient_sampler = build_deadline_stack(
        config_dir, card or {"deadline": {"enabled": True, "total_days": 90}}, start_iso,
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

    pending_event_ids: list[int] = []
    decision_count = 0
    day_idx = 0
    day_pnl = 0.0
    day_start_equity = float(positions.cash)
    peak_equity = day_start_equity
    days_profitable_streak = 0
    days_losing_streak = 0
    starting_baseline = person.baseline_snapshot()
    from datetime import date as _date

    _start_d = _date.fromisoformat(start_iso)
    life_cycle = [
        "ARGUMENT_WITH_WIFE",
        "RENT_DUE",
        "EX_COLLEAGUE_NEW_CAR",
        "INTERVIEW_REJECTED",
        "CHILD_SICK",
        "SLEPT_7_HOURS",
    ]

    # initial psychology + traits
    psychology_repo.insert(
        {
            "timestamp": ohlcv_data[100]["timestamp"],
            "mood": "calm",
            "mood_label": "平静",
            "state_snapshot": person.snapshot(),
        }
    )
    traits_repo.insert({"date": f"day-{day_idx:03d}", **person.snapshot()})
    baseline_repo.insert_snapshot(
        f"day-{day_idx:03d}",
        person.baseline_snapshot(),
        reason="initial",
        detail=None,
    )

    for i in range(100, len(ohlcv_data)):
        window = ohlcv_data[: i + 1]
        bar = ohlcv_data[i]
        ts = bar["timestamp"]
        atr = compute_atr(window)
        market = MarketSnapshot(price=float(bar["close"]), atr=atr, timestamp=ts)

        # inject life events for mode diversity
        if i % 180 == 0:
            name = life_cycle[(i // 180) % len(life_cycle)]
            specs = [{"name": name, "type": "atomic"}]
            person.apply_events(specs)
            eids = _persist_events(events_repo, specs, ts, config_dir, event_type="life")
            pending_event_ids.extend(eids)
            psychology_repo.insert(
                {
                    "timestamp": ts,
                    "mood": "anxious",
                    "mood_label": "焦虑",
                    "state_snapshot": person.snapshot(),
                }
            )

        # cooldown windows to exit REVENGE and surface other modes
        if i % 520 == 0 and i > 100:
            cool = [
                {"name": "SLEPT_7_HOURS", "type": "atomic"},
                {"name": "SLEPT_7_HOURS", "type": "atomic"},
                {"name": "BIG_WIN", "type": "atomic"},
            ]
            person.apply_events(cool)
            eids = _persist_events(events_repo, cool, ts, config_dir, event_type="life")
            pending_event_ids.extend(eids)
            # push toward CAUTIOUS: high stress + low risk
            person.apply_events([{"name": "CHILD_SICK", "type": "atomic"}])
            eids2 = _persist_events(
                events_repo,
                [{"name": "CHILD_SICK", "type": "atomic"}],
                ts,
                config_dir,
                event_type="life",
            )
            pending_event_ids.extend(eids2)
            psychology_repo.insert(
                {
                    "timestamp": ts,
                    "mood": "tired",
                    "mood_label": "疲惫",
                    "state_snapshot": person.snapshot(),
                }
            )

        if i % 3 == 0:
            signal_engine.history = {name: [] for name in signal_engine.rules}
            signals = signal_engine.generate_signals(window, "BTC")
            behavior = classifier.classify(person.state)

            for signal in signals:
                decision = decision_engine.decide(signal, person.state, behavior)
                decision_id = str(uuid4())
                risk_check = "SKIP"
                reject_reason = None
                position_id = None

                # occasional probe for extra reject codes (still uses RiskEngine)
                leverage = float(
                    risk_engine.config.get("execution", {}).get("default_leverage", 3.0)
                )
                probe_atr = atr
                saved_daily = positions.daily_pnl
                open_n = positions.get_portfolio_state(market.price).open_position_count
                if decision.action.startswith("OPEN") and open_n < 3:
                    # Force-diverse reject codes while capacity remains
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
                        now=datetime.fromisoformat(ts),
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
                    # re-fetch last opened paper position for this decision
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
                decision_count += 1
                if decision_count % 100 == 0:
                    conn.commit()

        closed = positions.update(market)
        for pos in closed:
            psychology_at_exit = person.snapshot()
            day_pnl += float(pos.realized_pnl or 0)
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
            psychology_repo.insert(
                {
                    "timestamp": ts,
                    "mood": "tired" if pos.realized_pnl < 0 else "confident",
                    "mood_label": "疲惫" if pos.realized_pnl < 0 else "自信",
                    "state_snapshot": person.snapshot(),
                }
            )

        if i % 240 == 0:
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
            # Synthetic calendar day for deadline/ambient
            cal_day = (_start_d + timedelta(days=day_idx)).isoformat()
            process_new_day(
                today=cal_day,
                person=person,
                deadline_repo=deadline_repo,
                ambient_repo=ambient_repo,
            )
            maybe_run_deadline_evaluation(
                today=cal_day,
                person=person,
                deadline_manager=deadline_manager,
                deadline_config=deadline_cfg,
                narrator=None,
                deadline_repo=deadline_repo,
                db_repos={"conn": conn, "positions_repo": positions_repo},
                starting_baseline=starting_baseline,
            )
            person.daily_decay()
            day_idx += 1
            day_pnl = 0.0
            day_start_equity = equity_now
            traits_repo.insert({"date": f"day-{day_idx:03d}", **person.snapshot()})
            psychology_repo.insert(
                {
                    "timestamp": ts,
                    "mood": "calm",
                    "mood_label": "平静",
                    "state_snapshot": person.snapshot(),
                }
            )
            conn.commit()

    # flatten leftover opens
    last = ohlcv_data[-1]
    last_market = MarketSnapshot(
        price=float(last["close"]), atr=compute_atr(ohlcv_data), timestamp=last["timestamp"]
    )
    for pos in list(positions.open_positions()):
        closed_pos = positions.close_position(
            pos,
            last_market.price,
            "REPLAY_END",
            psychology=person.snapshot(),
            when=datetime.fromisoformat(last["timestamp"]),
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
    report = generate_report_from_db(conn)
    close_connection(conn)
    return report


def main() -> None:
    bars = load_ohlcv(DATA_PATH, force_regen=True)
    text = replay(bars, ROOT / "config", DB_PATH)
    REPORT_PATH.parent.mkdir(parents=True, exist_ok=True)
    REPORT_PATH.write_text(text, encoding="utf-8")
    print(text)
    print(f"\n[wrote] {REPORT_PATH}")
    print(f"[db] {DB_PATH}")


if __name__ == "__main__":
    main()
