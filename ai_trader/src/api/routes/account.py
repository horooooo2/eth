"""Account summary route (paper DB or live OKX cache)."""
from __future__ import annotations

from fastapi import APIRouter, Request

from ...runtime_flags import get_account_sync
from ..helpers import RISK_CAP_PCT, START_EQUITY
from ..schemas import AccountResponse

router = APIRouter()


@router.get("/account", response_model=AccountResponse)
def get_account(request: Request) -> AccountResponse:
    conn = request.app.state.db

    sync = getattr(request.app.state, "account_sync", None) or get_account_sync()
    live = None
    source = "paper"
    last_sync: str | None = None

    if sync is not None and hasattr(sync, "get_cached_balance"):
        cached = sync.get_cached_balance()  # type: ignore[union-attr]
        if cached and cached.get("timestamp"):
            live = cached
            source = "okx"
            last_sync = str(cached.get("timestamp") or "") or None

    if live is None:
        row = conn.execute(
            "SELECT equity, balance, timestamp, source FROM balance_history ORDER BY id DESC LIMIT 1"
        ).fetchone()
        if row:
            live = {
                "equity": float(row["equity"] or 0),
                "available": float(row["balance"] or 0),
                "timestamp": row["timestamp"],
            }
            last_sync = str(row["timestamp"] or "") or None
            if row["source"] == "okx":
                source = "okx"

    pnl_row = conn.execute(
        "SELECT COALESCE(SUM(realized_pnl), 0) AS pnl FROM positions WHERE status = 'CLOSED'"
    ).fetchone()
    realized = float(pnl_row["pnl"] or 0.0)

    open_rows = conn.execute(
        """
        SELECT COALESCE(SUM(margin), 0) AS margin, COUNT(*) AS n
        FROM positions WHERE status = 'OPEN'
        """
    ).fetchone()
    total_margin = float(open_rows["margin"] or 0.0)
    position_count = int(open_rows["n"] or 0)

    if sync is not None and hasattr(sync, "get_cached_positions") and source == "okx":
        remote = sync.get_cached_positions()  # type: ignore[union-attr]
        position_count = sum(1 for p in remote if abs(float(p.get("pos") or 0)) > 0)

    if source == "okx" and live is not None:
        equity = float(live.get("equity") or 0)
        available = float(live.get("available") or 0)
    else:
        equity = START_EQUITY + realized
        available = max(0.0, equity - total_margin)
        source = "paper"

    today_row = conn.execute(
        """
        SELECT COALESCE(SUM(realized_pnl), 0) AS pnl
        FROM positions
        WHERE status = 'CLOSED'
          AND date(exit_time) = (
              SELECT date(MAX(exit_time)) FROM positions WHERE status = 'CLOSED'
          )
        """
    ).fetchone()
    today_pnl = float(today_row["pnl"] or 0.0) if today_row else realized
    base = equity if equity else START_EQUITY
    today_pnl_pct = (today_pnl / base * 100.0) if base else 0.0
    risk_exposure_pct = (total_margin / equity) if equity > 0 else 0.0

    return AccountResponse(
        equity=round(equity, 2),
        available=round(available, 2),
        today_pnl=round(today_pnl, 2),
        today_pnl_pct=round(today_pnl_pct, 2),
        position_count=position_count,
        risk_exposure_pct=round(risk_exposure_pct, 4),
        risk_cap_pct=RISK_CAP_PCT,
        last_sync=last_sync,
        source=source,
    )
