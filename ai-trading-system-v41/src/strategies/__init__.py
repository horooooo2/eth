"""Strategy modules S1–S9.

Submodules are imported lazily so `from src.strategies.s9_momentum import ...`
does not pull Orchestrator through S1 and create a circular import.
"""

from __future__ import annotations

from typing import Any

__all__ = [
    "S1TrendStrategy",
    "S2ReversalStrategy",
    "S3RegimeStrategy",
    "S4ExecutionStrategy",
    "S5RiskBudgetAllocator",
    "S6AnomalyDetector",
    "S7HealthMonitor",
    "S9MomentumStrategy",
]

_EXPORTS = {
    "S1TrendStrategy": (".s1_trend", "S1TrendStrategy"),
    "S2ReversalStrategy": (".s2_reversal", "S2ReversalStrategy"),
    "S3RegimeStrategy": (".s3_regime", "S3RegimeStrategy"),
    "S4ExecutionStrategy": (".s4_execution", "S4ExecutionStrategy"),
    "S5RiskBudgetAllocator": (".s5_risk_budget", "S5RiskBudgetAllocator"),
    "S6AnomalyDetector": (".s6_anomaly", "S6AnomalyDetector"),
    "S7HealthMonitor": (".s7_health", "S7HealthMonitor"),
    "S9MomentumStrategy": (".s9_momentum", "S9MomentumStrategy"),
}


def __getattr__(name: str) -> Any:
    spec = _EXPORTS.get(name)
    if spec is None:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
    module_name, attr = spec
    from importlib import import_module

    return getattr(import_module(module_name, __name__), attr)
