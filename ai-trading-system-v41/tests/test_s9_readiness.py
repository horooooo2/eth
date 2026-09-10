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
    for key in (
        "public_ws_capability",
        "fee_capability",
        "node_presubmit_capability",
        "public_websocket",
        "fee_from_okx_account",
        "node_presubmit_book",
    ):
        out = s9_implementation_readiness(adapters={key: False})
        assert out["status"] == "NOT_READY"
        assert any(k in out["blockers"] for k in (key, {
            "public_websocket": "public_ws_capability",
            "fee_from_okx_account": "fee_capability",
            "node_presubmit_book": "node_presubmit_capability",
        }.get(key, key)))


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


def test_implementation_ready_preflight_not_when_runtime_blocked():
    impl = s9_implementation_readiness()
    assert impl["status"] == "READY"
    assert impl["detection"] == "capability_registration"
    for key in (
        "public_ws_capability",
        "fee_capability",
        "node_presubmit_capability",
        "protective_stop_capability",
        "active_exit_capability",
    ):
        assert impl["checks"][key] is True
    rt = {
        "account_environment": "OKX_DEMO",
        "live_allowed": False,
        "live_permission": False,
        "trusted_owner_ready": True,
        "s6_level": 0,
        "reconciliation_status": "MATCHED",
        "ownership_clear": True,
        "data_state": "OFF",
        "fee_ready": False,
        "recovery_status": "FAILED",
        "demo_allowed": True,
    }
    pre = s9_demo_preflight_readiness(runtime=rt)
    assert pre["status"] == "NOT_READY"
    assert "fee_ready" in pre["blockers"]
    assert "market_data_ready" in pre["blockers"]
    assert "recovery_ready" in pre["blockers"]


def test_readiness_does_not_use_absolute_deploy_paths():
    from pathlib import Path

    src = Path(__file__).resolve().parents[1] / "src" / "runtime" / "s9_readiness.py"
    text = src.read_text(encoding="utf-8")
    assert "/root/whale-tracker-backend" not in text
    assert "/root/whale-tracker-deploy" not in text
    assert "_backend_file" not in text
    assert "_backend_roots" not in text
    assert "whale-tracker-deploy" not in text
    fake_missing = s9_implementation_readiness()
    assert fake_missing["status"] == "READY"
