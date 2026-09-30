import pytest
from src.web_replay import read_import


def test_export_with_equivalent_utc_bjt_and_epoch_columns(tmp_path):
    f = tmp_path/'export.csv'
    f.write_text('open_time_utc,open_time_bjt,open_time_ms,open,high,low,close,volume\n'
                 '2026-01-04T16:00:00Z,2026-01-05T00:00:00+08:00,1767542400000,100,102,99,101,1\n')
    bars, _ = read_import(f, 'XAUUSDT', 300000)
    assert bars[0].timestamp == 1767542400000
    f.write_text(f.read_text().replace('1767542400000', '1767542700000'))
    with pytest.raises(ValueError, match='时间列冲突.*open_time_ms'):
        read_import(f, 'XAUUSDT', 300000)


def test_conflicting_price_aliases_still_rejected(tmp_path):
    f = tmp_path/'prices.csv'
    f.write_text('timestamp,open,o,high,low,close,volume\n1767542400000,100,101,102,99,101,1\n')
    with pytest.raises(ValueError, match='重复列名'):
        read_import(f, 'XAUUSDT', 300000)


def test_minute_import_retains_gap(tmp_path):
    f = tmp_path/'minutes.csv'
    f.write_text('timestamp,open,high,low,close,volume\n'+'\n'.join(
        f'{1704067200+i*60},100,102,99,101,1' for i in range(15) if i != 7))
    bars, quality = read_import(f, 'XAUUSDT', 60000)
    assert len(bars) == 2 and quality['incomplete_5m_buckets'] == 1
    assert bars[1].timestamp-bars[0].timestamp == 600000
    assert bars[0].volume == 5


def test_headerless_binance_and_duplicate_rejected(tmp_path):
    f = tmp_path/'input.csv'
    f.write_text('1704067200000,100,102,99,101,10,unused\n1704067500000,101,103,100,102,20,unused\n')
    bars, _ = read_import(f, 'XAUUSDT', 300000)
    assert len(bars) == 2 and bars[0].timestamp == 1704067200000
    f.write_text('timestamp,open,high,low,close,volume\n1704067200000,100,102,99,101,1\n1704067200000,100,102,99,101,1')
    with pytest.raises(ValueError, match='重复'):
        read_import(f, 'XAUUSDT', 300000)


def test_parquet_and_symbol_mismatch(tmp_path):
    import pandas as pd
    f = tmp_path/'input.parquet'
    pd.DataFrame([dict(symbol='XAUUSDT', timestamp='2026-01-01T00:00:00Z', open=100, high=101, low=99, close=100, volume=1)]).to_parquet(f)
    assert len(read_import(f, 'XAUUSDT', 300000)[0]) == 1
    with pytest.raises(ValueError, match='symbol'):
        read_import(f, 'XAGUSDT', 300000)
