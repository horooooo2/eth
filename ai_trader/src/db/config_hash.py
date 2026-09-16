"""Stable hash over all config JSON files."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path


def compute_config_hash(config_dir: Path) -> str:
    """
    Hash every *.json under config_dir with sorted keys.
    Same files always yield the same 16-char hex prefix.
    """
    payload: dict[str, object] = {}
    for path in sorted(Path(config_dir).glob("*.json")):
        payload[path.name] = json.loads(path.read_text(encoding="utf-8"))
    serialized = json.dumps(payload, sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(serialized.encode("utf-8")).hexdigest()[:16]
