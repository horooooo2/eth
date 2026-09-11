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


def _swr_client(state, now, *, ttl_sec=5, hard_expiry_sec=25):
    def fetcher():
        state["n"] += 1
        if not state["ok"]:
            raise TimeoutError("fee timeout")
        return {"ok": True, "taker_bps": state["bps"], "source": "okx_account_trade_fee"}

    return S9FeeClient(
        fetcher=fetcher,
        ttl_sec=ttl_sec,
        hard_expiry_sec=hard_expiry_sec,
        now_fn=lambda: now["t"],
    )


def test_soft_ttl_keeps_fee_ready_while_refresh_in_flight():
    """TTL expiry alone must not flip fee_ready — that caused the 60s DEGRADED flap."""
    state = {"ok": True, "n": 0, "bps": 1.5}
    now = {"t": 10.0}
    client = _swr_client(state, now)
    assert client.get_taker_bps() == 1.5
    assert client.snapshot()["ready"] is True
    assert client.snapshot()["stale"] is False

    # Soft TTL elapsed, no refresh performed yet: still ready, now marked stale.
    now["t"] = 16.0
    snap = client.snapshot()
    assert client._soft_expired() is True
    assert snap["ready"] is True
    assert snap["stale"] is True
    assert snap["reason"] is None
    assert snap["fee_age"] == 6.0


def test_refresh_success_replaces_value():
    state = {"ok": True, "n": 0, "bps": 1.5}
    now = {"t": 10.0}
    client = _swr_client(state, now)
    assert client.get_taker_bps() == 1.5
    now["t"] = 16.0
    state["bps"] = 2.25
    assert client.get_taker_bps() == 2.25
    snap = client.snapshot()
    assert snap["ready"] is True
    assert snap["stale"] is False
    assert snap["taker_bps"] == 2.25
    assert snap["fee_refresh_error"] is None
    assert state["n"] == 2


def test_transient_refresh_failure_keeps_last_known_good():
    state = {"ok": True, "n": 0, "bps": 1.5}
    now = {"t": 10.0}
    client = _swr_client(state, now)
    assert client.get_taker_bps() == 1.5

    now["t"] = 16.0
    state["ok"] = False
    assert client.get_taker_bps() == 1.5
    snap = client.snapshot()
    assert snap["ready"] is True
    assert snap["stale"] is True
    assert snap["reason"] is None
    assert snap["fee_refresh_error"] == "FEE_API_TIMEOUT"
    assert snap["fee_refresh_error_at"] == 16.0
    assert snap["last_success_at_epoch"] == 10.0
    assert snap["fee_age"] == 6.0
    # No misleading unavailable event while the fee is still usable.
    assert client.last_event == "S9_FEE_READY"

    # Recovery re-arms the cache and clears the error.
    now["t"] = 22.0
    state["ok"] = True
    state["bps"] = 1.75
    assert client.get_taker_bps() == 1.75
    assert client.snapshot()["fee_refresh_error"] is None


def test_hard_expiry_fails_closed():
    state = {"ok": True, "n": 0, "bps": 1.5}
    now = {"t": 10.0}
    client = _swr_client(state, now)
    assert client.get_taker_bps() == 1.5

    state["ok"] = False
    # Still inside hard expiry (25s): usable.
    now["t"] = 30.0
    assert client.get_taker_bps() == 1.5
    assert client.snapshot()["ready"] is True

    # Past hard expiry: unusable, fail closed.
    now["t"] = 40.0
    assert client.get_taker_bps() is None
    snap = client.snapshot()
    assert snap["ready"] is False
    assert snap["reason"] == "S9_COST_DATA_UNAVAILABLE"
    assert snap["reason_code"] == "FEE_API_TIMEOUT"
    assert client.last_event == "S9_FEE_UNAVAILABLE"


def test_hard_expiry_without_refresh_attempt_is_not_ready():
    """Readiness must lapse on age alone, even if nobody called refresh."""
    state = {"ok": True, "n": 0, "bps": 1.5}
    now = {"t": 10.0}
    client = _swr_client(state, now)
    assert client.get_taker_bps() == 1.5
    now["t"] = 100.0
    snap = client.snapshot()
    assert snap["ready"] is False
    assert snap["reason_code"] == "FEE_CACHE_HARD_EXPIRED"


def test_first_start_without_fee_is_not_ready():
    state = {"ok": False, "n": 0, "bps": 1.5}
    now = {"t": 10.0}
    client = _swr_client(state, now)
    assert client.get_taker_bps() is None
    snap = client.snapshot()
    assert snap["ready"] is False
    assert snap["taker_bps"] is None
    assert snap["last_success_at_epoch"] is None
    assert snap["reason"] == "S9_COST_DATA_UNAVAILABLE"
    assert snap["reason_code"] == "FEE_API_TIMEOUT"
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
