"""Manual DeepSeek /responses + web_search smoke test."""
from __future__ import annotations

import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from src.envutil import load_dotenv  # noqa: E402
from src.news.search_client import SearchClient, SearchError  # noqa: E402


def main() -> int:
    load_dotenv(ROOT / ".env")
    key = (os.environ.get("DEEPSEEK_API_KEY") or "").strip()
    if not key:
        print("SKIP: DEEPSEEK_API_KEY missing — news search gracefully disabled")
        return 0
    client = SearchClient(key, model="deepseek-v4-flash")
    try:
        result = client.search("BTC 今日行情")
    except SearchError as exc:
        print(f"FAIL: {exc}")
        return 1
    print("query:", result.query)
    print("latency_ms:", result.latency_ms)
    print("token_usage:", result.token_usage)
    print("sources:", len(result.sources))
    print("answer:", (result.answer or "")[:400])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
