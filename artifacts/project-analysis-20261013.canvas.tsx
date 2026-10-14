import { Stack, Grid, H1, H2, Text, useHostTheme } from 'cursor/canvas';

const findings = [
  ['高优先级：账户管理缺少鉴权', 'GET/POST /auth/users、DELETE /auth/users/:id 和 PUT /auth/users/:id/password 没有身份或管理员校验。删除与改密函数直接写数据库；若这些 API 对外可达，匿名请求可枚举用户并删除账户或重置密码。', 'routes/auth.js:17–49；lib/authStore.js:207、237；lib/createApp.js:67', '用户管理统一 requireAdmin；本人改密需验证身份及原密码。补充匿名、普通用户、管理员权限测试。'],
  ['中优先级：AI 分析任务重启后可能滞留', '持久状态为 PENDING/RUNNING，但进程内 inFlightAnalyses 没有对应任务时，接口直接返回 202。进程异常退出后，相同 contextHash 的请求可能一直复用失去执行者的记录；上下文改变会形成其他记录。', 'routes/tradfi.js:52–55；lib/tradfiAnalysisStore.js:35–38', '增加启动恢复、任务租约或超时失败标记，并验证执行中重启后的重试行为。'],
  ['中优先级：部署检查缺少数据库就绪验证', 'health 顶层始终返回 ok:true/HTTP 200；SQLite 状态只描述连接，不执行数据库查询。轻量存活接口设计合理，但部署脚本把 HTTP 成功作为健康判断，缺少独立数据库就绪检查。', 'lib/createApp.js:26–40；lib/db.js:715；scripts/remote-deploy.sh:143–151', '保留轻量存活探针，新增只在启动/部署时调用的有界就绪检查，覆盖数据库和必要初始化。'],
  ['低优先级：运行说明与源码不一致', 'README 的前端端口是 5173，Vite 实际为 5273；代理默认连 3000，后端代码默认监听 80，可由 PORT 或 .env 覆盖。文档包含大量历史阶段，需明确当前功能。', 'README.md；前端 vite.config.ts；后端 server.js:74', '统一本地环境模板、开发端口与当前功能说明，将历史改造记录移到变更日志。'],
];

export default function ProjectAnalysis() {
  const t = useHostTheme();
  return <Stack gap={18} style={{ padding: 28, background: t.bg.editor, color: t.text.primary, lineHeight: 1.65 }}>
    <H1>WhaleTracker 项目分析 · 2026-10-13</H1>
    <Text>结论：数据同步主线已有较完整的持久化、回放和故障恢复设计；当前最应先补齐账户接口权限，再完善 AI 任务恢复与部署就绪验证。本次未修改业务源码、未部署。</Text>
    <H2>架构与范围</H2>
    <Text>Hyperliquid 等外部数据 → Express 后台采集 → SQLite 事实与持久状态 → bootstrap / WebSocket stateCommit → Vue 3 + TypeScript + Pinia + Element Plus 界面。epoch/seq 与 resume 支持回放、去重和缺口重同步；部署保持单 Node 进程，跨实例共享事件日志尚未实现。</Text>
    <Grid columns="repeat(auto-fit, minmax(280px, 1fr))" gap={24}>
      <section><H2>目录职责</H2><Text>whale-tracker-backend：API、采集、规则、SQLite 与实时通信。whale-tracker-frontend：界面、用户状态与规则展示。whale-tracker-deploy：CI 同步生成的部署副本。whale-tracker-edgeone：另一部署形态。emotion_backtest：Python 研究回测模块，含执行、指标、报告与测试。ai-trading-system-v41 与 codex-dual-client 属于额外目录，本轮未深入审阅。</Text></section>
      <section><H2>当前功能开关</H2><Text>雷达前后端默认启用，可分别用 RADAR_ENABLED=0 与 VITE_RADAR_ENABLED=0 暂停。观察模块默认关闭，需 WHALE_OBSERVATIONS_ENABLED=1 和前端对应变量开启。STRATEGY_WORKSPACE_ENABLED=false，/tradfi-replay 跳回首页；仍有相关构建资产不代表路由开放。</Text></section>
    </Grid>
    <H2>实际验证</H2>
    <Text>前端 whaleState：11/11 通过。vue-tsc -b 和 Vite 生产构建通过；最大 JS 分块 382.63 kB，gzip 136.47 kB；DesktopApp 为 307.35 kB，gzip 103.48 kB。后端 node scripts/test-whale-sync.js 完整执行，退出码 0。检查覆盖同步、事件原子性、回放、保留、观察计算、请求预算与故障路径。</Text>
    <Text>npm 启动器首次运行因用户目录 EPERM 失败，改为直接调用相同 Node 脚本完成验证。日志保存在 artifacts/project-analysis-20261013-backend.log 与 project-analysis-20261013-build.log。未验证线上部署、真实上游网络、长期采集稳定性或 Python 回测结果。</Text>
    <H2>按优先级处理</H2>
    {findings.map(([title, detail, source, action]) => <section key={title} style={{ borderTop: `1px solid ${t.stroke.primary}`, paddingTop: 14 }}><h3 style={{ fontSize: 16, margin: '0 0 6px' }}>{title}</h3><p>{detail}</p><p>建议：{action}</p><small>源码证据：whale-tracker-backend/{source}</small></section>)}
    <H2>维护判断</H2>
    <Text>CI 在 main 推送后运行后端回归、前端状态测试和构建，再同步打包部署。该流水线未覆盖独立 Python 模块。仓库同时保留部署副本、构建产物、日志、数据与实验项目，建议明确维护边界，防止修改部署副本而遗漏源文件。旧 project-analysis.canvas.tsx 保留为历史证据，其包体积与部分模块状态结论不适用于当前源码。</Text>
  </Stack>;
}
