import json
from pathlib import Path
import random
import subprocess
from src.models import Bar, STEP
from src.strategy_exhaustion import Exhaustion
from tests.synthetic_paths.test_paths import event, structure


def test_node_python_state_parity():
    root = Path(__file__).resolve().parents[2]
    cases = []
    randomizer = random.Random(42)
    for direction in ("UP", "DOWN"):
        for case in range(40):
            e = event(direction=direction)
            bars = structure() if case == 0 else []
            if not bars:
                close = 100
                for i in range(24):
                    new = close+randomizer.uniform(-7, 7)
                    bars.append(Bar(i*STEP, close, max(close, new)+randomizer.uniform(0, 4),
                                    min(close, new)-randomizer.uniform(0, 4), new))
                    close = new
            f = Exhaustion(e)
            expected = []
            for b in bars:
                f.advance(b)
                expected.append(dict(state=f.state, extreme=f.extreme, level=f.level, signalTime=f.signal_time))
            cases.append(dict(event=dict(eventId=e.event_id, direction=e.direction, detectedAt=e.detected_at,
                                         triggerClose=e.trigger_close, atr=e.atr, deadline=e.deadline),
                              bars=[vars(b) for b in bars], expected=expected))
    script = """
const fs=require('fs'); const core=require(fs.existsSync('./lib/tradfiEmotionCore.cjs') ? './lib/tradfiEmotionCore.cjs' : './whale-tracker-backend/lib/tradfiEmotionCore.cjs');
const cases=JSON.parse(fs.readFileSync(0,'utf8'));
const out=cases.map(c=>{let s=core.initial(c.event);return c.bars.map(b=>{s=core.advance(s,b).state;return {state:s.state,extreme:s.extreme,level:s.level,signalTime:s.signalTime};});});
process.stdout.write(JSON.stringify(out));
"""
    out = subprocess.run(["node", "-e", script], input=json.dumps(cases), capture_output=True, text=True, cwd=root, check=True)
    assert json.loads(out.stdout) == [c["expected"] for c in cases]
