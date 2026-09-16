"""LiveExecutor mock tests."""
from __future__ import annotations

import sys
import traceback
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from src.exchange.live_executor import LiveExecutor
from src.risk_engine import MarketSnapshot
from src.trade_intent import STATUS_RISK_APPROVED, TradeIntent


def _intent() -> TradeIntent:
    decision = SimpleNamespace(action="OPEN_LONG", position_multiplier=1.0, threshold=0.7)
    intent = TradeIntent.create(decision, "BTC", "LONG", leverage=3.0)
    intent.status = STATUS_RISK_APPROVED
    intent.margin = 200.0  # type: ignore[attr-defined]
    intent.stop_loss = 65000.0  # type: ignore[attr-defined]
    return intent


def test_execute_market_order() -> None:
    client = MagicMock()
    client.get_instruments.return_value = [{"instId": "BTC-USDT-SWAP", "ctVal": "0.01"}]
    client.place_order.return_value = {"ordId": "oid-1"}
    client.get_order.return_value = {"state": "filled", "avgPx": "67000", "accFillSz": "1"}
    ex = LiveExecutor(client=client, timeout_sec=2, poll_attempts=1, poll_interval_sec=0)
    market = MarketSnapshot(price=67000.0, atr=100.0)
    result = ex.execute(_intent(), market)
    assert result.status == "FILLED"
    kwargs = client.place_order.call_args.kwargs
    assert kwargs["ord_type"] == "market"
    assert kwargs["side"] == "buy"


def test_attach_stop_loss() -> None:
    client = MagicMock()
    client.get_instruments.return_value = [{"instId": "BTC-USDT-SWAP", "ctVal": "0.01"}]
    client.place_order.return_value = {"ordId": "oid-1"}
    client.get_order.return_value = {"state": "filled", "avgPx": "67000", "accFillSz": "1"}
    ex = LiveExecutor(client=client, poll_attempts=1, poll_interval_sec=0)
    ex.execute(_intent(), MarketSnapshot(price=67000.0, atr=100.0))
    attach = client.place_order.call_args.kwargs.get("attach_algo_ords")
    assert attach and "slTriggerPx" in attach[0]


def test_partial_fill_handling() -> None:
    client = MagicMock()
    client.get_instruments.return_value = [{"instId": "BTC-USDT-SWAP", "ctVal": "0.01"}]
    client.place_order.return_value = {"ordId": "oid-1"}
    client.get_order.return_value = {
        "state": "partially_filled",
        "avgPx": "67000",
        "accFillSz": "0.5",
    }
    ex = LiveExecutor(client=client, poll_attempts=1, poll_interval_sec=0, timeout_sec=1)
    result = ex.execute(_intent(), MarketSnapshot(price=67000.0, atr=100.0))
    assert result.status == "FILLED"
    assert result.position_size == 0.5


def test_timeout_cancels_order() -> None:
    client = MagicMock()
    client.get_instruments.return_value = [{"instId": "BTC-USDT-SWAP", "ctVal": "0.01"}]
    client.place_order.return_value = {"ordId": "oid-1"}
    client.get_order.return_value = {"state": "live", "accFillSz": "0"}
    ex = LiveExecutor(client=client, poll_attempts=1, poll_interval_sec=0, timeout_sec=0.01)
    result = ex.execute(_intent(), MarketSnapshot(price=67000.0, atr=100.0))
    assert result.status == "REJECTED"
    assert result.reject_reason == "ORDER_TIMEOUT"
    client.cancel_order.assert_called()


def test_close_position_reduce_only() -> None:
    client = MagicMock()
    client.place_order.return_value = {"ordId": "c1"}
    client.get_order.return_value = {"state": "filled", "avgPx": "67000", "accFillSz": "1"}
    ex = LiveExecutor(client=client, poll_attempts=1, poll_interval_sec=0)
    result = ex.close_position({"side": "LONG", "pos": "1", "position_id": "p1"})
    assert result.status == "FILLED"
    assert client.place_order.call_args.kwargs["reduce_only"] is True


def main() -> None:
    tests = [
        test_execute_market_order,
        test_attach_stop_loss,
        test_partial_fill_handling,
        test_timeout_cancels_order,
        test_close_position_reduce_only,
    ]
    failed = 0
    for fn in tests:
        try:
            fn()
            print(f"PASS {fn.__name__}")
        except Exception:
            failed += 1
            print(f"FAIL {fn.__name__}")
            traceback.print_exc()
    print(f"\n{len(tests) - failed}/{len(tests)} passed")
    raise SystemExit(failed)


if __name__ == "__main__":
    main()
