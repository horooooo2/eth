#!/bin/bash
cd "$(dirname "$0")/.."
python -m src.replay_with_narrator --mock --bars 500 --output reports/narrative_timeline_mock.md
echo "Mock replay 完成，输出：reports/narrative_timeline_mock.md"
