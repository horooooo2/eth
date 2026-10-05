# 已移除功能与恢复记录（2026-10-05）

## 决策与范围

用户要求：移除当前不需要的功能，X 动态相关功能全部移除，保留记录供未来恢复。
保留巨鲸采集、仓位、成交、异动、共振、净流入、雷达、宏观日历、AI 诊币与雷达 AI、管理后台用户与巨鲸管理。
“前端封装未调用”不等于后端业务无人使用。本次没有批量删除共享后端统计、新闻、雷达或 AI 接口。

## 一、Coinank（前一轮已移除）

原用途：BTC/ETH/SOL 现货与合约净流入，5m 至 6h；默认 45 秒轮询并缓存。
已移除 lib/coinankFlow.js、server.js 启动、flow 路由中的依赖、部署清单，以及前端 fetchDexFlowCoins 和关联类型。
原因：前端无调用，外部接口返回需要 API 订阅。未来恢复必须使用有效授权接口，不应依赖旧动态凭据实现。

## 二、无人消费的后台资金流采集

- lib/cexMarketFlow.js：Binance、OKX、Bybit 现货与合约主动买卖成交聚合，原有 6 条 WebSocket；已删除采集与启动。
- lib/onchainFlow.js：链上 DEX Swap 日志、游标、区块时间、成交额，默认 15 秒轮询；已删除采集与启动。
- GET /api/flow/coins、GET /api/flow/dex：删除。
- GET /api/flow/status：仅保留 DeFiLlama 状态。
- GET /api/flow/defillama 和后台 DeFiLlama 采集：保留，marketBrief 的 AI 上下文仍会读取。

这些资金流不是页面左上角的巨鲸合约净流入。后者来自本地真实成交事实，继续保留。

## 三、X 动态全链路

后端删除：routes/x.js、lib/xFeedPoller.js、lib/xWatchAccounts.js、lib/sorsaTwitter.js、lib/myMemoryTranslate.js。
原功能：Sorsa 获取关注账号推文、缓存、定时轮询、MyMemory 翻译、WebSocket xTweet 推送、账号增删改与启停。
移除 /api/x 下 feed/status/refresh/translate/tweets/accounts 全部路由与服务启动。
前端删除 XFeed.vue、stores/xFeed.ts、X API 类型和请求函数、DesktopApp 的推文接收分支、useRealtime 的 xTweet 协议类型。
管理后台删除 X 监控账号表单、列表、修改标签、启停、手工拉取和初始化请求。
AI 通用分析仅接受 macro/whale 来源，移除 x 来源类型和提示词；旧 x 来源请求返回 400。

历史缓存（cache/x-feed、x-user-*、x-watch-accounts 等）及私有 .env 未进行破坏性清理；当前运行代码不再读取它们。
SORSA_API_KEY、X_DEFAULT_USER、X_POLL_INTERVAL_MS、X_PER_USER_KEEP、X_USER_GAP_MS、SORSA_CACHE_MS 等旧配置可由运维按需清理，勿把密钥写入本文。

## 四、前端旧模块

删除未接入页面的组件：CoinFundFlow.vue、LiquidationBanner.vue、RiskAssessment.vue、WhaleTable.vue、XFeed.vue。
删除 store：news.ts、xFeed.ts。
删除未接入入口引用链的工具：clearAppCache、fedOdds、flowInsight、keywordHints、macroAnalysis、macroResonance、marketInsight、monitoredPositions、newsRelevance、resonance、tradeEnrichment、whalePositionRisk（均为 src/utils 下 .ts）。
保留 env.d.ts 等声明文件；保留当前页面实际使用的新版共振、巨鲸状态与风险计算链路。

## 五、API 文件清理

从 src/api/index.ts 递归清理无调用函数与无引用类型，共 62 个符号。包括旧 TradFi、旧分页加载、非流式 AI 封装、X 管理、旧资金流/爆仓组件的封装。
完整机器清单：removed-api-symbols-20261005.json。
具体符号：

