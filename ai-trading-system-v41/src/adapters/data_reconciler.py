"""Position / order reconciliation between local state and exchange."""

from __future__ import annotations

from typing import Any, Dict, List, Mapping, Optional


class DataReconciler:
    def __init__(self, adapter: Any, config: Optional[Mapping[str, Any]] = None) -> None:
        self.adapter = adapter
        self.config = config or {}
        self.local_positions: List[Dict[str, Any]] = []
        self.local_orders: List[Dict[str, Any]] = []

    def set_local_state(
        self,
        positions: Optional[List[Dict[str, Any]]] = None,
        orders: Optional[List[Dict[str, Any]]] = None,
    ) -> None:
        if positions is not None:
            self.local_positions = list(positions)
        if orders is not None:
            self.local_orders = list(orders)

    def reconcile(self, symbol: Optional[str] = None) -> Dict[str, Any]:
        account = self.adapter.get_account_info()
        remote_positions = account.get("positions") or []
        remote_orders = self.adapter.get_open_orders(symbol)

        def _pos_key(p: Mapping[str, Any]) -> str:
            return str(p.get("symbol") or p.get("instId") or "")

        local_map = {_pos_key(p): p for p in self.local_positions if _pos_key(p)}
        remote_map = {_pos_key(p): p for p in remote_positions if _pos_key(p)}

        mismatched = []
        for sym, lp in local_map.items():
            rp = remote_map.get(sym)
            if rp is None:
                mismatched.append({"symbol": sym, "reason": "missing_remote"})
                continue
            lsz = float(lp.get("size") or lp.get("contracts") or 0)
            rsz = float(rp.get("size") or rp.get("contracts") or rp.get("pos") or 0)
            if abs(lsz - rsz) > 1e-9:
                mismatched.append({"symbol": sym, "reason": "size_mismatch", "local": lsz, "remote": rsz})

        for sym in remote_map:
            if sym and sym not in local_map and abs(float(remote_map[sym].get("size") or remote_map[sym].get("contracts") or remote_map[sym].get("pos") or 0)) > 0:
                # Remote-only open position — treat as mismatch unless local empty intentionally for paper
                if self.local_positions:
                    mismatched.append({"symbol": sym, "reason": "missing_local"})

        local_order_ids = {str(o.get("id")) for o in self.local_orders}
        remote_order_ids = {str(o.get("id")) for o in remote_orders}
        order_mismatch = sorted(local_order_ids.symmetric_difference(remote_order_ids))

        positions_ok = len(mismatched) == 0
        # If both sides empty, reconciled
        if not self.local_positions and not remote_positions:
            positions_ok = True
        orders_ok = len(order_mismatch) == 0 or (not self.local_orders and not remote_orders)

        return {
            "positions_reconciled": positions_ok,
            "orders_reconciled": orders_ok,
            "position_mismatches": mismatched,
            "order_id_diffs": order_mismatch,
            "equity": account.get("equity"),
            "cash": account.get("cash"),
        }
