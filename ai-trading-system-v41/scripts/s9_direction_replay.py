"""Read-only OLD S9 vs S9_V1_1 replay on public OKX candles. No orders."""

from __future__ import annotations

import json
import time
from collections import Counter
from typing import Any, Dict, List, Optional

import pandas as pd

from src.runtime.config_loader import load_strategy_config
from src.strategies.s9_momentum import (
    closed_only,
    evaluate_entry,
    evaluate_5m_direction,
    evaluate_5m_direction_legacy,
    side_for_state,
)


def _df(rows: List[list]) -> pd.DataFrame:
    df = pd.DataFrame(rows, columns=["ts", "open", "high", "low", "close", "volume"])
    df["ts"] = pd.to_datetime(df["ts"], unit="ms", utc=True)
    return df.drop_duplicates("ts").set_index("ts").sort_index()


def fetch_ccxt_span(exchange, symbol: str, timeframe: str, span_ms: int) -> pd.DataFrame:
    """Public OHLCV in 12h chunks. Read-only. Never places orders."""
    now_ms = int(exchange.milliseconds())
    start_ms = now_ms - int(span_ms)
    rows: List[list] = []
    chunk = 12 * 60 * 60 * 1000
    cursor = start_ms
    while cursor < now_ms:
        end = min(cursor + chunk, now_ms)
        inner = cursor
        for _ in range(12):
            batch = exchange.fetch_ohlcv(symbol, timeframe, since=inner, limit=200)
            if not batch:
                break
            rows.extend(batch)
            nxt = int(batch[-1][0]) + 1
            if nxt <= inner:
                break
            inner = nxt
            if int(batch[-1][0]) >= end:
                break
            time.sleep(0.08)
        cursor = end
    if not rows:
        return pd.DataFrame(columns=["open", "high", "low", "close", "volume"])
    return _df(rows)


def replay_window(closed_1m: pd.DataFrame, closed_5m: pd.DataFrame, cfg: Dict[str, Any]) -> Dict[str, Any]:
    state_counts = Counter()
    old_state_counts = Counter()
    reasons_new: Counter = Counter()
    reasons_old: Counter = Counter()
    old_neutral = 0
    early_full = 0
    trend_cand = 0
    early_cand = 0
    old_cand = 0
    missed: List[Dict[str, Any]] = []
    early_seen: List[Dict[str, Any]] = []
    evals = 0
    for i in range(1, len(closed_1m) + 1):
        one = closed_1m.iloc[:i]
        if len(one) < 25:
            continue
        now = one.index[-1] + pd.Timedelta(minutes=1)
        five = closed_only(closed_5m.loc[closed_5m.index <= one.index[-1]], timeframe="5m", now=now)
        if five is None or len(five) < 30:
            continue
        evals += 1
        old_dir = evaluate_5m_direction_legacy(five, cfg)
        new_dir = evaluate_5m_direction(five, cfg)
        old_state_counts[str(old_dir.get("state"))] += 1
        state_counts[str(new_dir.get("state"))] += 1
        old_side = "LONG" if old_dir.get("state") == "BULLISH" else "SHORT" if old_dir.get("state") == "BEARISH" else None
        old = evaluate_entry(
            closed_1m=one,
            closed_5m=five,
            s3_regime="strong_trend" if old_side else "range",
            s3_bias=0.5 if old_side == "LONG" else (-0.5 if old_side == "SHORT" else 0.0),
            cfg=cfg,
            now=now,
            direction_version="legacy",
        )
        # TREND needs aligned S3; EARLY allows range/0
        new_probe = evaluate_entry(
            closed_1m=one,
            closed_5m=five,
            s3_regime="range",
            s3_bias=0.0,
            cfg=cfg,
            now=now,
            direction_version="v1_1",
        )
        mode = str(new_probe.get("s9_entry_mode") or (new_probe.get("diagnostics") or {}).get("s9_entry_mode") or "")
        new_side = side_for_state(str(new_dir.get("state") or ""))
        if mode == "TREND_CONTINUATION":
            new = evaluate_entry(
                closed_1m=one,
                closed_5m=five,
                s3_regime="strong_trend",
                s3_bias=0.5 if new_side == "LONG" else -0.5,
                cfg=cfg,
                now=now,
                direction_version="v1_1",
            )
        else:
            new = new_probe
        for code in old.get("reason_codes") or (["CANDIDATE"] if old.get("decision") == "CANDIDATE" else []):
            reasons_old[str(code)] += 1
        for code in new.get("reason_codes") or (["CANDIDATE"] if new.get("decision") == "CANDIDATE" else []):
            reasons_new[str(code)] += 1
        if old.get("decision") == "CANDIDATE":
            old_cand += 1
        if new.get("decision") == "CANDIDATE":
            if mode == "TREND_CONTINUATION":
                trend_cand += 1
            elif mode == "EARLY_MOMENTUM":
                early_cand += 1
        if (old.get("reason_codes") or [None])[0] == "S9_DIRECTION_NEUTRAL":
            old_neutral += 1
            if mode == "EARLY_MOMENTUM":
                diag = new.get("diagnostics") or {}
                row = {
                    "timestamp": str(one.index[-1]),
                    "price": diag.get("close") or float(one["close"].iloc[-1]),
                    "direction_state": new_dir.get("state"),
                    "direction_score": diag.get("s9_direction_score"),
                    "ADX": diag.get("s9_adx14"),
                    "EMA9": diag.get("ema9"),
                    "EMA21": diag.get("ema21"),
                    "slope": diag.get("ema9_slope_3"),
                    "ROC3": diag.get("s9_roc3"),
                    "1m_breakout": diag.get("early_breakout_level") or diag.get("s9_breakout_level"),
                    "volume": diag.get("early_volume_ratio") or diag.get("s9_volume_ratio"),
                    "depth": None,
                    "flow": None,
                    "reason": (new.get("reason_codes") or ["CANDIDATE"])[0],
                    "s3": "range/0 allowed for EARLY",
                    "s4": "historical_book_unavailable",
                }
                if new.get("decision") == "CANDIDATE":
                    early_full += 1
                    if len(missed) < 8:
                        missed.append(row)
                elif len(early_seen) < 6:
                    early_seen.append(row)
    return {
        "closed_1m_evaluations": evals,
        "old_states": dict(old_state_counts),
        "new_states": dict(state_counts),
        "OLD_S9_candidates": old_cand,
        "S9_V1_1_TREND_candidates": trend_cand,
        "S9_V1_1_EARLY_candidates": early_cand,
        "S9_V1_1_candidates": trend_cand + early_cand,
        "old_direction_neutral": old_neutral,
        "old_neutral_to_early_full_alpha": early_full,
        "old_reasons": dict(reasons_old),
        "new_reasons": dict(reasons_new),
        "missed_opportunities": missed,
        "early_direction_examples_old_would_neutral": early_seen,
        "s4_note": "Replay has no historical Top5 book/trades; S4 depth/flow not scored.",
        "write_requests": 0,
    }


