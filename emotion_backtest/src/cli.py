import argparse
import hashlib
import importlib.metadata
import json
from pathlib import Path
import subprocess
import sys
from .models import Config, Meta
from .data import load, resample
from .events import detect
from .engine import Run


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["run"])
    for name in ("config", "input", "exchange-meta", "output"):
        parser.add_argument("--"+name, required=True)
    args = parser.parse_args()
    import yaml
    import pandas as pd
    raw = yaml.safe_load(Path(args.config).read_text(encoding="utf-8"))
    if not isinstance(raw, dict) or any(v is None for v in raw.values()):
        parser.error("Explicit non-null cost/risk configuration required")
    config = Config(**raw)
    metadata = {}
    for r in pd.read_csv(args.exchange_meta).to_dict("records"):
        if r["symbol"] in metadata:
            parser.error("Duplicate metadata symbol")
        metadata[r["symbol"]] = Meta(**{k: float(r[k]) for k in ("tick_size", "qty_step", "min_qty", "min_notional")})
    root = Path(__file__).resolve().parents[1]
    # No historical processing before deterministic synthetic acceptance.
    subprocess.run([sys.executable, "-m", "pytest", "-q", "-p", "no:cacheprovider", str(root/"tests")], cwd=root, check=True)
    bars = load(args.input)
    events, diagnostics = detect(resample(bars))
    run = Run(config, metadata).execute(bars, events)
    from .reporting import report
    sources = sorted((root/"src").glob("*.py"))
    manifest = dict(spec_version="v1.0.1-final", implementation_status="BASELINE",
                    interpretations="S01-S10; TIME=24th-close; reset_samebar=true; ESS=null",
                    input_sha256=sha(args.input), config_sha256=sha(args.config), metadata_sha256=sha(args.exchange_meta),
                    source_sha256={p.name: sha(p) for p in sources},
                    spec_sha256={p.name: sha(p) for p in (root/"specs").glob("*.md")},
                    dependencies={n: importlib.metadata.version(n) for n in ("pandas", "numpy", "pyarrow", "matplotlib", "pytest", "PyYAML")},
                    python=sys.version, funding_included=False, sizing_entry_slippage_applied=False,
                    quantile_method="linear", bootstrap_seed=42, config=raw)
    report(run, args.output, manifest)
    Path(args.output, "candidate_diagnostics.json").write_text(json.dumps(diagnostics), encoding="utf-8")
    print(f"Completed: {len(events)} events; {args.output}")


if __name__ == "__main__":
    main()
