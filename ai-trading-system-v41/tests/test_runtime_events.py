"""Runtime event persistence is independent of the browser and of evaluation_count."""

from __future__ import annotations

from pathlib import Path

from src.runtime.engine_store import EngineStore
from src.runtime.runtime_events import RuntimeEventRecorder, new_event_id, resolve_event_id, redact_secrets


def _put(rec: RuntimeEventRecorder, row: dict):
    return rec.persist_direct(row, allow_injected_event_id=True)
from src.runtime.strategy_diagnostics import StrategyDiagnostics
from src.telemetry.event_bus import EventBus


def _no_trade_payload(candle: str = "2026-09-10T04:00:00+00:00", reasons=None, **over):
    payload = {
        "strategy_id": "S1",
        "symbol": "BTC-USDT-SWAP",
        "direction": "NONE",
        "decision": "NO_TRADE",
        "reason_codes": reasons or ["CLOSE_VS_EMA20", "S3_DIRECTION_BLOCK"],
        "source_closed_candle_timestamp": candle,
    }
    payload.update(over)
    return payload


def test_no_trade_same_candle_same_reasons_persists_once(tmp_path: Path) -> None:
    store = EngineStore(tmp_path / "events.db")
    rec = RuntimeEventRecorder(store)
    payload = _no_trade_payload()
    first = rec.persist_bus_event({"type": "strategy.decision", "timestamp": "2026-09-10T04:00:01+00:00", "payload": payload})
    second = rec.persist_bus_event({"type": "strategy.decision", "timestamp": "2026-09-10T04:00:06+00:00", "payload": payload})
    assert first is not None
    assert second is None
    rows = store.list_runtime_events(event_type="STRATEGY_NO_TRADE")
    assert len(rows) == 1
    assert rows[0]["reason_codes"] == ["CLOSE_VS_EMA20", "S3_DIRECTION_BLOCK"]
    store.close()


def test_no_trade_reason_change_or_new_candle_creates_new_event(tmp_path: Path) -> None:
    store = EngineStore(tmp_path / "events.db")
    rec = RuntimeEventRecorder(store)
    rec.persist_bus_event({"type": "strategy.decision", "payload": _no_trade_payload(), "timestamp": "t1"})
    rec.persist_bus_event(
        {
            "type": "strategy.decision",
            "payload": _no_trade_payload(reasons=["TREND_QUALITY_BELOW_THRESHOLD"]),
            "timestamp": "t2",
        }
    )
    rec.persist_bus_event(
        {
            "type": "strategy.decision",
            "payload": _no_trade_payload(candle="2026-09-10T05:00:00+00:00"),
            "timestamp": "t3",
        }
    )
    assert len(store.list_runtime_events(event_type="STRATEGY_NO_TRADE")) == 3
    store.close()


def test_no_trade_symbol_aliases_persist_once(tmp_path: Path) -> None:
    store = EngineStore(tmp_path / "events.db")
    rec = RuntimeEventRecorder(store)
    candle = "2026-09-10T04:00:00+00:00"
    reasons = ["CLOSE_VS_EMA20", "S3_DIRECTION_BLOCK"]
    first = rec.persist_bus_event(
        {
            "type": "strategy.decision",
            "timestamp": "2026-09-10T04:00:01+00:00",
            "payload": _no_trade_payload(candle=candle, reasons=reasons, symbol="BTC/USDT:USDT"),
        }
    )
    second = rec.persist_bus_event(
        {
            "type": "strategy.decision",
            "timestamp": "2026-09-10T04:00:06+00:00",
            "payload": _no_trade_payload(candle=candle, reasons=reasons, symbol="BTC-USDT-SWAP"),
        }
    )
    assert first is not None
    assert second is None
    rows = store.list_runtime_events(event_type="STRATEGY_NO_TRADE")
    assert len(rows) == 1
    assert rows[0]["symbol"] == "BTC-USDT-SWAP"

    rec.persist_bus_event(
        {
            "type": "strategy.decision",
            "timestamp": "t-candle",
            "payload": _no_trade_payload(candle="2026-09-10T05:00:00+00:00", reasons=reasons, symbol="BTC/USDT:USDT"),
        }
    )
    rec.persist_bus_event(
        {
            "type": "strategy.decision",
            "timestamp": "t-reason",
            "payload": _no_trade_payload(candle=candle, reasons=["TREND_SLOPE"], symbol="BTC-USDT-SWAP"),
        }
    )
    assert len(store.list_runtime_events(event_type="STRATEGY_NO_TRADE")) == 3
    store.close()


