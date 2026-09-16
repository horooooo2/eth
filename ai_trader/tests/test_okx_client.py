"""Mock tests for OKXClient."""
from __future__ import annotations

import sys
import traceback
from pathlib import Path
from unittest.mock import MagicMock, patch

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from src.exchange.okx_client import OKXAPIError, OKXClient


def test_signature_generation() -> None:
    client = OKXClient(api_key="k", secret_key="secret", passphrase="p")
    ts = "2026-09-16T14:52:00.000Z"
    sig = client._sign(ts, "GET", "/api/v5/account/balance", "")
    assert isinstance(sig, str) and len(sig) > 10
    # deterministic
    assert sig == client._sign(ts, "GET", "/api/v5/account/balance", "")


def test_get_balance_success() -> None:
    client = OKXClient(api_key="k", secret_key="s", passphrase="p")
    fake = MagicMock()
    fake.json.return_value = {"code": "0", "data": [{"totalEq": "100"}]}
    with patch("src.exchange.okx_client.requests.request", return_value=fake):
        data = client.get_balance()
    assert data[0]["totalEq"] == "100"


def test_api_error_raised() -> None:
    client = OKXClient(api_key="k", secret_key="s", passphrase="p")
    fake = MagicMock()
    fake.json.return_value = {"code": "50111", "msg": "Invalid Key"}
    with patch("src.exchange.okx_client.requests.request", return_value=fake):
        try:
            client.get_balance()
            raise AssertionError("expected OKXAPIError")
        except OKXAPIError as exc:
            assert exc.code == "50111"


def test_retry_on_network_error() -> None:
    client = OKXClient(api_key="k", secret_key="s", passphrase="p", max_retries=3)
    import requests

    calls = {"n": 0}

    def flaky(*_a, **_k):
        calls["n"] += 1
        if calls["n"] < 3:
            raise requests.RequestException("boom")
        fake = MagicMock()
        fake.json.return_value = {"code": "0", "data": []}
        return fake

    with patch("src.exchange.okx_client.requests.request", side_effect=flaky):
        with patch("src.exchange.okx_client.time.sleep"):
            data = client.get_balance()
    assert data == []
    assert calls["n"] == 3


def test_place_order_with_stop() -> None:
    client = OKXClient(api_key="k", secret_key="s", passphrase="p")
    captured: dict = {}

    def capture(method, url, headers=None, data=None, timeout=None):
        captured["data"] = data
        fake = MagicMock()
        fake.json.return_value = {"code": "0", "data": [{"ordId": "1"}]}
        return fake

    with patch("src.exchange.okx_client.requests.request", side_effect=capture):
        client.place_order(
            "BTC-USDT-SWAP",
            side="buy",
            ord_type="market",
            sz="1",
            pos_side="long",
            attach_algo_ords=[{"slTriggerPx": "60000", "slOrdPx": "-1"}],
        )
    assert "attachAlgoOrds" in (captured.get("data") or "")
    assert "slTriggerPx" in (captured.get("data") or "")


def main() -> None:
    tests = [
        test_signature_generation,
        test_get_balance_success,
        test_api_error_raised,
        test_retry_on_network_error,
        test_place_order_with_stop,
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
