"""Deadline day-90 LLM (or mock) evaluation."""
from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from typing import Any, Optional

from .state import DeadlineState, DeadlineStateManager

logger = logging.getLogger(__name__)


@dataclass
class DeadlineEvaluator:
    """Run end-of-deadline evaluation via narrator / mock."""

    config: dict[str, Any]
    narrator: Any
    db_repos: dict[str, Any]
    deadline_manager: DeadlineStateManager | None = None

    def evaluate(
        self,
        deadline_state: DeadlineState,
        stats: dict[str, Any],
        state_snapshot: dict[str, Any],
        starting_baseline: dict[str, Any],
        current_baseline: dict[str, Any],
        today: str | None = None,
    ) -> dict[str, Any]:
        system, user = self._build_evaluation_prompt(
            stats, state_snapshot, starting_baseline, current_baseline, deadline_state
        )
        result: dict[str, Any]
        try:
            raw = self._call_llm(system, user)
            result = self._parse_result(raw)
        except Exception as exc:  # noqa: BLE001
            logger.warning("deadline evaluation failed, default CONTINUE: %s", exc)
            result = {
                "action": "CONTINUE",
                "reason": "评估失败，默认继续观察 7 天",
                "new_deadline_days": None,
                "narrative": {
                    "psychology": {
                        "text": "先再撑几天看看吧。",
                        "mood": "anxious",
                        "mood_label": "焦虑",
                    }
                },
            }
        if today:
            result["as_of"] = str(today)[:10]
        self._apply_decision(result, deadline_state)
        return result

    def _call_llm(self, system: str, user: str) -> str:
        narrator = self.narrator
        if narrator is None:
            return json.dumps(
                {
                    "action": "CONTINUE",
                    "reason": "无旁白客户端，默认继续",
                    "new_deadline_days": None,
                    "narrative": {
                        "psychology": {
                            "text": "再看看。",
                            "mood": "calm",
                            "mood_label": "平静",
                        }
                    },
                },
                ensure_ascii=False,
            )
        # Prefer dedicated method if present
        if hasattr(narrator, "narrate_deadline_evaluation"):
            out = narrator.narrate_deadline_evaluation({"system": system, "user": user})
            if isinstance(out, dict):
                return json.dumps(out, ensure_ascii=False)
            if hasattr(out, "raw") and out.raw:
                return str(out.raw)
            # NarrativeResult-like
            return json.dumps(
                {
                    "action": "CONTINUE",
                    "reason": getattr(out, "psychology_text", "") or "继续",
                    "new_deadline_days": None,
                    "narrative": {
                        "psychology": {
                            "text": getattr(out, "psychology_text", ""),
                            "mood": getattr(out, "mood", "calm"),
                            "mood_label": getattr(out, "mood_label", "平静"),
                        }
                    },
                },
                ensure_ascii=False,
            )
        # MockLLMClient / real client path
        client = getattr(narrator, "llm_client", None)
        if client is not None and hasattr(client, "complete"):
            out = client.complete(system, user)
            if isinstance(out, dict):
                return json.dumps(out, ensure_ascii=False)
            return str(out)
        return json.dumps(
            {
                "action": "EXTEND",
                "reason": "这三个月证明了方法可行，也暴露了压力下的弱点。我想再给自己一次机会。",
                "new_deadline_days": 90,
                "narrative": {
                    "psychology": {
                        "text": "再给我一次机会。",
                        "mood": "confident",
                        "mood_label": "自信",
                    }
                },
            },
            ensure_ascii=False,
        )

    def _parse_result(self, raw: str) -> dict[str, Any]:
        text = raw.strip()
        if text.startswith("```"):
            text = text.strip("`")
            if text.startswith("json"):
                text = text[4:].strip()
        data = json.loads(text)
        action = str(data.get("action") or "CONTINUE").upper()
        allowed = set((self.config.get("evaluation") or {}).get("allowed_actions") or [])
        if allowed and action not in allowed:
            action = "CONTINUE"
        days = data.get("new_deadline_days")
        if action == "EXTEND" and days is None:
            opts = list((self.config.get("evaluation") or {}).get("extend_options_days") or [30])
            days = opts[-1] if opts else 30
        return {
            "action": action,
            "reason": str(data.get("reason") or ""),
            "new_deadline_days": int(days) if days is not None else None,
            "narrative": data.get("narrative") or {},
        }

    def _build_evaluation_prompt(
        self,
        stats: dict[str, Any],
        state_snapshot: dict[str, Any],
        starting_baseline: dict[str, Any],
        current_baseline: dict[str, Any],
        deadline_state: DeadlineState,
    ) -> tuple[str, str]:
        system = "你是张明。请根据三个月交易结果做出 CONTINUE/STOP/EXTEND 决定，只输出 JSON。"
        template = ""
        # Prefer card prompt if narrator has templates
        prompts = getattr(getattr(self.narrator, "prompt_builder", None), "templates", {}) or {}
        template = prompts.get("user_deadline_evaluation") or ""
        variables = {
            "starting_equity": stats.get("starting_equity", 20000),
            "current_equity": stats.get("current_equity", 20000),
            "total_return_pct": stats.get("total_return_pct", 0),
            "trade_count": stats.get("trade_count", 0),
            "win_rate": stats.get("win_rate", 0),
            "max_drawdown_pct": stats.get("max_drawdown_pct", 0),
            "current_day": deadline_state.current_day,
            "total_days": deadline_state.total_days,
            "stress": state_snapshot.get("stress"),
            "self_doubt": state_snapshot.get("self_doubt"),
            "starting_baseline": json.dumps(starting_baseline, ensure_ascii=False),
            "current_baseline": json.dumps(current_baseline, ensure_ascii=False),
            "stats_json": json.dumps(stats, ensure_ascii=False),
        }
        if template:
            user = template
            for k, v in variables.items():
                user = user.replace("{{" + k + "}}", str(v))
        else:
            user = (
                f"三个月评估统计：{json.dumps(stats, ensure_ascii=False)}\n"
                f"当前状态：{json.dumps(state_snapshot, ensure_ascii=False)}\n"
                "输出 JSON：{\"action\":\"CONTINUE|STOP|EXTEND\",\"reason\":\"...\",\"new_deadline_days\":30|60|90|null,"
                "\"narrative\":{\"psychology\":{\"text\":\"...\",\"mood\":\"calm\",\"mood_label\":\"平静\"}}}"
            )
        return system, user

    def _collect_stats(self, db_repos: dict[str, Any] | None = None) -> dict[str, Any]:
        repos = db_repos or self.db_repos
        conn = None
        for key in ("conn", "connection"):
            if key in repos:
                conn = repos[key]
                break
        if conn is None and "positions_repo" in repos:
            conn = getattr(repos["positions_repo"], "conn", None)
        starting = 20000.0
        current = starting
        trade_count = 0
        wins = 0
        max_dd = 0.0
        if conn is not None:
            try:
                row = conn.execute(
                    "SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN realized_pnl>0 THEN 1 ELSE 0 END),0) AS w, "
                    "COALESCE(SUM(realized_pnl),0) AS pnl FROM positions WHERE status='CLOSED'"
                ).fetchone()
                if row:
                    trade_count = int(row["n"] or 0)
                    wins = int(row["w"] or 0)
                    current = starting + float(row["pnl"] or 0)
                dd_row = conn.execute(
                    "SELECT MIN(realized_pnl) AS mn FROM positions WHERE status='CLOSED'"
                ).fetchone()
                if dd_row and dd_row["mn"] is not None:
                    max_dd = abs(min(0.0, float(dd_row["mn"]))) / starting
            except Exception:  # noqa: BLE001
                pass
        win_rate = (wins / trade_count) if trade_count else 0.0
        return {
            "starting_equity": starting,
            "current_equity": round(current, 2),
            "total_return_pct": round((current - starting) / starting * 100, 2),
            "trade_count": trade_count,
            "win_rate": round(win_rate * 100, 2),
            "max_drawdown_pct": round(max_dd * 100, 2),
        }

    def _apply_decision(self, result: dict[str, Any], deadline_state: DeadlineState) -> None:
        mgr = self.deadline_manager
        if mgr is not None:
            mgr.apply_evaluation_result(result)
        else:
            deadline_state.evaluation_result = result
            deadline_state.last_evaluation_day = deadline_state.current_day
