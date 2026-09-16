"""
统一的数据库路径解析。

所有模块必须通过这个函数获取 DB 路径，不允许硬编码。
"""
from __future__ import annotations

import os
from pathlib import Path


def project_root() -> Path:
    return Path(__file__).resolve().parent.parent.parent


def get_db_path() -> Path:
    """
    获取当前使用的数据库路径。

    优先级：
    1. 环境变量 AI_TRADER_DB
    2. 项目根目录下的 data/trader.db
    """
    env_path = os.environ.get("AI_TRADER_DB")
    if env_path and str(env_path).strip():
        return Path(env_path).expanduser().resolve()
    return (project_root() / "data" / "trader.db").resolve()


def get_db_path_str() -> str:
    return str(get_db_path())
