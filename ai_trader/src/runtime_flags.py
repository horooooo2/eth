"""Shared runtime flags for live trading safety."""
from __future__ import annotations

from threading import Lock

_lock = Lock()
_kill_switch_active = False
_new_orders_paused = False
_account_sync = None  # type: ignore[var-annotated]
_okx_client = None  # type: ignore[var-annotated]


def set_kill_switch(active: bool) -> None:
    global _kill_switch_active, _new_orders_paused
    with _lock:
        _kill_switch_active = active
        if active:
            _new_orders_paused = True


def is_kill_switch_active() -> bool:
    with _lock:
        return _kill_switch_active


def set_orders_paused(paused: bool) -> None:
    global _new_orders_paused
    with _lock:
        _new_orders_paused = paused


def orders_paused() -> bool:
    with _lock:
        return _new_orders_paused or _kill_switch_active


def register_account_sync(sync: object | None) -> None:
    global _account_sync
    with _lock:
        _account_sync = sync


def get_account_sync() -> object | None:
    with _lock:
        return _account_sync


def register_okx_client(client: object | None) -> None:
    global _okx_client
    with _lock:
        _okx_client = client


def get_okx_client() -> object | None:
    with _lock:
        return _okx_client
