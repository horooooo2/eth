from src.models import Bar, STEP
from src.execution import grid, market_fill, plan
from tests.synthetic_paths.test_paths import C, M, event, bar, run, row, structure


def test_adverse_rounding_and_risk():
    m = M["TEST"]
    assert grid(1.001, .01, True) == 1.01
    assert market_fill(100, False, 1, m) <= 99.99
    assert market_fill(100, True, 1, m) >= 100.01
    p = plan(event(), 100, False, C, m)
    assert 0 < p["planned_loss_usdt"] <= C.risk_budget_usdt


def test_time_exit_close_not_next_open():
    bars = [bar(0, 100, 131, 99, 130)]+[bar(i, 130, 131, 129, 130) for i in range(1, 24)]+[bar(24, 160, 161, 159, 160)]
    r = row(run(bars))
    assert r["status"] == "TRADED_TIME" and r["exit_fill"] < 131
    assert r["holding_bars"] == 24 and r["exit_time"] == 24*STEP


def test_resting_gap_already_beyond_stop():
    r = row(run([bar(0), bar(1, 150, 151, 149, 150)]))
    assert r["entry"] == 130 and r["exit_fill"] > 150 and r["R"] < -1


def test_no_future_state():
    from src.strategy_exhaustion import Exhaustion
    bars = structure()
    f = Exhaustion(event())
    for b in bars:
        f.advance(b)
    for n in range(1, len(bars)+1):
        prefix = Exhaustion(event())
        for b in bars[:n]:
            prefix.advance(b)
        assert prefix.trace == f.trace[:n]


def test_after_exit_future_gap_cannot_erase_ledger():
    prefix = [bar(0, 100, 131, 99, 130), bar(1, 130, 131, 119, 120)]
    a, b = run(prefix), run(prefix+[bar(4)])
    assert row(a) == row(b)


def test_duplicate_input_rejected():
    import pytest
    with pytest.raises(ValueError, match="Duplicate"):
        run([bar(0), bar(0)])
