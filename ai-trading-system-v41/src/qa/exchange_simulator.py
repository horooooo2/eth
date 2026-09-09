"""Deterministic exchange simulator for QA-HFT-SIM only.

Never talks to real OKX. Supports fault injection for pressure tests.
"""

from __future__ import annotations

import math
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional


def _now_ms() -> int:
    return int(time.time() * 1000)


@dataclass
class SimOrder:
    order_intent_id: str
    client_order_id: str
    symbol: str
    side: str
    quantity: float
    reduce_only: bool
    target_notional_usdt: float
    status: str = "NEW"
    filled_quantity: float = 0.0
    average_fill_price: float = 0.0
    exchange_order_id: str = ""
    created_at_ms: int = 0
    ack_at_ms: Optional[int] = None
    test_run_id: str = ""
    cycle_id: int = 0


@dataclass
class ExchangeSimulator:
    mark_price: float = 100_000.0
    lot_size: float = 0.0001
    min_quantity: float = 0.0001
    seed: int = 20260909
    leverage: float = 2.0
    # signed notional: +long / -short, in USDT
    position_notional_usdt: float = 0.0
    orders: Dict[str, SimOrder] = field(default_factory=dict)
    by_client_order_id: Dict[str, str] = field(default_factory=dict)
    executed_intent_ids: set[str] = field(default_factory=set)
    duplicate_orders_executed: int = 0
    orphan_order_count: int = 0
    pending_acks: Dict[str, Dict[str, Any]] = field(default_factory=dict)
    _rng_counter: int = 0

    def reset(self) -> None:
        self.leverage = 2.0
        self.position_notional_usdt = 0.0
        self.orders.clear()
        self.by_client_order_id.clear()
        self.executed_intent_ids.clear()
        self.duplicate_orders_executed = 0
        self.orphan_order_count = 0
        self.pending_acks.clear()
        self._rng_counter = 0

    def snapshot(self) -> Dict[str, Any]:
        return {
            "mark_price": self.mark_price,
            "leverage": self.leverage,
            "position_notional_usdt": self.position_notional_usdt,
            "position_side": self._side_from_notional(),
            "open_orders": [self._order_dict(o) for o in self.orders.values() if o.status in ("NEW", "PARTIAL", "ACK_PENDING")],
            "orders": [self._order_dict(o) for o in self.orders.values()],
            "duplicate_orders_executed": self.duplicate_orders_executed,
            "orphan_order_count": self.orphan_order_count,
        }

    def _side_from_notional(self) -> str:
        if self.position_notional_usdt > 1e-9:
            return "LONG"
        if self.position_notional_usdt < -1e-9:
            return "SHORT"
        return "FLAT"

    def normalize_quantity(self, notional_usdt: float, *, round_up: bool = False) -> float:
        if self.mark_price <= 0:
            return 0.0
        raw = abs(float(notional_usdt)) / self.mark_price
        if round_up:
            steps = math.ceil(raw / self.lot_size - 1e-12)
        else:
            steps = math.floor(raw / self.lot_size + 1e-12)
        qty = max(steps * self.lot_size, 0.0)
        if qty > 0 and qty < self.min_quantity:
            qty = self.min_quantity
        return round(qty, 8)

    def set_leverage(self, leverage: float) -> Dict[str, Any]:
        lev = float(leverage)
        if lev <= 0:
            return {"ok": False, "error": "INVALID_LEVERAGE"}
        self.leverage = lev
        return {"ok": True, "leverage": self.leverage}

    def inject_leverage(self, leverage: float) -> None:
        """Fault injection: set actual leverage without going through set_leverage API semantics."""
        self.leverage = float(leverage)

    def inject_position_notional(self, notional_usdt: float) -> None:
        self.position_notional_usdt = float(notional_usdt)

    def set_price(self, price: float) -> None:
        self.mark_price = float(price)

    def submit_order(self, intent: Dict[str, Any], *, fault: Optional[str] = None) -> Dict[str, Any]:
        order_intent_id = str(intent.get("order_intent_id") or "").strip()
        client_order_id = str(intent.get("client_order_id") or "").strip()
        if not order_intent_id:
            return {"ok": False, "error": "MISSING_ORDER_INTENT_ID"}

        # Idempotency: same intent must not create a second position effect
        if order_intent_id in self.executed_intent_ids or order_intent_id in self.orders:
            existing = self.orders.get(order_intent_id)
            self.duplicate_orders_executed += 0  # received duplicate, but not re-executed
            return {
                "ok": True,
                "idempotent": True,
                "report": self._report_from_order(existing) if existing else {
                    "order_intent_id": order_intent_id,
                    "client_order_id": client_order_id,
                    "status": "FILLED",
                    "idempotent": True,
                },
            }
        if client_order_id and client_order_id in self.by_client_order_id:
            existing_id = self.by_client_order_id[client_order_id]
            existing = self.orders.get(existing_id)
            return {
                "ok": True,
                "idempotent": True,
                "report": self._report_from_order(existing) if existing else None,
            }

        side = str(intent.get("side") or "").lower()
        reduce_only = bool(intent.get("reduce_only"))
        target_notional = float(intent.get("target_notional_usdt") or 0)
        if target_notional <= 0 and intent.get("quantity"):
            target_notional = float(intent["quantity"]) * self.mark_price
        qty = float(intent.get("quantity") or 0) or self.normalize_quantity(
            target_notional, round_up=reduce_only
        )
        if qty <= 0 and target_notional > 0:
            qty = self.normalize_quantity(target_notional, round_up=True)
        if qty <= 0:
            return {"ok": False, "error": "INVALID_QUANTITY"}

        order = SimOrder(
            order_intent_id=order_intent_id,
            client_order_id=client_order_id,
            symbol=str(intent.get("symbol") or "BTC-USDT-SWAP"),
            side=side,
            quantity=qty,
            reduce_only=reduce_only,
            target_notional_usdt=target_notional or qty * self.mark_price,
            exchange_order_id=f"SIM-{uuid.uuid4().hex[:12]}",
            created_at_ms=_now_ms(),
            test_run_id=str(intent.get("test_run_id") or ""),
            cycle_id=int(intent.get("test_cycle_id") or intent.get("cycle_id") or 0),
        )
        self.orders[order_intent_id] = order
        if client_order_id:
            self.by_client_order_id[client_order_id] = order_intent_id

        fill_notional = order.target_notional_usdt

        if fault == "lost_ack":
            order.status = "ACK_PENDING"
            self.pending_acks[order_intent_id] = {"fault": "lost_ack", "intent": dict(intent)}
            # still apply fill silently (exchange accepted) — Node must not double-fill on retry
            self._apply_fill(order, fill_qty=qty, fill_notional=fill_notional, partial=False)
            order.status = "FILLED"
            self.executed_intent_ids.add(order_intent_id)
            return {
                "ok": False,
                "error": "ACK_TIMEOUT",
                "code": "ACK_TIMEOUT",
                "silent_fill": True,
                "order_intent_id": order_intent_id,
                "client_order_id": client_order_id,
            }

        if fault == "delayed_ack":
            order.status = "ACK_PENDING"
            self.pending_acks[order_intent_id] = {"fault": "delayed_ack", "intent": dict(intent)}
            report = self._apply_fill(order, fill_qty=qty, fill_notional=fill_notional, partial=False)
            self.executed_intent_ids.add(order_intent_id)
            return {"ok": True, "delayed": True, "report": report}

        if fault == "partial_fill":
            fill_qty = round(qty * 0.62, 8)
            fill_n = fill_notional * 0.62
            report = self._apply_fill(order, fill_qty=fill_qty, fill_notional=fill_n, partial=True)
            self.executed_intent_ids.add(order_intent_id)
            return {"ok": True, "report": report}

        report = self._apply_fill(order, fill_qty=qty, fill_notional=fill_notional, partial=False)
        self.executed_intent_ids.add(order_intent_id)
        return {"ok": True, "idempotent": False, "report": report}

    def complete_pending_ack(self, order_intent_id: str) -> Dict[str, Any]:
        order = self.orders.get(order_intent_id)
        if not order:
            return {"ok": False, "error": "NOT_FOUND"}
        self.pending_acks.pop(order_intent_id, None)
        return {"ok": True, "report": self._report_from_order(order)}

    def cancel_order(self, order_intent_id: str = "", client_order_id: str = "", *, fault: Optional[str] = None) -> Dict[str, Any]:
        oid = order_intent_id or self.by_client_order_id.get(client_order_id, "")
        order = self.orders.get(oid)
        if fault == "cancel_timeout":
            return {"ok": False, "error": "CANCEL_TIMEOUT", "code": "CANCEL_TIMEOUT"}
        if not order:
            return {"ok": False, "error": "NOT_FOUND"}
        if order.status in ("FILLED", "CANCELLED"):
            return {"ok": True, "report": self._report_from_order(order)}
        # cancel remaining
        remaining = max(order.quantity - order.filled_quantity, 0.0)
        if remaining > 0 and order.status == "PARTIAL":
            order.status = "CANCELLED"
        else:
            order.status = "CANCELLED"
        return {"ok": True, "report": self._report_from_order(order)}

    def fill_remaining(self, order_intent_id: str) -> Dict[str, Any]:
        order = self.orders.get(order_intent_id)
        if not order:
            return {"ok": False, "error": "NOT_FOUND"}
        remaining = max(order.quantity - order.filled_quantity, 0.0)
        if remaining <= 0:
            return {"ok": True, "report": self._report_from_order(order)}
        remaining_notional = max(order.target_notional_usdt - (order.filled_quantity * self.mark_price), 0.0)
        report = self._apply_fill(order, fill_qty=remaining, fill_notional=remaining_notional, partial=False)
        return {"ok": True, "report": report}

    def _apply_fill(
        self,
        order: SimOrder,
        *,
        fill_qty: float,
        partial: bool,
        fill_notional: Optional[float] = None,
    ) -> Dict[str, Any]:
        notional = float(fill_notional) if fill_notional is not None else fill_qty * self.mark_price
        signed = notional if order.side == "buy" else -notional
        if order.reduce_only:
            # reduce toward flat
            if self.position_notional_usdt > 0:
                signed = -abs(notional)
            elif self.position_notional_usdt < 0:
                signed = abs(notional)
            # clamp so we don't flip via reduce-only
            new_pos = self.position_notional_usdt + signed
            if self.position_notional_usdt > 0 and new_pos < 0:
                signed = -self.position_notional_usdt
                notional = abs(signed)
                fill_qty = notional / self.mark_price if self.mark_price else fill_qty
            elif self.position_notional_usdt < 0 and new_pos > 0:
                signed = -self.position_notional_usdt
                notional = abs(signed)
                fill_qty = notional / self.mark_price if self.mark_price else fill_qty

        self.position_notional_usdt += signed
        # snap near-zero
        if abs(self.position_notional_usdt) < 0.01:
            self.position_notional_usdt = 0.0

        order.filled_quantity += fill_qty
        order.average_fill_price = self.mark_price
        order.ack_at_ms = _now_ms()
        order.status = "PARTIAL" if partial or order.filled_quantity + 1e-12 < order.quantity else "FILLED"
        return self._report_from_order(order)

    def _order_dict(self, order: SimOrder) -> Dict[str, Any]:
        return {
            "order_intent_id": order.order_intent_id,
            "client_order_id": order.client_order_id,
            "exchange_order_id": order.exchange_order_id,
            "symbol": order.symbol,
            "side": order.side,
            "quantity": order.quantity,
            "filled_quantity": order.filled_quantity,
            "average_fill_price": order.average_fill_price,
            "reduce_only": order.reduce_only,
            "status": order.status,
            "test_run_id": order.test_run_id,
            "cycle_id": order.cycle_id,
        }

    def _report_from_order(self, order: Optional[SimOrder]) -> Optional[Dict[str, Any]]:
        if not order:
            return None
        return {
            "order_intent_id": order.order_intent_id,
            "client_order_id": order.client_order_id,
            "exchange_order_id": order.exchange_order_id,
            "status": order.status,
            "submitted_at": None,
            "completed_at": None,
            "average_fill_price": order.average_fill_price,
            "filled_quantity": order.filled_quantity,
            "target_notional_usdt": order.target_notional_usdt,
            "position_notional_usdt": self.position_notional_usdt,
            "leverage": self.leverage,
            "test_mode": True,
            "execution_target": "simulator",
            "exclude_from_strategy_health": True,
            "exclude_from_expected_edge": True,
            "exclude_from_live_pnl_stats": True,
            "test_run_id": order.test_run_id,
            "test_cycle_id": order.cycle_id,
        }
