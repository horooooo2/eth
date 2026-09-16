"""Offline analytics over trader.db."""
from __future__ import annotations

import json
import statistics
from pathlib import Path
from typing import Any

from .db import close_connection, get_connection

ROOT = Path(__file__).resolve().parent.parent
DB_PATH = ROOT / "data" / "trader.db"
REPORT_PATH = ROOT / "reports" / "analysis_report.md"


def get_behavior_mode_stats(conn: Any) -> dict[str, Any]:
    """Counts, win rate, and avg PnL by BehaviorMode."""
    rows = conn.execute(
        """
        SELECT d.primary_mode AS mode,
               COUNT(DISTINCT d.decision_id) AS decisions,
               COUNT(p.position_id) AS trades,
               SUM(CASE WHEN p.realized_pnl > 0 THEN 1 ELSE 0 END) AS wins,
               AVG(p.realized_pnl) AS avg_pnl
        FROM decision_log d
        LEFT JOIN positions p
          ON p.decision_id = d.decision_id AND p.status = 'CLOSED'
        GROUP BY d.primary_mode
        """
    ).fetchall()
    out: dict[str, Any] = {}
    for r in rows:
        trades = int(r["trades"] or 0)
        wins = int(r["wins"] or 0)
        out[str(r["mode"] or "UNKNOWN")] = {
            "decisions": int(r["decisions"] or 0),
            "trades": trades,
            "win_rate": (wins / trades) if trades else None,
            "avg_pnl": float(r["avg_pnl"]) if r["avg_pnl"] is not None else None,
        }
    return out


def get_threshold_distribution(conn: Any) -> dict[str, float]:
    """Threshold stats from decision_reason JSON."""
    rows = conn.execute("SELECT decision_reason FROM decision_log").fetchall()
    values: list[float] = []
    for r in rows:
        try:
            reason = json.loads(r["decision_reason"] or "{}")
            if "final_threshold" in reason:
                values.append(float(reason["final_threshold"]))
        except (TypeError, ValueError, json.JSONDecodeError):
            continue
    if not values:
        return {"min": 0.0, "max": 0.0, "mean": 0.0, "median": 0.0, "n": 0}
    return {
        "min": min(values),
        "max": max(values),
        "mean": statistics.mean(values),
        "median": statistics.median(values),
        "n": len(values),
    }


def get_reject_reasons(conn: Any) -> dict[str, int]:
    rows = conn.execute(
        """
        SELECT risk_reject_reason AS reason, COUNT(*) AS c
        FROM decision_log
        WHERE risk_check = 'REJECT' AND risk_reject_reason IS NOT NULL
        GROUP BY risk_reject_reason
        ORDER BY c DESC
        """
    ).fetchall()
    return {str(r["reason"]): int(r["c"]) for r in rows}


def get_mfe_mae_stats(conn: Any) -> dict[str, float]:
    rows = conn.execute(
        """
        SELECT max_favorable_excursion AS mfe, max_adverse_excursion AS mae
        FROM positions WHERE status = 'CLOSED'
        """
    ).fetchall()
    mfes = [float(r["mfe"] or 0) for r in rows]
    maes = [float(r["mae"] or 0) for r in rows]
    return {
        "n": len(rows),
        "mfe_mean": statistics.mean(mfes) if mfes else 0.0,
        "mfe_min": min(mfes) if mfes else 0.0,
        "mfe_max": max(mfes) if mfes else 0.0,
        "mae_mean": statistics.mean(maes) if maes else 0.0,
        "mae_min": min(maes) if maes else 0.0,
        "mae_max": max(maes) if maes else 0.0,
    }


def get_loss_streak_behavior(conn: Any) -> dict[str, Any]:
    """Approximate next-decision aggressiveness after stop-loss events."""
    rows = conn.execute(
        """
        SELECT d.decision_id, d.timestamp, d.decision, d.primary_mode, d.position_multiplier
        FROM decision_log d
        ORDER BY d.timestamp
        """
    ).fetchall()
    stops = conn.execute(
        """
        SELECT exit_time FROM positions
        WHERE exit_reason = 'STOP_LOSS' AND exit_time IS NOT NULL
        ORDER BY exit_time
        """
    ).fetchall()
    stop_times = [r["exit_time"] for r in stops]
    next_opens = 0
    next_total = 0
    for st in stop_times:
        nxt = next((r for r in rows if r["timestamp"] > st), None)
        if not nxt:
            continue
        next_total += 1
        if str(nxt["decision"]).startswith("OPEN_"):
            next_opens += 1
    return {
        "stop_events": len(stop_times),
        "next_decisions": next_total,
        "next_open_rate": (next_opens / next_total) if next_total else 0.0,
    }


def get_sleep_debt_impact(conn: Any) -> dict[str, Any]:
    """Trade outcomes when psychology_before.sleep_debt > 5."""
    rows = conn.execute(
        """
        SELECT d.psychology_before, p.realized_pnl, p.entry_time, p.exit_time
        FROM decision_log d
        JOIN positions p ON p.decision_id = d.decision_id
        WHERE p.status = 'CLOSED'
        """
    ).fetchall()
    high: list[float] = []
    normal: list[float] = []
    for r in rows:
        try:
            snap = json.loads(r["psychology_before"] or "{}")
        except json.JSONDecodeError:
            continue
        debt = float(snap.get("sleep_debt") or 0)
        pnl = float(r["realized_pnl"] or 0)
        if debt > 5:
            high.append(pnl)
        else:
            normal.append(pnl)
    return {
        "high_sleep_trades": len(high),
        "high_sleep_avg_pnl": statistics.mean(high) if high else 0.0,
        "normal_avg_pnl": statistics.mean(normal) if normal else 0.0,
    }


