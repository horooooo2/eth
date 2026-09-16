"""Package exports for AI Trader modules."""
from .behavior_classifier import BehaviorClassification, BehaviorClassifier
from .decision_engine import Decision, DecisionEngine
from .paper_execution import ExecutionResult, PaperExecutionEngine
from .person_state import (
    TRAIT_BASELINE,
    TRAIT_BOUNDS,
    EventImpacts,
    PersonState,
    PersonStateEngine,
)
from .position_manager import Position, PositionManager
from .risk_engine import MarketSnapshot, PortfolioState, RiskCheckResult, RiskEngine
from .signal_engine import Signal, SignalEngine, clamp
from .trade_intent import TradeIntent

__all__ = [
    "TRAIT_BASELINE",
    "TRAIT_BOUNDS",
    "EventImpacts",
    "PersonState",
    "PersonStateEngine",
    "BehaviorClassification",
    "BehaviorClassifier",
    "Signal",
    "SignalEngine",
    "Decision",
    "DecisionEngine",
    "clamp",
    "RiskEngine",
    "RiskCheckResult",
    "MarketSnapshot",
    "PortfolioState",
    "TradeIntent",
    "PaperExecutionEngine",
    "ExecutionResult",
    "PositionManager",
    "Position",
]
