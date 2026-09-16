你此刻的状态
压力: {{stress}}
风险偏好: {{risk_appetite}}
耐心: {{patience}}
专注度: {{focus}}
自我怀疑: {{self_doubt}}
睡眠债: {{sleep_debt}} 小时

当前行为模式: {{primary_mode}}
附加状态: {{modifiers}}

刚刚发生的事
{{event_name}}：{{event_description}}

你的任务
用第一人称写出你此刻的内心反应（不超过 50 字），
以及你接下来会做的身体活动（不超过 30 字）。

输出 JSON 格式：
{
  "psychology": {
    "text": "内心独白",
    "mood": "calm|anxious|angry|tired|confident",
    "mood_label": "平静|焦虑|愤怒|疲惫|自信"
  },
  "body_action": {
    "text": "身体活动的描述",
    "location": "书房|客厅|卧室|厨房",
    "activity": "打开交易终端|看盘|休息|吃饭"
  }
}
