"""SQLite schema for AI Trader persistence."""
from __future__ import annotations

import sqlite3

SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    event_type TEXT NOT NULL,
    event_subtype TEXT,
    event_class TEXT NOT NULL,
    compound_id TEXT,
    name TEXT NOT NULL,
    description TEXT,
    psychology_impact TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp);
CREATE INDEX IF NOT EXISTS idx_events_name ON events(name);

CREATE TABLE IF NOT EXISTS psychology_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    mood TEXT,
    mood_label TEXT,
    state_snapshot TEXT NOT NULL,
    narrative_text TEXT,
    prompt_version TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_psychology_timestamp ON psychology_log(timestamp);

CREATE TABLE IF NOT EXISTS decision_log (
    decision_id TEXT PRIMARY KEY,
    timestamp TEXT NOT NULL,
    symbol TEXT,
    direction TEXT,
    signal_rule TEXT,
    signal_raw_score REAL,
    signal_score REAL,
    signal_reason TEXT,
    signal_rule_version TEXT,
    psychology_before TEXT,
    primary_mode TEXT,
    modifiers TEXT,
    behavior_rule_version TEXT,
    decision_reason TEXT,
    decision_rule_version TEXT,
    decision TEXT,
    position_multiplier REAL,
    risk_check TEXT,
    risk_reject_reason TEXT,
    narrative_thought TEXT,
    narrative_body_action TEXT,
    narrative_generated_at TEXT,
    position_id TEXT,
    config_snapshot_hash TEXT,
    prompt_version TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_decision_timestamp ON decision_log(timestamp);
CREATE INDEX IF NOT EXISTS idx_decision_mode ON decision_log(primary_mode);
CREATE INDEX IF NOT EXISTS idx_decision_position ON decision_log(position_id);

CREATE TABLE IF NOT EXISTS decision_events (
    decision_id TEXT NOT NULL,
    event_id INTEGER NOT NULL,
    PRIMARY KEY (decision_id, event_id),
    FOREIGN KEY (decision_id) REFERENCES decision_log(decision_id),
    FOREIGN KEY (event_id) REFERENCES events(id)
);

CREATE INDEX IF NOT EXISTS idx_decision_events_event ON decision_events(event_id);

CREATE TABLE IF NOT EXISTS positions (
    position_id TEXT PRIMARY KEY,
    decision_id TEXT,
    symbol TEXT NOT NULL,
    side TEXT NOT NULL,
    leverage REAL,
    margin REAL,
    notional REAL,
    entry_price REAL,
    exit_price REAL,
    stop_loss REAL,
    take_profit REAL,
    status TEXT NOT NULL,
    realized_pnl REAL DEFAULT 0,
    fees REAL DEFAULT 0,
    max_favorable_excursion REAL DEFAULT 0,
    max_adverse_excursion REAL DEFAULT 0,
    entry_time TEXT,
    exit_time TEXT,
    exit_reason TEXT,
    psychology_at_entry TEXT,
    psychology_at_exit TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (decision_id) REFERENCES decision_log(decision_id)
);

CREATE INDEX IF NOT EXISTS idx_positions_status ON positions(status);
CREATE INDEX IF NOT EXISTS idx_positions_entry_time ON positions(entry_time);
CREATE INDEX IF NOT EXISTS idx_positions_symbol ON positions(symbol);

CREATE TABLE IF NOT EXISTS traits_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    risk_appetite REAL,
    patience REAL,
    focus REAL,
    self_doubt REAL,
    stubbornness REAL,
    stress REAL,
    sleep_debt REAL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_traits_date ON traits_history(date);

CREATE TABLE IF NOT EXISTS baseline_traits_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    risk_appetite REAL,
    patience REAL,
    focus REAL,
    self_doubt REAL,
    stubbornness REAL,
    stress REAL,
    sleep_debt REAL,
    change_reason TEXT,
    change_detail TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_baseline_date ON baseline_traits_history(date);

CREATE TABLE IF NOT EXISTS trauma_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    event_type TEXT NOT NULL,
    description TEXT,
    baseline_impact TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_trauma_timestamp ON trauma_events(timestamp);

CREATE TABLE IF NOT EXISTS ambient_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    date TEXT NOT NULL,
    name TEXT NOT NULL,
    impacts TEXT,
    description TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_ambient_date ON ambient_events(date);

CREATE TABLE IF NOT EXISTS deadline_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    day_number INTEGER NOT NULL,
    days_left INTEGER,
    pressure REAL,
    evaluation_action TEXT,
    evaluation_reason TEXT,
    new_deadline_days INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_deadline_date ON deadline_history(date);

CREATE TABLE IF NOT EXISTS conversation_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    state_snapshot TEXT,
    trigger_type TEXT DEFAULT 'passive',
    impact_applied TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_conv_timestamp ON conversation_messages(timestamp);

CREATE TABLE IF NOT EXISTS news_checks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    window TEXT,
    context_tags TEXT,
    query TEXT,
    search_answer TEXT,
    sources TEXT,
    latency_ms INTEGER,
    token_usage TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_news_checks_timestamp ON news_checks(timestamp);

CREATE TABLE IF NOT EXISTS news_assessments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    check_id INTEGER,
    timestamp TEXT NOT NULL,
    direction TEXT,
    impact_level TEXT,
    key_point TEXT,
    event_type TEXT,
    confidence REAL,
    psychology_text TEXT,
    body_action_text TEXT,
    impact_applied TEXT,
    window TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (check_id) REFERENCES news_checks(id)
);

CREATE INDEX IF NOT EXISTS idx_news_assessments_timestamp ON news_assessments(timestamp);
CREATE INDEX IF NOT EXISTS idx_news_assessments_event_type ON news_assessments(event_type);
"""


def init_database(conn: sqlite3.Connection) -> None:
    """Create all tables idempotently and apply lightweight migrations."""
    conn.executescript(SCHEMA_SQL)
    _ensure_column(conn, "psychology_log", "prompt_version", "TEXT")
    _ensure_column(conn, "decision_log", "prompt_version", "TEXT")
    from .migrations_v10 import apply_v10_migrations
    from .migrations_v11 import apply_v11_migrations
    from .migrations_v12 import apply_v12_migrations
    from .migrations_v13 import apply_v13_migrations

    apply_v10_migrations(conn)
    apply_v11_migrations(conn)
    apply_v12_migrations(conn)
    apply_v13_migrations(conn)
    conn.commit()


def _ensure_column(
    conn: sqlite3.Connection,
    table: str,
    column: str,
    col_type: str,
) -> None:
    rows = conn.execute(f"PRAGMA table_info({table})").fetchall()
    names = {str(r[1]) for r in rows}
    if column not in names:
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {col_type}")