def test_evaluation_count_not_affected_by_persist_dedupe() -> None:
    diag = StrategyDiagnostics("S1")
    for _ in range(1000):
        diag.record_evaluation(
            decision="NO_TRADE",
            reason_codes=["CLOSE_VS_EMA20"],
            symbol="BTC-USDT-SWAP",
            source_closed_candle_timestamp="2026-09-10T04:00:00+00:00",
        )
    assert diag.evaluation_count == 1000


def test_ui_disconnected_engine_keeps_recording(tmp_path: Path) -> None:
    store = EngineStore(tmp_path / "events.db")
    rec = RuntimeEventRecorder(store)
    bus = EventBus()
    bus.set_persist_hook(rec.persist_bus_event)
    a = bus.emit("engine.status", {"state": "RUNNING"})
    # no websocket subscribers — browser closed
    assert bus._subscribers == []
    b = bus.emit(
        "strategy.decision",
        _no_trade_payload(),
    )
    c = bus.emit(
        "order_intent.updated",
        {"order_intent_id": "oi-1", "status": "FILLED", "strategy_id": "S1", "symbol": "BTC-USDT-SWAP"},
    )
    ids = {row["event_id"] for row in store.list_runtime_events(limit=20)}
    assert a["event_id"] in ids
    assert b["event_id"] in ids
    assert c["event_id"] in ids
    store.close()


def test_server_restart_keeps_events(tmp_path: Path) -> None:
    path = tmp_path / "events.db"
    store = EngineStore(path)
    rec = RuntimeEventRecorder(store)
    _put(rec, {"event_id": "A", "event_type": "ENGINE_START", "occurred_at": "2026-09-10T01:00:00+00:00"})
    _put(rec, {"event_id": "B", "event_type": "ORDER_SUBMITTED", "occurred_at": "2026-09-10T01:01:00+00:00", "order_intent_id": "oi-1"})
    _put(rec, {"event_id": "C", "event_type": "ORDER_FILLED", "occurred_at": "2026-09-10T01:02:00+00:00", "order_intent_id": "oi-1"})
    store.close()

    restored = EngineStore(path)
    ids = {row["event_id"] for row in restored.list_runtime_events(limit=20)}
    assert ids == {"A", "B", "C"}
    restored.close()


def test_order_lifecycle_is_never_deduped(tmp_path: Path) -> None:
    store = EngineStore(tmp_path / "events.db")
    rec = RuntimeEventRecorder(store)
    rec.persist_bus_event(
        {"type": "order_intent.updated", "payload": {"order_intent_id": "oi-1", "status": "SUBMITTED"}}
    )
    rec.persist_bus_event(
        {"type": "order_intent.updated", "payload": {"order_intent_id": "oi-1", "status": "PARTIAL"}}
    )
    rec.persist_bus_event(
        {"type": "order_intent.updated", "payload": {"order_intent_id": "oi-1", "status": "FILLED"}}
    )
    rec.persist_bus_event(
        {"type": "order_intent.updated", "payload": {"order_intent_id": "oi-2", "status": "FILLED"}}
    )
    types = [row["event_type"] for row in reversed(store.list_runtime_events(limit=20))]
    assert types == [
        "ORDER_SUBMITTED",
        "ORDER_PARTIALLY_FILLED",
        "ORDER_FILLED",
        "ORDER_FILLED",
    ]
    store.close()


