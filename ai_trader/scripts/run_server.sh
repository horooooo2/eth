#!/bin/bash
cd "$(dirname "$0")/.."

export AI_TRADER_DB="${AI_TRADER_DB:-$(pwd)/data/trader.db}"
mkdir -p "$(dirname "$AI_TRADER_DB")"
echo "使用数据库：$AI_TRADER_DB"
echo "启动 FastAPI 服务..."
echo "访问：http://localhost:8000"
echo "按 Ctrl+C 停止"

python -m uvicorn src.api.server:app --host 0.0.0.0 --port 8000 --reload
