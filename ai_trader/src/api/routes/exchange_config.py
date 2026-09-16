"""Exchange API key configuration routes."""
from __future__ import annotations

import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from ...envutil import env_path, load_dotenv, mask_secret, read_env_file, write_env_updates
from ...exchange.okx_client import OKXAPIError, OKXClient
from ...runtime_flags import register_okx_client

router = APIRouter()


class ExchangeConfigUpdate(BaseModel):
    okx_api_key: str | None = None
    okx_secret_key: str | None = None
    okx_passphrase: str | None = None
    okx_demo: bool | None = None
    deepseek_api_key: str | None = None


class ExchangeConfigResponse(BaseModel):
    okx_api_key: str = ""
    okx_secret_key: str = ""
    okx_passphrase: str = ""
    okx_demo: bool = False
    deepseek_api_key: str = ""
    env_path: str = ""
    note: str = "更新后需重启服务才能完全生效"


@router.get("/exchange/config", response_model=ExchangeConfigResponse)
def get_exchange_config(request: Request) -> ExchangeConfigResponse:
    root = Path(request.app.state.project_root)
    load_dotenv(env_path(root))
    vals = read_env_file(env_path(root))
    return ExchangeConfigResponse(
        okx_api_key=mask_secret(vals.get("OKX_API_KEY") or ""),
        okx_secret_key=mask_secret(vals.get("OKX_SECRET_KEY") or ""),
        okx_passphrase=mask_secret(vals.get("OKX_PASSPHRASE") or ""),
        okx_demo=str(vals.get("OKX_DEMO", "false")).lower() in {"1", "true", "yes"},
        deepseek_api_key=mask_secret(vals.get("DEEPSEEK_API_KEY") or ""),
        env_path=str(env_path(root)),
    )


@router.post("/exchange/config", response_model=ExchangeConfigResponse)
def update_exchange_config(body: ExchangeConfigUpdate, request: Request) -> ExchangeConfigResponse:
    root = Path(request.app.state.project_root)
    updates: dict[str, Any] = {}
    if body.okx_api_key is not None and body.okx_api_key.strip():
        updates["OKX_API_KEY"] = body.okx_api_key.strip()
    if body.okx_secret_key is not None and body.okx_secret_key.strip():
        updates["OKX_SECRET_KEY"] = body.okx_secret_key.strip()
    if body.okx_passphrase is not None and body.okx_passphrase.strip():
        updates["OKX_PASSPHRASE"] = body.okx_passphrase.strip()
    if body.okx_demo is not None:
        updates["OKX_DEMO"] = "true" if body.okx_demo else "false"
    if body.deepseek_api_key is not None and body.deepseek_api_key.strip():
        updates["DEEPSEEK_API_KEY"] = body.deepseek_api_key.strip()
    if not updates:
        raise HTTPException(status_code=400, detail="no fields to update")
    write_env_updates(updates, env_path(root))
    # Invalidate readiness cache when keys change
    store = getattr(request.app.state, "ready_cache", None)
    if isinstance(store, dict):
        store.clear()
    conn: sqlite3.Connection = request.app.state.db
    conn.execute(
        "INSERT INTO exchange_config_log (timestamp, action, details) VALUES (?, ?, ?)",
        (datetime.now(timezone.utc).isoformat(), "UPDATE", ",".join(sorted(updates.keys()))),
    )
    conn.commit()
    # refresh client
    client = OKXClient()
    register_okx_client(client)
    request.app.state.okx_client = client
    return get_exchange_config(request)


@router.post("/exchange/test")
def test_exchange_connection(request: Request) -> dict[str, Any]:
    root = Path(request.app.state.project_root)
    load_dotenv(env_path(root))
    client = OKXClient(timeout=5.0)
    try:
        data = client.get_balance()
        store = getattr(request.app.state, "ready_cache", None)
        if not isinstance(store, dict):
            store = {}
            request.app.state.ready_cache = store
        import time

        store["okx"] = (time.time(), True, "OKX 检验通过")
        return {"ok": True, "message": "连接成功", "accounts": len(data or [])}
    except OKXAPIError as exc:
        store = getattr(request.app.state, "ready_cache", None)
        if not isinstance(store, dict):
            store = {}
            request.app.state.ready_cache = store
        import time

        store["okx"] = (time.time(), False, str(exc))
        return {"ok": False, "message": str(exc), "code": exc.code}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "message": str(exc)}
