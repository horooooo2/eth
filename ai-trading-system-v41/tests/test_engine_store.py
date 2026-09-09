"""Persistence smoke for EngineStore order/trade intent reload."""

from __future__ import annotations

from pathlib import Path

from src.runtime.engine_store import EngineStore


def test_order_intent_roundtrip(tmp_path: Path) -> None:
    db = tmp_path / "t.db"
    store = EngineStore(db)
    store.upsert_order_intent(
        "oi-1",
        "ti-1",
        "SUBMITTED",
        {"order_intent_id": "oi-1", "trade_intent_id": "ti-1", "status": "SUBMITTED"},
        "2026-01-01T00:00:00+00:00",
    )
    store.close()

    store2 = EngineStore(db)
    items = store2.list_order_intents(10)
    assert len(items) == 1
    assert items[0]["order_intent_id"] == "oi-1"
    store2.close()


def test_trade_intent_list(tmp_path: Path) -> None:
    db = tmp_path / "t2.db"
    store = EngineStore(db)
    store.upsert_intent(
        "ti-9",
        "S1",
        "CREATED",
        {"intent_id": "ti-9", "strategy_id": "S1", "status": "CREATED"},
        "2026-01-01T00:00:00+00:00",
    )
    items = store.list_trade_intents(5)
    assert items[0]["intent_id"] == "ti-9"
    store.close()