def main() -> int:
    cfg = load_strategy_config("S9")
    now_ms = int(time.time() * 1000)
    windows = {"24h": 24 * 60 * 60 * 1000, "7d": 7 * 24 * 60 * 60 * 1000}
    warmup_1m = 220 * 60 * 1000
    warmup_5m = 140 * 5 * 60 * 1000
    report: Dict[str, Any] = {"symbol": "BTC-USDT-SWAP", "write_requests": 0, "windows": {}}
    try:
        import ccxt  # type: ignore

        exchange = ccxt.okx({"enableRateLimit": True, "options": {"defaultType": "swap"}})
        one_all = fetch_ccxt_span(exchange, "BTC/USDT:USDT", "1m", windows["7d"] + warmup_1m)
        five_all = fetch_ccxt_span(exchange, "BTC/USDT:USDT", "5m", windows["7d"] + warmup_5m)
    except Exception as exc:
        report["fetch_error"] = str(exc)[:300]
        print(json.dumps(report, ensure_ascii=False, default=str))
        return 2
    split = __import__("src.adapters.okx_market_data", fromlist=["split_closed_bars"]).split_closed_bars
    for name, span in windows.items():
        cutoff = pd.to_datetime(now_ms - span, unit="ms", utc=True)
        one_w = one_all[one_all.index >= cutoff] if not one_all.empty else one_all
        five_w = five_all[five_all.index >= cutoff - pd.Timedelta(minutes=5 * 90)] if not five_all.empty else five_all
        one_closed, _, _ = split(one_w, timeframe="1m") if not one_w.empty else (one_w, None, True)
        five_closed, _, _ = split(five_all if not five_all.empty else five_w, timeframe="5m")
        if one_closed is None or getattr(one_closed, "empty", True):
            one_closed = one_w
        if five_closed is None or getattr(five_closed, "empty", True):
            five_closed = five_w
        if one_closed.empty or five_closed.empty:
            report["windows"][name] = {"ok": False, "error": "empty candles", "write_requests": 0}
            continue
        report["windows"][name] = replay_window(one_closed, five_closed, cfg)
        report["windows"][name]["bars_1m"] = int(len(one_closed))
        report["windows"][name]["bars_5m"] = int(len(five_closed))
    print(json.dumps(report, ensure_ascii=False, default=str))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
