"""Deadline pressure computation."""
from __future__ import annotations

from typing import Any


def compute_deadline_pressure(
    current_day: int,
    total_days: int,
    curve: dict[str, Any],
) -> float:
    """
    Map current_day onto the pressure curve.
    day 1-30: flat
    day 31-60: linear
    day 61-90: linear
    day > total_days: capped at peak
    """
    day = max(0, int(current_day))
    total = max(1, int(total_days))
    # Normalize curve segments relative to total_days (default 90)
    seg1_end = max(1, int(round(total * 30 / 90)))
    seg2_end = max(seg1_end + 1, int(round(total * 60 / 90)))

    flat = float(curve.get("day_1_to_30", 0.0))
    mid = curve.get("day_31_to_60", [0.0, 0.02])
    late = curve.get("day_61_to_90", [0.02, 0.05])
    mid_lo, mid_hi = float(mid[0]), float(mid[1])
    late_lo, late_hi = float(late[0]), float(late[1])
    peak = late_hi

    if day <= 0:
        return 0.0
    if day <= seg1_end:
        return round(flat, 4)
    if day <= seg2_end:
        span = max(1, seg2_end - seg1_end)
        t = (day - seg1_end) / span
        return round(mid_lo + t * (mid_hi - mid_lo), 4)
    if day <= total:
        span = max(1, total - seg2_end)
        t = (day - seg2_end) / span
        return round(late_lo + t * (late_hi - late_lo), 4)
    return round(peak, 4)
