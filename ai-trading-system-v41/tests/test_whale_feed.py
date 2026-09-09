"""E1 whale feed telemetry — no S8 alpha."""

from src.qa.whale_feed import WhaleFeedStore, event_dedupe_key


def test_event_dedupe():
    store = WhaleFeedStore()
    base = {
        "event_id": "e1",
        "timestamp": "2026-09-09T10:00:00.100Z",
        "source_event_timestamp": "2026-09-09T10:00:00.100Z",
        "wallet_id": "w1",
        "symbol": "BTC",
        "event_type": "POSITION_INCREASE",
        "position_notional_before_usd": 1_000_000,
        "position_notional_after_usd": 2_000_000,
        "source_sequence": 10,
        "node_received_at": "2026-09-09T10:00:00.150Z",
        "node_forwarded_at": "2026-09-09T10:00:00.160Z",
    }
    r1 = store.apply_events({"events": [base]})
    # duplicate with slightly different event_id / ms inside same second bucket
    dup = dict(base)
    dup["event_id"] = "e1-dup"
    dup["timestamp"] = "2026-09-09T10:00:00.900Z"
    r2 = store.apply_events({"events": [dup]})
    assert r1["applied"] == 1
    assert r2["duplicates"] == 1
    assert store.metrics["duplicate_event_count"] == 1


def test_latency_telemetry_percentiles():
    store = WhaleFeedStore()
    events = []
    for i in range(20):
        events.append(
            {
                "event_id": f"e{i}",
                "timestamp": f"2026-09-09T10:00:{i:02d}.000Z",
                "source_event_timestamp": f"2026-09-09T10:00:{i:02d}.000Z",
                "wallet_id": f"w{i}",
                "symbol": "ETH",
                "event_type": "POSITION_OPEN",
                "position_notional_before_usd": 0,
                "position_notional_after_usd": 500000,
                "source_sequence": i + 1,
                "node_received_at": f"2026-09-09T10:00:{i:02d}.050Z",
                "node_forwarded_at": f"2026-09-09T10:00:{i:02d}.060Z",
            }
        )
    store.apply_events({"events": events})
    tel = store.telemetry()
    assert tel["alpha_enabled"] is False
    assert tel["events_applied"] == 20
    assert tel["latency_ms"]["source_to_node"]["count"] == 20
    assert tel["latency_ms"]["end_to_end"]["p50"] is not None


def test_sequence_gap_detected():
    store = WhaleFeedStore()
    store.apply_events(
        {
            "events": [
                {
                    "event_id": "a",
                    "timestamp": "2026-09-09T11:00:00Z",
                    "wallet_id": "w",
                    "symbol": "BTC",
                    "event_type": "POSITION_OPEN",
                    "position_notional_before_usd": 0,
                    "position_notional_after_usd": 1,
                    "source_sequence": 1,
                },
                {
                    "event_id": "b",
                    "timestamp": "2026-09-09T11:00:01Z",
                    "wallet_id": "w",
                    "symbol": "BTC",
                    "event_type": "POSITION_INCREASE",
                    "position_notional_before_usd": 1,
                    "position_notional_after_usd": 2,
                    "source_sequence": 5,
                },
            ]
        }
    )
    assert store.metrics["sequence_gap_count"] == 1


def test_dedupe_key_stable():
    e = {
        "wallet_id": "abc",
        "symbol": "BTC",
        "event_type": "POSITION_CLOSE",
        "timestamp": "2026-09-09T12:00:00.123Z",
        "position_notional_before_usd": 9,
        "position_notional_after_usd": 0,
        "source_sequence": 99,
    }
    assert event_dedupe_key(e) == event_dedupe_key(e)
