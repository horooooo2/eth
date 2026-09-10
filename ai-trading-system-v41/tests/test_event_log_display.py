"""POSITION vs SYSTEM classification and Chinese display. No trading side effects."""

from __future__ import annotations

from pathlib import Path

from src.runtime.engine_store import EngineStore
from src.runtime.event_log_display import (
    annotate_event,
    classify_display_category,
    display_symbol,
    format_user_message,
)
from src.runtime.runtime_events import RuntimeEventRecorder
from src.runtime.strategy_display_zh import event_zh, reason_zh, status_zh


def _cat(event):
    return classify_display_category(event)


def test_classification_matrix() -> None:
    cases = [
        ({"event_type": "STRATEGY_NO_TRADE"}, "SYSTEM"),
        ({"event_type": "TRADE_INTENT_CREATED"}, "SYSTEM"),
        ({"event_type": "ORDER_INTENT_CREATED"}, "SYSTEM"),
        ({"event_type": "ORDER_SUBMITTED", "details": {"accFillSz": 0, "sz": 10}}, "SYSTEM"),
        ({"event_type": "ORDER_PARTIALLY_FILLED", "details": {"accFillSz": 4, "sz": 10}}, "POSITION"),
        ({"event_type": "ORDER_FILLED", "details": {"accFillSz": 10, "sz": 10}}, "POSITION"),
        ({"event_type": "FILLED"}, "POSITION"),
        ({"event_type": "POSITION_OPENED"}, "POSITION"),
        ({"event_type": "PROTECTIVE_STOP_ACTIVE", "position_id": "pos-1"}, "POSITION"),
        ({"event_type": "TAKE_PROFIT_TRIGGERED", "position_id": "pos-1"}, "POSITION"),
        ({"event_type": "POSITION_CLOSED", "position_id": "pos-1"}, "POSITION"),
        ({"event_type": "SYMBOL_OWNERSHIP_CONFLICT", "strategy_id": "S9"}, "SYSTEM"),
        ({"event_type": "S9_ORDERBOOK_STALE"}, "SYSTEM"),
        ({"event_type": "ENGINE_STARTED"}, "SYSTEM"),
        ({"event_type": "ENGINE_START"}, "SYSTEM"),
        ({"event_type": "ORDER_REJECTED", "details": {"accFillSz": 0}}, "SYSTEM"),
        ({"event_type": "ORDER_CANCELLED", "details": {"accFillSz": 0}}, "SYSTEM"),
        ({"event_type": "RECONCILIATION_MATCHED"}, "SYSTEM"),
        (
            {
                "event_type": "RECONCILIATION_MISMATCH",
                "position_id": "pos-1",
                "details": {"owned_contracts": 10, "exchange_qty": 7},
            },
            "POSITION",
        ),
        ({"event_type": "RECONCILIATION_MISMATCH"}, "SYSTEM"),
        ({"event_type": "S5_RISK_CHANGED"}, "SYSTEM"),
        ({"event_type": "S6_BLOCK"}, "SYSTEM"),
        ({"event_type": "ORDER_SUBMITTED", "reduce_only": True}, "POSITION"),
    ]
    for event, expected in cases:
        got = _cat(event)
        assert got == expected, event
        other = "SYSTEM" if expected == "POSITION" else "POSITION"
        assert got != other


