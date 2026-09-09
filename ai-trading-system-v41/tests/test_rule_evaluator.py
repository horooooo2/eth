"""Tests for RuleEvaluator."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from src.core.data_pool import FeatureDataPool
from src.core.rule_evaluator import RuleEvaluator

ROOT = Path(__file__).resolve().parents[1]
CFG = json.loads((ROOT / "config" / "system_config.json").read_text(encoding="utf-8"))


class _Pool:
    def __init__(self, values):
        self.values = values

    def get(self, name, default=None):
        return self.values.get(name, default)


@pytest.fixture
def evaluator():
    pool = _Pool(
        {
            "close": 110.0,
            "ema20": 100.0,
            "ema50": 90.0,
            "trend_slope_6": 0.5,
            "rsi14": 20.0,
            "S3.regime": "strong_trend",
            "S3.direction_bias": 0.8,
        }
    )
    return RuleEvaluator(CFG, pool)


def test_supported_operators_present():
    ops = CFG["engine_contract"]["expression_language"]["supported_operators"]
    for op in [
        "gt", "gte", "lt", "lte", "eq", "neq", "and", "or", "not",
        "add", "sub", "mul", "div", "abs", "min", "max", "clip", "in", "not_in",
    ]:
        assert op in ops


def test_comparison_and_logic(evaluator):
    node = {
        "logic": "and",
        "conditions": [
            {"lhs": "close", "op": "gt", "rhs": "ema20"},
            {"lhs": "ema20", "op": "gt", "rhs": "ema50"},
            {"lhs": "trend_slope_6", "op": "gt", "rhs": 0.0},
        ],
    }
    assert evaluator.evaluate(node) is True


def test_or_logic(evaluator):
    node = {
        "logic": "or",
        "conditions": [
            {"lhs": "rsi14", "op": "gte", "rhs": 80},
            {"lhs": "rsi14", "op": "lte", "rhs": 25},
        ],
    }
    assert evaluator.evaluate(node) is True


def test_in_operator(evaluator):
    node = {"lhs": "S3.regime", "op": "in", "rhs": ["strong_trend", "weak_trend"]}
    assert evaluator.evaluate(node) is True
    node2 = {"lhs": "S3.regime", "op": "not_in", "rhs": ["panic"]}
    assert evaluator.evaluate(node2) is True


def test_missing_value_fail_closed(evaluator):
    node = {"lhs": "does_not_exist", "op": "gt", "rhs": 1}
    assert evaluator.evaluate(node) is False


def test_unary_not(evaluator):
    node = {"op": "not", "condition": {"lhs": "close", "op": "lt", "rhs": 0}}
    assert evaluator.evaluate(node) is True


def test_arithmetic_ops(evaluator):
    add = {"op": "add", "lhs": 2, "rhs": 3}
    assert evaluator.evaluate(add) == 5.0
    mul = {"op": "mul", "lhs": "close", "rhs": 2}
    assert evaluator.evaluate(mul) == 220.0
    abs_node = {"op": "abs", "arg": -4}
    assert evaluator.evaluate(abs_node) == 4.0
    clip = {"op": "clip", "value": 2, "min": 0, "max": 1}
    assert evaluator.evaluate(clip) == 1.0


def test_abs_feature_string(evaluator):
    pool = _Pool({"return_1m": -0.02})
    ev = RuleEvaluator(CFG, pool)
    assert ev.evaluate({"lhs": "abs(return_1m)", "op": "gte", "rhs": 0.01}) is True


def test_with_feature_data_pool():
    import numpy as np
    import pandas as pd

    n = 300
    close = np.cumsum(np.random.default_rng(0).normal(0, 1, n)) + 1000
    df = pd.DataFrame(
        {
            "open": close,
            "high": close + 1,
            "low": close - 1,
            "close": close,
            "volume": np.ones(n) * 10,
        }
    )
    pool = FeatureDataPool(CFG)
    pool.update_from_bars(df)
    ev = RuleEvaluator(CFG, pool)
    assert pool.get("ema20") is not None
    assert pool.get("atr14") is not None
    assert isinstance(ev.evaluate({"lhs": "close", "op": "gt", "rhs": 0}), bool)
