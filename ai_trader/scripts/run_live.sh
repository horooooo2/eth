#!/bin/bash
cd "$(dirname "$0")/.."

if [ ! -f ".env" ]; then
    echo "错误：.env 文件不存在"
    exit 1
fi

export AI_TRADER_DB="${AI_TRADER_DB:-$(pwd)/data/trader.db}"
mkdir -p "$(dirname "$AI_TRADER_DB")"
echo "使用数据库：$AI_TRADER_DB"

# Optional: AI_TRADER_NARRATOR=mock|real
EXTRA_ARGS=()
if [ "${AI_TRADER_NARRATOR}" = "mock" ]; then
  EXTRA_ARGS+=(--mock-narrator)
elif [ "${AI_TRADER_NARRATOR}" = "real" ]; then
  EXTRA_ARGS+=(--real-narrator)
fi

echo "警告：即将启动实盘交易"
echo "5 秒后开始，按 Ctrl+C 取消"
sleep 5

python -m src.live_scheduler "${EXTRA_ARGS[@]}" "$@"
