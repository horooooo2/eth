# AI Trader Analysis Report

## 1. 行为模式统计
```json
{
  "EXHAUSTED": {
    "decisions": 14,
    "trades": 2,
    "win_rate": 0.5,
    "avg_pnl": 3.1664020068303014
  },
  "FROZEN": {
    "decisions": 52,
    "trades": 1,
    "win_rate": 1.0,
    "avg_pnl": 10.323304193733042
  },
  "NORMAL": {
    "decisions": 163,
    "trades": 9,
    "win_rate": 0.3333333333333333,
    "avg_pnl": -4.985966199374162
  },
  "REVENGE_TRADING": {
    "decisions": 534,
    "trades": 36,
    "win_rate": 0.2777777777777778,
    "avg_pnl": -5.030654455201375
  }
}
```

## 2. 阈值分布
```json
{
  "min": 0.69,
  "max": 0.9,
  "mean": 0.8182568807339449,
  "median": 0.82,
  "n": 763
}
```

## 3. 风控拒绝分析
```json
{
  "MAX_POSITIONS_REACHED": 527,
  "LOSS_STREAK_PAUSED": 98,
  "LEVERAGE_EXCEEDED": 12,
  "DAILY_LOSS_LIMIT": 12,
  "STOP_LOSS_TOO_WIDE": 1
}
```

## 4. MFE / MAE 分布
```json
{
  "n": 48,
  "mfe_mean": 0.005244065295303388,
  "mfe_min": 0.0,
  "mfe_max": 0.01052078181899568,
  "mae_mean": -0.004084410145725646,
  "mae_min": -0.00610759854712782,
  "mae_max": -0.00021036386398809237
}
```

## 5. 关键因果链示例
### decision `b3cd9a13-12e7-4e1a-a643-6c0fffa13a9e`
```json
[
  {
    "event_time": "2026-09-01T03:34:00+00:00",
    "event_name": "STOP_LOSS_TRIGGERED",
    "decision": "OPEN_SHORT",
    "primary_mode": "NORMAL",
    "entry": 67042.05861395414,
    "exit": 67394.53,
    "pnl": -17.093198744528507,
    "mfe": 0.0040202914338618246,
    "mae": -0.005257466631140923,
    "exit_reason": "STOP_LOSS",
    "config_hash": "dbc633e4fe51b349"
  },
  {
    "event_time": "2026-09-01T03:34:00+00:00",
    "event_name": "LOSS_STREAK_3",
    "decision": "OPEN_SHORT",
    "primary_mode": "NORMAL",
    "entry": 67042.05861395414,
    "exit": 67394.53,
    "pnl": -17.093198744528507,
    "mfe": 0.0040202914338618246,
    "mae": -0.005257466631140923,
    "exit_reason": "STOP_LOSS",
    "config_hash": "dbc633e4fe51b349"
  }
]
```

### decision `8c0e528d-5b46-45ce-9083-033640134cd6`
```json
[
  {
    "event_time": "2026-09-01T03:32:00+00:00",
    "event_name": "STOP_LOSS_TRIGGERED",
    "decision": "OPEN_SHORT",
    "primary_mode": "NORMAL",
    "entry": 67003.81371660667,
    "exit": 67375.85,
    "pnl": -17.968917934837332,
    "mfe": 0.0034517992898865668,
    "mae": -0.005552464296537859,
    "exit_reason": "STOP_LOSS",
    "config_hash": "dbc633e4fe51b349"
  }
]
```

### decision `57293f26-acb4-4469-8518-f976751e85b5`
```json
[
  {
    "event_time": "2026-09-01T03:32:00+00:00",
    "event_name": "STOP_LOSS_TRIGGERED",
    "decision": "OPEN_SHORT",
    "primary_mode": "NORMAL",
    "entry": 67024.43920827963,
    "exit": 67375.85,
    "pnl": -17.046892803638986,
    "mfe": 0.0037584679745967676,
    "mae": -0.0052430247215999055,
    "exit_reason": "STOP_LOSS",
    "config_hash": "dbc633e4fe51b349"
  }
]
```

### decision `75e917c1-c2e6-4e47-b949-13eca162dd4c`
```json
[
  {
    "event_time": "2026-09-01T14:02:00+00:00",
    "event_name": "STOP_LOSS_TRIGGERED",
    "decision": "OPEN_LONG",
    "primary_mode": "NORMAL",
    "entry": 67381.82484234148,
    "exit": 67029.43,
    "pnl": -17.03583436426555,
    "mfe": 0.00958099842456111,
    "mae": -0.005229820402846165,
    "exit_reason": "STOP_LOSS",
    "config_hash": "dbc633e4fe51b349"
  },
  {
    "event_time": "2026-09-01T14:02:00+00:00",
    "event_name": "LOSS_STREAK_3",
    "decision": "OPEN_LONG",
    "primary_mode": "NORMAL",
    "entry": 67381.82484234148,
    "exit": 67029.43,
    "pnl": -17.03583436426555,
    "mfe": 0.00958099842456111,
    "mae": -0.005229820402846165,
    "exit_reason": "STOP_LOSS",
    "config_hash": "dbc633e4fe51b349"
  }
]
```

### decision `184bb311-decd-45af-8d2f-d4d3c0af7fad`
```json
[
  {
    "event_time": "2026-09-01T09:19:00+00:00",
    "event_name": "STOP_LOSS_TRIGGERED",
    "decision": "OPEN_LONG",
    "primary_mode": "REVENGE_TRADING",
    "entry": 67480.43339697491,
    "exit": 67068.29,
    "pnl": -19.768844231224556,
    "mfe": 0.005123805310956836,
    "mae": -0.00610759854712782,
    "exit_reason": "STOP_LOSS",
    "config_hash": "dbc633e4fe51b349"
  },
  {
    "event_time": "2026-09-01T09:19:00+00:00",
    "event_name": "LOSS_STREAK_5",
    "decision": "OPEN_LONG",
    "primary_mode": "REVENGE_TRADING",
    "entry": 67480.43339697491,
    "exit": 67068.29,
    "pnl": -19.768844231224556,
    "mfe": 0.005123805310956836,
    "mae": -0.00610759854712782,
    "exit_reason": "STOP_LOSS",
    "config_hash": "dbc633e4fe51b349"
  }
]
```

## 6. 自动洞察
- EXHAUSTED: 决策 14，成交 2，胜率 50%，均盈亏 +3.17
- FROZEN: 决策 52，成交 1，胜率 100%，均盈亏 +10.32
- NORMAL: 决策 163，成交 9，胜率 33%，均盈亏 -4.99
- REVENGE_TRADING: 决策 534，成交 36，胜率 28%，均盈亏 -5.03
- 最常见拒绝原因：MAX_POSITIONS_REACHED × 527
- 止损后下一笔开仓率：91% （样本 32）
- 高睡眠债交易均盈亏 -3.39 vs 普通 -7.63