- `refreshMarketBriefStance`
- `refreshXWatchNow`
- `deleteXWatchAccount`
- `updateXWatchAccount`
- `toggleXWatchAccount`
- `addXWatchAccount`
- `fetchXStatus`
- `fetchXAccounts`
- `ConsoleXAccount`
- `chatMarketBrief`
- `fetchMarketBrief`
- `analyzeWithWhaleAi`
- `fetchXFeed`
- `fetchXTweets`
- `XFeedResponse`
- `XFeedAccount`
- `XTweetsResponse`
- `XFeedTweet`
- `XTweet`
- `XTweetUser`
- `saveConfig`
- `fetchConfig`
- `fetchLiquidations`
- `LiquidationsResponse`
- `LiquidationPeriod`
- `LiquidationBucket`
- `fetchDefillamaMacro`
- `DefillamaMacroResponse`
- `DefillamaCoinRow`
- `DefillamaProtocolRow`
- `DefillamaOverview`
- `fetchMarkets`
- `fetchWhaleAlertsFeed`
- `fetchNewsDetail`
- `fetchNews`
- `fetchPagedTrades`
- `fetchWhaleSummary`
- `fetchPersistedAlertHistory`
- `refreshAlertHistory`
- `refreshWhaleById`
- `fetchWhaleCacheQuery`
- `WhaleCacheQuery`
- `fetchWhalesBatch`
- `fetchActivitySince`
- `withRetrySuffix`
- `retryableErrorText`
- `isRetryableLoadError`
- `fetchAllTradFiWhales`
- `TradFiAllWhaleResponse`
- `fetchTradFiWhales`
- `TradFiWhaleResponse`
- `TradFiWhaleRow`
- `analyzeTradFiMarket`
- `fetchTradFiIntel`
- `TradFiIntelResponse`
- `fetchTradFiQuotes`
- `fetchTradFiCatalog`
- `fetchTradFiAnalysis`
- `TradFiAiAnalysisResult`
- `TradFiAiAnalysis`
- `TradFiDirectionResult`
- `TradFiDirectionFrame`

## 六、明确保留的共享服务

- DeFiLlama、新闻、爆仓数据：仍供 AI 上下文使用；只删除无人引用的前端封装或展示组件。
- 现有 bootstrap + Socket 巨鲸状态、异动统计、行情汇总、雷达及 AI 流式功能。
- 旧后端兼容接口不根据前端单个函数是否调用来盲删；共享计算与内部调用须独立核对。

## 七、如何恢复

源码快照：同目录 retired-source-20261005.zip，仅包含源码，不含数据库、缓存和 .env。
快照保存本轮删除前的前端组件、工具和 API/页面，以及被移除的 CEX/DEX/X 后端模块、原 server/flow/createApp/whaleAi 路由。
Coinank 在上一轮已删除，不在此快照中；可查 Git 历史。开始清理时 Git HEAD：09266fc079b79d72e939869b246e4b0bf2935465（仅历史参考，未包含此前未提交修复）。
恢复时先解压到临时目录比对，不能整体覆盖当前代码。依次恢复数据源模块、凭据配置、路由、服务启动、部署清单、前端组件/API，再接入实际页面。
X 还需重新加入管理后台、Socket 协议、AI 来源校验与提示词。DEX 恢复需保留游标与日志原子持久化、真实区块时间、稳定币实际结算金额与缺失标记。
删除模块的 3 项专用 DEX 测试已同步撤除；恢复时需重新补回这些覆盖。巨鲸采集与数据一致性测试继续保留。

## 八、验证与部署

前端 vue-tsc/Vite 构建通过；后端保留功能回归 78 项通过；前端状态同步 11 项通过；页面加载、控制台兼容、雷达及相关 AI 测试通过。
部署目录通过 sync-deploy.js 同步与本地依赖检查。本次未发布到线上。
部署需要更新前后端并重启后端，否则旧进程的定时器和 WebSocket 仍会继续运行。
线上若使用覆盖式上传，旧 JS 文件可能仍在磁盘；新代码不再引用它们，不会启动，运维可按本文精确清单移除旧文件，不要删除数据目录。
