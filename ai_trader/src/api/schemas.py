"""Pydantic response models for AI Trader API."""
from __future__ import annotations

from typing import Any, Literal, Optional

from pydantic import BaseModel, Field


class AccountResponse(BaseModel):
    equity: float
    available: float
    today_pnl: float
    today_pnl_pct: float
    position_count: int
    risk_exposure_pct: float
    risk_cap_pct: float = 1.0
    last_sync: str | None = None
    source: str = "paper"


class StateResponse(BaseModel):
    mood: str
    mood_label: str
    risk_appetite: float
    patience: float
    focus: float
    self_doubt: float
    stubbornness: float
    stress: float
    sleep_debt: float
    primary_mode: str
    modifiers: list[str] = Field(default_factory=list)
    mode_label: str
    last_updated: str


class TraitItem(BaseModel):
    name: str
    value: float
    change_7d: float


class RecentEventItem(BaseModel):
    time: str
    icon: str
    text: str


class CharacterResponse(BaseModel):
    available: bool = True
    id: str | None = None
    name: str = ""
    age: int | None = None
    occupation: str = ""
    location: str = ""
    tags: list[str] = Field(default_factory=list)
    traits: list[TraitItem] = Field(default_factory=list)
    emotion_arc: str = ""
    recent_events: list[RecentEventItem] = Field(default_factory=list)
    baseline: dict[str, float] = Field(default_factory=dict)
    baseline_trend: dict[str, float] = Field(default_factory=dict)
    recent_trauma: list[dict[str, Any]] = Field(default_factory=list)
    deadline: dict[str, Any] | None = None


class CurrentPosition(BaseModel):
    position_id: str
    symbol: str
    side: str
    leverage: float
    margin: float
    entry_price: float
    current_price: float
    stop_loss: Optional[float] = None
    take_profit: Optional[float] = None
    pnl: float
    pnl_pct: float
    holding_minutes: int
    psychology_mood: str
    decision_id: Optional[str] = None


class HistoryPosition(BaseModel):
    position_id: str
    symbol: str
    side: str
    entry_price: float
    exit_price: Optional[float] = None
    realized_pnl: float
    pnl_pct: float
    exit_reason: Optional[str] = None
    entry_time: Optional[str] = None
    exit_time: Optional[str] = None
    narrative_reason: str = ""


class PositionsSummary(BaseModel):
    total_margin: float
    total_pnl: float
    total_risk_pct: float


class PositionsResponse(BaseModel):
    current: list[CurrentPosition]
    history: list[HistoryPosition]
    summary: PositionsSummary


class TimelineEntry(BaseModel):
    timestamp: str
    type: Literal["psych", "body", "trade", "ambient", "news"]
    mood: Optional[str] = None
    mood_label: Optional[str] = None
    text: Optional[str] = None
    mode: Optional[str] = None
    prompt_version: Optional[str] = None
    location: Optional[str] = None
    activity: Optional[str] = None
    decision: Optional[str] = None
    symbol: Optional[str] = None
    leverage: Optional[float] = None
    margin: Optional[float] = None
    signal_score: Optional[float] = None
    threshold: Optional[float] = None
    position_multiplier: Optional[float] = None
    narrative_thought: Optional[str] = None
    name: Optional[str] = None
    source: Optional[str] = None
    direction: Optional[str] = None
    impact_level: Optional[str] = None
    key_point: Optional[str] = None
    event_type: Optional[str] = None


class TimelineResponse(BaseModel):
    entries: list[TimelineEntry]
    total: int
    has_more: bool


class SignalInfo(BaseModel):
    symbol: Optional[str] = None
    direction: Optional[str] = None
    rule: Optional[str] = None
    score: Optional[float] = None


class TriggerEvent(BaseModel):
    event_id: int
    name: str
    timestamp: str


class BehaviorInfo(BaseModel):
    primary_mode: Optional[str] = None
    modifiers: list[str] = Field(default_factory=list)


class DecisionDetailResponse(BaseModel):
    decision_id: str
    timestamp: str
    signal: SignalInfo
    psychology_before: dict[str, Any] = Field(default_factory=dict)
    trigger_events: list[TriggerEvent] = Field(default_factory=list)
    behavior: BehaviorInfo
    decision_reason: dict[str, Any] = Field(default_factory=dict)
    decision: Optional[str] = None
    position_multiplier: Optional[float] = None
    narrative_thought: Optional[str] = None
    narrative_body_action: Optional[str] = None
    risk_check: Optional[str] = None
    position_id: Optional[str] = None
