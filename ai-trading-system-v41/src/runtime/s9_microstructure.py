"""S9 microstructure: Top5 book, aggressive flow, spread window, slippage, cost."""

from __future__ import annotations

from collections import deque
from typing import Any, Deque, Dict, List, Mapping, Optional, Sequence, Tuple


def _f(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def depth_imbalance_5(bids: Sequence[Sequence[float]], asks: Sequence[Sequence[float]]) -> Optional[float]:
    bid_qty = sum(_f(level[1]) for level in list(bids)[:5])
    ask_qty = sum(_f(level[1]) for level in list(asks)[:5])
    den = bid_qty + ask_qty
    if den <= 0:
        return None
    return (bid_qty - ask_qty) / den


def aggressive_flow(trades: Sequence[Mapping[str, Any]]) -> Optional[float]:
    buy = 0.0
    sell = 0.0
    for row in trades:
        qty = _f(row.get("qty") or row.get("size") or row.get("amount"))
        side = str(row.get("side") or row.get("taker_side") or "").lower()
        if side in {"buy", "b", "long"}:
            buy += qty
        elif side in {"sell", "s", "short"}:
            sell += qty
        else:
            return None
    den = buy + sell
    if den <= 0:
        return None
    return (buy - sell) / den


def spread_bps(bid: float, ask: float) -> Optional[float]:
    if bid <= 0 or ask <= 0 or ask < bid:
        return None
    mid = (bid + ask) / 2.0
    if mid <= 0:
        return None
    return (ask - bid) / mid * 10_000.0


def expected_vwap(levels: Sequence[Sequence[float]], base_qty: float) -> Optional[float]:
    remaining = float(base_qty)
    if remaining <= 0:
        return None
    notional = 0.0
    filled = 0.0
    for level in levels:
        px = _f(level[0])
        qty = _f(level[1])
        if px <= 0 or qty <= 0:
            continue
        take = min(remaining, qty)
        notional += take * px
        filled += take
        remaining -= take
        if remaining <= 1e-12:
            break
    if remaining > 1e-12 or filled <= 0:
        return None
    return notional / filled


class SpreadWindow:
    def __init__(self, *, interval_sec: int = 5, window_sec: int = 300, required: int = 60) -> None:
        self.interval_sec = int(interval_sec)
        self.window_sec = int(window_sec)
        self.required = int(required)
        self._samples: Deque[Tuple[float, float]] = deque()
        self._last_ts: Optional[float] = None

    def observe(self, ts: float, value_bps: float) -> None:
        if self._last_ts is not None and ts - self._last_ts < self.interval_sec - 1e-9:
            return
        self._last_ts = ts
        self._samples.append((ts, float(value_bps)))
        cutoff = ts - self.window_sec
        while self._samples and self._samples[0][0] < cutoff:
            self._samples.popleft()

    @property
    def count(self) -> int:
        return len(self._samples)

    def ready(self) -> bool:
        return self.count >= self.required

    def p80(self) -> Optional[float]:
        if not self._samples:
            return None
        vals = sorted(v for _, v in self._samples)
        idx = max(0, min(len(vals) - 1, int(round(0.80 * (len(vals) - 1)))))
        return float(vals[idx])


def evaluate_microstructure(
    *,
    side: str,
    bid: float,
    ask: float,
    bids: Sequence[Sequence[float]],
    asks: Sequence[Sequence[float]],
    trades: Sequence[Mapping[str, Any]],
    spread_window: SpreadWindow,
    now_ts: float,
    book_age_sec: float,
    trades_age_sec: float,
    cfg: Mapping[str, Any],
    authorized_base_qty: float,
    entry_mode: str = "TREND_CONTINUATION",
) -> Dict[str, Any]:
    mcfg = dict(cfg.get("microstructure") or cfg)
    early = str(entry_mode or "").upper() == "EARLY_MOMENTUM"
    if early:
        early_cfg = dict(cfg.get("early_microstructure") or {})
        long_depth_min = _f(early_cfg.get("long_depth_imbalance_min"), 0.05)
        short_depth_max = _f(early_cfg.get("short_depth_imbalance_max"), -0.05)
        long_flow_min = _f(early_cfg.get("long_flow_imbalance_min"), 0.10)
        short_flow_max = _f(early_cfg.get("short_flow_imbalance_max"), -0.10)
        depth_code = "S9_EARLY_DEPTH_BLOCK"
        flow_code = "S9_EARLY_FLOW_BLOCK"
    else:
        long_depth_min = _f(mcfg.get("long_depth_imbalance_min"), -0.10)
        short_depth_max = _f(mcfg.get("short_depth_imbalance_max"), 0.10)
        long_flow_min = _f(mcfg.get("long_flow_imbalance_min"), 0.05)
        short_flow_max = _f(mcfg.get("short_flow_imbalance_max"), -0.05)
        depth_code = "S9_INSUFFICIENT_BOOK_DEPTH"
        flow_code = "S9_DATA_DEGRADED"
    reasons: List[str] = []
    if book_age_sec > _f(mcfg.get("orderbook_max_age_seconds"), 2):
        reasons.append("S9_ORDERBOOK_STALE")
    if trades_age_sec > _f(mcfg.get("trades_max_age_seconds"), 3):
        reasons.append("S9_TRADES_STALE")
    spr = spread_bps(bid, ask)
    if spr is None:
        reasons.append("S9_DATA_DEGRADED")
        return {"ok": False, "reasons": reasons, "data_state": "DEGRADED"}
    spread_window.observe(now_ts, spr)
    if not spread_window.ready():
        reasons.append("SPREAD_WINDOW_WARMING_UP")
        return {"ok": False, "reasons": reasons, "data_state": "DEGRADED", "s9_spread_bps": spr}
    p80 = spread_window.p80()
    abs_max = _f(mcfg.get("spread_abs_max_bps"), 2.0)
    if spr > abs_max:
        reasons.append("S9_SPREAD_TOO_WIDE")
    if p80 is not None and spr > _f(mcfg.get("spread_p80_mult"), 1.25) * p80:
        reasons.append("S9_SPREAD_TOO_WIDE")
    imb = depth_imbalance_5(bids, asks)
    if imb is None:
        reasons.append("S9_DATA_DEGRADED")
    else:
        if str(side).upper() == "LONG" and imb < long_depth_min:
            reasons.append(depth_code)
        if str(side).upper() == "SHORT" and imb > short_depth_max:
            reasons.append(depth_code)
    window_sec = _f(mcfg.get("trades_window_seconds"), 15)
    recent = []
    for row in trades:
        ts = _f(row.get("timestamp") or row.get("ts") or 0)
        ts_sec = ts / 1000.0 if ts > 1e12 else ts
        if ts_sec <= 0 or now_ts - ts_sec <= window_sec:
            recent.append(row)
    flow = aggressive_flow(recent)
    if flow is None:
        reasons.append("S9_DATA_DEGRADED")
    else:
        if str(side).upper() == "LONG" and flow < long_flow_min:
            reasons.append(flow_code)
        if str(side).upper() == "SHORT" and flow > short_flow_max:
            reasons.append(flow_code)
    mid = (bid + ask) / 2.0
    levels = asks if str(side).upper() == "LONG" else bids
    vwap = expected_vwap(levels, authorized_base_qty)
    slip = None
    if vwap is None:
        reasons.append("S9_INSUFFICIENT_BOOK_DEPTH")
    elif mid > 0:
        slip = abs(vwap - mid) / mid * 10_000.0
        if slip > _f(mcfg.get("max_expected_slippage_bps"), 2.0):
            reasons.append("S9_EXPECTED_SLIPPAGE_TOO_HIGH")
    data_state = "READY" if not reasons else "DEGRADED"
    out = {
        "ok": not reasons,
        "reasons": reasons,
        "data_state": data_state,
        "s9_spread_bps": spr,
        "s9_spread_p80": p80,
        "s9_depth_imbalance_5": imb,
        "s9_aggressive_flow_15s": flow,
        "s9_expected_slippage_bps": slip,
        "expected_vwap": vwap,
        "s9_entry_mode": "EARLY_MOMENTUM" if early else "TREND_CONTINUATION",
    }
    if early:
        out["early_depth_imbalance"] = imb
        out["early_flow_imbalance"] = flow
    return out


def round_trip_cost_bps(*, entry_fee_bps: float, exit_fee_bps: float, spread: float, slip: float) -> float:
    return float(entry_fee_bps) + float(exit_fee_bps) + float(spread) + 2.0 * float(slip)


def cost_gate(*, target_distance_bps: float, round_trip_bps: float, multiple: float = 3.0) -> Optional[str]:
    if round_trip_bps < 0:
        return "S9_COST_DATA_UNAVAILABLE"
    if target_distance_bps < multiple * round_trip_bps:
        return "S9_EXPECTED_MOVE_INSUFFICIENT_AFTER_COST"
    return None


def entry_drift_exceeded(*, side: str, trigger: float, executable: float, max_bps: float = 6.0) -> bool:
    if trigger <= 0 or executable <= 0:
        return True
    bps = (executable - trigger) / trigger * 10_000.0
    if str(side).upper() == "LONG":
        return bps > max_bps
    return -bps > max_bps
