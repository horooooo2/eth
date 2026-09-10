"""Selectable vs research alpha IDs. Not a plugin framework."""

SELECTABLE_ALPHAS = ("S1", "S2", "S9")
RESEARCH_ALPHAS = ("S8",)
IMPLEMENTED_ALPHAS = ("S1", "S2", "S9")


def is_selectable_alpha(strategy_id: str) -> bool:
    return str(strategy_id or "").strip().upper() in SELECTABLE_ALPHAS


def coerce_selectable(strategy_id: str, default: str = "S1") -> str:
    sid = str(strategy_id or "").strip().upper()
    return sid if sid in SELECTABLE_ALPHAS else default
