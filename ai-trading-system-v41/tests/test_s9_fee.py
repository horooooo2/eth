"""S9 trusted-owner OKX taker fee. Fail-closed. No orders."""

from __future__ import annotations

import time

import pytest

from src.runtime.s9_fee import S9FeeClient


def test_fee_success_taker_and_cache():
    calls = {"n": 0}

    def fetcher():
        calls["n"] += 1
        return {
            "ok": True,
            "taker_bps": 2.0,
            "maker_bps": 1.0,
            "source": "okx_account_trade_fee",
            "owner_bound": True,
            "account_environment": "OKX_DEMO",
        }

    now = {"t": 100.0}
    client = S9FeeClient(fetcher=fetcher, ttl_sec=60, now_fn=lambda: now["t"])
    assert client.get_taker_bps() == 2.0
    assert client.snapshot()["ready"] is True
    assert client.last_event == "S9_FEE_READY"
    assert client.get_taker_bps() == 2.0
    assert calls["n"] == 1


def test_cache_expiry_refresh_success_and_failure():
    state = {"ok": True, "n": 0}

    def fetcher():
        state["n"] += 1
        if not state["ok"]:
            raise TimeoutError("fee timeout")
        return {"ok": True, "taker_bps": 1.5, "source": "okx_account_trade_fee"}

    now = {"t": 10.0}
    client = S9FeeClient(fetcher=fetcher, ttl_sec=5, now_fn=lambda: now["t"])
    assert client.get_taker_bps() == 1.5
    now["t"] = 16.0
    state["ok"] = False
    assert client.get_taker_bps() is None
    assert client.snapshot()["reason"] == "S9_COST_DATA_UNAVAILABLE"
    assert client.snapshot()["reason_code"] == "FEE_API_TIMEOUT"
    assert client.last_event == "S9_FEE_UNAVAILABLE"
    assert client.last_reason_code == "FEE_API_TIMEOUT"


@pytest.mark.parametrize(
    "body",
    [
        {"ok": True, "taker_bps": "x"},
        {"ok": False, "taker_bps": 1},
        {"ok": True, "taker_bps": -1},
        {"ok": True, "taker_bps": 0},
        {},
    ],
)
def test_invalid_fee_response(body):
    client = S9FeeClient(fetcher=lambda: body, ttl_sec=60, now_fn=lambda: 1.0)
    assert client.get_taker_bps() is None
    assert client.snapshot()["reason"] == "S9_COST_DATA_UNAVAILABLE"


def test_owner_or_credential_missing():
    def boom():
        raise RuntimeError("owner missing")

    client = S9FeeClient(fetcher=boom, ttl_sec=60, now_fn=time.time)
    assert client.get_taker_bps() is None
    assert client.last_event == "S9_FEE_UNAVAILABLE"
    assert client.last_reason_code == "FEE_API_ERROR"


@pytest.mark.parametrize(
    "code",
    [
        "OWNER_NOT_READY",
        "CREDENTIAL_NOT_FOUND",
        "ACCOUNT_ENV_NOT_READY",
        "FEE_API_TIMEOUT",
        "FEE_API_ERROR",
        "FEE_RESPONSE_INVALID",
    ],
)
def test_fee_failure_subreasons(code):
    from src.runtime.s9_fee import FeeFetchError

    def boom():
        raise FeeFetchError(code, code)

    client = S9FeeClient(fetcher=boom, ttl_sec=60, now_fn=time.time)
    assert client.get_taker_bps() is None
    assert client.snapshot()["reason"] == "S9_COST_DATA_UNAVAILABLE"
    assert client.snapshot()["reason_code"] == code
    assert client.last_reason_code == code
