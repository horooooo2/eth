"""S9 three-status readiness. Validation stays UNVERIFIED."""

from __future__ import annotations

from src.runtime.demo_execute_v1 import DEMO_EXECUTE_V1_ALLOWED
from src.runtime.s9_readiness import (
    CORE_EXECUTE_READINESS,
    DEMO_EXECUTE_V1_READINESS,
    s9_demo_preflight_readiness,
    s9_demo_validation_status,
    s9_implementation_readiness,
    s9_status_bundle,
)


def test_missing_capabilities_not_ready():
    for key in ("public_websocket", "fee_from_okx_account", "node_presubmit_book"):
        out = s9_implementation_readiness(adapters={key: False})
        assert out["status"] == "NOT_READY"
        assert key in out["blockers"]


def test_wired_implementation_ready_validation_unverified():
    impl = s9_implementation_readiness()
    assert impl["status"] == "READY", impl
    val = s9_demo_validation_status()
    assert val["status"] == "UNVERIFIED"
    assert s9_demo_validation_status(persisted=None)["status"] == "UNVERIFIED"
    bundle = s9_status_bundle()
    assert bundle["CORE_EXECUTE_READINESS"] == "READY"
    assert bundle["DEMO_EXECUTE_V1_READINESS"] == "READY"
    assert bundle["S9_DEMO_VALIDATION_STATUS"] == "UNVERIFIED"
    assert DEMO_EXECUTE_V1_ALLOWED["S9"] is False
    assert CORE_EXECUTE_READINESS == "READY"
    assert DEMO_EXECUTE_V1_READINESS == "READY"


def test_preflight_ready_without_live_fill():
    rt = {
        "account_environment": "OKX_DEMO",
        "live_allowed": False,
        "live_permission": False,
        "trusted_owner_ready": True,
        "s6_level": 0,
        "reconciliation_status": "MATCHED",
        "ownership_clear": True,
        "data_state": "READY",
        "fee_ready": True,
        "demo_allowed": True,
    }
    out = s9_demo_preflight_readiness(runtime=rt)
    assert out["status"] == "READY"
    assert "live_demo_fill_verified" not in out["checks"]
    bad = s9_demo_preflight_readiness(runtime={**rt, "fee_ready": False})
    assert bad["status"] == "NOT_READY"
    assert "fee_ready" in bad["blockers"]
    live = s9_demo_preflight_readiness(runtime={**rt, "live_permission": True})
    assert live["status"] == "NOT_READY"
