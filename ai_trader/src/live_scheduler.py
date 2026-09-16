"""
Live trading scheduler: OKX WS candles -> decision chain -> LiveExecutor.

Usage:
    python -m src.live_scheduler
"""
from __future__ import annotations

import argparse
import logging
import os
import queue
import signal
import sys
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from uuid import uuid4

from .baseline_integration import apply_and_persist_evolution, collect_daily_stats
from .character.card import apply_to_engines, resolve_runtime_character
from .db.connection import get_connection
from .db.migrations_v8 import apply_v8_migrations
from .db.migrations_v9 import apply_v9_migrations
from .db.migrations_v10 import apply_v10_migrations
from .db.migrations_v12 import apply_v12_migrations
from .db.migrations_v13 import apply_v13_migrations
from .db.path import get_db_path
from .db.repositories import (
    AmbientRepo,
    BaselineRepo,
    DecisionRepo,
    DeadlineRepo,
    EventsRepo,
    NewsAssessmentsRepo,
    NewsRepo,
    PositionsRepo,
    PsychologyRepo,
    TraumaRepo,
)
from .deadline_hooks import (
    build_deadline_stack,
    maybe_run_deadline_evaluation,
    process_new_day,
)
from .envutil import load_dotenv
from .exchange.account_sync import AccountSync
from .exchange.live_executor import LiveExecutor
from .exchange.okx_client import OKXClient
from .exchange.okx_ws import OKXWebSocket
from .narrator.event_bridge import NarratorEventBridge
from .narrator.mock_client import MockLLMClient
from .narrator.mode import resolve_narrator_mode
from .narrator.narrator import Narrator
from .risk_engine import MarketSnapshot, RiskEngine
from .runtime_flags import (
    orders_paused,
    register_account_sync,
    register_okx_client,
    set_orders_paused,
)
from .runtime_heartbeat import write_scheduler_heartbeat
from .signal_engine import SignalEngine
from .trade_intent import (
    STATUS_PENDING_RISK,
    STATUS_RISK_APPROVED,
    STATUS_RISK_REJECTED,
    TradeIntent,
)

ROOT = Path(__file__).resolve().parent.parent
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("live_scheduler")


