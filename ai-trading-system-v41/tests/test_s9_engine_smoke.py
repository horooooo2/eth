"""Engine smoke: load modular config and S9 hub without starting strategies or placing orders."""

from __future__ import annotations

from src.adapters.okx_public_ws import parse_public_message, s9_subscribe_args
from src.runtime.config_loader import load_runtime_config, load_strategy_config
from src.runtime.s9_market_hub import S9MarketHub
from src.runtime.s9_readiness import s9_implementation_readiness
from src.strategies.s9_momentum import S9MomentumStrategy


def test_engine_s9_init_no_orders():
    loaded = load_runtime_config()
    cfg = loaded.effective
    s9 = S9MomentumStrategy(cfg)
    hub = S9MarketHub()
    doc = load_strategy_config("S9")
    assert doc["live_allowed"] is False
    assert s9.cfg.get("enabled", True) is True
    assert s9_subscribe_args()
    assert parse_public_message("pong")["type"] == "pong"
    impl = s9_implementation_readiness()
    assert impl["status"] == "READY"
    assert hub.data_state == "OFF"
    assert hub.connection_state == "DISCONNECTED"
