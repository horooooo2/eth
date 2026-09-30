import json
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
import pandas as pd
from .metrics import summary, paired, subset_curve, drawdown
from .engine import VERSIONS


def report(run, output, manifest):
    output = Path(output)
    output.mkdir(parents=True, exist_ok=True)
    def dump(name, value):
        (output/name).write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False), encoding="utf-8")
    for name, records in (("events", run.event_records), ("strategy_results", run.results),
                          ("raw_ledger", run.ledger), ("continuous_account_path", run.equity)):
        pd.DataFrame(records).to_parquet(output/f"{name}.parquet", index=False)
    (output/"state_trace.jsonl").write_text("\n".join(json.dumps(x, ensure_ascii=False) for x in run.trace), encoding="utf-8")
    groups = defaultdict(list)
    for key in VERSIONS:
        groups[key] = []
    breakdown = defaultdict(list)
    for r in run.results:
        groups[(r["strategy_id"], r["execution_scenario"])].append(r)
        dt = datetime.fromtimestamp(r["event_detected_at"]/1000, timezone.utc)
        for dimension, value in (("direction", r["direction"]), ("symbol", r["symbol"]),
                                 ("month", dt.strftime("%Y-%m")), ("year", str(dt.year)),
                                 ("quarter", f"{dt.year}-Q{(dt.month-1)//3+1}")):
            breakdown[(r["strategy_id"], r["execution_scenario"], dimension, value)].append(r)
    summaries, curves = [], []
    for (version, scenario), rows in sorted(groups.items()):
        curve = subset_curve(run, rows)
        s = dict(strategy_id=version, execution_scenario=scenario, **summary(rows))
        s.update(realized_max_drawdown=drawdown([x["evaluable_subset_realized_equity"] for x in curve]),
                 mtm_max_drawdown=drawdown([x["evaluable_subset_mtm_equity"] for x in curve]),
                 max_concurrent_positions=max([x["concurrent_positions"] for x in curve], default=0),
                 peak_concurrent_planned_risk_usdt=max([x["concurrent_planned_risk_usdt"] for x in curve], default=0))
        path = [x for x in run.equity if (x["strategy_id"], x["execution_scenario"]) == (version, scenario)]
        timestamps = defaultdict(list)
        for x in path:
            timestamps[x["timestamp"]].append(x)
        known_times = [all(x["continuous_equity_known"] for x in xs) for _, xs in sorted(timestamps.items())]
        unknown = [t for t, xs in timestamps.items() if not all(x["continuous_equity_known"] for x in xs)]
        s.update(first_indeterminate_timestamp=min(unknown) if unknown else None,
                 number_of_indeterminate_segments=int(bool(unknown)),
                 fraction_of_time_equity_known=sum(known_times)/len(known_times) if known_times else None,
                 continuous_coverage_scope="from_first_simulated_position_to_dataset_end")
        s["mean_concurrent_positions"] = (sum(x["concurrent_positions"] * max(0, curve[i+1]["timestamp"]-x["timestamp"])
                                              for i, x in enumerate(curve[:-1])) / (curve[-1]["timestamp"]-curve[0]["timestamp"])
                                             if len(curve) > 1 and curve[-1]["timestamp"] > curve[0]["timestamp"] else None)
        s["concurrency_mean_scope"] = "time_weighted_evaluable_subset_trade_span"
        summaries.append(s)
        curves.extend(dict(x, strategy_id=version, execution_scenario=scenario) for x in curve)
    comparisons = []
    b = groups.get(("B", "primary"), [])
    for (version, scenario), rows in sorted(groups.items()):
        if version != "B":
            comparisons.append(dict(strategy_id=version, execution_scenario=scenario, **paired(rows, b)))
    sensitive = False
    for k in (3, 4, 5, 6):
        values = [x["delta_event_ev"] for x in comparisons if x["strategy_id"] == f"A_K{k}"]
        if len(values) == 2 and all(x is not None for x in values) and values[0]*values[1] < 0:
            sensitive = True
    dump("manifest.json", manifest)
    dump("summary.json", summaries)
    dump("paired_comparisons.json", comparisons)
    pd.DataFrame(summaries).to_csv(output/"summary.csv", index=False)
    pd.DataFrame(curves).to_csv(output/"evaluable_subset_equity.csv", index=False)
    pd.DataFrame([dict(strategy_id=v, execution_scenario=s, dimension=d, value=value, **summary(rows))
                  for (v, s, d, value), rows in sorted(breakdown.items())]).to_csv(output/"breakdown.csv", index=False)
    text = ["# 情绪过冲 / 衰竭确认研究报告", "", "A/B conclusion is execution-model sensitive." if sensitive else "指定 OHLC 执行模型下的固定参数研究。",
            "", "费用及滑点已计入；funding 未计入。曲线为 unconstrained_experimental_equity，不是账户 ROI。",
            "Evaluable subset 是事后完整样本；连续账户路径单独输出，缺口后保持未知，不拼接。",
            "MAE/MFE 是指定 OHLC + execution model 下的 estimate / bound。日聚类区间不能消除跨日依赖。", ""]
    for s in summaries:
        text.append(f"- {s['strategy_id']} / {s['execution_scenario']}: events={s['formal_event_count']}, evaluable={s['evaluable_events']}, trades={s['trade_count']}, Event EV={s['event_ev_ex_funding']}, Trade EV={s['trade_ev_ex_funding']}")
    text += ["", "样本稀少时仅表示交易后收益证据有限；不作策略有效/无效的自动判定。"]
    (output/"report.md").write_text("\n".join(text), encoding="utf-8")
    import html
    (output/"report.html").write_text('<meta charset="utf-8"><title>Emotion research</title><pre>'+html.escape("\n".join(text))+"</pre>", encoding="utf-8")
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    fig, ax = plt.subplots(figsize=(10, 5))
    for key in groups:
        data = [x for x in curves if (x["strategy_id"], x["execution_scenario"]) == key]
        ax.plot([x["timestamp"] for x in data], [x["evaluable_subset_mtm_equity"] for x in data], label="/".join(key))
    ax.set(title="Evaluable subset MTM (ex funding, unconstrained)", xlabel="UTC epoch milliseconds", ylabel="USDT")
    if curves:
        ax.legend(fontsize=7)
    fig.tight_layout(); fig.savefig(output/"equity.png"); plt.close(fig)
    for field, filename in (("event_ev_ex_funding", "event_ev.png"), ("participation_rate", "participation.png")):
        fig, ax = plt.subplots(figsize=(10, 5))
        valid = [s for s in summaries if s[field] is not None]
        ax.bar([s["strategy_id"]+"/"+s["execution_scenario"] for s in valid], [s[field] for s in valid])
        ax.tick_params(axis="x", labelrotation=60); ax.set_title(field)
        fig.tight_layout(); fig.savefig(output/filename); plt.close(fig)
    for field, records, filename in (("trade_mae_ohlc_upper_bound", run.results, "mae_bound.png"),
                                     ("event_adverse_extension", run.event_records, "event_extension.png")):
        fig, ax = plt.subplots(figsize=(8, 5))
        values = [x[field] for x in records if x.get(field) is not None and ("traded" not in x or x["traded"])]
        if values: ax.hist(values, bins=min(30, len(values)))
        ax.set(title=field+" (price units; pooled descriptive only)", ylabel="Count")
        fig.tight_layout(); fig.savefig(output/filename); plt.close(fig)
    fig, ax = plt.subplots(figsize=(10, 5))
    for key in groups:
        data = [x for x in curves if (x["strategy_id"], x["execution_scenario"]) == key]
        peak = 0.; values = []
        for x in data:
            peak = max(peak, x["evaluable_subset_mtm_equity"])
            values.append(peak-x["evaluable_subset_mtm_equity"])
        ax.plot([x["timestamp"] for x in data], values, label="/".join(key))
    ax.set(title="Evaluable subset MTM drawdown", ylabel="USDT")
    if curves: ax.legend(fontsize=7)
    fig.tight_layout(); fig.savefig(output/"drawdown.png"); plt.close(fig)
    fig, ax = plt.subplots(figsize=(10, 5))
    for (version, scenario) in groups:
        rows = [(key[3], summary(value)["event_ev_ex_funding"]) for key, value in breakdown.items()
                if key[:3] == (version, scenario, "month")]
        rows = sorted((month, ev) for month, ev in rows if ev is not None)
        ax.plot([m for m, _ in rows], [ev for _, ev in rows], marker=".", label=version+"/"+scenario)
    ax.set(title="Monthly Event EV (ex funding)", ylabel="USDT / evaluable event")
    if groups: ax.legend(fontsize=7)
    fig.tight_layout(); fig.savefig(output/"monthly.png"); plt.close(fig)
