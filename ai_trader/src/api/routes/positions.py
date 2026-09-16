"""Open / closed positions route."""
from __future__ import annotations

from fastapi import APIRouter, Request

from ...db.repositories import PositionsRepo
from ..helpers import START_EQUITY, holding_minutes, parse_json, symbol_display
from ..schemas import (
    CurrentPosition,
    HistoryPosition,
    PositionsResponse,
    PositionsSummary,
)

router = APIRouter()


@router.get("/positions", response_model=PositionsResponse)
def get_positions(request: Request) -> PositionsResponse:
    conn = request.app.state.db
    repo = PositionsRepo(conn)
    open_pos = repo.list_open()
    closed = repo.list_closed(limit=50)

    current: list[CurrentPosition] = []
    total_margin = 0.0
    total_unreal = 0.0
    for p in open_pos:
        entry = float(p.get("entry_price") or 0)
        # No live mark: use entry as mark (unrealized ~0)
        mark = entry
        margin = float(p.get("margin") or 0)
        side = str(p.get("side") or "LONG")
        pnl = 0.0
        pnl_pct = 0.0
        psych = parse_json(p.get("psychology_at_entry"), {})
        mood_hint = "盯着盘面"
        if isinstance(psych, dict) and psych.get("stress", 0) > 0.7:
            mood_hint = "有点紧张，但还能扛"
        narr = conn.execute(
            """
            SELECT narrative_thought FROM decision_log
            WHERE decision_id = ? LIMIT 1
            """,
            (p.get("decision_id"),),
        ).fetchone()
        if narr and narr["narrative_thought"]:
            mood_hint = str(narr["narrative_thought"])[:40]
        total_margin += margin
        total_unreal += pnl
        current.append(
            CurrentPosition(
                position_id=str(p["position_id"]),
                symbol=symbol_display(p.get("symbol")),
                side=side,
                leverage=float(p.get("leverage") or 1),
                margin=round(margin, 2),
                entry_price=round(entry, 2),
                current_price=round(mark, 2),
                stop_loss=float(p["stop_loss"]) if p.get("stop_loss") is not None else None,
                take_profit=float(p["take_profit"]) if p.get("take_profit") is not None else None,
                pnl=round(pnl, 2),
                pnl_pct=round(pnl_pct, 2),
                holding_minutes=holding_minutes(p.get("entry_time")),
                psychology_mood=mood_hint,
                decision_id=p.get("decision_id"),
            )
        )

    history: list[HistoryPosition] = []
    closed_pnl = 0.0
    for p in closed:
        entry = float(p.get("entry_price") or 0)
        exit_p = float(p.get("exit_price") or entry)
        rpnl = float(p.get("realized_pnl") or 0)
        closed_pnl += rpnl
        margin = float(p.get("margin") or 0) or 1.0
        pnl_pct = (rpnl / margin * 100.0) if margin else 0.0
        narr_row = conn.execute(
            """
            SELECT narrative_thought, narrative_body_action
            FROM decision_log WHERE decision_id = ? LIMIT 1
            """,
            (p.get("decision_id"),),
        ).fetchone()
        reason = ""
        if narr_row and narr_row["narrative_thought"]:
            reason = str(narr_row["narrative_thought"])
            mins = holding_minutes(p.get("entry_time"), p.get("exit_time"))
            if mins:
                reason = f"{reason} · 持仓{mins}分钟"
        history.append(
            HistoryPosition(
                position_id=str(p["position_id"]),
                symbol=symbol_display(p.get("symbol")),
                side=str(p.get("side") or ""),
                entry_price=round(entry, 2),
                exit_price=round(exit_p, 2),
                realized_pnl=round(rpnl, 2),
                pnl_pct=round(pnl_pct, 2),
                exit_reason=p.get("exit_reason"),
                entry_time=p.get("entry_time"),
                exit_time=p.get("exit_time"),
                narrative_reason=reason,
            )
        )

    equity = START_EQUITY + closed_pnl
    risk_pct = (total_margin / equity) if equity > 0 else 0.0
    return PositionsResponse(
        current=current,
        history=history,
        summary=PositionsSummary(
            total_margin=round(total_margin, 2),
            total_pnl=round(total_unreal + closed_pnl, 2),
            total_risk_pct=round(risk_pct, 4),
        ),
    )
