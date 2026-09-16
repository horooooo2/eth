"""Ambient background-friction event sampler."""
from __future__ import annotations

import random
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Optional


DEFAULT_DESCRIPTIONS = {
    "QUIET_EVENING_ALONE": "晚上一个人坐在电脑前，客厅里没什么声音",
    "NOTICE_SAVINGS_DIP": "打开银行 App，余额又少了一截",
    "SCROLL_JOB_BOARD": "无意识地刷了会儿招聘网站，又关掉了",
    "KID_QUESTION_WHY_HOME": "孩子问：爸爸你怎么又在家？",
    "WIFE_QUIET_SIGH": "李娜晚饭时安静地叹了一口气",
}


@dataclass
class AmbientSampler:
    """Sample 0–2 weighted ambient events per day."""

    config: dict[str, Any]
    card: dict[str, Any]
    _rng: random.Random = field(default_factory=random.Random, init=False)

    def __post_init__(self) -> None:
        ambient_cfg = dict(self.config.get("ambient") or self.config)
        self.sample_range = list(ambient_cfg.get("daily_sample_range") or [0, 2])
        self.weights = dict(ambient_cfg.get("frequency_weights") or {})
        impacts = dict((self.card.get("event_impacts") or {}).get("ambient_events") or {})
        self.pool = impacts
        # Ensure weight keys exist even if card missing some
        for name in list(self.weights.keys()):
            if name not in self.pool:
                self.pool[name] = {"stress": 0.01, "self_doubt": 0.01}

    def sample_today(
        self,
        day: str | None = None,
        random_state: Optional[int] = None,
    ) -> list[dict[str, Any]]:
        if random_state is not None:
            self._rng = random.Random(random_state)
        lo = int(self.sample_range[0]) if self.sample_range else 0
        hi = int(self.sample_range[1]) if len(self.sample_range) > 1 else lo
        if hi < lo:
            lo, hi = hi, lo
        k = self._rng.randint(lo, hi)
        if k <= 0 or not self.pool:
            return []
        names = self._weighted_sample(self.weights or {n: 1.0 for n in self.pool}, k)
        day_str = (day or datetime.now(timezone.utc).date().isoformat())[:10]
        out: list[dict[str, Any]] = []
        for name in names:
            impacts = dict(self.pool.get(name) or {})
            # Strip non-trait metadata
            impacts = {
                kk: float(vv)
                for kk, vv in impacts.items()
                if isinstance(vv, (int, float))
            }
            out.append(
                {
                    "name": name,
                    "impacts": impacts,
                    "timestamp": self._random_timestamp(day_str),
                    "description": str(
                        (self.pool.get(name) or {}).get("description")
                        or DEFAULT_DESCRIPTIONS.get(name)
                        or name
                    ),
                    "date": day_str,
                }
            )
        out.sort(key=lambda e: e["timestamp"])
        return out

    def _weighted_sample(self, pool: dict[str, float], k: int) -> list[str]:
        items = [(n, float(w)) for n, w in pool.items() if float(w) > 0 and n in self.pool]
        if not items:
            items = [(n, 1.0) for n in self.pool]
        chosen: list[str] = []
        remaining = list(items)
        for _ in range(min(k, len(remaining))):
            total = sum(w for _, w in remaining)
            r = self._rng.random() * total
            acc = 0.0
            pick_idx = 0
            for i, (name, w) in enumerate(remaining):
                acc += w
                if r <= acc:
                    pick_idx = i
                    break
            name, _ = remaining.pop(pick_idx)
            chosen.append(name)
        return chosen

    def _random_timestamp(self, day: str) -> str:
        # 08:00–22:00 UTC-ish local narrative window
        minute_of_day = self._rng.randint(8 * 60, 22 * 60 - 1)
        hour, minute = divmod(minute_of_day, 60)
        second = self._rng.randint(0, 59)
        return f"{day}T{hour:02d}:{minute:02d}:{second:02d}Z"
