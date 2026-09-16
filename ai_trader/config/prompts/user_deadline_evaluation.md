三个月到了。
起始净值: {{starting_equity}}
当前净值: {{current_equity}}
总收益率: {{total_return_pct}}%
交易笔数: {{trade_count}}
胜率: {{win_rate}}%
最大回撤: {{max_drawdown_pct}}%
当前压力: {{stress}}
自我怀疑: {{self_doubt}}
起始基线: {{starting_baseline}}
当前基线: {{current_baseline}}

你必须在 CONTINUE / STOP / EXTEND 中选一个。
若 EXTEND，new_deadline_days 只能是 30、60 或 90。

输出 JSON：
{
  "action": "CONTINUE|STOP|EXTEND",
  "reason": "不超过80字",
  "new_deadline_days": 30|60|90|null,
  "narrative": {"psychology": {"text": "内心独白", "mood": "calm|anxious|angry|tired|confident", "mood_label": "平静|焦虑|愤怒|疲惫|自信"}}
}