def test_chinese_primary_copy() -> None:
    assert "本轮不交易" in format_user_message(
        {
            "event_type": "STRATEGY_NO_TRADE",
            "strategy_id": "S1",
            "symbol": "BTC-USDT-SWAP",
            "reason_codes": [
                "CLOSE_VS_EMA20",
                "EMA20_VS_EMA50",
                "S3_DIRECTION_BLOCK",
                "S3_REGIME_BLOCK",
                "TREND_SLOPE",
            ],
        }
    )
    msg = format_user_message(
        {
            "event_type": "ORDER_PARTIALLY_FILLED",
            "details": {"accFillSz": 4, "sz": 10},
        }
    )
    assert "开仓部分成交" in msg
    assert "4 张" in msg
    assert "10 张" in msg
    assert "ORDER_PARTIALLY_FILLED" not in msg
    filled = format_user_message({"event_type": "ORDER_FILLED", "details": {"accFillSz": 10}})
    assert "仓位建立完成" in filled
    assert "10 张" in filled
    assert "仓位已全部平仓" == format_user_message({"event_type": "POSITION_CLOSED"})
    assert "保护止损已生效" in format_user_message(
        {"event_type": "PROTECTIVE_STOP_ACTIVE", "details": {"covered_contracts": 10}}
    )
    submitted = format_user_message({"event_type": "ORDER_SUBMITTED", "details": {"accFillSz": 0}})
    assert submitted == "开仓订单已提交，等待成交"
    assert format_user_message({"event_type": "ENGINE_START"}) == "交易引擎已启动"
    assert "盘口数据已过期" == format_user_message({"event_type": "S9_ORDERBOOK_STALE"})
    assert "当前交易对仍由其他策略持有" in format_user_message({"event_type": "SYMBOL_OWNERSHIP_CONFLICT"})

    assert reason_zh("CLOSE_VS_EMA20") == "收盘价与 EMA20 的位置不符合趋势要求"
    assert reason_zh("EMA20_VS_EMA50") == "EMA20 与 EMA50 未形成有效趋势排列"
    assert reason_zh("S3_DIRECTION_BLOCK") == "市场方向不支持当前交易方向"
    assert reason_zh("S3_REGIME_BLOCK") == "当前市场状态不适合该策略交易"
    assert reason_zh("TREND_SLOPE") == "趋势斜率不足"
    assert "未识别的交易提示（CODEX）" == reason_zh("CODEX")
    assert status_zh("NO_TRADE") == "本轮不交易"
    assert status_zh("PARTIALLY_FILLED") == "部分成交"
    assert status_zh("FILLED") == "已成交"
    assert status_zh("READY") == "就绪"
    assert status_zh("WARMING_UP") == "预热中"
    assert status_zh("BLOCKED") == "已阻止"
    assert "未识别的系统状态（ZZZ）" == status_zh("ZZZ")
    assert "未识别的系统状态（WEIRD_EVENT）" == event_zh("WEIRD_EVENT")


def test_display_symbol_canonical() -> None:
    assert display_symbol("BTC/USDT:USDT") == "BTC-USDT-SWAP"
    assert display_symbol("BTC-USDT-SWAP") == "BTC-USDT-SWAP"
    no_trade = format_user_message(
        {
            "event_type": "STRATEGY_NO_TRADE",
            "strategy_id": "S1",
            "symbol": "BTC/USDT:USDT",
            "reason_codes": ["CLOSE_VS_EMA20"],
        }
    )
    assert "BTC-USDT-SWAP" in no_trade
    assert "BTC/USDT:USDT" not in no_trade


def test_historical_runtime_events_reclassify(tmp_path: Path) -> None:
    store = EngineStore(tmp_path / "events.db")
    rec = RuntimeEventRecorder(store)
    rec.persist_direct(
        {
            "event_id": "hist-nt",
            "event_type": "STRATEGY_NO_TRADE",
            "occurred_at": "2026-09-01T00:00:00+00:00",
            "strategy_id": "S1",
            "symbol": "BTC/USDT:USDT",
            "decision": "NO_TRADE",
            "reason_codes": ["CLOSE_VS_EMA20", "S3_DIRECTION_BLOCK"],
            "message": "S1 · BTC/USDT:USDT · NO_TRADE · CLOSE_VS_EMA20",
        },
        allow_injected_event_id=True,
    )
    rec.persist_direct(
        {
            "event_id": "hist-sub",
            "event_type": "ORDER_SUBMITTED",
            "occurred_at": "2026-09-01T00:01:00+00:00",
            "message": "ORDER_SUBMITTED 0 fill",
            "details": {"accFillSz": 0, "sz": 10},
        },
        allow_injected_event_id=True,
    )
    rec.persist_direct(
        {
            "event_id": "hist-pf",
            "event_type": "ORDER_PARTIALLY_FILLED",
            "occurred_at": "2026-09-01T00:02:00+00:00",
            "message": "ORDER_PARTIALLY_FILLED 4/10",
            "details": {"accFillSz": 4, "sz": 10},
        },
        allow_injected_event_id=True,
    )
    rec.persist_direct(
        {
            "event_id": "hist-fill",
            "event_type": "ORDER_FILLED",
            "occurred_at": "2026-09-01T00:03:00+00:00",
            "message": "FILLED",
            "details": {"accFillSz": 10},
        },
        allow_injected_event_id=True,
    )
    rows = {row["event_id"]: annotate_event(row) for row in store.list_runtime_events(limit=20)}
    assert rows["hist-nt"]["display_category"] == "SYSTEM"
    assert "本轮不交易" in rows["hist-nt"]["display_message"]
    assert "BTC-USDT-SWAP" in rows["hist-nt"]["display_message"]
    assert rows["hist-sub"]["display_category"] == "SYSTEM"
    assert rows["hist-pf"]["display_category"] == "POSITION"
    assert "开仓部分成交" in rows["hist-pf"]["display_message"]
    assert rows["hist-fill"]["display_category"] == "POSITION"
    store.close()
