"""File-based bridge for the authenticated Node replay job, never an HTTP/trade server."""
import argparse
import json
from pathlib import Path
import sys
import hashlib
import subprocess
from .models import Bar, Config, Meta, STEP
from .data import validate, resample
from .events import detect
from .engine import Run
from .reporting import report


def read_import(path, symbol, interval):
    import pandas as pd
    aliases = {"time": "timestamp", "datetime": "timestamp", "open_time": "timestamp", "open time": "timestamp",
               "open_time_ms": "timestamp", "open_time_utc": "timestamp", "open_time_bjt": "timestamp", "o": "open", "h": "high", "l": "low",
               "c": "close", "v": "volume", "vol": "volume"}
    if path.suffix == ".parquet":
        frame = pd.read_parquet(path)
    else:
        frame = pd.read_csv(path)
        names = [str(x).strip().lower() for x in frame.columns]
        if not any(x in ("timestamp", *[k for k, v in aliases.items() if v == "timestamp"]) for x in names):
            frame = pd.read_csv(path, header=None)
            if len(frame.columns) < 6:
                raise ValueError("K线至少需要 timestamp,open,high,low,close,volume 六列")
            frame = frame.iloc[:, :6]
            frame.columns = ["timestamp", "open", "high", "low", "close", "volume"]
    if len(frame) == 0:
        raise ValueError("文件需包含至少一行 K线")
    original_names = [str(c).strip().lower() for c in frame.columns]
    normalized_names = [aliases.get(c, c) for c in original_names]
    time_columns = [i for i, name in enumerate(normalized_names) if name == "timestamp"]
    def parse_time(column):
        numeric = pd.to_numeric(column, errors="coerce")
        if numeric.notna().all():
            largest = numeric.abs().max()
            unit = "s" if largest < 100_000_000_000 else "ms" if largest < 100_000_000_000_000 else "us" if largest < 100_000_000_000_000_000 else "ns"
            return pd.to_datetime(numeric, unit=unit, utc=True)
        return pd.to_datetime(column, utc=True, errors="raise")

    # Exporters often include both epoch and human-readable UTC/local times.
    # Compare actual instants before collapsing their aliases into one column.
    times = None
    if time_columns:
        first = time_columns[0]
        times = parse_time(frame.iloc[:, first])
        for index in time_columns[1:]:
            other = parse_time(frame.iloc[:, index])
            if not (times == other).all():
                raise ValueError(f"时间列冲突：{original_names[first]} 与 {original_names[index]} 不一致")
        keep = [i for i in range(len(normalized_names)) if i not in time_columns[1:]]
        frame = frame.iloc[:, keep].copy()
        normalized_names = [normalized_names[i] for i in keep]
    frame.columns = normalized_names
    if frame.columns.duplicated().any():
        raise ValueError("重复列名")
    if "symbol" in frame and set(frame.symbol.astype(str).str.upper()) != {symbol}:
        raise ValueError("文件 symbol 与所选标的不一致；每次回放导入一个标的")
    required = ["timestamp", "open", "high", "low", "close", "volume"]
    if not set(required) <= set(frame.columns):
        raise ValueError("缺少 timestamp/open/high/low/close/volume 列")
    assert times is not None
    if times.isna().any() or times.duplicated().any():
        raise ValueError("时间戳缺失或重复")
    # Numeric prices must not be silently interpolated/coerced through gaps.
    prices = frame[required[1:]].apply(pd.to_numeric, errors="raise")
    rows = []
    for i, values in enumerate(prices.itertuples(index=False, name=None)):
        ns = times.iloc[i].value
        if ns % (interval * 1_000_000):
            raise ValueError("K线时间未按所选周期对齐")
        t = ns // 1_000_000
        o, h, l, c, v = map(float, values)
        # Bar validation is 5m-aligned: validate the prices at a neutral time first.
        checked = Bar(0, o, h, l, c, v, symbol)
        rows.append((t, checked))
    rows.sort(key=lambda x: x[0])
    incomplete = 0
    if interval == STEP:
        bars = [Bar(t, b.open, b.high, b.low, b.close, b.volume, symbol) for t, b in rows]
    else:
        groups = {}
        for t, b in rows:
            groups.setdefault(t // STEP * STEP, []).append((t, b))
        bars = []
        for t, group in sorted(groups.items()):
            if [x[0] for x in group] != list(range(t, t+STEP, interval)):
                incomplete += 1
                continue
            xs = [x[1] for x in group]
            bars.append(Bar(t, xs[0].open, max(x.high for x in xs), min(x.low for x in xs), xs[-1].close,
                            sum(x.volume for x in xs), symbol))
    return validate(bars), dict(input_rows=len(frame), valid_5m_bars=len(bars), incomplete_5m_buckets=incomplete)


def stage(name):
    print(json.dumps({"stage": name}), flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("job_dir")
    args = parser.parse_args()
    job = Path(args.job_dir).resolve()
    request = json.loads((job/"request.json").read_text(encoding="utf-8"))
    c = Config(**request["config"])
    meta = Meta(**request["meta"])
    stage("验证回测核心")
    root = Path(__file__).resolve().parents[1]
    subprocess.run([sys.executable, "-m", "pytest", "-q", "-p", "no:cacheprovider", str(root/"tests")], cwd=root, check=True)
    stage("校验并聚合导入数据")
    input_file = job/("input.parquet" if request["format"] == "parquet" else "input.csv")
    bars, quality = read_import(input_file, request["symbol"], request["interval"])
    if not bars:
        raise ValueError("没有完整有效的 5m K线")
    stage("检测事前异常事件")
    events, diagnostics = detect(resample(bars))
    stage("计算 A/B 执行与账务")
    run = Run(c, {request["symbol"]: meta}).execute(bars, events)
    stage("生成配对统计与回放结果")
    manifest = dict(spec_version="v1.0.1-final", engine="canonical_python", funding_included=False,
                    config=vars(c), metadata=vars(meta), quality=quality,
                    input_sha256=hashlib.sha256(input_file.read_bytes()).hexdigest(),
                    source_sha256={p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in (root/"src").glob("*.py")},
                    time_exit="24th_bar_close", symbol=request["symbol"])
    report(run, job/"report", manifest)
    payload = dict(manifest=manifest, quality=quality,
                   bars=[[b.timestamp, b.open, b.high, b.low, b.close, b.volume] for b in bars],
                   events=run.event_records, results=run.results, trace=run.trace, ledger=run.ledger,
                   equity=run.equity,
                   summary=json.loads((job/"report/summary.json").read_text(encoding="utf-8")),
                   paired=json.loads((job/"report/paired_comparisons.json").read_text(encoding="utf-8")),
                   diagnostics={reason: sum(x["reason"] == reason for x in diagnostics) for reason in {x["reason"] for x in diagnostics}})
    (job/"result.json").write_text(json.dumps(payload, ensure_ascii=False, allow_nan=False), encoding="utf-8")
    stage("完成")


if __name__ == "__main__":
    main()
