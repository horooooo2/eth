"""Canonical S9 closed-candle identity.

One representation on the whole path: UTC epoch milliseconds (int).
REST seed, business WS confirm=1, and REST gap recovery must resolve
to the same integer. Do not compare raw Timestamp strings.
"""

from __future__ import annotations

from typing import Any, Optional

import pandas as pd

# Seconds / ms / ns cutoffs for integer inputs.
_SEC_MAX = 10**11
_MS_MAX = 10**14


def closed_candle_id(ts: Any) -> Optional[int]:
    """UTC epoch milliseconds for a closed-candle open time.

    Integer inputs are treated as already-ms (OKX candle ts, hub keys),
    except nanoseconds (>= 1e16). Unix seconds are accepted only as float
    in 1e9..1e12 so fake 1970-era test clocks stay milliseconds.
    """
    if ts is None:
        return None
    if isinstance(ts, bool):
        return None
    if isinstance(ts, str) and ts.strip().isdigit():
        return closed_candle_id(int(ts.strip()))
    if isinstance(ts, int):
        if ts <= 0:
            return None
        if ts >= _MS_MAX:
            return int(ts // 1_000_000)
        return int(ts)
    if isinstance(ts, float):
        if ts != ts or ts <= 0:
            return None
        if ts >= _MS_MAX:
            return int(ts // 1_000_000)
        if ts >= _SEC_MAX:
            return int(round(ts))
        if ts >= 1_000_000_000:
            return int(round(ts * 1000.0))
        return int(round(ts))
    try:
        t = pd.Timestamp(ts)
    except (TypeError, ValueError):
        return None
    if t is pd.NaT or bool(pd.isna(t)):
        return None
    if t.tzinfo is None:
        t = t.tz_localize("UTC")
    else:
        t = t.tz_convert("UTC")
    return int(t.value // 1_000_000)


def closed_candle_iso(ts: Any) -> str:
    """Canonical UTC timestamp derived from closed_candle_id. signal_key uses this."""
    cid = closed_candle_id(ts)
    if cid is None:
        return ""
    return pd.Timestamp(cid, unit="ms", tz="UTC").strftime("%Y-%m-%dT%H:%M:%SZ")