def test_secrets_are_redacted(tmp_path: Path) -> None:
    store = EngineStore(tmp_path / "events.db")
    rec = RuntimeEventRecorder(store)
    saved = _put(
        rec,
        {
            "event_id": "sec-1",
            "event_type": "ORDER_SUBMITTED",
            "details": {
                "api_secret": "super-secret",
                "passphrase": "pp",
                "Authorization": "Bearer abc",
                "safe": "ok",
            },
        },
    )
    assert saved is not None
    details = saved["details"]
    assert details["api_secret"] == "[REDACTED]"
    assert details["passphrase"] == "[REDACTED]"
    assert details["Authorization"] == "[REDACTED]"
    assert details["safe"] == "ok"
    assert "super-secret" not in str(saved)
    store.close()


def test_redact_helper_covers_nested_credentials() -> None:
    out = redact_secrets({"outer": {"credentials": {"apiKey": "k", "secret": "s"}}})
    assert out["outer"]["credentials"] == "[REDACTED]"


def test_history_filters_and_limit(tmp_path: Path) -> None:
    store = EngineStore(tmp_path / "events.db")
    rec = RuntimeEventRecorder(store)
    _put(rec, {"event_id": "1", "event_type": "ENGINE_START", "occurred_at": "2026-09-10T01:00:00+00:00"})
    _put(
        rec,
        {
            "event_id": "2",
            "event_type": "STRATEGY_NO_TRADE",
            "occurred_at": "2026-09-10T01:01:00+00:00",
            "strategy_id": "S1",
            "symbol": "BTC-USDT-SWAP",
            "decision": "NO_TRADE",
            "reason_codes": ["CLOSE_VS_EMA20"],
            "source_closed_candle_timestamp": "c1",
        },
    )
    _put(
        rec,
        {
            "event_id": "3",
            "event_type": "ORDER_FILLED",
            "occurred_at": "2026-09-10T01:02:00+00:00",
            "symbol": "ETH-USDT-SWAP",
        },
    )
    page = store.list_runtime_events(limit=2)
    assert [r["event_id"] for r in page] == ["3", "2"]
    older = store.list_runtime_events(limit=10, before="2026-09-10T01:02:00+00:00")
    assert [r["event_id"] for r in older] == ["2", "1"]
    only_s1 = store.list_runtime_events(strategy_id="S1")
    assert [r["event_id"] for r in only_s1] == ["2"]
    store.close()


def test_generated_event_id_is_python_namespaced() -> None:
    eid = new_event_id()
    assert eid.startswith("py_")
    bus = EventBus()
    emitted = bus.emit("engine.status", {"state": "PAUSED"})
    assert emitted["event_id"].startswith("py_")


def test_same_timestamp_pagination_is_stable(tmp_path: Path) -> None:
    store = EngineStore(tmp_path / "events.db")
    rec = RuntimeEventRecorder(store)
    ts = "2026-09-10T04:00:00+00:00"
    for eid in ("py_c", "py_b", "py_a"):
        rec.persist_direct({"event_id": eid, "event_type": "S6_BLOCK", "occurred_at": ts})
    page1 = store.list_runtime_events(limit=2)
    assert [r["event_id"] for r in page1] == ["py_c", "py_b"]
    page2 = store.list_runtime_events(
        limit=2,
        before=page1[-1]["occurred_at"],
        before_event_id=page1[-1]["event_id"],
    )
    assert [r["event_id"] for r in page2] == ["py_a"]
    seen = [r["event_id"] for r in page1 + page2]
    assert seen == ["py_c", "py_b", "py_a"]
    assert len(set(seen)) == 3
    store.close()


