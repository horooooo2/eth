import { useHostTheme } from 'cursor/canvas';

const findings = [
  ['高 · 账户管理缺少鉴权', 'GET /auth/users 可列出用户 ID；DELETE /auth/users/:id、PUT /auth/users/:id/password 未验证身份。底层函数也没有调用者校验，可形成未登录删除账户或重置密码的路径。', 'whale-tracker-backend/routes/auth.js:17、35、44；lib/authStore.js:208、238', '先为用户管理加入管理员权限；本人改密验证当前身份与原密码，并补充未登录、普通用户和管理员测试。'],
  ['中 · AI 任务可能永久停留在处理中', '持久记录为 PENDING/RUNNING，但进程内 Map 已无任务时，TradFi 分析接口直接返回 202。若进程在任务执行时退出，相同上下文重试可能持续复用失去执行者的任务。', 'whale-tracker-backend/routes/tradfi.js:27；lib/tradfiAnalysisStore.js:35', '增加启动恢复、超时标记或任务租约；验证进程重启后的重试行为。'],
  ['中 · 健康状态不能代表服务就绪', 'health 即使 SQLite 状态异常仍返回 HTTP 200 和顶层 ok:true；部署脚本以 HTTP 成功判断健康，可能放过数据库故障。', 'whale-tracker-backend/lib/createApp.js:26；scripts/remote-deploy.sh', '拆分存活与就绪检查；就绪状态覆盖数据库与关键初始化。'],
  ['中 · 文档与运行入口不一致', 'README 写前端 5173，实际 Vite 是 5273；代理默认 3000，后端无 PORT 配置时监听 80。emotion_backtest README 描述的 emotion 接口未在当前 TradFi 路由找到。', 'README.md；whale-tracker-frontend/vite.config.ts:31；whale-tracker-backend/server.js:74', '统一开发命令、环境变量和功能清单；历史能力标记为保留或退役。'],
  ['低 · 首次加载与维护成本', '构建主 chunk 为 1064.01 kB，gzip 350.07 kB，触发体积警告。仓库保留部署副本、构建资产、历史日志与独立实验目录，功能状态容易混淆。', '本地 npm run build 输出；仓库目录结构', '核对实际引入链再拆包；明确源码、部署产物和归档边界。'],
];

