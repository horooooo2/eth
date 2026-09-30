import json
import pytest
from src.models import Bar, Config, Meta, Event, STEP, HOUR
from src.engine import Run
from src.events import detect
from src.strategy_exhaustion import Exhaustion

C = Config(2, 5, 1, 1, 1, 1, 100)
M = {"TEST": Meta(.01, .001, .001, 1)}


def event(t=0, direction="UP"):
    return Event(f"TEST_{t}_{direction}", "TEST", direction, t, 100, 70, 10)


def bar(i, o=100, h=101, l=99, c=100):
    return Bar(i*STEP, o, h, l, c)


def run(bars, events=None):
    result = Run(C, M).execute(bars, events or [event()])
    print(json.dumps(result.trace, ensure_ascii=False))
    print(json.dumps([{k: r.get(k) for k in ("event_id", "strategy_id", "status", "entry_time", "exit_time", "R")} for r in result.results]))
    return result


def row(result, strategy="A_K3", scenario="primary", event_id=None):
    return next(r for r in result.results if r["strategy_id"] == strategy and r["execution_scenario"] == scenario
                and (event_id is None or r["event_id"] == event_id))


def structure(start=0):
    values = [(100, 110, 99, 110), (110, 110, 103, 104), (104, 105, 102, 103),
              (103, 104, 101, 102), (102, 106, 102, 105), (105, 106, 99, 100)]
    return [bar(start+i, *v) for i, v in enumerate(values)]


def test_path01_normal_touch():
    r = row(run([bar(0, 100, 131, 99, 130), bar(1, 130, 131, 119, 120)]))
    assert r["status"] == "TRADED_TARGET"
    assert r["entry"] == 130 and r["exit_fill"] >= 120


def test_path02_activation_reject():
    assert row(run([bar(0, 132, 133, 129, 131)]))["status"] == "POST_ONLY_REJECTED_ON_ACTIVATION"


def test_path03_resting_gap():
    r = row(run([bar(0), bar(1, 132, 133, 119, 120), bar(2, 120, 121, 119, 120)]))
    assert r["traded"] and r["entry"] == 130 and r["status"] == "TRADED_TARGET"


def test_path04_samebar_reversal():
    result = run([bar(0, 100, 131, 99, 120), bar(1, 130, 141, 129, 140)])
    assert row(result)["status"] == "TRADED_STOP"
    assert row(result, scenario="same_bar_target")["status"] == "TRADED_TARGET"


def test_path05_gap_stop():
    r = row(run([bar(0, 100, 131, 99, 130), bar(1, 150, 151, 149, 150)]))
    assert r["R"] < -1 and r["exit_fill"] > 150


def test_path06_b_exhaustion():
    r = row(run(structure()+[bar(6, 100, 101, 89, 90)]), "B")
    assert r["status"] == "TRADED_TARGET"
    assert r["signal_time"] == r["entry_time"] == 6*STEP


def test_path07_straight_collapse():
    bars = [bar(i, 100-i, 101-i, 98-i, 99-i) for i in range(24)]
    assert row(run(bars), "B")["status"] == "NO_CONFIRMATION"


def test_path08_equal_high():
    f = Exhaustion(event())
    for b in structure()[:4]+[bar(4, 102, 110, 101, 106)]:
        f.advance(b)
    print(json.dumps(f.trace))
    assert f.state != "REBOUND_ACTIVE" and f.signal_time is None
    assert f.trace[-1]["reset_reason"] == "EQUAL_EVENT_EXTREME"


def test_path09_new_high_window():
    f = Exhaustion(event())
    for b in structure()[:2]+[bar(2, 104, 115, 103, 105)]:
        f.advance(b)
    print(json.dumps(f.trace))
    assert f.event.event_id == event().event_id and f.extreme == 115 and len(f.window) == 1


def test_path10_last_bar_signal():
    bars = [bar(i) for i in range(18)]+structure(18)+[bar(24, 100, 101, 89, 90)]
    r = row(run(bars), "B")
    assert r["entry_time"] == 24*STEP and r["status"] == "TRADED_TARGET"


def test_path11_gap_preentry():
    r = row(run([bar(0), bar(2)]))
    assert r["status"] == "DATA_GAP_PRE_ENTRY" and r["R"] is None


def test_path12_gap_pending():
    r = row(run(structure()+[bar(7)]), "B")
    assert r["status"] == "DATA_GAP_PENDING_ENTRY"


def test_path13_gap_position():
    result = run([bar(0, 100, 131, 99, 130), bar(2, 130, 131, 129, 130)])
    r = row(result)
    assert r["status"] == "DATA_GAP_IN_POSITION" and r["R"] is None
    assert r["realized_cost_before_gap"] > 0 and r["trade_partial_path_valid"]
    assert any(x["kind"] == "ENTRY" and x["cash_delta"] < 0 for x in result.ledger)
    assert any(not x["continuous_equity_known"] for x in result.equity)


def test_path14_closed_before_gap():
    r = row(run([bar(0, 100, 131, 99, 130), bar(1, 130, 131, 119, 120), bar(3)]))
    assert r["status"] == "TRADED_TARGET" and r["data_valid_for_strategy"]


def test_path15_mtm_path():
    result = run([bar(0, 100, 139, 99, 138), bar(1, 138, 139, 119, 120)])
    r = row(result)
    marks = [x["continuous_account_path"] for x in result.equity if x["strategy_id"] == "A_K3" and x["execution_scenario"] == "primary"]
    assert min(marks) < -50 and r["pnl_after_fees_slippage_ex_funding"] > 0


def test_path16_exit_boundary():
    result = run([bar(0, 100, 155, 99, 150)])
    r = row(result)
    assert r["trade_mae_known"] < 11 and r["trade_mae_ohlc_upper_bound"] >= 25


def hourly_history():
    return [Bar(i*HOUR, 100, 101, 99, 100) for i in range(2161)] + [Bar(2161*HOUR, 100, 141, 99, 140)]


def test_path17_atr_dependency():
    hourly = hourly_history()
    assert len(detect(hourly)[0]) == 1
    del hourly[-22]
    ev, diagnostic = detect(hourly)
    print(json.dumps(diagnostic[-1:]))
    assert not ev


def test_path18_quantile_dependency():
    hourly = hourly_history()[1:]
    ev, diagnostic = detect(hourly)
    print(json.dumps(diagnostic[-1:]))
    assert not ev


def test_path19_old_entry_priority():
    bars = [bar(i) for i in range(18)]+structure(18)+[bar(24), bar(25, 100, 101, 89, 90)]
    second = event(24*STEP)
    result = run(bars, [event(), second])
    assert row(result, "B", event_id=second.event_id)["status"] == "SKIP_POSITION_BUSY"


def test_path20_down_mirror():
    bars = structure()+[bar(6, 100, 101, 89, 90)]
    mirrored = [Bar(b.timestamp, 200-b.open, 200-b.low, 200-b.high, 200-b.close) for b in bars]
    r = row(run(mirrored, [event(direction="DOWN")]), "B")
    assert r["status"] == "TRADED_TARGET" and r["exit_fill"] > r["entry"]
