from collections import defaultdict
from datetime import datetime, timezone
import numpy as np


def drawdown(values):
    peak, worst = 0., 0.
    for value in values:
        peak = max(peak, value)
        worst = max(worst, peak-value)
    return worst


def paired(a, b, repetitions=10_000, seed=42):
    left = {r["event_id"]: r for r in a if r["data_valid_for_strategy"]}
    right = {r["event_id"]: r for r in b if r["data_valid_for_strategy"]}
    days = defaultdict(list)
    for eid in sorted(left.keys() & right.keys()):
        r = right[eid]
        day = datetime.fromtimestamp(r["event_detected_at"]/1000, timezone.utc).date().isoformat()
        days[day].append(r["pnl_after_fees_slippage_ex_funding"]-left[eid]["pnl_after_fees_slippage_ex_funding"])
    if not days:
        return dict(paired_events=0, paired_days=0, delta_event_ev=None, cluster_bootstrap_interval=None)
    totals = np.array([(sum(values), len(values)) for _, values in sorted(days.items())])
    rng = np.random.default_rng(seed)
    draws = []
    for _ in range(repetitions):
        sample = totals[rng.integers(0, len(totals), size=len(totals))].sum(axis=0)
        draws.append(float(sample[0]/sample[1]))
    return dict(paired_events=int(totals[:, 1].sum()), paired_days=len(days),
                delta_event_ev=float(totals[:, 0].sum()/totals[:, 1].sum()),
                cluster_bootstrap_interval=np.quantile(draws, [.025, .975]).tolist(),
                bootstrap_repetitions=repetitions, bootstrap_seed=seed)


def summary(rows):
    valid = [r for r in rows if r["data_valid_for_strategy"]]
    trades = [r for r in valid if r["traded"]]
    pnls = [r["pnl_after_fees_slippage_ex_funding"] for r in trades]
    positive, negative = [p for p in pnls if p > 0], [p for p in pnls if p < 0]
    streak = worst = 0
    for r in sorted(trades, key=lambda r: (r["exit_time"], r["event_id"])):
        streak = streak+1 if r["pnl_after_fees_slippage_ex_funding"] < 0 else 0
        worst = max(worst, streak)
    eligible = sum(r["maker_eligible"] for r in rows)
    fills = sum(r["traded"] for r in rows)
    return dict(formal_event_count=len(rows), evaluable_events=len(valid), data_invalid_events=len(rows)-len(valid),
                evaluation_coverage_rate=len(valid)/len(rows) if rows else None,
                trade_count=len(trades), strategy_no_trade_count=len(valid)-len(trades),
                participation_rate=len(trades)/len(valid) if valid else None,
                maker_eligible_count=eligible, maker_fill_count=fills if eligible else 0,
                maker_fill_rate=fills/eligible if eligible else None,
                event_ev_ex_funding=sum(pnls)/len(valid) if valid else None,
                trade_ev_ex_funding=sum(pnls)/len(trades) if trades else None,
                win_rate=len(positive)/len(trades) if trades else None,
                mean_win=float(np.mean(positive)) if positive else None,
                mean_loss=float(np.mean(negative)) if negative else None,
                profit_factor=sum(positive)/-sum(negative) if negative else None,
                tail_pnl_p05=float(np.quantile(pnls, .05)) if pnls else None,
                mean_holding_bars=float(np.mean([r["holding_bars"] for r in trades])) if trades else None,
                max_consecutive_losses=worst, effective_trade_sample_size=None,
                effective_trade_sample_size_method="not_specified",
                fees=sum(r["total_fee"] for r in trades), funding_included=False)


def subset_curve(run, rows):
    ids = {r["event_id"] for r in rows if r["data_valid_for_strategy"] and r["traded"]}
    if not rows:
        return []
    version, scenario = rows[0]["strategy_id"], rows[0]["execution_scenario"]
    actions = defaultdict(list)
    for x in run.ledger:
        if x["event_id"] in ids and x["strategy_id"] == version and x["execution_scenario"] == scenario:
            actions[x["timestamp"]].append(x)
    cash, marks, completed, realized, out = 0., {}, set(), 0., []
    trade_map = {r["event_id"]: r for r in rows}
    for t, entries in sorted(actions.items()):
        # At a shared boundary the preceding close MARK must precede OPEN exit.
        for x in sorted(entries, key=lambda x: {"MARK": 0, "ENTRY": 1, "EXIT": 2}.get(x["kind"], 3)):
            eid = x["event_id"]
            cash += x["cash_delta"]
            if x["kind"] == "MARK" and eid not in completed:
                marks[eid] = x["unrealized_pnl"]
            elif x["kind"] == "ENTRY":
                marks[eid] = 0
            elif x["kind"] == "EXIT":
                marks.pop(eid, None)
                completed.add(eid)
                realized += trade_map[eid]["pnl_after_fees_slippage_ex_funding"]
            # Preserve the preceding close mark even when the next open/exit shares T.
            # Collapsing both into a single timestamp would erase the floating loss.
            out.append(dict(timestamp=t, phase=x["kind"], evaluable_subset_realized_equity=realized,
                            evaluable_subset_mtm_equity=cash+sum(marks.values()),
                            concurrent_positions=len(marks),
                            concurrent_planned_risk_usdt=len(marks)*run.config.risk_budget_usdt))
    return out
