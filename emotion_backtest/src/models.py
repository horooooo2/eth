from dataclasses import dataclass
from math import isfinite

STEP = 300_000
HOUR = 12 * STEP


@dataclass(frozen=True)
class Bar:
    timestamp: int
    open: float
    high: float
    low: float
    close: float
    volume: float = 0
    symbol: str = "TEST"

    def __post_init__(self):
        values = (self.open, self.high, self.low, self.close, self.volume)
        if (not all(isfinite(x) for x in values) or min(values[:4]) <= 0
                or self.volume < 0 or self.low > min(self.open, self.close)
                or self.high < max(self.open, self.close) or self.timestamp % STEP):
            raise ValueError("Invalid aligned OHLCV bar")


@dataclass(frozen=True)
class Config:
    maker_fee_bps: float
    taker_fee_bps: float
    sizing_entry_slippage_bps: float
    sizing_stop_slippage_bps: float
    actual_entry_slippage_bps: float
    actual_exit_slippage_bps: float
    risk_budget_usdt: float

    def __post_init__(self):
        for name, value in vars(self).items():
            if not isfinite(value) or value < 0:
                raise ValueError(f"Invalid {name}")
            if name.endswith("bps") and value >= 10_000:
                raise ValueError(f"Invalid {name}")
        if self.risk_budget_usdt <= 0:
            raise ValueError("Positive risk budget required")


@dataclass(frozen=True)
class Meta:
    tick_size: float
    qty_step: float
    min_qty: float
    min_notional: float

    def __post_init__(self):
        if not all(isfinite(x) and x >= 0 for x in vars(self).values()):
            raise ValueError("Invalid exchange metadata")
        if self.tick_size <= 0 or self.qty_step <= 0:
            raise ValueError("Positive tick and step required")


@dataclass(frozen=True)
class Event:
    event_id: str
    symbol: str
    direction: str
    detected_at: int
    trigger_close: float
    reference_price: float
    atr: float
    historical_quantile: float = 0
    return_1h: float = 0

    @property
    def sign(self):
        return -1 if self.direction == "UP" else 1

    @property
    def deadline(self):
        return self.detected_at + 24 * STEP
