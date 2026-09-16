"""API tests with FastAPI TestClient (no live server)."""
from __future__ import annotations

import sys
import tempfile
import time
import traceback
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from fastapi.testclient import TestClient

from src.api.server import create_app
from src.replay import generate_sample_ohlcv
from src.replay_with_narrator import replay_with_narrator

CONFIG = ROOT / "config"
_TMP = Path(tempfile.mkdtemp())
_DB = _TMP / "api_test.db"
_BARS = generate_sample_ohlcv(_TMP / "ohlcv.json", n=260, seed=21)
replay_with_narrator(_BARS, CONFIG, _DB, use_mock=True)
_APP = create_app(_DB)
client = TestClient(_APP)


def test_get_account() -> None:
    r = client.get("/api/account")
    assert r.status_code == 200
    data = r.json()
    assert "equity" in data
    assert "available" in data
    assert "today_pnl" in data


def test_get_state() -> None:
    r = client.get("/api/state")
    assert r.status_code == 200
    data = r.json()
    for key in (
        "mood",
        "mood_label",
        "risk_appetite",
        "patience",
        "focus",
        "self_doubt",
        "stubbornness",
        "stress",
        "sleep_debt",
        "primary_mode",
        "modifiers",
        "mode_label",
        "last_updated",
    ):
        assert key in data


def test_get_character() -> None:
    r = client.get("/api/character")
    assert r.status_code == 200
    data = r.json()
    # No imported card yet → empty placeholders for UI
    assert data.get("available") is False
    assert data["name"] in ("", None)
    assert len(data["traits"]) == 5


def test_get_positions_current_and_history() -> None:
    r = client.get("/api/positions")
    assert r.status_code == 200
    data = r.json()
    assert "current" in data
    assert "history" in data
    assert "summary" in data
    assert isinstance(data["current"], list)
    assert isinstance(data["history"], list)


def test_get_timeline() -> None:
    r = client.get("/api/timeline?limit=50")
    assert r.status_code == 200
    data = r.json()
    assert data["total"] >= 10
    assert len(data["entries"]) >= 10


def test_get_timeline_with_limit() -> None:
    r = client.get("/api/timeline?limit=5&offset=0")
    assert r.status_code == 200
    data = r.json()
    assert len(data["entries"]) == 5
    assert data["has_more"] is True


def test_get_timeline_type_filter() -> None:
    r = client.get("/api/timeline?type=psych&limit=100")
    assert r.status_code == 200
    data = r.json()
    assert data["entries"]
    assert all(e["type"] == "psych" for e in data["entries"])


def test_get_decision_detail() -> None:
    row = _APP.state.db.execute(
        "SELECT decision_id FROM decision_log LIMIT 1"
    ).fetchone()
    assert row is not None
    did = row["decision_id"]
    r = client.get(f"/api/decisions/{did}")
    assert r.status_code == 200
    data = r.json()
    assert data["decision_id"] == did
    assert "signal" in data
    assert "behavior" in data
    assert "decision_reason" in data


def test_404_for_missing_decision() -> None:
    r = client.get("/api/decisions/does-not-exist")
    assert r.status_code == 404


def test_api_latency_under_200ms() -> None:
    paths = ["/api/account", "/api/state", "/api/character", "/api/positions", "/api/timeline"]
    for path in paths:
        t0 = time.perf_counter()
        r = client.get(path)
        ms = (time.perf_counter() - t0) * 1000
        assert r.status_code == 200
        assert ms < 200, f"{path} took {ms:.1f}ms"


def main() -> None:
    tests = [
        test_get_account,
        test_get_state,
        test_get_character,
        test_get_positions_current_and_history,
        test_get_timeline,
        test_get_timeline_with_limit,
        test_get_timeline_type_filter,
        test_get_decision_detail,
        test_404_for_missing_decision,
        test_api_latency_under_200ms,
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
