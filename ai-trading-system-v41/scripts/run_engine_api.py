#!/usr/bin/env python3
"""Run V4.1 internal API (long-lived). Default: http://127.0.0.1:8711"""

from __future__ import annotations

import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

# Load local .env before importing app (python-dotenv)
try:
    from dotenv import load_dotenv

    load_dotenv(ROOT / ".env", override=False)
except Exception:
    pass

import uvicorn


def _truthy(value: str | None) -> bool:
    return str(value or "").strip().lower() in {"1", "true", "yes", "on"}


def main() -> None:
    host = os.getenv("V41_ENGINE_HOST", "127.0.0.1")
    port = int(os.getenv("V41_ENGINE_PORT", "8711"))
    os.environ.setdefault("V41_ENGINE_INTERNAL_TOKEN", "dev-internal-token")
    os.environ.setdefault("V41_ENGINE_AUTOSTART", "1")
    hft = _truthy(os.getenv("V41_HFT_SIM_ENABLED"))
    print(
        f"HFT_SIM_CONFIG enabled={str(hft).lower()} "
        f"execution_target=simulator max_position_notional_usdt=50 "
        f"V41_HFT_SIM_ENABLED={os.getenv('V41_HFT_SIM_ENABLED')!r}",
        flush=True,
    )
    uvicorn.run(
        "src.api.app:app",
        host=host,
        port=port,
        reload=False,
        log_level="info",
    )


if __name__ == "__main__":
    main()
