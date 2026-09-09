"""Structured JSON logging and immutable audit log."""

from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Mapping, Optional


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload: Dict[str, Any] = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
        }
        extra = getattr(record, "extra_fields", None)
        if isinstance(extra, dict):
            payload.update(extra)
        if record.exc_info:
            payload["exc_info"] = self.formatException(record.exc_info)
        return json.dumps(payload, ensure_ascii=False)


def setup_logger(
    name: str = "ai_trading",
    log_dir: Optional[str | Path] = None,
    level: int = logging.INFO,
) -> logging.Logger:
    logger = logging.getLogger(name)
    if logger.handlers:
        return logger
    logger.setLevel(level)
    handler = logging.StreamHandler()
    handler.setFormatter(JsonFormatter())
    logger.addHandler(handler)

    if log_dir is None:
        log_dir = Path(__file__).resolve().parents[2] / "logs"
    log_dir = Path(log_dir)
    log_dir.mkdir(parents=True, exist_ok=True)
    fh = logging.FileHandler(log_dir / "system.jsonl", encoding="utf-8")
    fh.setFormatter(JsonFormatter())
    logger.addHandler(fh)
    return logger


def get_audit_logger(log_dir: Optional[str | Path] = None) -> "AuditLogger":
    if log_dir is None:
        log_dir = Path(__file__).resolve().parents[2] / "logs"
    return AuditLogger(Path(log_dir) / "audit.jsonl")


class AuditLogger:
    """Append-only audit sink."""

    def __init__(self, path: Path) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)

    def write(self, record: Mapping[str, Any]) -> None:
        payload = dict(record)
        payload.setdefault("timestamp", datetime.now(timezone.utc).isoformat())
        with self.path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(payload, ensure_ascii=False) + "\n")


def log_decision(logger: logging.Logger, fields: Mapping[str, Any], required: Optional[list] = None) -> None:
    payload = dict(fields)
    if required:
        for key in required:
            payload.setdefault(key, None)
    logger.info("decision", extra={"extra_fields": payload})