class LiveScheduler:
    """Thread + queue based live loop."""

    def __init__(
        self,
        *,
        config_dir: Path | None = None,
        db_path: Path | None = None,
        inst_id: str = "BTC-USDT-SWAP",
        mock_narrator_override: bool | None = None,
        use_mock_narrator: bool | None = None,
    ) -> None:
        load_dotenv(ROOT / ".env")
        self.config_dir = Path(config_dir or (ROOT / "config"))
        self.db_path = Path(db_path) if db_path is not None else get_db_path()
        self.inst_id = inst_id
        # Backward compat: use_mock_narrator True/False maps to override
        if mock_narrator_override is None and use_mock_narrator is not None:
            mock_narrator_override = bool(use_mock_narrator)
        self._q: queue.Queue[dict[str, Any]] = queue.Queue()
        self._stop = threading.Event()
        self._candles: list[dict[str, Any]] = []
        self._started_at = datetime.now(timezone.utc).isoformat()

        self.conn = get_connection(self.db_path)
        apply_v8_migrations(self.conn)
        apply_v9_migrations(self.conn)
        apply_v10_migrations(self.conn)
        apply_v12_migrations(self.conn)
        apply_v13_migrations(self.conn)

        card = resolve_runtime_character(self.config_dir)
        engines = apply_to_engines(card, project_root=ROOT)
        self.card = card
        self.person = engines["person"]
        self.classifier = engines["classifier"]
        self.decision_engine = engines["decision_engine"]
        self.char_config_dir = Path(engines["config_dir"])
        self.baseline_repo = BaselineRepo(self.conn)
        self.trauma_repo = TraumaRepo(self.conn)
        self.ambient_repo = AmbientRepo(self.conn)
        self.deadline_repo = DeadlineRepo(self.conn)
        from datetime import date as _date

        start_iso = _date.today().isoformat()
        self.deadline_cfg, self.deadline_manager, self.ambient_sampler = build_deadline_stack(
            self.config_dir, card, start_iso
        )
        self.person.deadline_manager = self.deadline_manager
        self.person.ambient_sampler = self.ambient_sampler
        self.starting_baseline = self.person.baseline_snapshot()
        self._trading_paused = False
        self._last_evolution_date = ""
        self._day_pnl = 0.0
        self._day_start_equity = 20000.0
        self._peak_equity = 20000.0
        self._days_profitable_streak = 0
        self._days_losing_streak = 0

        # signal/risk from project config (not fully in character card yet)
        self.signal_engine = SignalEngine(self.config_dir / "signal_rules.json")
        self.risk_engine = RiskEngine(self.config_dir / "risk_rules.json")

        self.client = OKXClient()
        register_okx_client(self.client)
        self.executor = LiveExecutor(client=self.client, inst_id=inst_id)
        self.sync = AccountSync(client=self.client, conn=self.conn, interval_sec=30.0)
        register_account_sync(self.sync)
        try:
            bal = self.sync.get_cached_balance() or {}
            if bal.get("equity"):
                self._day_start_equity = float(bal["equity"])
                self._peak_equity = float(bal["equity"])
        except Exception:
            pass

        narrator_cfg_path = self.config_dir / "narrator_config.json"
        mode, use_mock = resolve_narrator_mode(
            config_path=narrator_cfg_path,
            mock_override=mock_narrator_override,
        )
        self.narrator_mode = mode
        self.use_mock_narrator = use_mock
        llm = MockLLMClient() if use_mock else None
        self.narrator = Narrator(
            narrator_cfg_path,
            project_root=ROOT,
            llm_client=llm,
            api_key=None if not use_mock else "",
        )
        if not use_mock:
            # Ensure real path: no mock client, key from env
            self.narrator.llm_client = None
            self.narrator.api_key = (os.environ.get("DEEPSEEK_API_KEY") or "").strip()
            self.narrator.enabled = bool(self.narrator.config.get("enabled")) and bool(
                self.narrator.api_key
            )
            self.narrator.mode = self.narrator._resolve_mode()
            self.narrator_mode = self.narrator.mode
        logger.info(
            "narrator_mode=%s db=%s",
            self.narrator_mode,
            self.db_path,
        )
        self.bridge = NarratorEventBridge(
            self.narrator,
            DecisionRepo(self.conn),
            PsychologyRepo(self.conn),
        )
        self.decision_repo = DecisionRepo(self.conn)
        self.positions_repo = PositionsRepo(self.conn)
        self.events_repo = EventsRepo(self.conn)
        self._init_news_checker()

        self.ws = OKXWebSocket(
            inst_id=inst_id,
            bar="1m",
            demo=self.client.demo,
            on_candle=self._enqueue_candle,
        )
        self._last_hb = 0.0
        write_scheduler_heartbeat(
            pid=os.getpid(),
            narrator_mode=self.narrator_mode,
            started_at=self._started_at,
        )

    def _enqueue_candle(self, candle: dict[str, Any]) -> None:
        self._q.put({"type": "candle", "data": candle})

    def start(self) -> None:
        logger.info(
            "LiveScheduler starting character=%s inst=%s demo=%s narrator=%s db=%s",
            self.card.get("id"),
            self.inst_id,
            self.client.demo,
            self.narrator_mode,
            self.db_path,
        )
        self.sync.start()
        try:
            self.sync.sync_once()
        except Exception as exc:
            logger.warning("initial account sync failed: %s", exc)

        ws_thread = threading.Thread(target=self.ws.start, kwargs={"blocking": True}, name="okx-ws-main", daemon=True)
        ws_thread.start()

        risk_thread = threading.Thread(target=self._risk_loop, name="risk-loop", daemon=True)
        risk_thread.start()

        if self.news_checker is not None:
            news_thread = threading.Thread(
                target=self._news_check_loop, name="news-check-loop", daemon=True
            )
            news_thread.start()

        while not self._stop.is_set():
            now = time.time()
            if now - self._last_hb >= 30.0:
                write_scheduler_heartbeat(
                    pid=os.getpid(),
                    narrator_mode=self.narrator_mode,
                    started_at=self._started_at,
                )
                self._last_hb = now
            try:
                item = self._q.get(timeout=1.0)
            except queue.Empty:
                continue
            try:
                if item.get("type") == "candle":
                    self._on_candle(item["data"])
            except Exception:
                logger.exception("candle handler failed")

        self.ws.stop()
        self.sync.stop()
        logger.info("LiveScheduler stopped")

    def stop(self) -> None:
        self._stop.set()
        self.ws.stop()

    def _init_news_checker(self) -> None:
        """Build NewsChecker when news_behavior.enabled and API key present."""
        self.news_checker = None
        nb = dict(self.card.get("news_behavior") or {})
        if not nb.get("enabled", True):
            logger.info("NewsChecker disabled by character config")
            return
        api_key = (os.environ.get("DEEPSEEK_API_KEY") or "").strip()
        if not api_key:
            logger.info("NewsChecker disabled: DEEPSEEK_API_KEY missing")
            return
        try:
            from .db.migrations_v13 import apply_v13_migrations
            from .news.assessor import NewsAssessor
            from .news.checker import NewsChecker
            from .news.memory import NewsMemory
            from .news.query_builder import QueryBuilder
            from .news.search_client import SearchClient
            from .news.trigger import NewsTrigger

            apply_v13_migrations(self.conn)
            model = str(nb.get("model") or "deepseek-v4-flash")
            search_client = SearchClient(api_key, model=model)
            news_repo = NewsRepo(self.conn)
            assessments_repo = NewsAssessmentsRepo(self.conn)
            self.news_checker = NewsChecker(
                nb,
                search_client,
                NewsTrigger(nb),
                QueryBuilder(nb),
                NewsAssessor(nb, self.narrator),
                NewsMemory(assessments_repo, retention_days=int(
                    ((nb.get("memory_retention") or {}).get("daily_news_summary_days")) or 7
                )),
                self.bridge,
                self.person,
                {
                    "news_repo": news_repo,
                    "news_assessments_repo": assessments_repo,
                    "psychology_repo": PsychologyRepo(self.conn),
                },
                event_impacts=dict(self.card.get("event_impacts") or {}),
                behavior_classifier=self.classifier,
            )
            logger.info("NewsChecker enabled model=%s", model)
        except Exception as exc:  # noqa: BLE001
            logger.warning("NewsChecker init failed (non-blocking): %s", exc)
            self.news_checker = None

    def _get_recent_activity(self) -> dict[str, Any]:
        return {
            "consecutive_losses": 0,
            "hours_since_last_trade": 48.0,
            "days_to_major_macro_event": 99.0,
            "recent_big_win_within_6h": False,
            "after_big_move": False,
        }

    def _news_check_loop(self) -> None:
        """Every 15 minutes: decide whether Zhang Ming wants to check news."""
        while not self._stop.is_set():
            try:
                if self.news_checker is None:
                    break
                opens = []
                try:
                    opens = self.positions_repo.list_open() if hasattr(self.positions_repo, "list_open") else []
                except Exception:  # noqa: BLE001
                    opens = []
                portfolio = {
                    "position_count": len(opens or []),
                    "positions": opens or [],
                    "unrealized_pnl_pct": 0.0,
                }
                result = self.news_checker.tick(
                    current_time=datetime.now(timezone.utc).astimezone(),
                    portfolio=portfolio,
                    recent_activity=self._get_recent_activity(),
                )
                if result:
                    logger.info(
                        "News check triggered: window=%s query='%s' event_type=%s",
                        result.window,
                        result.query,
                        result.event_type,
                    )
            except Exception as exc:  # noqa: BLE001
                logger.error("News check failed: %s", exc)
            self._stop.wait(15 * 60)

    def _risk_loop(self) -> None:
        while not self._stop.is_set():
            try:
                if self.sync.pause_new_orders:
                    set_orders_paused(True)
                    logger.warning("orders paused due to account reconcile mismatch")
                self._maybe_daily_evolution()
            except Exception:
                logger.exception("periodic risk check failed")
            self._stop.wait(60.0)

    def _maybe_daily_evolution(self) -> None:
        """Run baseline evolution once per calendar day (UTC+8 near 23:59)."""
        from datetime import timedelta, timezone as tz

        tz8 = tz(timedelta(hours=8))
        now = datetime.now(tz8)
        today = now.date().isoformat()
        if today == self._last_evolution_date:
            return
        # Trigger after 23:50 local to approximate run_time 23:59
        if now.hour < 23 or now.minute < 50:
            return
        bal = self.sync.get_cached_balance() or {}
        equity = float(bal.get("equity") or self._day_start_equity)
        self._peak_equity = max(self._peak_equity, equity)
        if self._day_pnl > 0:
            self._days_profitable_streak += 1
            self._days_losing_streak = 0
        elif self._day_pnl < 0:
            self._days_losing_streak += 1
            self._days_profitable_streak = 0
        stats = collect_daily_stats(
            daily_pnl=self._day_pnl,
            start_equity=self._day_start_equity,
            equity=equity,
            peak_equity=self._peak_equity,
            consecutive_losses=0,
            days_profitable_streak=self._days_profitable_streak,
            days_losing_streak=self._days_losing_streak,
        )
        changes = apply_and_persist_evolution(
            self.person,
            stats,
            date=today,
            timestamp=now.isoformat(),
            baseline_repo=self.baseline_repo,
            trauma_repo=self.trauma_repo,
        )
        behavior = self.classifier.classify(self.person.state)
        process_new_day(
            today=today,
            person=self.person,
            deadline_repo=self.deadline_repo,
            ambient_repo=self.ambient_repo,
            narrator_bridge=self.bridge,
            behavior={
                "primary_mode": behavior.primary_mode,
                "modifiers": list(behavior.modifiers),
            },
        )
        maybe_run_deadline_evaluation(
            today=today,
            person=self.person,
            deadline_manager=self.deadline_manager,
            deadline_config=self.deadline_cfg,
            narrator=self.narrator,
            deadline_repo=self.deadline_repo,
            db_repos={"conn": self.conn, "positions_repo": self.positions_repo},
            starting_baseline=self.starting_baseline,
            pause_trading=self.pause_trading,
        )
        self.person.daily_decay()
        self._last_evolution_date = today
        self._day_pnl = 0.0
        self._day_start_equity = equity
        self.conn.commit()
        logger.info("daily evolution done date=%s changes=%s", today, len(changes))

    def pause_trading(self) -> None:
        self._trading_paused = True
        try:
            from .runtime_flags import set_orders_paused

            set_orders_paused(True)
        except Exception:
            pass
        logger.info("trading paused by deadline STOP")

    def notify_trauma_event(self, event: dict[str, Any]) -> None:
        logger.warning("TRAUMA: %s — %s", event.get("event_type"), event.get("description"))

    def _collect_daily_stats(self) -> dict[str, float]:
        bal = self.sync.get_cached_balance() or {}
        equity = float(bal.get("equity") or self._day_start_equity)
        return collect_daily_stats(
            daily_pnl=self._day_pnl,
            start_equity=self._day_start_equity,
            equity=equity,
            peak_equity=max(self._peak_equity, equity),
            consecutive_losses=0,
            days_profitable_streak=self._days_profitable_streak,
            days_losing_streak=self._days_losing_streak,
        )

    def _daily_evolution(self) -> None:
        """Explicit daily evolution entry (also used by tests)."""
        from datetime import timedelta, timezone as tz

        tz8 = tz(timedelta(hours=8))
        now = datetime.now(tz8)
        stats = self._collect_daily_stats()
        changes = apply_and_persist_evolution(
            self.person,
            stats,
            date=now.date().isoformat(),
            timestamp=now.isoformat(),
            baseline_repo=self.baseline_repo,
            trauma_repo=self.trauma_repo,
        )
        for change in changes:
            if change.get("type") == "trauma":
                self.notify_trauma_event(change.get("event") or {})
        self.person.daily_decay()
        self.conn.commit()
        return

    def _on_candle(self, candle: dict[str, Any]) -> None:
        ts = datetime.fromtimestamp(int(candle["timestamp"]) / 1000, tz=timezone.utc).isoformat()
        bar = {
            "timestamp": ts,
            "open": float(candle["open"]),
            "high": float(candle["high"]),
            "low": float(candle["low"]),
            "close": float(candle["close"]),
            "volume": float(candle.get("volume") or 0),
        }
        self._candles.append(bar)
        self._candles = self._candles[-500:]
        if len(self._candles) < 50:
            logger.info("warming up candles=%s", len(self._candles))
            return

        if orders_paused() or self.sync.pause_new_orders:
            logger.info("skip decision: orders paused")
            return

        market = MarketSnapshot(price=bar["close"], atr=abs(bar["high"] - bar["low"]), timestamp=ts)
        signals = self.signal_engine.generate_signals(self._candles, "BTC")
        behavior = self.classifier.classify(self.person.state)
        behavior_dict = {
            "primary_mode": behavior.primary_mode,
            "modifiers": list(behavior.modifiers),
        }

        for signal in signals:
            decision = self.decision_engine.decide(signal, self.person.state, behavior)
            decision_id = str(uuid4())
            risk_check = "SKIP"
            reject_reason = None
            position_id = None

            if decision.action.startswith("OPEN"):
                intent = TradeIntent.create(
                    decision,
                    symbol="BTC",
                    direction=signal.direction,
                    ttl_seconds=60,
                    entry_price_hint=market.price,
                    atr=market.atr,
                    leverage=float(self.risk_engine.config.get("execution", {}).get("default_leverage", 3.0)),
                    now=datetime.fromisoformat(ts),
                )
                intent.transition_to(STATUS_PENDING_RISK)
                from .position_manager import PositionManager
                from .risk_engine import PortfolioState

                bal = self.sync.get_cached_balance() or {}
                equity = float(bal.get("equity") or 20000.0)
                available = float(bal.get("available") or equity)
                remote = self.sync.get_cached_positions() or []
                open_n = sum(1 for p in remote if abs(float(p.get("pos") or 0)) > 0)
                portfolio = PortfolioState(
                    equity=equity,
                    cash=available,
                    open_position_count=open_n,
                    daily_pnl=0.0,
                    daily_start_equity=equity or 20000.0,
                )
                # Keep PositionManager for paper-compatible helpers if needed later
                _ = PositionManager(self.config_dir / "risk_rules.json")
                risk_result = self.risk_engine.check(intent, portfolio, market)
                intent.risk_result = risk_result
                if risk_result.approved:
                    intent.transition_to(STATUS_RISK_APPROVED)
                    # stash sizing for live executor
                    intent.margin = float(risk_result.margin)  # type: ignore[attr-defined]
                    intent.stop_loss = float(risk_result.stop_price)  # type: ignore[attr-defined]
                    execution = self.executor.execute(intent, market)
                    if execution.status == "FILLED":
                        risk_check = "PASS"
                        position_id = str(uuid4())
                        self.positions_repo.insert(
                            {
                                "position_id": position_id,
                                "decision_id": decision_id,
                                "symbol": "BTC",
                                "side": signal.direction,
                                "leverage": intent.leverage,
                                "margin": execution.margin,
                                "notional": execution.notional,
                                "entry_price": execution.entry_price,
                                "stop_loss": getattr(intent, "stop_loss", None),
                                "take_profit": None,
                                "status": "OPEN",
                                "fees": execution.fees,
                                "entry_time": ts,
                                "psychology_at_entry": self.person.snapshot(),
                                "exchange_order_id": None,
                            }
                        )
                    else:
                        risk_check = "REJECT"
                        reject_reason = execution.reject_reason
                else:
                    intent.transition_to(STATUS_RISK_REJECTED)
                    risk_check = "REJECT"
                    reject_reason = risk_result.reject_reason

            self.decision_repo.insert(
                {
                    "decision_id": decision_id,
                    "timestamp": ts,
                    "symbol": signal.symbol,
                    "direction": signal.direction,
                    "signal_rule": signal.rule_name,
                    "signal_raw_score": signal.raw_score,
                    "signal_score": signal.score,
                    "signal_reason": signal.reason,
                    "signal_rule_version": signal.rule_version,
                    "psychology_before": self.person.snapshot(),
                    "primary_mode": behavior.primary_mode,
                    "modifiers": behavior.modifiers,
                    "behavior_rule_version": behavior.rule_version,
                    "decision_reason": decision.decision_reason,
                    "decision_rule_version": decision.rule_version,
                    "decision": decision.action,
                    "position_multiplier": decision.position_multiplier,
                    "risk_check": risk_check,
                    "risk_reject_reason": reject_reason,
                    "position_id": position_id,
                    "config_snapshot_hash": f"live-{self.card.get('id')}",
                }
            )
            self.bridge.on_decision(
                decision_id=decision_id,
                state=self.person.snapshot(),
                behavior=behavior_dict,
                signal={
                    "symbol": signal.symbol,
                    "direction": signal.direction,
                    "score": signal.score,
                    "rule_name": signal.rule_name,
                    "reason": signal.reason,
                },
                decision={
                    "timestamp": ts,
                    "action": decision.action,
                    "threshold": decision.threshold,
                },
                recent_events=[],
                now=datetime.fromisoformat(ts),
            )
            self.conn.commit()
            logger.info(
                "decision %s action=%s risk=%s mode=%s",
                decision_id[:8],
                decision.action,
                risk_check,
                behavior.primary_mode,
            )


def main() -> None:
    parser = argparse.ArgumentParser(description="AI Trader live scheduler")
    parser.add_argument("--mock-narrator", action="store_true", help="强制使用 mock narrator")
    parser.add_argument("--real-narrator", action="store_true", help="强制使用真实 LLM narrator")
    parser.add_argument("--inst-id", default="BTC-USDT-SWAP")
    args = parser.parse_args()
    override: bool | None = None
    if args.mock_narrator and args.real_narrator:
        print("不能同时指定 --mock-narrator 与 --real-narrator", file=sys.stderr)
        raise SystemExit(2)
    if args.mock_narrator:
        override = True
    elif args.real_narrator:
        override = False

    scheduler = LiveScheduler(inst_id=args.inst_id, mock_narrator_override=override)

    def _shutdown(*_args: Any) -> None:
        logger.info("shutdown signal received")
        scheduler.stop()

    signal.signal(signal.SIGINT, _shutdown)
    signal.signal(signal.SIGTERM, _shutdown)
    scheduler.start()


if __name__ == "__main__":
    main()
