"""S9 orphan protective-stop cleanup. Never locally force CANCELLED."""

from __future__ import annotations

from typing import Any, Dict, List, Mapping, Optional

NONTERMINAL = {
    "ACTIVE",
    "PENDING_SUBMIT",
    "AMEND_PENDING",
    "CANCEL_REQUESTED",
    "UNKNOWN",
}

BACKOFF = (2, 5, 10, 30, 60)
MAX_ATTEMPTS = 5


def is_nonterminal(status: str) -> bool:
    return str(status or "").upper() in NONTERMINAL


def next_action(*, queried_status: str, attempts: int, last_was_timeout: bool = False) -> Dict[str, Any]:
    st = str(queried_status or "").upper()
    if st in {"CANCELLED", "CANCELED", "EXPIRED", "REJECTED"}:
        return {"action": "CLEAN", "attempts": attempts, "status": st}
    if attempts >= MAX_ATTEMPTS:
        return {
            "action": "FAIL",
            "attempts": attempts,
            "status": st,
            "reason": "ORPHAN_PROTECTIVE_STOP_CLEANUP_FAILED",
            "review": "MANUAL_REVIEW_REQUIRED",
            "force_local_cancelled": False,
        }
    if last_was_timeout:
        return {
            "action": "QUERY",
            "attempts": attempts,
            "status": "CLEANUP_UNCERTAIN",
            "assume_cancelled": False,
        }
    if st == "ACTIVE" or is_nonterminal(st):
        delay = BACKOFF[min(attempts, len(BACKOFF) - 1)]
        return {"action": "CANCEL", "attempts": attempts + 1, "delay_seconds": delay, "status": "RETRY_PENDING"}
    return {"action": "QUERY", "attempts": attempts, "status": st}


def symbol_conflict(*, other_owned_same_symbol: bool) -> Optional[str]:
    if other_owned_same_symbol:
        return "SYMBOL_OWNERSHIP_CONFLICT"
    return None
