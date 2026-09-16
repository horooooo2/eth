"""Current psychology / behavior state route."""
from __future__ import annotations

from fastapi import APIRouter, Request

from ...db.repositories import PsychologyRepo, TraitsRepo
from ..helpers import mode_label, parse_json
from ..schemas import StateResponse

router = APIRouter()


@router.get("/state", response_model=StateResponse)
def get_state(request: Request) -> StateResponse:
    conn = request.app.state.db
    psych = PsychologyRepo(conn).latest()
    traits = TraitsRepo(conn).latest()

    snap: dict = {}
    if psych:
        snap = parse_json(psych.get("state_snapshot"), {})
    if traits:
        for key in (
            "risk_appetite",
            "patience",
            "focus",
            "self_doubt",
            "stubbornness",
            "stress",
            "sleep_debt",
        ):
            if traits.get(key) is not None:
                snap.setdefault(key, traits[key])

    # Latest decision carries mode / modifiers
    mode_row = conn.execute(
        """
        SELECT primary_mode, modifiers, timestamp
        FROM decision_log
        ORDER BY timestamp DESC LIMIT 1
        """
    ).fetchone()
    primary_mode = "NORMAL"
    modifiers: list[str] = []
    last_updated = ""
    if mode_row:
        primary_mode = str(mode_row["primary_mode"] or snap.get("primary_mode") or "NORMAL")
        modifiers = parse_json(mode_row["modifiers"], [])
        if not isinstance(modifiers, list):
            modifiers = []
        last_updated = str(mode_row["timestamp"] or "")
    if psych and psych.get("timestamp"):
        last_updated = str(psych["timestamp"])
    if snap.get("primary_mode") and primary_mode == "NORMAL":
        primary_mode = str(snap["primary_mode"])

    mood = str((psych or {}).get("mood") or "calm")
    mood_label = str((psych or {}).get("mood_label") or "平静")

    return StateResponse(
        mood=mood,
        mood_label=mood_label,
        risk_appetite=float(snap.get("risk_appetite") or 0.5),
        patience=float(snap.get("patience") or 0.5),
        focus=float(snap.get("focus") or 0.5),
        self_doubt=float(snap.get("self_doubt") or 0.5),
        stubbornness=float(snap.get("stubbornness") or 0.5),
        stress=float(snap.get("stress") or 0.5),
        sleep_debt=float(snap.get("sleep_debt") or 0.0),
        primary_mode=primary_mode,
        modifiers=[str(m) for m in modifiers],
        mode_label=mode_label(primary_mode),
        last_updated=last_updated or "",
    )