def get_causal_chain(conn: Any, decision_id: str) -> dict[str, Any]:
    """Full event → decision → position chain for one decision."""
    rows = conn.execute(
        """
        SELECT
            e.timestamp AS event_time,
            e.name AS event_name,
            e.psychology_impact,
            d.timestamp AS decision_time,
            d.primary_mode,
            d.decision_reason,
            d.decision,
            d.config_snapshot_hash,
            p.entry_price,
            p.exit_price,
            p.realized_pnl,
            p.max_favorable_excursion,
            p.max_adverse_excursion,
            p.exit_reason
        FROM decision_log d
        LEFT JOIN decision_events de ON de.decision_id = d.decision_id
        LEFT JOIN events e ON e.id = de.event_id
        LEFT JOIN positions p ON p.decision_id = d.decision_id
        WHERE d.decision_id = ?
        ORDER BY e.timestamp, d.timestamp
        """,
        (decision_id,),
    ).fetchall()
    return {
        "decision_id": decision_id,
        "rows": [dict(r) for r in rows],
    }


def _pick_sample_decision_ids(conn: Any, limit: int = 5) -> list[str]:
    rows = conn.execute(
        """
        SELECT d.decision_id
        FROM decision_log d
        JOIN decision_events de ON de.decision_id = d.decision_id
        JOIN positions p ON p.decision_id = d.decision_id
        WHERE d.decision LIKE 'OPEN_%'
        GROUP BY d.decision_id
        ORDER BY d.timestamp
        LIMIT ?
        """,
        (limit,),
    ).fetchall()
    ids = [str(r["decision_id"]) for r in rows]
    if len(ids) >= limit:
        return ids
    extra = conn.execute(
        """
        SELECT decision_id FROM decision_log
        WHERE decision LIKE 'OPEN_%'
        ORDER BY timestamp LIMIT ?
        """,
        (limit,),
    ).fetchall()
    for r in extra:
        if r["decision_id"] not in ids:
            ids.append(str(r["decision_id"]))
        if len(ids) >= limit:
            break
    return ids[:limit]


def build_analysis_report(conn: Any) -> str:
    modes = get_behavior_mode_stats(conn)
    thr = get_threshold_distribution(conn)
    rejects = get_reject_reasons(conn)
    mfe = get_mfe_mae_stats(conn)
    streak = get_loss_streak_behavior(conn)
    sleep = get_sleep_debt_impact(conn)
    samples = _pick_sample_decision_ids(conn, 5)

    insights: list[str] = []
    for mode, stats in modes.items():
        if stats.get("win_rate") is not None and stats.get("trades", 0) > 0:
            insights.append(
                f"{mode}: 决策 {stats['decisions']}，成交 {stats['trades']}，"
                f"胜率 {stats['win_rate']:.0%}，均盈亏 "
                f"{(stats['avg_pnl'] or 0):+.2f}"
            )
    if rejects:
        top = max(rejects.items(), key=lambda kv: kv[1])
        insights.append(f"最常见拒绝原因：{top[0]} × {top[1]}")
    insights.append(
        f"止损后下一笔开仓率：{streak['next_open_rate']:.0%} "
        f"（样本 {streak['next_decisions']}）"
    )
    insights.append(
        f"高睡眠债交易均盈亏 {sleep['high_sleep_avg_pnl']:+.2f} vs "
        f"普通 {sleep['normal_avg_pnl']:+.2f}"
    )

    lines = [
        "# AI Trader Analysis Report",
        "",
        "## 1. 行为模式统计",
        "```json",
        json.dumps(modes, ensure_ascii=False, indent=2),
        "```",
        "",
        "## 2. 阈值分布",
        "```json",
        json.dumps(thr, ensure_ascii=False, indent=2),
        "```",
        "",
        "## 3. 风控拒绝分析",
        "```json",
        json.dumps(rejects, ensure_ascii=False, indent=2),
        "```",
        "",
        "## 4. MFE / MAE 分布",
        "```json",
        json.dumps(mfe, ensure_ascii=False, indent=2),
        "```",
        "",
        "## 5. 关键因果链示例",
    ]
    for did in samples:
        chain = get_causal_chain(conn, did)
        lines.append(f"### decision `{did}`")
        lines.append("```json")
        # compact printable rows
        printable = []
        for row in chain["rows"][:8]:
            printable.append(
                {
                    "event_time": row.get("event_time"),
                    "event_name": row.get("event_name"),
                    "decision": row.get("decision"),
                    "primary_mode": row.get("primary_mode"),
                    "entry": row.get("entry_price"),
                    "exit": row.get("exit_price"),
                    "pnl": row.get("realized_pnl"),
                    "mfe": row.get("max_favorable_excursion"),
                    "mae": row.get("max_adverse_excursion"),
                    "exit_reason": row.get("exit_reason"),
                    "config_hash": row.get("config_snapshot_hash"),
                }
            )
        lines.append(json.dumps(printable, ensure_ascii=False, indent=2))
        lines.append("```")
        lines.append("")

    lines += ["## 6. 自动洞察"]
    for tip in insights:
        lines.append(f"- {tip}")
    lines.append("")
    return "\n".join(lines)


def main() -> None:
    if not DB_PATH.exists():
        raise SystemExit(f"missing database: {DB_PATH} (run python -m src.replay first)")
    conn = get_connection(DB_PATH)
    text = build_analysis_report(conn)
    REPORT_PATH.parent.mkdir(parents=True, exist_ok=True)
    REPORT_PATH.write_text(text, encoding="utf-8")
    close_connection(conn)
    print(text)
    print(f"\n[wrote] {REPORT_PATH}")


if __name__ == "__main__":
    main()
