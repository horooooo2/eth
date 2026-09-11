"""Read-only audit of recorded S9 microstructure samples. No orders. No new rules."""

from __future__ import annotations

import argparse
import json
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

from src.runtime.engine_store import DEFAULT_DB, EngineStore

COMPARE = (
    "depth_imbalance",
    "flow_imbalance",
    "spread_bps",
    "volume_ratio",
    "distance_to_breakout_bps",
    "structure_distance_atr",
)


def _pcts(vals: List[float]) -> Dict[str, Optional[float]]:
    if not vals:
        return {"count": 0, "p25": None, "median": None, "p75": None}
    s = sorted(vals)
    n = len(s)

    def q(p: float) -> float:
        if n == 1:
            return round(s[0], 6)
        return round(s[min(n - 1, max(0, int(round((n - 1) * p))))], 6)

    return {"count": n, "p25": q(0.25), "median": q(0.50), "p75": q(0.75)}


def _sep(success: List[float], fail: List[float]) -> Dict[str, Any]:
    a, b = _pcts(success), _pcts(fail)
    if a["count"] < 20 or b["count"] < 20:
        return {"success": a, "failure": b, "stable_separation": False, "note": "insufficient_n"}
    iqr = (b["p75"] - b["p25"]) if b["p25"] is not None and b["p75"] is not None else 0.0
    if iqr <= 1e-12:
        iqr = 1e-12
    outside = a["median"] < b["p25"] or a["median"] > b["p75"]
    no_overlap = a["p25"] > b["p75"] or a["p75"] < b["p25"]
    rel = abs(a["median"] - b["median"]) / iqr
    stable = bool(no_overlap or (outside and rel >= 0.5))
    return {
        "success": a,
        "failure": b,
        "stable_separation": stable,
        "note": "IQR_NO_OVERLAP" if no_overlap else ("median_outside_fail_IQR" if outside else "overlap"),
    }


def _window(hours: int, rows: List[Dict[str, Any]]) -> Dict[str, Any]:
    cut = (datetime.now(timezone.utc) - timedelta(hours=hours)).isoformat()
    picked = [r for r in rows if str(r.get("recorded_at") or "") >= cut]
    success, fail = [], []
    for r in picked:
        out = r.get("outcome") or {}
        fwd = out.get("15m_directional_return")
        if fwd is None:
            continue
        (success if float(fwd) >= 15.0 else fail).append(r)
    cmp = {}
    for key in COMPARE:
        sv = [float(x["payload"][key]) for x in success if x.get("payload", {}).get(key) is not None]
        fv = [float(x["payload"][key]) for x in fail if x.get("payload", {}).get(key) is not None]
        cmp[key] = _sep(sv, fv)
    return {
        "hours": hours,
        "recorded": len(picked),
        "with_15m_outcome": len(success) + len(fail),
        "success_15m_ge_15bps": len(success),
        "failure": len(fail),
        "features": cmp,
        "any_stable_separation": any(v.get("stable_separation") for v in cmp.values()),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="S9 microstructure research report. Read-only.")
    parser.add_argument("--db", default=os.environ.get("V41_ENGINE_DB") or str(DEFAULT_DB))
    args = parser.parse_args()
    path = Path(args.db)
    if not path.exists():
        print(json.dumps({"error": "db_missing", "path": str(path), "recorded": 0}, ensure_ascii=False))
        return 0
    store = EngineStore(path)
    rows = store.list_s9_microstructure_research(limit=20000)
    store.close()
    report = {
        "source": "s9_microstructure_research",
        "db": str(path),
        "write_requests": 0,
        "new_rules": False,
        "label_note": "SUCCESS uses 15m directional_return >= 15bps. Research only.",
        "total_recorded": len(rows),
        "windows": {f"{h}h": _window(h, rows) for h in (24, 48, 72)},
    }
    print(json.dumps(report, ensure_ascii=False, default=str))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
