"""Append-only LLM call metadata log (no prompt bodies)."""
from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_LOG = ROOT / "logs" / "llm_calls.log"


def log_llm_call(
    *,
    component: str,
    scene: str,
    latency_ms: float,
    status: str,
    prompt_tokens: int | None = None,
    completion_tokens: int | None = None,
    fallback: str | None = None,
    log_path: Path | None = None,
) -> None:
    path = Path(log_path or DEFAULT_LOG)
    path.parent.mkdir(parents=True, exist_ok=True)
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    pt = str(prompt_tokens) if prompt_tokens is not None else "-"
    ct = str(completion_tokens) if completion_tokens is not None else "-"
    extra = f" | fallback={fallback}" if fallback else ""
    line = (
        f"{ts} | {component} | {scene} | prompt_tokens={pt} | "
        f"completion_tokens={ct} | latency_ms={int(latency_ms)} | status={status}{extra}\n"
    )
    with path.open("a", encoding="utf-8") as fh:
        fh.write(line)


def count_llm_calls_today(log_path: Path | None = None) -> int:
    path = Path(log_path or DEFAULT_LOG)
    if not path.exists():
        return 0
    day = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    n = 0
    try:
        for line in path.read_text(encoding="utf-8").splitlines():
            if line.startswith(day) and "| status=ok" in line:
                n += 1
    except OSError:
        return 0
    return n
