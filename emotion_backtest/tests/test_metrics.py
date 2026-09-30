from src.metrics import summary, paired, subset_curve, drawdown
from tests.synthetic_paths.test_paths import run, row, bar


def fake(i, pnl, day=0, valid=True, traded=True):
    return dict(event_id=str(i), data_valid_for_strategy=valid, traded=traded,
                event_detected_at=day*86400000, pnl_after_fees_slippage_ex_funding=pnl,
                maker_eligible=True, exit_time=i, holding_bars=1, total_fee=0)


def test_ev_zero_participation_and_invalid():
    s = summary([fake(0, 10), fake(1, 0, traded=False), fake(2, None, valid=False)])
    assert s["event_ev_ex_funding"] == 5 and s["trade_ev_ex_funding"] == 10
    assert s["evaluable_events"] == 2 and s["data_invalid_events"] == 1


def test_pairing_ratio_of_sums_and_seed():
    a = [fake(i, 0) for i in range(10)] + [fake(10, 0, day=1), fake(11, None, valid=False)]
    b = [fake(i, 1) for i in range(10)] + [fake(10, 100, day=1), fake(11, 900)]
    s = paired(a, b, 100)
    assert s["delta_event_ev"] == 10 and s["paired_events"] == 11
    assert s == paired(a, b, 100)


def test_equity_costs_not_double_counted():
    result = run([bar(0, 100, 139, 99, 138), bar(1, 138, 139, 119, 120)])
    r = row(result)
    curve = subset_curve(result, [r])
    assert abs(curve[-1]["evaluable_subset_mtm_equity"]-r["pnl_after_fees_slippage_ex_funding"]) < 1e-8
    assert drawdown([x["evaluable_subset_mtm_equity"] for x in curve]) > 50
    assert drawdown([x["evaluable_subset_realized_equity"] for x in curve]) == 0


def test_report_roundtrip(tmp_path):
    import pandas as pd
    from src.reporting import report
    result = run([bar(0, 100, 131, 99, 130), bar(1, 130, 131, 119, 120)])
    report(result, tmp_path, {"synthetic_only": True})
    assert len(pd.read_parquet(tmp_path/"strategy_results.parquet")) == 9
    assert (tmp_path/"equity.png").stat().st_size > 100
    assert "funding" in (tmp_path/"report.md").read_text(encoding="utf-8")
