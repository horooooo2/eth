"""Read-only strategy config view — no filesystem writes."""

from __future__ import annotations

from src.runtime.strategy_config_view import (
    config_hash,
    extract_section,
    get_strategy_config,
    list_strategy_configs,
    redact_secrets,
)


class _RT:
    def __init__(self, cfg, state="RUNNING", active="S1"):
        self.state = state
        self.active_strategy = active
        self.config_path = "system.json"
        self.config_source_kind = "MODULAR_JSON"
        self.config_status = "OK"
        self.orchestrator = type("O", (), {"config": cfg})()


def test_unknown_id_none():
    assert get_strategy_config(_RT({}), "S99") is None


def test_hash_stable_and_canonical():
    a = {"z": 1, "a": {"b": 2}}
    b = {"a": {"b": 2}, "z": 1}
    assert config_hash(a) == config_hash(b)
    assert len(config_hash(a)) == 64


def test_redact_secrets():
    out = redact_secrets({"risk_per_trade_pct_equity": 0.004, "api_key": "x", "nested": {"passphrase": "y"}})
    assert out["api_key"] == "[REDACTED]"
    assert out["nested"]["passphrase"] == "[REDACTED]"
    assert out["risk_per_trade_pct_equity"] == 0.004


def test_s8_has_no_section():
    assert extract_section({"S1_trend": {}}, "S8") is None


def test_list_and_get_s1():
    cfg = {"S1_trend": {"risk_per_trade_pct_equity": 0.004}, "S5_risk_budget": {"enabled": True}, "global_risk": {}}
    rt = _RT(cfg)
    listing = list_strategy_configs(rt)
    assert listing["source_kind"] == "MODULAR_JSON"
    assert listing["config_path"].startswith("config/")
    one = get_strategy_config(rt, "S1")
    assert one["id"] == "S1"
    assert one["effective_config"]["risk_per_trade_pct_equity"] == 0.004
    assert one["config_path"] == "config/system.json"
    assert one["live_allowed"] is True
    assert "live_permission" in one


def test_live_allowed_not_and_permission(monkeypatch):
    monkeypatch.setenv("V41_LIVE_TRADING_ENABLED", "false")
    cfg = {"S1_trend": {"risk_per_trade_pct_equity": 0.004}}
    one = get_strategy_config(_RT(cfg), "S1")
    assert one["live_allowed"] is True
    assert one["live_permission"] is False
    s8 = get_strategy_config(_RT(cfg), "S8")
    assert s8["live_allowed"] is False
    assert s8["live_permission"] is False
