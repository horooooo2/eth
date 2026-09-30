from dataclasses import asdict
from .models import STEP, Event, Config, Meta
from .strategy_exhaustion import Exhaustion
from .execution import grid, plan, market_fill, exit_touch
from .data import validate

VERSIONS = [(f"A_K{k}", "primary") for k in (3, 4, 5, 6)] + [("B", "primary")] + [
    (f"A_K{k}", "same_bar_target") for k in (3, 4, 5, 6)]


class Run:
    def __init__(self, config: Config, metadata: dict[str, Meta]):
        self.config, self.metadata = config, metadata
        self.results, self.ledger, self.trace, self.equity = [], [], [], []
        self.active, self.positions = [], {}
        self.cash, self.known, self.last_mark = {}, {}, {}

    def key(self, r):
        return r["strategy_id"], r["execution_scenario"], r["symbol"]

    def finish(self, r, status, valid=True):
        r["status"], r["data_valid_for_strategy"] = status, valid
        r["pnl_after_fees_slippage_ex_funding"] = r.get("pnl", 0) if valid else None
        r["R"] = r["pnl_after_fees_slippage_ex_funding"] / self.config.risk_budget_usdt if valid else None
        self.trace.append(dict(event_id=r["event_id"], strategy_id=r["strategy_id"],
                               execution_scenario=r["execution_scenario"], known_at=getattr(self, "clock", None),
                               state=status, phase=getattr(self, "phase", "CLOSE"), data_valid_for_strategy=valid))

    def new(self, e, version, scenario):
        r = dict(event_id=e.event_id, symbol=e.symbol, direction=e.direction,
                 strategy_id=version, execution_scenario=scenario, event_detected_at=e.detected_at,
                 source_bar_open_time=e.detected_at-12*STEP, source_bar_close_time=e.detected_at,
                 observation_start_time=e.detected_at, observation_end_time=e.deadline,
                 status="OBSERVING", funding_included=False, risk_budget_usdt=self.config.risk_budget_usdt,
                 trade_mae_known=0., trade_mae_ohlc_upper_bound=0., trade_mfe_known=0.,
                 trade_mfe_ohlc_upper_bound=0., intrabar_order_ambiguous=False,
                 same_bar_target_ambiguous=False, maker_eligible=False, traded=False)
        item = dict(event=e, result=r, fsm=Exhaustion(e), position=None, active_at=e.detected_at)
        self.results.append(r)
        key = self.key(r)
        if key in self.positions:
            if self.known.get(key, True):
                self.finish(r, "SKIP_POSITION_BUSY")
            else:
                self.finish(r, "DATA_GAP_IN_POSITION", False)
            return
        if version != "B":
            limit = grid(e.trigger_close-e.sign*int(version[-1])*e.atr,
                         self.metadata[e.symbol].tick_size, e.sign == -1)
            item["limit"] = limit
            item["plan"] = plan(e, limit, True, self.config, self.metadata[e.symbol])
            r.update(limit_price=limit, order_active_at=e.detected_at, maker_fill_model="OHLC_TOUCH_FULL_FILL")
            if item["plan"] is None:
                self.finish(r, "SKIP_SIZE_CONSTRAINT")
                return
            r["maker_eligible"] = True
        self.active.append(item)

    def book(self, r, time, delta, kind, **extra):
        key = self.key(r)
        self.cash[key] = self.cash.get(key, 0)+delta
        self.ledger.append(dict(event_id=r["event_id"], strategy_id=r["strategy_id"],
                                execution_scenario=r["execution_scenario"], symbol=r["symbol"],
                                timestamp=time, kind=kind, cash_delta=delta, **extra))

    def enter(self, item, b, maker):
        r, e = item["result"], item["event"]
        p = item.get("plan") if maker else plan(e, b.open, False, self.config, self.metadata[e.symbol])
        if p is None:
            self.finish(r, "SKIP_SIZE_CONSTRAINT")
            return
        if self.key(r) in self.positions:
            self.finish(r, "SKIP_POSITION_BUSY")
            return
        item["position"] = dict(p, bars=0)
        self.positions[self.key(r)] = item
        r.update(p, traded=True, status="IN_POSITION", entry_time=b.timestamp,
                 entry_phase="INTRABAR_UNKNOWN" if maker and b.open*e.sign > p["entry"]*e.sign else "OPEN",
                 actual_entry_slippage_bps=0 if maker else self.config.actual_entry_slippage_bps,
                 actual_exit_slippage_bps=self.config.actual_exit_slippage_bps)
        self.book(r, b.timestamp, -p["entry_fee"], "ENTRY", fill_price=p["entry"], phase=r["entry_phase"])
        self.trace.append(dict(event_id=e.event_id, strategy_id=r["strategy_id"], known_at=b.timestamp,
                               state="ENTRY", phase=r["entry_phase"]))

    def position_bar(self, item, b):
        p, r, e = item["position"], item["result"], item["event"]
        first = p["bars"] == 0
        maker = r["strategy_id"] != "B"
        allow_target = not (maker and first and r["execution_scenario"] == "primary")
        gap_entry = first and maker and (b.open >= p["entry"] if e.sign == -1 else b.open <= p["entry"])
        outcome = exit_touch(b, p, e.sign, allow_target, not first or not maker or gap_entry)
        if first and maker:
            r["same_bar_target_ambiguous"] = b.low <= p["target"] if e.sign == -1 else b.high >= p["target"]
        p["bars"] += 1
        if outcome is None and p["bars"] == 24:
            outcome = (b.close, "TIME", False)
        # Bound includes uncertain entry/exit-bar extremes; known respects exit boundary.
        known = [p["entry"]]
        bound = [b.high, b.low, p["entry"]]
        if outcome:
            ref, reason, ambiguous = outcome
            fill = market_fill(ref, e.sign == -1, self.config.actual_exit_slippage_bps, self.metadata[e.symbol])
            known += [ref, fill]
            bound += [fill]
            if reason == "TIME":
                known += [b.high, b.low]
            r["intrabar_order_ambiguous"] |= ambiguous
        elif not first or not maker or gap_entry:
            known += [b.high, b.low]
        else:
            known += [b.high if e.sign == -1 else b.low, b.close]
        for suffix, prices in (("known", known), ("ohlc_upper_bound", bound)):
            moves = [e.sign*(x-p["entry"]) for x in prices]
            r[f"trade_mae_{suffix}"] = max(r[f"trade_mae_{suffix}"], -min(moves), 0)
            r[f"trade_mfe_{suffix}"] = max(r[f"trade_mfe_{suffix}"], max(moves), 0)
        if outcome:
            exit_fee = fill*p["qty"]*self.config.taker_fee_bps/10_000
            gross = e.sign*(fill-p["entry"])*p["qty"]
            # Exact intrabar time is unknown; bar and phase are persisted.
            time = b.timestamp+STEP if reason == "TIME" else b.timestamp
            r.update(exit_fill=fill, exit_time=time, exit_bar_open_time=b.timestamp,
                     exit_phase="CLOSE" if reason == "TIME" else "OPEN" if ref == b.open else "INTRABAR_UNKNOWN",
                     exit_fee=exit_fee, gross_pnl=gross, total_fee=p["entry_fee"]+exit_fee,
                     pnl=gross-p["entry_fee"]-exit_fee, holding_bars=p["bars"])
            self.book(r, time, gross-exit_fee, "EXIT", fill_price=fill, phase=r["exit_phase"])
            del self.positions[self.key(r)]
            self.finish(r, "TRADED_"+reason)

    def gap(self, item, time):
        r = item["result"]
        status = "DATA_GAP_IN_POSITION" if item["position"] else "DATA_GAP_PENDING_ENTRY" if item["fsm"].signal_time else "DATA_GAP_PRE_ENTRY"
        self.finish(r, status, False)
        r["data_gap_time"] = time
        if item["position"]:
            key, p = self.key(r), item["position"]
            self.known[key] = False
            mark = self.last_mark.get(key, p["entry"])
            r.update(trade_partial_path_valid=True, realized_cost_before_gap=p["entry_fee"],
                     last_known_mark_price=mark,
                     unrealized_pnl_at_last_known_close=item["event"].sign*(mark-p["entry"])*p["qty"])
            self.book(r, time, 0, "INDETERMINATE", last_known_mark_price=mark)

    def execute(self, bars, events):
        bars = validate(bars)
        if not bars:
            raise ValueError("No bars")
        if len({e.event_id for e in events}) != len(events):
            raise ValueError("Duplicate event_id")
        by_time = {(b.symbol, b.timestamp): b for b in bars}
        scheduled = {}
        for e in events:
            if e.symbol not in self.metadata or e.atr <= 0 or e.direction not in ("UP", "DOWN"):
                raise ValueError("Invalid event/metadata")
            scheduled.setdefault(e.detected_at, []).append(e)
        begin = min([b.timestamp for b in bars]+[e.detected_at for e in events])
        end = max([b.timestamp for b in bars]+[e.detected_at for e in events])+STEP
        for t in range(begin, end+STEP, STEP):
            self.clock = t
            self.phase = "OPEN"
            # Old position opening gaps first, then old B pending entries, then new events.
            for item in list(self.active):
                r, e = item["result"], item["event"]
                if r["status"] not in ("OBSERVING", "IN_POSITION"):
                    continue
                b = by_time.get((e.symbol, t))
                if b is None:
                    self.gap(item, t)
                    continue
                if item["position"]:
                    hit = exit_touch(b, item["position"], e.sign)
                    if hit and hit[0] == b.open:
                        # Process gap using an open-only bar, before new occupancy checks.
                        from .models import Bar
                        self.position_bar(item, Bar(t, b.open, b.open, b.open, b.open, 0, b.symbol))
                        if r["status"] == "IN_POSITION":
                            item["position"]["bars"] -= 1
                elif r["strategy_id"] == "B" and item["fsm"].signal_time == t:
                    r["signal_time"] = t
                    self.enter(item, b, False)
            for e in scheduled.get(t, []):
                for version, scenario in VERSIONS:
                    self.new(e, version, scenario)
            # The following stage consumes this bar's complete OHLC, known at its close.
            self.clock = t + STEP
            self.phase = "CLOSE"
            for item in list(self.active):
                r, e = item["result"], item["event"]
                if r["status"] not in ("OBSERVING", "IN_POSITION"):
                    continue
                b = by_time.get((e.symbol, t))
                if b is None:
                    self.gap(item, t)
                    continue
                maker = r["strategy_id"] != "B"
                if r["status"] == "OBSERVING" and maker:
                    if t >= e.deadline:
                        self.finish(r, "NO_FILL")
                        continue
                    limit = item["limit"]
                    if t == e.detected_at and (b.open > limit if e.sign == -1 else b.open < limit):
                        r["post_only_rejected"] = True
                        self.finish(r, "POST_ONLY_REJECTED_ON_ACTIVATION")
                        continue
                    if b.high >= limit if e.sign == -1 else b.low <= limit:
                        self.enter(item, b, True)
                if r["status"] == "IN_POSITION":
                    self.position_bar(item, b)
                elif r["status"] == "OBSERVING" and not maker:
                    fsm = item["fsm"]
                    fsm.advance(b)
                    if fsm.trace:
                        self.trace.append(dict(fsm.trace[-1], strategy_id="B"))
                    if b.timestamp+STEP >= e.deadline and fsm.signal_time is None:
                        self.finish(r, "NO_CONFIRMATION")
                if r["status"] == "OBSERVING" and maker and b.timestamp+STEP >= e.deadline:
                    self.finish(r, "NO_FILL")
            keys = set(self.cash) | set(self.positions)
            for key in sorted(keys):
                item = self.positions.get(key)
                unrealized, risk = 0, 0
                known = self.known.get(key, True)
                if item:
                    p, e, r = item["position"], item["event"], item["result"]
                    b = by_time.get((e.symbol, t))
                    if known and b:
                        self.last_mark[key] = b.close
                        unrealized = e.sign*(b.close-p["entry"])*p["qty"]
                        risk = self.config.risk_budget_usdt
                        self.ledger.append(dict(event_id=e.event_id, strategy_id=key[0], execution_scenario=key[1],
                                                symbol=e.symbol, timestamp=t+STEP, kind="MARK", cash_delta=0,
                                                unrealized_pnl=unrealized, planned_risk=risk))
                self.equity.append(dict(timestamp=t+STEP, strategy_id=key[0], execution_scenario=key[1], symbol=key[2],
                                        continuous_segment_id="segment_001", continuous_equity_known=known,
                                        continuous_account_path=self.cash.get(key, 0)+unrealized if known else None,
                                        position_open=bool(item), planned_risk=risk if known else None))
            self.active = [x for x in self.active if x["result"]["status"] in ("OBSERVING", "IN_POSITION")]
        self.event_records = []
        for e in events:
            path = [by_time.get((e.symbol, e.detected_at+i*STEP)) for i in range(288)]
            valid = all(b is not None for b in path)
            self.event_records.append(dict(asdict(e), path_metrics_valid=valid,
                event_adverse_extension=max(0, max(b.high for b in path)-e.trigger_close if e.sign == -1 else e.trigger_close-min(b.low for b in path)) if valid else None,
                event_max_reversion=max(0, e.trigger_close-min(b.low for b in path) if e.sign == -1 else max(b.high for b in path)-e.trigger_close) if valid else None))
        return self
