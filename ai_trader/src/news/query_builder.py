"""Rule-based search query builder (no LLM)."""
from __future__ import annotations

import random
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any


@dataclass
class QueryBuilder:
    news_behavior_config: dict[str, Any]
    random_seed: int | None = None
    _rng: random.Random = field(init=False, repr=False)

    def __post_init__(self) -> None:
        self._rng = random.Random(self.random_seed)

    def _queries_map(self) -> dict[str, list[str]]:
        raw = (self.news_behavior_config or {}).get("search_queries_by_context") or {}
        out: dict[str, list[str]] = {}
        for key, vals in raw.items():
            if isinstance(vals, list):
                cleaned = [str(v).strip() for v in vals if str(v).strip()]
                if cleaned:
                    out[str(key)] = cleaned
        return out

    def build(
        self,
        context_tags: list[str],
        state: dict[str, Any] | None = None,
        current_time: datetime | None = None,
    ) -> str:
        queries = self._queries_map()
        candidates: list[str] = []
        for tag in context_tags or []:
            if tag in queries:
                candidates.extend(queries[tag])
        if not candidates:
            candidates = list(queries.get("no_position_watching") or ["加密市场 今日动态"])
        chosen = self._rng.choice(candidates)
        # Light time hint if missing
        if current_time is not None and "今日" not in chosen and "今天" not in chosen and "最新" not in chosen:
            chosen = f"{chosen} 最新"
        return chosen

    def build_multi(
        self,
        context_tags: list[str],
        count: int = 2,
    ) -> list[str]:
        queries = self._queries_map()
        pool: list[str] = []
        for tag in context_tags or []:
            if tag in queries:
                pool.extend(queries[tag])
        if not pool:
            pool = list(queries.get("no_position_watching") or ["加密市场 今日动态"])
        # unique preserve order
        seen: set[str] = set()
        uniq: list[str] = []
        for q in pool:
            if q not in seen:
                seen.add(q)
                uniq.append(q)
        self._rng.shuffle(uniq)
        n = max(1, int(count))
        return uniq[:n]
