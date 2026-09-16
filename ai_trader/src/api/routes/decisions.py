"""Single decision causal-chain detail."""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request

from ...db.repositories import DecisionEventsRepo, DecisionRepo
from ..helpers import parse_json
from ..schemas import BehaviorInfo, DecisionDetailResponse, SignalInfo, TriggerEvent

router = APIRouter()


@router.get("/decisions/{decision_id}", response_model=DecisionDetailResponse)
def get_decision(decision_id: str, request: Request) -> DecisionDetailResponse:
    conn = request.app.state.db
    row = DecisionRepo(conn).get_by_id(decision_id)
    if not row:
        raise HTTPException(status_code=404, detail="decision not found")

    events = DecisionEventsRepo(conn).get_events_for_decision(decision_id)
    triggers = [
        TriggerEvent(
            event_id=int(e["id"]),
            name=str(e.get("name") or ""),
            timestamp=str(e.get("timestamp") or ""),
        )
        for e in events
    ]
    psych = parse_json(row.get("psychology_before"), {})
    modifiers = parse_json(row.get("modifiers"), [])
    if not isinstance(modifiers, list):
        modifiers = []
    reason = parse_json(row.get("decision_reason"), {})

    return DecisionDetailResponse(
        decision_id=str(row["decision_id"]),
        timestamp=str(row.get("timestamp") or ""),
        signal=SignalInfo(
            symbol=row.get("symbol"),
            direction=row.get("direction"),
            rule=row.get("signal_rule"),
            score=float(row["signal_score"]) if row.get("signal_score") is not None else None,
        ),
        psychology_before={
            k: psych.get(k)
            for k in ("stress", "risk_appetite", "patience", "focus", "self_doubt", "sleep_debt")
            if isinstance(psych, dict)
        },
        trigger_events=triggers,
        behavior=BehaviorInfo(
            primary_mode=row.get("primary_mode"),
            modifiers=[str(m) for m in modifiers],
        ),
        decision_reason=reason if isinstance(reason, dict) else {},
        decision=row.get("decision"),
        position_multiplier=(
            float(row["position_multiplier"])
            if row.get("position_multiplier") is not None
            else None
        ),
        narrative_thought=row.get("narrative_thought"),
        narrative_body_action=row.get("narrative_body_action"),
        risk_check=row.get("risk_check"),
        position_id=row.get("position_id"),
    )
