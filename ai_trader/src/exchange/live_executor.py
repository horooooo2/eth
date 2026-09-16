"""Live OKX execution engine (market + attached stop)."""
from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

from ..paper_execution import ExecutionResult
from ..risk_engine import MarketSnapshot
from ..trade_intent import STATUS_RISK_APPROVED, TradeIntent
from .okx_client import OKXAPIError, OKXClient

logger = logging.getLogger(__name__)


@dataclass
class LiveExecutor:
    """Place real OKX orders for risk-approved intents."""

    client: OKXClient
    inst_id: str = "BTC-USDT-SWAP"
    td_mode: str = "cross"
    poll_attempts: int = 3
    poll_interval_sec: float = 1.0
    timeout_sec: float = 10.0
    _ct_val: float | None = field(default=None, init=False, repr=False)
    _instruments: dict[str, dict[str, Any]] = field(default_factory=dict, init=False, repr=False)

    def _ensure_ct_val(self, inst_id: str | None = None) -> float:
        iid = inst_id or self.inst_id
        if iid in self._instruments and self._instruments[iid].get("ctVal") is not None:
            return float(self._instruments[iid]["ctVal"])
        instruments = self.client.get_instruments("SWAP")
        for row in instruments:
            rid = str(row.get("instId") or "")
            self._instruments[rid] = row
        row = self._instruments.get(iid) or {}
        ct = float(row.get("ctVal") or 0.01)
        self._ct_val = ct
        return ct

    def _contracts_for_notional(self, notional: float, price: float, inst_id: str) -> str:
        ct_val = self._ensure_ct_val(inst_id)
        if price <= 0 or ct_val <= 0:
            raise OKXAPIError("invalid price/ctVal for size calc")
        sz = notional / (price * ct_val)
        # OKX SWAP sizes often allow decimals; keep 2 places
        return f"{max(sz, 0.01):.2f}"

    def execute(self, intent: TradeIntent, market: MarketSnapshot) -> ExecutionResult:
        now = datetime.now(timezone.utc)
        if intent.status != STATUS_RISK_APPROVED:
            return ExecutionResult(
                intent_id=intent.intent_id,
                status="REJECTED",
                entry_price=0.0,
                position_size=0.0,
                notional=0.0,
                margin=0.0,
                fees=0.0,
                slippage_bps=0.0,
                timestamp=now.isoformat(),
                reject_reason="NOT_RISK_APPROVED",
            )

        price = float(market.price)
        leverage = float(intent.leverage or 1.0)
        # Approximate notional from hint risk sizing if present on intent
        margin = float(getattr(intent, "margin", 0) or 0) or (200.0)
        notional = margin * leverage
        side = "buy" if str(intent.direction).upper() in {"LONG", "BUY"} else "sell"
        pos_side = "long" if side == "buy" else "short"
        sz = self._contracts_for_notional(notional, price, self.inst_id)

        stop = float(getattr(intent, "stop_loss", 0) or 0)
        attach: list[dict[str, Any]] = []
        if stop > 0:
            attach.append(
                {
                    "attachAlgoOrds": True,
                    "slTriggerPx": str(round(stop, 2)),
                    "slOrdPx": "-1",  # market
                    "tpTriggerPx": "",
                    "tpOrdPx": "",
                }
            )
            # OKX expects attachAlgoOrds as list of algo objects
            attach = [
                {
                    "slTriggerPx": str(round(stop, 2)),
                    "slOrdPx": "-1",
                }
            ]

        try:
            placed = self.client.place_order(
                self.inst_id,
                side=side,
                ord_type="market",
                sz=sz,
                pos_side=pos_side,
                reduce_only=False,
                attach_algo_ords=attach or None,
                td_mode=self.td_mode,
            )
        except OKXAPIError as exc:
            return ExecutionResult(
                intent_id=intent.intent_id,
                status="REJECTED",
                entry_price=0.0,
                position_size=0.0,
                notional=0.0,
                margin=0.0,
                fees=0.0,
                slippage_bps=0.0,
                timestamp=now.isoformat(),
                reject_reason=str(exc),
            )

        ord_id = str(placed.get("ordId") or "")
        filled = self._wait_fill(ord_id)
        if filled is None:
            try:
                if ord_id:
                    self.client.cancel_order(self.inst_id, ord_id)
            except OKXAPIError:
                pass
            return ExecutionResult(
                intent_id=intent.intent_id,
                status="REJECTED",
                entry_price=0.0,
                position_size=0.0,
                notional=0.0,
                margin=0.0,
                fees=0.0,
                slippage_bps=0.0,
                timestamp=now.isoformat(),
                reject_reason="ORDER_TIMEOUT",
            )

        avg_px = float(filled.get("avgPx") or price)
        acc_sz = float(filled.get("accFillSz") or sz)
        fill_notional = avg_px * acc_sz * self._ensure_ct_val(self.inst_id)
        return ExecutionResult(
            intent_id=intent.intent_id,
            status="FILLED",
            entry_price=avg_px,
            position_size=acc_sz,
            notional=fill_notional,
            margin=fill_notional / leverage if leverage else fill_notional,
            fees=0.0,
            slippage_bps=0.0,
            timestamp=now.isoformat(),
            reject_reason=None,
        )

    def close_position(
        self,
        position: Any,
        reason: str = "MANUAL",
    ) -> ExecutionResult:
        """Reduce-only market close."""
        now = datetime.now(timezone.utc)
        side_raw = str(getattr(position, "side", None) or position.get("side") if isinstance(position, dict) else "LONG")
        is_long = side_raw.upper() in {"LONG", "BUY"}
        side = "sell" if is_long else "buy"
        pos_side = "long" if is_long else "short"
        size = float(
            getattr(position, "position_size", None)
            or (position.get("notional") if isinstance(position, dict) else 0)
            or 0
        )
        # Prefer contracts if present
        sz = str(
            getattr(position, "contracts", None)
            or (position.get("pos") if isinstance(position, dict) else None)
            or max(size, 0.01)
        )
        try:
            placed = self.client.place_order(
                self.inst_id,
                side=side,
                ord_type="market",
                sz=sz,
                pos_side=pos_side,
                reduce_only=True,
                td_mode=self.td_mode,
            )
            ord_id = str(placed.get("ordId") or "")
            filled = self._wait_fill(ord_id) or placed
            avg_px = float(filled.get("avgPx") or 0)
            return ExecutionResult(
                intent_id=str(getattr(position, "position_id", "") or position.get("position_id", "") if isinstance(position, dict) else ""),
                status="FILLED",
                entry_price=avg_px,
                position_size=float(filled.get("accFillSz") or sz),
                notional=0.0,
                margin=0.0,
                fees=0.0,
                slippage_bps=0.0,
                timestamp=now.isoformat(),
                reject_reason=None,
            )
        except OKXAPIError as exc:
            logger.error("close_position failed (%s): %s", reason, exc)
            return ExecutionResult(
                intent_id="",
                status="REJECTED",
                entry_price=0.0,
                position_size=0.0,
                notional=0.0,
                margin=0.0,
                fees=0.0,
                slippage_bps=0.0,
                timestamp=now.isoformat(),
                reject_reason=str(exc),
            )

    def _wait_fill(self, ord_id: str) -> dict[str, Any] | None:
        if not ord_id:
            return None
        deadline = time.time() + self.timeout_sec
        last: dict[str, Any] | None = None
        for attempt in range(self.poll_attempts):
            if time.time() > deadline:
                break
            try:
                order = self.client.get_order(self.inst_id, ord_id)
            except OKXAPIError:
                time.sleep(self.poll_interval_sec)
                continue
            last = order
            state = str(order.get("state") or "")
            if state == "filled":
                return order
            if state in {"canceled", "cancelled"}:
                return None
            # Accept partial fill on final poll attempt
            if state == "partially_filled" and float(order.get("accFillSz") or 0) > 0:
                if attempt >= self.poll_attempts - 1:
                    return order
            time.sleep(self.poll_interval_sec)
        if last and float(last.get("accFillSz") or 0) > 0:
            return last
        try:
            order = self.client.get_order(self.inst_id, ord_id)
            if float(order.get("accFillSz") or 0) > 0:
                return order
        except OKXAPIError:
            pass
        return None