def test_empty_order_intent_does_not_collapse_same_event_type(tmp_path: Path) -> None:
    store = EngineStore(tmp_path / "events.db")
    rec = RuntimeEventRecorder(store)
    rec.persist_direct(
        {
            "event_id": "py_nt_1",
            "event_type": "STRATEGY_NO_TRADE",
            "occurred_at": "2026-09-10T04:00:00+00:00",
            "strategy_id": "S1",
            "symbol": "BTC-USDT-SWAP",
            "decision": "NO_TRADE",
            "reason_codes": ["CLOSE_VS_EMA20"],
            "source_closed_candle_timestamp": "c1",
        }
    )
    rec.persist_direct(
        {
            "event_id": "py_nt_2",
            "event_type": "STRATEGY_NO_TRADE",
            "occurred_at": "2026-09-10T05:00:00+00:00",
            "strategy_id": "S1",
            "symbol": "BTC-USDT-SWAP",
            "decision": "NO_TRADE",
            "reason_codes": ["CLOSE_VS_EMA20"],
            "source_closed_candle_timestamp": "c2",
        }
    )
    rec.persist_direct({"event_id": "py_s6_1", "event_type": "S6_BLOCK", "occurred_at": "2026-09-10T06:00:00+00:00"})
    rec.persist_direct({"event_id": "py_s6_2", "event_type": "S6_BLOCK", "occurred_at": "2026-09-10T06:01:00+00:00"})
    rec.persist_direct({"event_id": "py_eng_1", "event_type": "ENGINE_START", "occurred_at": "2026-09-10T07:00:00+00:00"})
    rec.persist_direct({"event_id": "py_eng_2", "event_type": "ENGINE_PAUSE", "occurred_at": "2026-09-10T07:01:00+00:00"})
    ids = {row["event_id"] for row in store.list_runtime_events(limit=20)}
    assert ids == {"py_nt_1", "py_nt_2", "py_s6_1", "py_s6_2", "py_eng_1", "py_eng_2"}
    store.close()


def test_partial_fill_updates_keep_each_qty(tmp_path: Path) -> None:
    store = EngineStore(tmp_path / "events.db")
    rec = RuntimeEventRecorder(store)
    rec.persist_bus_event(
        {
            "type": "order_intent.updated",
            "payload": {"order_intent_id": "oi_123", "status": "PARTIAL", "accFillSz": 4},
        }
    )
    rec.persist_bus_event(
        {
            "type": "order_intent.updated",
            "payload": {"order_intent_id": "oi_123", "status": "PARTIAL", "accFillSz": 7},
        }
    )
    rec.persist_bus_event(
        {
            "type": "order_intent.updated",
            "payload": {"order_intent_id": "oi_123", "status": "FILLED", "accFillSz": 10},
        }
    )
    rows = list(reversed(store.list_runtime_events(limit=20)))
    assert [r["event_type"] for r in rows] == [
        "ORDER_PARTIALLY_FILLED",
        "ORDER_PARTIALLY_FILLED",
        "ORDER_FILLED",
    ]
    qtys = [str((r["details"] or {}).get("accFillSz")) for r in rows]
    assert qtys == ["4", "7", "10"]
    store.close()


def test_production_event_id_rejects_bare_ids(tmp_path: Path) -> None:
    store = EngineStore(tmp_path / "events.db")
    rec = RuntimeEventRecorder(store)
    saved = rec.persist_direct({"event_id": "bare-id", "event_type": "ENGINE_START"})
    assert saved is not None
    assert saved["event_id"].startswith("py_")
    assert saved["event_id"] != "bare-id"
    injected = rec.persist_direct(
        {"event_id": "bare-id", "event_type": "ENGINE_PAUSE"},
        allow_injected_event_id=True,
    )
    assert injected is not None
    assert injected["event_id"] == "bare-id"
    auto = rec.persist_direct({"event_type": "ENGINE_LOCK"})
    assert auto is not None
    assert auto["event_id"].startswith("py_")
    assert resolve_event_id("node:ORDER_FILLED:oi:FILLED:10").startswith("node:")
    store.close()
