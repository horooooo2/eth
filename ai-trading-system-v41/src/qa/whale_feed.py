"""Whale data ingest + latency telemetry (E1). No S8 Alpha scoring."""

from __future__ import annotations

import hashlib
import time
from collections import deque
from dataclasses import dataclass, field
from typing import Any, Deque, Dict, List, Optional, Tuple


def _now_ms() -> int:
    return int(time.time() * 1000)


def _parse_iso_ms(value: Any) -> Optional[int]:
    if value is None:
        return None
    if isinstance(value, (int, float)):
        v = int(value)
        return v if v > 10_000_000_000 else v * 1000
    s = str(value).strip()
    if not s:
        return None
    try:
        # handle Z
        from datetime import datetime

        if s.endswith("Z"):
            s = s[:-1] + "+00:00"
        return int(datetime.fromisoformat(s).timestamp() * 1000)
    except Exception:
        return None


def event_dedupe_key(event: Dict[str, Any]) -> str:
    ts = str(event.get("timestamp") or "")
    # 1-second bucket to collapse WS/backfill duplicates
    ts_ms = _parse_iso_ms(ts) or 0
    bucket = ts_ms // 1000
    parts = [
        str(event.get("wallet_id") or ""),
        str(event.get("symbol") or ""),
        str(event.get("event_type") or ""),
        str(bucket),
        str(event.get("position_notional_before_usd") or ""),
        str(event.get("position_notional_after_usd") or ""),
        str(event.get("source_sequence") or ""),
    ]
    raw = "|".join(parts)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


@dataclass
class WhaleFeedStore:
    """In-memory whale snapshots/events with latency telemetry. Not Alpha."""

    max_events: int = 5000
    events: Deque[Dict[str, Any]] = field(default_factory=deque)
    seen_keys: Deque[str] = field(default_factory=deque)
    seen_set: set[str] = field(default_factory=set)
    last_snapshot: Optional[Dict[str, Any]] = None
    last_sequences: Dict[str, int] = field(default_factory=dict)
    metrics: Dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        self.metrics = {
            "events_received": 0,
            "events_applied": 0,
            "duplicate_event_count": 0,
            "sequence_gap_count": 0,
            "stale_event_count": 0,
            "snapshot_recovery_count": 0,
            "latency_samples_ms": {
                "source_to_node": [],
                "node_processing": [],
                "node_to_python": [],
                "end_to_end": [],
            },
        }

    def apply_snapshot(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        python_received_at = _now_ms()
        python_applied_at = python_received_at
        body = dict(payload or {})
        body["python_received_at"] = body.get("python_received_at") or python_received_at
        body["python_applied_at"] = python_applied_at
        self.last_snapshot = body
        self.metrics["snapshot_recovery_count"] += 1
        self._record_latency(body, python_received_at, python_applied_at)
        return {"ok": True, "whales": len(body.get("whales") or []), "applied_at": python_applied_at}

    def apply_events(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        python_received_at = _now_ms()
        items = payload.get("events") if isinstance(payload, dict) else None
        if items is None and isinstance(payload, list):
            items = payload
        if not isinstance(items, list):
            items = [payload] if isinstance(payload, dict) and payload.get("event_id") else []

        applied = 0
        duplicates = 0
        gaps = 0
        stale = 0
        for raw in items:
            if not isinstance(raw, dict):
                continue
            self.metrics["events_received"] += 1
            event = dict(raw)
            event["python_received_at"] = event.get("python_received_at") or python_received_at
            event["python_applied_at"] = _now_ms()

            key = event_dedupe_key(event)
            if key in self.seen_set:
                duplicates += 1
                self.metrics["duplicate_event_count"] += 1
                continue

            # sequence gap
            wallet = str(event.get("wallet_id") or "")
            seq = event.get("source_sequence")
            if wallet and seq is not None:
                try:
                    seq_i = int(seq)
                    prev = self.last_sequences.get(wallet)
                    if prev is not None and seq_i > prev + 1:
                        gaps += 1
                        self.metrics["sequence_gap_count"] += 1
                    self.last_sequences[wallet] = seq_i
                except (TypeError, ValueError):
                    pass

            # stale: event older than 120s vs python_received
            src_ms = _parse_iso_ms(event.get("source_event_timestamp") or event.get("timestamp"))
            if src_ms and python_received_at - src_ms > 120_000:
                stale += 1
                self.metrics["stale_event_count"] += 1

            self._remember_key(key)
            self.events.append(event)
            while len(self.events) > self.max_events:
                self.events.popleft()
            self._record_latency(event, python_received_at, event["python_applied_at"])
            applied += 1
            self.metrics["events_applied"] += 1

        return {
            "ok": True,
            "applied": applied,
            "duplicates": duplicates,
            "sequence_gaps": gaps,
            "stale": stale,
        }

    def _remember_key(self, key: str) -> None:
        self.seen_set.add(key)
        self.seen_keys.append(key)
        while len(self.seen_keys) > self.max_events * 2:
            old = self.seen_keys.popleft()
            self.seen_set.discard(old)

    def _record_latency(self, body: Dict[str, Any], python_received_at: int, python_applied_at: int) -> None:
        src = _parse_iso_ms(body.get("source_event_timestamp") or body.get("timestamp"))
        node_recv = _parse_iso_ms(body.get("node_received_at"))
        node_fwd = _parse_iso_ms(body.get("node_forwarded_at"))
        samples = self.metrics["latency_samples_ms"]

        def _push(name: str, value: Optional[float]) -> None:
            if value is None:
                return
            arr = samples[name]
            arr.append(float(value))
            if len(arr) > 2000:
                del arr[: len(arr) - 2000]

        if src is not None and node_recv is not None:
            _push("source_to_node", node_recv - src)
        if node_recv is not None and node_fwd is not None:
            _push("node_processing", node_fwd - node_recv)
        if node_fwd is not None:
            _push("node_to_python", python_received_at - node_fwd)
        if src is not None:
            _push("end_to_end", python_applied_at - src)

    def telemetry(self) -> Dict[str, Any]:
        def pct(arr: List[float]) -> Dict[str, Optional[float]]:
            if not arr:
                return {"p50": None, "p95": None, "p99": None, "count": 0}
            s = sorted(arr)
            def q(p: float) -> float:
                idx = min(len(s) - 1, max(0, int(round((p / 100.0) * (len(s) - 1)))))
                return s[idx]
            return {"p50": q(50), "p95": q(95), "p99": q(99), "count": len(s)}

        samples = self.metrics["latency_samples_ms"]
        return {
            "module": "whale_data_bridge",
            "alpha_enabled": False,
            "events_received": self.metrics["events_received"],
            "events_applied": self.metrics["events_applied"],
            "duplicate_event_count": self.metrics["duplicate_event_count"],
            "sequence_gap_count": self.metrics["sequence_gap_count"],
            "stale_event_count": self.metrics["stale_event_count"],
            "snapshot_recovery_count": self.metrics["snapshot_recovery_count"],
            "last_snapshot_at": (self.last_snapshot or {}).get("python_applied_at"),
            "latency_ms": {
                "source_to_node": pct(samples["source_to_node"]),
                "node_processing": pct(samples["node_processing"]),
                "node_to_python": pct(samples["node_to_python"]),
                "end_to_end": pct(samples["end_to_end"]),
            },
            "recent_events": list(self.events)[-20:],
        }


_feed: Optional[WhaleFeedStore] = None


def get_whale_feed() -> WhaleFeedStore:
    global _feed
    if _feed is None:
        _feed = WhaleFeedStore()
    return _feed
