"""
FastAPI 主入口。

启动方式：
    uvicorn src.api.server:app --host 0.0.0.0 --port 8000
或：
    python -m src.api.server
"""
from __future__ import annotations

import os
import sqlite3
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from ..db.migrations_v8 import apply_v8_migrations
from ..db.migrations_v9 import apply_v9_migrations
from ..db.migrations_v10 import apply_v10_migrations
from ..db.migrations_v11 import apply_v11_migrations
from ..db.path import get_db_path
from ..envutil import load_dotenv
from ..exchange.account_sync import AccountSync
from ..exchange.okx_client import OKXClient
from ..runtime_flags import register_account_sync, register_okx_client
from .routes import (
    account,
    character,
    conversation,
    deadline,
    decisions,
    exchange_config,
    positions,
    runtime,
    safety,
    state,
    system,
    timeline,
)

ROOT = Path(__file__).resolve().parents[2]
WEB_DIR = ROOT / "web"


def _open_db(path: Path) -> sqlite3.Connection:
    """Open connection usable across FastAPI worker threads."""
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(path), check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    return conn


def create_app(db_path: str | Path | None = None) -> FastAPI:
    load_dotenv(ROOT / ".env")
    app = FastAPI(title="AI Trader API", version="1.0.0")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["*"],
        allow_headers=["*"],
    )
    path = Path(db_path).resolve() if db_path is not None else get_db_path()
    conn = _open_db(path)
    apply_v8_migrations(conn)
    apply_v9_migrations(conn)
    apply_v10_migrations(conn)
    apply_v11_migrations(conn)
    from ..db.migrations_v12 import apply_v12_migrations

    apply_v12_migrations(conn)
    app.state.db = conn
    app.state.db_path = str(path)
    app.state.project_root = str(ROOT)
    app.state.config_dir = str(ROOT / "config")
    client = OKXClient()
    app.state.okx_client = client
    register_okx_client(client)

    # Background OKX balance sync when API keys are present
    sync: AccountSync | None = None
    if client.api_key and client.secret_key and client.passphrase:
        sync = AccountSync(client=client, conn=conn, interval_sec=30.0)
        try:
            sync.sync_once()
        except Exception:
            pass
        sync.start()
    app.state.account_sync = sync
    register_account_sync(sync)

    # Conversation / chat controller (shares PersonStateEngine with API)
    try:
        from ..conversation.factory import build_chat_controller

        chat, conv_repo, state_engine = build_chat_controller(
            config_dir=ROOT / "config",
            conn=conn,
            project_root=ROOT,
        )
        if sync is not None:

            def _account_from_sync() -> dict:
                bal = sync.get_cached_balance() or {}
                pos = sync.get_cached_positions() if hasattr(sync, "get_cached_positions") else []
                return {
                    "equity": float(bal.get("equity") or 20000),
                    "today_pnl": float(bal.get("today_pnl") or 0),
                    "position_count": len(pos or []),
                }

            chat.account_provider = _account_from_sync
        app.state.chat_controller = chat
        app.state.conversation_repo = conv_repo
        app.state.state_engine = state_engine
    except Exception as exc:  # noqa: BLE001
        import logging

        logging.getLogger(__name__).warning("chat controller init failed: %s", exc)
        app.state.chat_controller = None
        app.state.conversation_repo = None
        app.state.state_engine = None

    app.include_router(account.router, prefix="/api")
    app.include_router(state.router, prefix="/api")
    app.include_router(character.router, prefix="/api")
    app.include_router(conversation.router, prefix="/api")
    app.include_router(deadline.router, prefix="/api")
    app.include_router(positions.router, prefix="/api")
    app.include_router(timeline.router, prefix="/api")
    app.include_router(decisions.router, prefix="/api")
    app.include_router(exchange_config.router, prefix="/api")
    app.include_router(runtime.router, prefix="/api")
    app.include_router(system.router, prefix="/api")
    app.include_router(safety.router, prefix="/api")

    @app.get("/api/health")
    def health() -> dict:
        return {
            "ok": True,
            "db": app.state.db_path,
            "character": Path(app.state.config_dir, "active_character.txt").read_text(encoding="utf-8").strip()
            if Path(app.state.config_dir, "active_character.txt").exists()
            else "",
        }

    # Unmatched /api/* must not fall through to StaticFiles (POST→405 Method Not Allowed).
    @app.api_route(
        "/api/{full_path:path}",
        methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        include_in_schema=False,
    )
    def api_not_found(full_path: str) -> None:
        from fastapi import HTTPException

        raise HTTPException(status_code=404, detail=f"Not Found: /api/{full_path}")

    if WEB_DIR.is_dir():
        app.mount("/", StaticFiles(directory=str(WEB_DIR), html=True), name="web")

    return app


app = create_app()


def main() -> None:
    import uvicorn

    uvicorn.run(
        "src.api.server:app",
        host="0.0.0.0",
        port=int(os.environ.get("PORT", "8000")),
        reload=os.environ.get("RELOAD", "0") == "1",
    )


if __name__ == "__main__":
    main()
