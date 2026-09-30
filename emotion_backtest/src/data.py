from .models import Bar, HOUR, STEP


def validate(bars):
    keys = [(b.symbol, b.timestamp) for b in bars]
    if len(set(keys)) != len(keys):
        raise ValueError("Duplicate symbol/timestamp")
    return sorted(bars, key=lambda b: (b.timestamp, b.symbol))


def resample(bars):
    groups = {}
    for b in validate(bars):
        groups.setdefault((b.symbol, b.timestamp // HOUR * HOUR), []).append(b)
    out = []
    for (symbol, t), group in sorted(groups.items()):
        if [b.timestamp for b in group] != list(range(t, t+HOUR, STEP)):
            continue
        out.append(Bar(t, group[0].open, max(b.high for b in group), min(b.low for b in group),
                       group[-1].close, sum(b.volume for b in group), symbol))
    return out


def load(path):
    import pandas as pd
    frame = pd.read_parquet(path) if str(path).endswith(".parquet") else pd.read_csv(path)
    required = {"symbol", "timestamp", "open", "high", "low", "close", "volume"}
    if not required <= set(frame.columns):
        raise ValueError(f"Missing columns: {required-set(frame.columns)}")
    if pd.api.types.is_numeric_dtype(frame.timestamp):
        timestamps = pd.to_datetime(frame.timestamp, unit="ms", utc=True, errors="raise")
    else:
        timestamps = pd.to_datetime(frame.timestamp, utc=True, errors="raise")
    if timestamps.isna().any():
        raise ValueError("Missing timestamps")
    result = []
    for i, row in enumerate(frame.to_dict("records")):
        timestamp = int(timestamps.iloc[i].value // 1_000_000)
        if timestamps.iloc[i].value % 1_000_000:
            raise ValueError("Sub-millisecond input")
        result.append(Bar(timestamp, *(float(row[k]) for k in ("open", "high", "low", "close", "volume")), str(row["symbol"])))
    return validate(result)