export default function ProjectAnalysis() {
  const theme = useHostTheme();
  return <main style={{ background: theme.bg.editor, color: theme.text.primary, padding: 28, fontFamily: 'system-ui', lineHeight: 1.65 }}>
    <h1 style={{ fontSize: 24 }}>WhaleTracker 项目分析</h1>
    <p>2026-10-08 · 基于当前本地源码与实际测试。主线已具备较完整的数据同步工程；优先修复账户接口权限，随后处理任务恢复与运维验证。</p>
    <h2 style={{ fontSize: 19 }}>架构与当前功能</h2>
    <p>Vue 3 + TypeScript + Pinia + Element Plus → Express API / WebSocket → SQLite。Hyperliquid 仓位与成交由后台采集，数据库提交后发布 stateCommit；前端通过 bootstrap、epoch/seq 游标、resume 与缺口重同步维持状态。</p>
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24 }}>
      <section><h3>产品主线</h3><p>巨鲸名单、仓位、异动、方向与共振；行情雷达、宏观资讯、AI 分析和管理后台。实时回放具有去重与序号缺口恢复，统计事实与展示限额分离。</p><p>策略工作区开关为 false，/tradfi-replay 当前重定向首页；策略代码保留不等于功能已开放。</p></section>
      <section><h3>目录职责</h3><p>whale-tracker-frontend：界面与状态。whale-tracker-backend：API、采集、数据与规则。whale-tracker-deploy：CI 同步部署副本。whale-tracker-edgeone：另一部署形态。emotion_backtest：独立 Python 研究引擎。ai-trading-system-v41、codex-dual-client：本次未深入审阅。</p></section>
    </div>
    <h2 style={{ fontSize: 19 }}>验证结果</h2>
    <p>前端状态测试 11/11 通过；vue-tsc 与 Vite 生产构建通过；后端 test:whale-sync 完整脚本通过，涵盖 22 个测试文件。测试包含事件原子性、同步缺口、数据库提交失败、保留策略、请求预算与性能路径。</p>
    <p>CI 在 main 推送后执行后端同步检查、前端状态测试和构建，再打包上传并重启 Node。当前同步脚本未包含 Python 引擎；现有流水线不能据此视为 Python 回测部署已验证。</p>
    <h2 style={{ fontSize: 19 }}>按优先级处理</h2>
    {findings.map(([title, detail, source, action]) => <section key={title} style={{ borderTop: `1px solid ${theme.stroke.primary}`, padding: '14px 0' }}><h3 style={{ fontSize: 16, margin: '0 0 6px' }}>{title}</h3><p>{detail}</p><p><strong>建议：</strong>{action}</p><small>证据：{source}</small></section>)}
    <h2 style={{ fontSize: 19 }}>成交链路内存专项检查 · 2026-10-08</h2>
    <p><strong>原始成交全量加载的修复有效，但下游计算和故障积压仍有风险。</strong>下面的数据来自本机 Node 20 合成测试，不代表生产服务器的内存峰值或真实故障频率。没有修改业务代码或正式数据库。</p>
    <section style={{ background: theme.fill.tertiary, padding: 16 }}>
      <h3 style={{ fontSize: 16 }}>已验证的保护</h3>
      <p>原始成交投影测试：25,000 条记录，每条附带 4 KiB 填充，总填充 102,400,000 字节；在 --max-old-space-size=96 下通过。构建 559 ms，定时采样 heapUsed 最大约 22 MiB，事件循环回调执行 98 次。数字为采样结果，未包含全部瞬时峰值、SQLite 原生内存与文件缓存。</p>
      <p>本轮成交投影 3 项、观察模块 15 项、事件流 4 项测试全部通过。内存成交缓存最多 8,000 条；观察列表最多 100 条；公共 Socket 最多 200 个并有 4 MiB 发送前缓冲检查；已提交回放日志默认 2,000 条 / 8 MiB。前端长期状态也有裁剪机制。</p>
    </section>
    <h3>1. 高 · 共振读取后重新物化全部明细</h3>
    <p>collectOpenRows 把迭代输入装入 rawRows，之后去重、过滤、复制排序并分别计算两类信号。数据库迭代没有让这一层变成有界聚合。合成测试：10,000 条耗时 57 ms、结束时 heapUsed 12 MiB；100,000 条耗时 466 ms、结束时 heapUsed 102 MiB。两次在同一进程运行，heapUsed 不是独立分配量或严格峰值。</p>
    <p>建议：按地址、币种、方向和固定合并区间增量聚合，保留精确金额与次数；明细分开分页读取。避免用展示条数截断统计事实。源：lib/resonanceEngine.js:356、388、508；源文件 src/utils/whaleResonanceSignal.ts，后端文件由脚本生成。</p>
    <h3>2. 高 · 观察计算预算不能限制单个任务</h3>
    <p>processPair 在同步事务中读取单个地址和币种七天输入；buildObservations 收集完整记录，并为多个观察事件分别追踪后续成交。后续记录被共享引用，但每个事件仍有自己的证据引用数组和数据库链接。50 ms 预算在 processPair 返回后才检查，不能打断一个大任务。</p>
    <p>合成的连续增仓：10,000 条 processPair 执行约 1,044 ms，期间排队的 setImmediate 尚未执行，产生 141,628 条证据链接；60,000 条仅算法计算即产生 1,389,820 个证据引用。证据随事件和后续成交量放大。建议：独立计算 Worker / 进程，缩小事务，增量维护事件追踪，减少重叠证据扫描；保持纠错、回撤和证据完整性。源：lib/whaleObservationStore.js:38；lib/whaleObservationEngine.js:130、162；lib/whaleObservationWorker.js:38。</p>
    <h3>3. 中 · 故障时待发布队列没有容量限制</h3>
    <p>decorate 失败后保留 pending Map/Set 并重试；maxBytes 仅限制已提交日志，在构造和序列化大事件之后执行。不同异动 ID 持续到来时，待发布记录继续积累。合成测试设置回放上限 1 KiB，一次 decorate 失败后积累 10,000 条记录，恢复时仍发布约 10.52 MB 的事件。日志限制不等于排队或单事件限制。</p>
    <p>建议：待发布事件设置条数和字节预算，超过预算后通知客户端重新 bootstrap；保留 SQLite 为事实源。Socket 发送前核对当前缓冲加消息长度，超大事件走重同步。源：lib/stateStream.js:37、42、50；lib/realtimeHub.js:18。</p>
    <h3>4. 中 · 清理吞吐可能落后于采集</h3>
    <p>默认每分钟只删最多 500 条过期 fills，即每小时 30,000 条。持续进入过期窗口的成交超过该速度时，积压将增长；不意味着当前已发生。alerts/events 有相同批量上限，并按业务规则保留当前持仓相关记录。建议：根据过期积压在时间预算内多批清理，并监控最老时间、过期条数、磁盘与 WAL；不要按显示数量删除统计事实。源：lib/whaleRetention.js:5、13、41。</p>
    <h3>5. 低 · 地址规模扩大可触发真实调用栈溢出</h3>
    <p>directionSummary 使用 Math.max(0, ...amounts.values())；150,000 个不同地址的合成输入复现 RangeError: Maximum call stack size exceeded，定位 serialize 第 29 行。触发因素是不同地址数量，不是单个地址的成交笔数，当前较小监控名单下优先级较低。建议：用迭代求最大值代替参数展开，并检查 dataFreshness 等同类写法。</p>
    <p>补充边界：fillFactProjection.read 的 ensure 仍有同步重建兜底；现有统计 HTTP 路由会先 await prepare，降低了实际触发概率，新调用者需要保持这个约定。私有 Socket 的发送方法没有公共频道同等背压，但当前源码没有找到调用者，未作为活跃故障路径。</p>
    <h2 style={{ fontSize: 19 }}>少用户、持续计算场景的优化方案</h2>
    <p><strong>推荐保留 Node、Express 与 SQLite，按“先限量与测量 → 隔离重任务 → 增量计算”推进。</strong>当前用户不超过 5 个，扩展 HTTP 实例无法解决重复重算，还会引入现有单进程 epoch/seq 与订阅状态的一致性问题。</p>
    <h3>本地数据基线</h3>
    <p>只读打开 whale-tracker-backend/data/whale.db：fills 400,846 行；observation_inputs 271,919 行；观察摘要 118 行；证据链接 5,296 行；待计算任务 1 行。七天内最多的地址＋币种有 12,974 条输入，其次 8,105 条。数据库文件约 1.017 GB，WAL 约 27.9 MB，23,170 个空闲页约 94.9 MB。表统计为各查询时点，文件数来自目录快照。</p>
    <p>按默认两天保留窗口，过期 fills 为 293,296 行；仅按默认每分钟 500 条的定时清理、且无新增过期记录计算，消化约需 9.8 小时。最近成交时间为北京时间 10 月 8 日 01:02，检查时间 12:05，不能排除停机影响，不能据此判断当前在线清理已持续落后。实际部署的保留参数另需核对。</p>
    <h3>第一阶段：小范围改动，限制峰值并建立指标</h3>
    <p>1. 将 Math.max 参数展开改为循环，修复确定可触发的栈溢出点。2. stateStream 待发布数据设置预算；超预算时清空可重建的增量并发 resyncRequired，让客户端 bootstrap；不删除 SQLite 事实。3. 发送检查包含当前 bufferedAmount 与新消息字节，超大消息走重同步。4. 采集进程暴露 RSS、heapUsed、事件循环延迟、计算耗时、任务最老年龄、过期行数与 WAL 大小。</p>
    <p>共振当前浏览器有 10 秒合并触发与 30 秒刷新，而后端 sharedStats 结果仅缓存 3 秒。先用后台调度维持查询结果：新成交、纠错、名单和配置变更标记需要更新，多个请求只触发一个任务；无成交时也按时间到期更新。缓存必须包含输入版本、规则、时间窗、币种，以及影响筛选的仓位/胜率版本，返回 generatedAt、inputVersion、stale 状态，不能单纯延长 TTL 隐藏新成交。</p>
    <h3>第二阶段：一个独立计算进程</h3>
    <p>主进程继续负责采集写库、API、实时游标和推送。子进程负责观察与共振，读取必要字段，计算完成只传结果摘要或任务标识；禁止通过 IPC 传七天成交数组。第一版只设一个计算任务并发，并合并同一地址＋币种的任务，避免多个大任务同时占内存。主进程和子进程的总 RSS 都要纳入预算，隔离本身不会消除计算量。</p>
    <p>保留 SQLite 单写者，主进程分批提交结果并发布事件；子进程不能复用当前含事务和发布副作用的 processPair。先把读取、纯算法、结果提交拆开。任务记录增加输入 generation/版本：计算完成只确认该版本；执行中若又有新成交或纠错，仍保留新版本的待处理任务，避免删除 job 丢失更新。进程重启可重试，旧结果不能覆盖新结果。</p>
    <p>读取使用短快照或可核对版本的分批读取，避免长时间读事务影响 WAL checkpoint。输入分页期间若发生纠错，需要版本检测与重新调度；不能假设逐页读取天然一致。部署同步清单、子进程启动/退出/重启和现有前后端协议都需要同步验收。</p>
    <h3>第三阶段：减少扫描与重复证据</h3>
    <p>方向统计优先维护按时间桶、币种、地址的精确增减仓金额和次数；成交 ID 幂等入账，纠错时撤销旧贡献再加新贡献，查询边界桶按真实成交时间补算。共振固定五分钟合并从第一笔成交起算，不能直接替换为自然时钟五分钟桶；通过流式有序读取维护合并状态，仍保持当前金额、价格、次数和信号含义。</p>
    <p>观察计算保留已闭合区间和连续性检查点，新成交只推进未闭合会话及有效追踪事件。迟到成交和纠错从受影响检查点重算，必要时回退到完整基准算法；不能只取最近若干条。追踪证据改为共享记录与有序链接/区间查询，避免每个事件复制长尾数组；保留原始触发时间、24 小时跟踪边界、缺口中断和同毫秒歧义规则。集体事件只重算受影响币种、方向、小时区间。</p>
    <h3>清理与上线验收</h3>
    <p>清理根据积压自适应执行多批，每批结束让出事件循环并设置事务耗时预算；SQLite 单次同步事务不能被预算中途打断，应按观测耗时调整批量。观察输入、证据孤儿与临时投影也分批清理。文件大小不会仅因删行立刻下降；数据库整理或 VACUUM 属于另行维护，本次不执行。</p>
    <p>第一版压测候选目标：主进程事件循环延迟 p95 &lt; 50 ms、缓存 API p95 &lt; 200 ms、5 个浏览器同时打开不重复启动相同任务、运行 24 小时总 RSS 无持续增长、输入持续增长时队列年龄与过期积压可回落。目标需在实际服务器验证，不承诺当前已经达到。结果正确性以现有算法为基准，对照完整金额、次数、事件 ID、触发时间与证据，并覆盖重复、迟到、纠错、重启、窗口到期和读写并发。</p>
    <p>技术依据：<a href="https://nodejs.org/api/child_process.html">Node 子进程与 IPC</a>；<a href="https://sqlite.org/wal.html">SQLite WAL 并发与 checkpoint</a>。本节是可实施方案，尚未修改计算模块或部署。</p>
    <h2 style={{ fontSize: 19 }}>分析边界</h2>
    <p>没有启动生产服务、发送订单或修改业务源码。未执行 Python 回测测试、真实浏览器体验、线上接口可用性或长期采集验证。源码问题为静态确认或明确标注的故障推演，测试通过不能替代这些验证。</p>
  </main>;
}
