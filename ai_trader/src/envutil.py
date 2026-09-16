"""Load / write project .env without third-party deps."""
from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Any


def project_root() -> Path:
    return Path(__file__).resolve().parents[1]


def env_path(root: Path | None = None) -> Path:
    return (root or project_root()) / ".env"


def load_dotenv(path: Path | None = None) -> dict[str, str]:
    """Parse .env into os.environ. Fills missing or empty keys from file."""
    p = path or env_path()
    values: dict[str, str] = {}
    if not p.exists():
        return values
    for line in p.read_text(encoding="utf-8").splitlines():
        s = line.strip()
        if not s or s.startswith("#") or "=" not in s:
            continue
        key, val = s.split("=", 1)
        key = key.strip()
        val = val.strip().strip('"').strip("'")
        values[key] = val
        cur = os.environ.get(key)
        if cur is None or str(cur).strip() == "":
            os.environ[key] = val
    return values


def read_env_file(path: Path | None = None) -> dict[str, str]:
    p = path or env_path()
    values: dict[str, str] = {}
    if not p.exists():
        return values
    for line in p.read_text(encoding="utf-8").splitlines():
        s = line.strip()
        if not s or s.startswith("#") or "=" not in s:
            continue
        key, val = s.split("=", 1)
        values[key.strip()] = val.strip().strip('"').strip("'")
    return values


def write_env_updates(updates: dict[str, Any], path: Path | None = None) -> Path:
    """Merge keys into .env preserving other lines."""
    p = path or env_path()
    existing_lines: list[str] = []
    if p.exists():
        existing_lines = p.read_text(encoding="utf-8").splitlines()
    keys = {k.upper(): str(v) for k, v in updates.items() if v is not None}
    seen: set[str] = set()
    out: list[str] = []
    for line in existing_lines:
        m = re.match(r"^([A-Za-z_][A-Za-z0-9_]*)=", line.strip())
        if m and m.group(1).upper() in {k.upper() for k in keys}:
            key = m.group(1)
            # find canonical key in updates
            match = next(k for k in keys if k.upper() == key.upper())
            out.append(f"{key}={keys[match]}")
            seen.add(match.upper())
        else:
            out.append(line)
    for k, v in keys.items():
        if k.upper() not in seen:
            out.append(f"{k}={v}")
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text("\n".join(out).rstrip() + "\n", encoding="utf-8")
    # refresh process env
    for k, v in keys.items():
        os.environ[k] = v
    return p


def mask_secret(value: str | None) -> str:
    if not value:
        return ""
    s = str(value)
    if len(s) <= 8:
        return "*" * len(s)
    return f"{s[:4]}...{s[-4:]}"
