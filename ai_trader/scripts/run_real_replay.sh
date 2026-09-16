#!/bin/bash
cd "$(dirname "$0")/.."

if [ -z "$DEEPSEEK_API_KEY" ]; then
    echo "错误：DEEPSEEK_API_KEY 未设置"
    exit 1
fi

echo "即将调用真实 API，预计消耗 0.05~0.20 元"
echo "5 秒后开始..."
sleep 5

python -m src.replay_with_narrator --real --bars 200 --output reports/narrative_timeline_real.md
echo "真实 replay 完成，输出：reports/narrative_timeline_real.md"
