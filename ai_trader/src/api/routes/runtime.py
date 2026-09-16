"""Runtime readiness: character + OKX + DeepSeek."""
from __future__ import annotations

import json
import os
import time
from typing import Any
from urllib import error, request

from fastapi import APIRouter, Request
from pydantic import BaseModel, Field

from ...character.card import list_characters
from ...envutil import env_path, load_dotenv, read_env_file
from ...exchange.okx_client import OKXAPIError, OKXClient
from ..helpers import request_owner

router = APIRouter()

CACHE_TTL_SEC = 60.0


class RuntimeReadyResponse(BaseModel):
    ready: bool = False
    character_ok: bool = False
    okx_ok: bool = False
    deepseek_ok: bool = False
    character_id: str = ""
    okx_message: str = ""
    deepseek_message: str = ""
    missing: list[str] = Field(default_factory=list)


def _cache_get(app_state: Any, key: str) -> tuple[bool, Any] | None:
    store = getattr(app_state, "ready_cache", None)
    if not isinstance(store, dict):
        return None
    entry = store.get(key)
    if not entry:
        return None
    ts, ok, msg = entry
    if time.time() - float(ts) > CACHE_TTL_SEC:
        return None
    return bool(ok), str(msg or "")


def _cache_set(app_state: Any, key: str, ok: bool, msg: str) -> None:
    store = getattr(app_state, "ready_cache", None)
    if not isinstance(store, dict):
        store = {}
        app_state.ready_cache = store
    store[key] = (time.time(), bool(ok), str(msg or ""))


def _check_okx(app_state: Any, root) -> tuple[bool, str]:
    cached = _cache_get(app_state, "okx")
    if cached is not None:
        return cached
    load_dotenv(env_path(root))
    vals = read_env_file(env_path(root))
    if not (vals.get("OKX_API_KEY") and vals.get("OKX_SECRET_KEY") and vals.get("OKX_PASSPHRASE")):
        msg = "OKX API 未配置"
        _cache_set(app_state, "okx", False, msg)
        return False, msg
    client = OKXClient(timeout=5.0)
    try:
        client.get_balance()
        msg = "OKX 检验通过"
        _cache_set(app_state, "okx", True, msg)
        return True, msg
    except OKXAPIError as exc:
        msg = str(exc)
        _cache_set(app_state, "okx", False, msg)
        return False, msg
    except Exception as exc:  # noqa: BLE001
        msg = str(exc)
        _cache_set(app_state, "okx", False, msg)
        return False, msg


def _check_deepseek(app_state: Any, root) -> tuple[bool, str]:
    cached = _cache_get(app_state, "deepseek")
    if cached is not None:
        return cached
    load_dotenv(env_path(root))
    # Prefer live env (after write) then file
    api_key = (os.environ.get("DEEPSEEK_API_KEY") or "").strip()
    if not api_key:
        api_key = (read_env_file(env_path(root)).get("DEEPSEEK_API_KEY") or "").strip()
    if not api_key:
        msg = "DeepSeek API 未配置"
        _cache_set(app_state, "deepseek", False, msg)
        return False, msg
    req = request.Request(
        "https://api.deepseek.com/models",
        headers={"Authorization": f"Bearer {api_key}"},
        method="GET",
    )
    try:
        with request.urlopen(req, timeout=8.0) as resp:
            body = json.loads(resp.read().decode("utf-8"))
        models = body.get("data") if isinstance(body, dict) else None
        if isinstance(models, list) and models:
            msg = "DeepSeek API 可用"
            _cache_set(app_state, "deepseek", True, msg)
            return True, msg
        msg = "DeepSeek 返回异常"
        _cache_set(app_state, "deepseek", False, msg)
        return False, msg
    except error.HTTPError as exc:
        msg = f"DeepSeek HTTP {exc.code}"
        _cache_set(app_state, "deepseek", False, msg)
        return False, msg
    except Exception as exc:  # noqa: BLE001
        msg = str(exc)
        _cache_set(app_state, "deepseek", False, msg)
        return False, msg


@router.get("/runtime/ready", response_model=RuntimeReadyResponse)
def runtime_ready(request: Request) -> RuntimeReadyResponse:
    from pathlib import Path

    config_dir = Path(request.app.state.config_dir)
    root = Path(request.app.state.project_root)
    owner = request_owner(request)
    chars = list_characters(config_dir, owner)
    character_ok = len(chars) > 0
    character_id = chars[0]["id"] if chars else ""

    okx_ok, okx_message = _check_okx(request.app.state, root)
    deepseek_ok, deepseek_message = _check_deepseek(request.app.state, root)

    missing: list[str] = []
    if not character_ok:
        missing.append("角色性格文件")
    if not okx_ok:
        missing.append("OKX API")
    if not deepseek_ok:
        missing.append("DeepSeek API")

    return RuntimeReadyResponse(
        ready=character_ok and okx_ok and deepseek_ok,
        character_ok=character_ok,
        okx_ok=okx_ok,
        deepseek_ok=deepseek_ok,
        character_id=character_id,
        okx_message=okx_message,
        deepseek_message=deepseek_message,
        missing=missing,
    )


@router.post("/runtime/ready/refresh")
def runtime_ready_refresh(request: Request) -> RuntimeReadyResponse:
    """Force re-check OKX / DeepSeek (bypass cache)."""
    store = getattr(request.app.state, "ready_cache", None)
    if isinstance(store, dict):
        store.clear()
    return runtime_ready(request)
