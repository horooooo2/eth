"""Psychology / body / trade timeline route."""
from __future__ import annotations

from fastapi import APIRouter, Query, Request

from ..helpers import parse_json, symbol_display
from ..schemas import TimelineEntry, TimelineResponse

router = APIRouter()


@router.get("/timeline", response_model=TimelineResponse)
def get_timeline(
    request: Request,
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    type: str = Query("all"),
) -> TimelineResponse:
    conn = request.app.state.db
    entries: list[TimelineEntry] = []

    want_psych = type in ("all", "psych")
    want_body = type in ("all", "body")
    want_trade = type in ("all", "trade")
    want_ambient = type in ("all", "ambient")
    want_news = type in ("all", "news")

    if want_psych:
        rows = conn.execute(
            """
            SELECT timestamp, mood, mood_label, narrative_text, prompt_version, state_snapshot
            FROM psychology_log
            WHERE narrative_text IS NOT NULL AND TRIM(narrative_text) != ''
            ORDER BY timestamp DESC
            """
        ).fetchall()
        for r in rows:
            snap = parse_json(r["state_snapshot"], {})
            if str(snap.get("entry_type") or "") == "news":
                # news entries rendered separately when want_news
                if want_news:
                    sources = snap.get("sources") or []
                    src_label = "搜索"
                    if isinstance(sources, list) and sources:
                        first = sources[0] if isinstance(sources[0], dict) else {}
                        title = str(first.get("title") or "")[:40]
                        src_label = f"搜索 + {title}" if title else "搜索"
                    entries.append(
                        TimelineEntry(
                            timestamp=str(r["timestamp"]),
                            type="news",
                            mood=r["mood"],
                            mood_label=r["mood_label"],
                            text=r["narrative_text"],
                            mode=str(snap.get("primary_mode") or ""),
                            prompt_version=r["prompt_version"],
                            source=src_label,
                            direction=str(snap.get("direction") or ""),
                            impact_level=str(snap.get("impact_level") or ""),
                            key_point=str(snap.get("key_point") or ""),
                            event_type=str(snap.get("event_type") or snap.get("news_event_type") or ""),
                        )
                    )
                continue
            entries.append(
                TimelineEntry(
                    timestamp=str(r["timestamp"]),
                    type="psych",
                    mood=r["mood"],
                    mood_label=r["mood_label"],
                    text=r["narrative_text"],
                    mode=str(snap.get("primary_mode") or ""),
                    prompt_version=r["prompt_version"],
                )
            )

    if want_body:
        rows = conn.execute(
            """
            SELECT timestamp, narrative_body_action, primary_mode, prompt_version
            FROM decision_log
            WHERE narrative_body_action IS NOT NULL AND TRIM(narrative_body_action) != ''
            ORDER BY timestamp DESC
            """
        ).fetchall()
        for r in rows:
            entries.append(
                TimelineEntry(
                    timestamp=str(r["timestamp"]),
                    type="body",
                    text=r["narrative_body_action"],
                    location="书房",
                    activity="看盘",
                    mode=r["primary_mode"],
                    prompt_version=r["prompt_version"],
                )
            )

    if want_trade:
        rows = conn.execute(
            """
            SELECT d.timestamp, d.decision, d.symbol, d.signal_score, d.decision_reason,
                   d.position_multiplier, d.narrative_thought, d.primary_mode,
                   p.leverage, p.margin
            FROM decision_log d
            LEFT JOIN positions p ON p.decision_id = d.decision_id
            WHERE d.decision IS NOT NULL
            ORDER BY d.timestamp DESC
            """
        ).fetchall()
        for r in rows:
            reason = parse_json(r["decision_reason"], {})
            thr = reason.get("final_threshold") if isinstance(reason, dict) else None
            entries.append(
                TimelineEntry(
                    timestamp=str(r["timestamp"]),
                    type="trade",
                    decision=r["decision"],
                    symbol=symbol_display(r["symbol"]),
                    leverage=float(r["leverage"]) if r["leverage"] is not None else None,
                    margin=float(r["margin"]) if r["margin"] is not None else None,
                    signal_score=float(r["signal_score"]) if r["signal_score"] is not None else None,
                    threshold=float(thr) if thr is not None else None,
                    position_multiplier=(
                        float(r["position_multiplier"])
                        if r["position_multiplier"] is not None
                        else None
                    ),
                    narrative_thought=r["narrative_thought"],
                    mode=r["primary_mode"],
                )
            )

    if want_ambient:
        try:
            from ...db.migrations_v10 import apply_v10_migrations

            apply_v10_migrations(conn)
            rows = conn.execute(
                """
                SELECT timestamp, name, description
                FROM ambient_events
                ORDER BY timestamp DESC
                """
            ).fetchall()
            for r in rows:
                entries.append(
                    TimelineEntry(
                        timestamp=str(r["timestamp"]),
                        type="ambient",
                        text=r["description"] or r["name"],
                        name=r["name"],
                        mood_label="背景",
                    )
                )
        except Exception:
            pass

    entries.sort(key=lambda e: e.timestamp, reverse=True)
    total = len(entries)
    page = entries[offset : offset + limit]
    return TimelineResponse(entries=page, total=total, has_more=(offset + limit) < total)
