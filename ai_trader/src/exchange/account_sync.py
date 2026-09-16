"""Periodic OKX account balance / position sync."""
from __future__ import annotations

import logging
import sqlite3
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

from .okx_client import OKXAPIError, OKXClient

logger = logging.getLogger(__name__)


@dataclass
class AccountSync:
    """Background sync of OKX balance and positions into cache (+ SQLite)."""

    client: OKXClient
    conn: sqlite3.Connection | None = None
    interval_sec: float = 30.0
    _stop: threading.Event = field(default_factory=threading.Event, init=False)
    _thread: threading.Thread | None = field(default=None, init=False)
    _balance: dict[str, Any] = field(default_factory=dict, init=False)
    _positions: list[dict[str, Any]] = field(default_factory=list, init=False)
    _last_sync: str = field(default="", init=False)
    reconcile_ok: bool = field(default=True, init=False)
    pause_new_orders: bool = field(default=False, init=False)

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._loop, name="account-sync", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=5)

    def _loop(self) -> None:
        while not self._stop.is_set():
            try:
                self.sync_once()
            except Exception as exc:
                logger.exception("account sync failed: %s", exc)
            self._stop.wait(self.interval_sec)

    def sync_once(self) -> dict[str, Any]:
        now = datetime.now(timezone.utc).isoformat()
        balances = self.client.get_balance()
        positions = self.client.get_positions("SWAP")
        equity = 0.0
        available = 0.0
        if balances:
            details = balances[0].get("details") or []
            # Prefer USDT detail
            usdt = next((d for d in details if str(d.get("ccy")) == "USDT"), None)
            if usdt:
                equity = float(usdt.get("eq") or usdt.get("cashBal") or 0)
                available = float(usdt.get("availBal") or usdt.get("availEq") or 0)
            else:
                equity = float(balances[0].get("totalEq") or 0)
                available = equity
        self._balance = {
            "equity": equity,
            "available": available,
            "raw": balances,
            "timestamp": now,
        }
        self._positions = list(positions or [])
        self._last_sync = now
        if self.conn is not None:
            self.conn.execute(
                """
                INSERT INTO balance_history (timestamp, balance, equity, source)
                VALUES (?, ?, ?, ?)
                """,
                (now, available, equity, "okx"),
            )
            self.conn.commit()
            self._reconcile_positions()
        return {"balance": self._balance, "positions": self._positions}

    def _reconcile_positions(self) -> None:
        assert self.conn is not None
        local = self.conn.execute(
            "SELECT position_id, symbol, side, status FROM positions WHERE status = 'OPEN'"
        ).fetchall()
        remote_open = [
            p
            for p in self._positions
            if abs(float(p.get("pos") or 0)) > 0
        ]
        # Soft check: count mismatch
        if len(local) != len(remote_open):
            logger.warning(
                "position reconcile mismatch: local_open=%s remote_open=%s — pause new orders",
                len(local),
                len(remote_open),
            )
            self.reconcile_ok = False
            self.pause_new_orders = True
        else:
            self.reconcile_ok = True
            # keep pause sticky until Kill Switch / manual clear; only clear if previously ok cycle
            if self.pause_new_orders and len(local) == len(remote_open):
                # auto-clear after consistent cycle
                self.pause_new_orders = False

    def get_cached_balance(self) -> dict[str, Any]:
        return dict(self._balance)

    def get_cached_positions(self) -> list[dict[str, Any]]:
        return list(self._positions)

    @property
    def last_sync(self) -> str:
        return self._last_sync
