"""Deterministic expression / rule evaluator (fail-closed on missing values)."""

from __future__ import annotations

import math
import re
from typing import Any, Dict, List, Mapping, MutableMapping, Optional, Union

Number = Union[int, float, bool]
EvalResult = Union[bool, float, int]

_ABS_CALL_RE = re.compile(r"^abs\((.+)\)$", re.IGNORECASE)
_EPS = 1e-12


class RuleEvaluator:
    """Evaluate config condition trees against a FeatureDataPool + optional context."""

    def __init__(self, config: Mapping[str, Any], data_pool: Any) -> None:
        self.config = config
        self.data_pool = data_pool
        expr = (
            config.get("engine_contract", {})
            .get("expression_language", {})
        )
        self.supported_ops = set(expr.get("supported_operators", []))
        self.missing_policy = expr.get("missing_value_policy", "fail_closed")

    def evaluate(
        self,
        node: Any,
        context: Optional[MutableMapping[str, Any]] = None,
    ) -> EvalResult:
        ctx = context if context is not None else {}
        try:
            return self._eval(node, ctx)
        except Exception:
            if self.missing_policy == "fail_closed":
                return False
            raise

    def explain_failures(
        self,
        node: Any,
        context: Optional[MutableMapping[str, Any]] = None,
    ) -> List[Dict[str, Any]]:
        """List failed leaf conditions. Does not change evaluate() semantics."""
        ctx = context if context is not None else {}
        failed: List[Dict[str, Any]] = []
        self._collect_failures(node, ctx, failed)
        return failed

    def _eval(self, node: Any, ctx: MutableMapping[str, Any]) -> EvalResult:
        if node is None:
            return False if self.missing_policy == "fail_closed" else False

        if isinstance(node, bool):
            return node
        if isinstance(node, (int, float)):
            if isinstance(node, float) and (math.isnan(node) or math.isinf(node)):
                return False
            return float(node)
        if isinstance(node, str):
            return self._resolve_value(node, ctx)

        if isinstance(node, list):
            return [self._eval(x, ctx) for x in node]  # type: ignore[return-value]

        if not isinstance(node, dict):
            return False

        # Unary not wrappers
        if "not" in node and "op" not in node and "logic" not in node:
            inner = node["not"]
            if "condition" in node:
                inner = node["condition"]
            return not bool(self._eval(inner, ctx))

        if node.get("op") == "not" or (
            "condition" in node and node.get("op") is None and "logic" not in node and "lhs" not in node
        ):
            cond = node.get("condition") or node.get("arg") or node.get("value")
            return not bool(self._eval(cond, ctx))

        # Nested logic groups
        if "logic" in node:
            logic = str(node["logic"]).lower()
            conditions = node.get("conditions") or []
            if logic == "and":
                if not conditions:
                    return False
                return all(bool(self._eval(c, ctx)) for c in conditions)
            if logic == "or":
                if not conditions:
                    return False
                return any(bool(self._eval(c, ctx)) for c in conditions)
            if logic == "not":
                if not conditions:
                    return False
                return not bool(self._eval(conditions[0], ctx))
            return False

        op = node.get("op")
        if op is None:
            return False
        op = str(op).lower()
        if self.supported_ops and op not in self.supported_ops:
            return False

        # Unary arithmetic
        if op == "abs":
            arg = node.get("arg", node.get("lhs", node.get("value")))
            v = self._as_number(self._eval(arg, ctx))
            if v is None:
                return False
            return abs(v)

        if op == "clip":
            val = self._as_number(self._eval(node.get("value", node.get("lhs")), ctx))
            lo = self._as_number(self._eval(node.get("min", node.get("low", 0)), ctx))
            hi = self._as_number(self._eval(node.get("max", node.get("high", 1)), ctx))
            if val is None or lo is None or hi is None:
                return False
            return max(lo, min(hi, val))

        # Binary / n-ary ops with lhs/rhs
        lhs_raw = node.get("lhs", node.get("left", node.get("a")))
        rhs_raw = node.get("rhs", node.get("right", node.get("b")))

        if op in {"min", "max"}:
            args = node.get("args") or node.get("values")
            if args is None:
                args = [lhs_raw, rhs_raw]
            nums = []
            for a in args:
                n = self._as_number(self._eval(a, ctx) if not isinstance(a, (int, float, bool)) else a)
                if n is None:
                    return False
                nums.append(n)
            return min(nums) if op == "min" else max(nums)

        if op in {"add", "sub", "mul", "div"}:
            left = self._as_number(self._resolve_operand(lhs_raw, ctx))
            right = self._as_number(self._resolve_operand(rhs_raw, ctx))
            if left is None or right is None:
                return False
            if op == "add":
                return left + right
            if op == "sub":
                return left - right
            if op == "mul":
                return left * right
            if abs(right) < _EPS:
                return False
            return left / right

        # Comparisons / membership
        left = self._resolve_operand(lhs_raw, ctx)
        if left is None and not isinstance(left, bool):
            # distinguish missing vs False
            if lhs_raw is not None and self._is_missing(lhs_raw, ctx):
                return False

        if op in {"in", "not_in"}:
            right = rhs_raw
            if isinstance(right, dict):
                right = self._eval(right, ctx)
            elif isinstance(right, str):
                # feature name that resolves to a list, or literal list via context
                resolved = self._resolve_value(right, ctx)
                right = resolved if isinstance(resolved, (list, tuple, set)) else right
            if not isinstance(right, (list, tuple, set)):
                return False
            if left is None and not isinstance(left, (int, float, bool, str)):
                return False
            contained = left in list(right)
            return contained if op == "in" else not contained

        right = self._resolve_operand(rhs_raw, ctx)
        if self._value_missing(left) or self._value_missing(right):
            return False

        if op == "gt":
            return float(left) > float(right)  # type: ignore[arg-type]
        if op == "gte":
            return float(left) >= float(right)  # type: ignore[arg-type]
        if op == "lt":
            return float(left) < float(right)  # type: ignore[arg-type]
        if op == "lte":
            return float(left) <= float(right)  # type: ignore[arg-type]
        if op == "eq":
            return left == right
        if op == "neq":
            return left != right
        return False

    def _collect_failures(
        self,
        node: Any,
        ctx: MutableMapping[str, Any],
        out: List[Dict[str, Any]],
    ) -> None:
        if not isinstance(node, dict):
            return
        if "logic" in node:
            for cond in node.get("conditions") or []:
                if not bool(self.evaluate(cond, ctx)):
                    self._collect_failures(cond, ctx, out)
            return
        if node.get("lhs") is None:
            return
        if bool(self.evaluate(node, ctx)):
            return
        lhs = str(node.get("lhs"))
        out.append(
            {
                "lhs": lhs,
                "op": node.get("op"),
                "rhs": node.get("rhs"),
                "lhs_value": self._resolve_operand(node.get("lhs"), ctx),
                "rhs_value": self._resolve_operand(node.get("rhs"), ctx)
                if node.get("op") not in {"in", "not_in"}
                else node.get("rhs"),
            }
        )

    def _resolve_operand(self, raw: Any, ctx: MutableMapping[str, Any]) -> Any:
        if raw is None:
            return None
        if isinstance(raw, (int, float, bool)):
            return raw
        if isinstance(raw, list):
            return raw
        if isinstance(raw, dict):
            return self._eval(raw, ctx)
        if isinstance(raw, str):
            return self._resolve_value(raw, ctx)
        return raw

    def _resolve_value(self, name: str, ctx: MutableMapping[str, Any]) -> Any:
        m = _ABS_CALL_RE.match(name.strip())
        if m:
            inner = self._resolve_value(m.group(1).strip(), ctx)
            if self._value_missing(inner):
                return None
            try:
                return abs(float(inner))
            except (TypeError, ValueError):
                return None

        # Nested context keys: S3.regime, trade_intent.status
        if name in ctx:
            return ctx[name]
        if "." in name:
            parts = name.split(".")
            cur: Any = ctx
            ok = True
            for p in parts:
                if isinstance(cur, Mapping) and p in cur:
                    cur = cur[p]
                else:
                    ok = False
                    break
            if ok:
                return cur
            # also try dotted key on data_pool
            if hasattr(self.data_pool, "get"):
                v = self.data_pool.get(name)
                if v is not None:
                    return v

        if hasattr(self.data_pool, "get"):
            v = self.data_pool.get(name)
            if v is not None:
                return v

        # strategy_policy.expiry_seconds style paths into config
        if name.startswith("strategy_policy.") and "strategy_id" in ctx:
            sid = ctx["strategy_id"]
            policy = (
                self.config.get("signal_lifecycle", {})
                .get("strategy_policy", {})
                .get(sid, {})
            )
            key = name.split(".", 1)[1]
            if key in policy:
                return policy[key]

        return None

    def _is_missing(self, raw: Any, ctx: MutableMapping[str, Any]) -> bool:
        if isinstance(raw, (int, float, bool, list)):
            return False
        if isinstance(raw, dict):
            return False
        if isinstance(raw, str):
            return self._value_missing(self._resolve_value(raw, ctx))
        return True

    @staticmethod
    def _value_missing(v: Any) -> bool:
        if v is None:
            return True
        if isinstance(v, float) and (math.isnan(v) or math.isinf(v)):
            return True
        return False

    @staticmethod
    def _as_number(v: Any) -> Optional[float]:
        if v is None:
            return None
        if isinstance(v, bool):
            return float(v)
        if isinstance(v, (int, float)):
            if isinstance(v, float) and (math.isnan(v) or math.isinf(v)):
                return None
            return float(v)
        try:
            return float(v)
        except (TypeError, ValueError):
            return None
