const crypto = require('node:crypto');
const { getCatalog } = require('./tradfiMarkets');
const { getIntel } = require('./tradfiIntel');
const { getWhaleActivity } = require('./tradfiWhales');
const { publicGet, signedRequest, symbolRules, stepped } = require('./binanceTradfiTrade');
const { deepseekFetch, DEFAULT_MODEL } = require('./deepseekClient');
const tradfiAiMonitor = require('./tradfiAiMonitor');

const MAX_AGE_MS = 20 * 60_000;
const saved = new Map();
function invalid(message, status = 400) { const error = new Error(message); error.status = status; return error; }
function positive(value) { const number = Number(value); return Number.isFinite(number) && number > 0 ? number : null; }
function within(promise, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    Promise.resolve(promise).then((value) => { clearTimeout(timer); resolve(value); }, () => { clearTimeout(timer); resolve(null); });
  });
}
async function verifyAlgoOrder(creds, item) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const lookup = attempt === 1 ? { clientAlgoId: item.clientAlgoId } : { algoId: String(item.algoId) };
      return await signedRequest(creds, 'GET', '/fapi/v1/algoOrder', lookup);
    } catch (error) {
      if (Number(error.code) !== -2013 || attempt === 2) throw error;
      await new Promise((resolve) => setTimeout(resolve, 350 * (attempt + 1)));
    }
  }
}
function briefCandles(rows) {
  if (!Array.isArray(rows) || rows.length < 25) return null;
  const now = Date.now();
  const bars = rows.filter((row) => !Number(row[6]) || Number(row[6]) <= now)
    .map((row) => ({ time: Number(row[0]), closeTime: Number(row[6]) || null, open: Number(row[1]), high: Number(row[2]), low: Number(row[3]), close: Number(row[4]), volume: Number(row[5]) }));
  if (bars.length < 25) return null;
  if (bars.some((bar) => !positive(bar.close))) return null;
  const tail = bars.slice(-20);
  const wider = bars.slice(-60);
  const low60 = Math.min(...wider.map((bar) => bar.low));
  const high60 = Math.max(...wider.map((bar) => bar.high));
  const priorVolume = bars.slice(-21, -1).reduce((sum, bar) => sum + bar.volume, 0) / 20;
  const changePct = (previous) => Number(((bars.at(-1).close / previous - 1) * 100).toFixed(3));
  return {
    last: bars.at(-1).close, lastClosedAt: bars.at(-1).closeTime,
    ma20: Number((tail.reduce((sum, bar) => sum + bar.close, 0) / tail.length).toFixed(6)),
    high20: Math.max(...tail.map((bar) => bar.high)), low20: Math.min(...tail.map((bar) => bar.low)),
    high60, low60,
    riseFromLow60Pct: Number(((bars.at(-1).close / low60 - 1) * 100).toFixed(3)),
    retreatFromHigh60Pct: Number(((bars.at(-1).close / high60 - 1) * 100).toFixed(3)),
    change6Pct: changePct(bars.at(-7).close), change20Pct: changePct(bars.at(-21).close),
    lastVolumeVs20: priorVolume > 0 ? Number((bars.at(-1).volume / priorVolume).toFixed(2)) : null,
    recent: bars.slice(-6),
  };
}
function sessionSummary(schedule, category) {
  const sessions = schedule?.marketSchedules?.[category]?.sessions;
  if (!Array.isArray(sessions)) return { type: 'UNKNOWN', nextChangeAt: null };
  const now = Date.now();
  const current = sessions.find((item) => Number(item.startTime) <= now && Number(item.endTime) > now);
  const next = sessions.filter((item) => Number(item.startTime) > now).sort((a, b) => Number(a.startTime) - Number(b.startTime))[0];
  return { type: current?.type || 'UNKNOWN', nextChangeAt: current?.endTime || next?.startTime || null };
}
function normalizeModelPlan(raw, mode, referencePrice) {
  if (!raw || typeof raw !== 'object') throw invalid('AI 未返回有效计划', 502);
  const direction = raw.direction === '做多' ? 'BUY' : raw.direction === '做空' ? 'SELL' : null;
  const decision = ['可挂单', '可试探'].includes(raw.decision) ? raw.decision : '暂缓';
  const marketState = ['趋势', '震荡', '不明确'].includes(raw.marketState) ? raw.marketState : '不明确';
  const effectiveMode = decision === '可试探' ? 'probe' : mode;
  const rangeLow = positive(raw.rangeLow);
  const rangeHigh = positive(raw.rangeHigh);
  const common = {
    decision, marketState, direction, reason: String(raw.reason || '').slice(0, 500),
    shortView: String(raw.shortView || '').slice(0, 350), longView: String(raw.longView || '').slice(0, 350),
    dayView: String(raw.dayView || '').slice(0, 350),
    evidence: Array.isArray(raw.evidence) ? raw.evidence.map((x) => String(x).slice(0, 180)).slice(0, 6) : [],
    fundamentalBias: String(raw.fundamentalBias || '数据不足').slice(0, 30),
    thesis: String(raw.thesis || '').slice(0, 350), invalidation: String(raw.invalidation || '').slice(0, 350),
    rangeLow, rangeHigh, mode: effectiveMode,
  };
  const defer = (reason) => ({ ...common, decision: '暂缓', direction: null, reason, orders: [] });
  if (decision === '暂缓') return { ...common, orders: [] };
  const leverage = Number(raw.leverage);
  const stop = positive(raw.stop);
  const takeProfit = positive(raw.takeProfit);
  const probe = decision === '可试探';
  const rawOrders = Array.isArray(raw.orders) ? raw.orders : [];
  // DeepSeek may occasionally include scale-in levels even when single-entry was
  // requested. A single/probe plan deliberately uses only its primary entry.
  const orders = probe || mode === 'single' ? rawOrders.slice(0, 1) : rawOrders;
  if ((probe && marketState !== '震荡') || (!probe && marketState !== '趋势')) throw invalid('AI 市场状态与交易方案不一致，请重新分析', 502);
  if (!common.thesis || !common.invalidation) throw invalid('AI 缺少交易依据或失效条件，请重新分析', 502);
  if (!direction || !Number.isInteger(leverage) || leverage < 1 || leverage > (probe ? 2 : 5) || !stop || !takeProfit || orders.length !== (probe ? 1 : mode === 'ladder' ? 3 : 1)) {
    throw invalid('AI 计划缺少方向、杠杆、止盈止损或挂单档位，请重新分析', 502);
  }
  if (probe && (!rangeLow || !rangeHigh || rangeHigh <= rangeLow || referencePrice < rangeLow || referencePrice > rangeHigh)) {
    return defer('当前震荡区间边界不清晰，等待形成有效区间后再考虑小仓位试探。');
  }
  const normalized = orders.map((order, index) => ({
    level: index,
    price: positive(order.price), marginUsdt: positive(order.marginUsdt),
    reason: String(order.reason || '').slice(0, 240),
  }));
  const totalMarginUsdt = normalized.reduce((sum, order) => sum + (order.marginUsdt || 0), 0);
  if (normalized.some((order) => !order.price || !order.marginUsdt || !order.reason) || totalMarginUsdt > (probe ? 100 : 1000) || totalMarginUsdt < 1) {
    throw invalid(`AI 挂单价格、金额或理由无效；总保证金不能超过 ${probe ? 100 : 1000} USDT`, 502);
  }
  if (probe) {
    const edge = (rangeHigh - rangeLow) * 0.25;
    const entry = normalized[0].price;
    if (direction === 'BUY' ? !(referencePrice <= rangeLow + edge && entry >= rangeLow && entry <= rangeLow + edge && stop < rangeLow && takeProfit < rangeHigh)
      : !(referencePrice >= rangeHigh - edge && entry <= rangeHigh && entry >= rangeHigh - edge && stop > rangeHigh && takeProfit > rangeLow)) {
      return defer('处于震荡行情，但现价或入场价尚未接近有效区间边缘；等待边缘试探机会。');
    }
  }
  for (let i = 0; i < normalized.length; i += 1) {
    const price = normalized[i].price;
    if (direction === 'BUY' ? !(stop < price && takeProfit > Math.max(price, referencePrice)) : !(takeProfit < Math.min(price, referencePrice) && stop > price)) {
      throw invalid('AI 止盈止损与挂单方向不符，请重新分析', 502);
    }
    if (i && (direction === 'BUY' ? !(price < normalized[i - 1].price) : !(price > normalized[i - 1].price))) {
      throw invalid('AI 加仓档位未按有利方向排序，请重新分析', 502);
    }
  }
  return { ...common, leverage, stop, takeProfit, orders: normalized, totalMarginUsdt };
}
async function analyzeTradfiAi(userId, apiKey, symbolInput, modeInput) {
  const symbol = String(symbolInput || '').trim().toUpperCase();
  const mode = modeInput === 'ladder' ? 'ladder' : 'single';
  const catalog = await getCatalog();
  const market = catalog.symbols.find((row) => row.symbol === symbol);
  if (!market) throw invalid('请选择当前可交易的 TradFi 合约');
  const [ticker, book, minuteRows, fiveMinuteRows, quarterHourRows, hourRows, dayRows, mark, intel, whale, schedule] = await Promise.all([
    publicGet('/fapi/v1/ticker/price', { symbol }),
    publicGet('/fapi/v1/ticker/bookTicker', { symbol }),
    publicGet('/fapi/v1/klines', { symbol, interval: '1m', limit: 90 }),
    publicGet('/fapi/v1/klines', { symbol, interval: '5m', limit: 90 }),
    publicGet('/fapi/v1/klines', { symbol, interval: '15m', limit: 72 }),
    publicGet('/fapi/v1/klines', { symbol, interval: '1h', limit: 72 }),
    publicGet('/fapi/v1/klines', { symbol, interval: '1d', limit: 60 }).catch(() => null),
    publicGet('/fapi/v1/premiumIndex', { symbol }).catch(() => null),
    getIntel(symbol).catch(() => null),
    within(getWhaleActivity(symbol), 12_000),
    publicGet('/fapi/v1/tradingSchedule').catch(() => null),
  ]);
  const referencePrice = positive(ticker.price);
  const minute = briefCandles(minuteRows);
  const fiveMinute = briefCandles(fiveMinuteRows);
  const quarterHour = briefCandles(quarterHourRows);
  const hour = briefCandles(hourRows);
  const day = briefCandles(dayRows);
  if (!referencePrice || !positive(book.askPrice) || !positive(book.bidPrice) || !minute || !fiveMinute || !quarterHour || !hour) {
    throw invalid('现价、盘口或分钟线/小时线不完整，暂不能生成可执行计划', 503);
  }
  if ([[minute, 4], [fiveMinute, 15], [quarterHour, 40], [hour, 180]]
    .some(([series, maxMinutes]) => series.lastClosedAt && Date.now() - series.lastClosedAt > maxMinutes * 60_000)) {
    throw invalid('分钟线或小时线数据已过期，暂不能生成新的挂单计划', 503);
  }
  const context = {
    market, asOf: new Date().toISOString(), referencePrice, bid: Number(book.bidPrice), ask: Number(book.askPrice),
    underlyingSession: sessionSummary(schedule, market.category),
    markPrice: positive(mark?.markPrice), indexPrice: positive(mark?.indexPrice), fundingRate: mark?.lastFundingRate ?? null,
    spreadPct: Number(((Number(book.askPrice) - Number(book.bidPrice)) / referencePrice * 100).toFixed(4)),
    markIndexDeviationPct: positive(mark?.markPrice) && positive(mark?.indexPrice)
      ? Number(((Number(mark.markPrice) / Number(mark.indexPrice) - 1) * 100).toFixed(4)) : null,
    minute, fiveMinute, quarterHour, hour, day,
    news: (intel?.news?.items || []).slice(0, 8).map((row) => ({ title: row.title, publishedAt: row.publishedAt, summary: row.summary, source: row.source })),
    fundamentals: (intel?.fundamentals?.rows || []).slice(0, 10),
    events: (intel?.events?.items || []).slice(0, 8),
    hip3: {
      coverage: whale?.coverageNote || '未取得公开地址样本', stale: Boolean(whale?.stale),
      rows: (whale?.rows || []).slice(0, 12).map((row) => ({ type: row.type, direction: row.direction, notionalUsd: row.notionalUsd, time: row.time })),
      binanceRatio: whale?.binance || null,
    },
    dataStatus: { news: intel?.news?.stale ? 'stale' : intel?.news?.items?.length ? 'ok' : 'unavailable', fundamentals: intel?.fundamentals?.status || 'unavailable', events: intel?.events?.stale ? 'stale' : intel?.events?.items?.length ? 'ok' : 'unavailable', hip3: whale?.rows?.length ? 'sample' : 'unavailable' },
  };
  const prompt = [
    '你是传统资产 USDT 永续合约研究助手。只依据提供的数据输出一个 JSON 对象。underlyingSession 来自币安交易时段接口：NO_TRADING 表示底层市场休市，永续仍可交易；UNKNOWN 不得推断开市。休市、开盘切换及非标准指数定价应降低计划可信度。HIP-3 地址样本不是币安全市场大户。缺失数据不得编造。',
    '交易周期是盘中分钟到小时。先用 1 小时判断当前主方向和结构，再用 15 分钟核实趋势是否延续，5 分钟与已收盘 1 分钟 K 线寻找入场位置、回踩与量价确认。使用各周期涨跌幅、近 60 根高低点、均线和成交量相对变化；勿将尚未收盘的 K 线当成确认信号。shortView 说明分钟线执行机会，longView 说明小时线方向，dayView 简述日线背景。',
    '先判定 marketState=趋势、震荡或不明确。即使日线方向相反或基本面信息缺失，只要小时线与 15 分钟线证实当前盘中趋势，也应给出该方向的候选 Maker 挂单计划；明确标注这是顺盘中趋势、可能逆日线背景。连续上涨不能仅因“涨过了”而笼统观望：若现价不适合追入，在 5/15 分钟有依据的回踩位设 Maker 单，并给出止损、止盈和失效条件。小时线与 15 分钟线不一致、分钟线失速或价格结构不足时，具体说明为什么暂缓。每档加仓是价格逆向运行时有结构依据的候选价，触及失效位整套计划退出。',
    '结合新闻实际发布时间、事件预期/实际、基础面、资金费率、标记价与指数价差、盘口价差、公开大户样本。区分消息字面方向与公布后实测价格反应。日线与基本面用于评估盘中交易风险和仓位，不单独否决已经确认的分钟/小时趋势；重大反向事件或价差异常可以否决交易。缺失的非技术数据明确标为数据不足，不得编造。',
    '震荡时仅当区间上下沿均清晰、现价位于边缘四分之一区域、近期没有方向性重大事件时，可 decision=可试探：只生成一笔小仓 Maker 挂单，无自动加仓。区间下沿做多、上沿做空；止损放区间外，止盈在区间内。现价位于区间中部、边界模糊或突破风险高时 decision=暂缓。',
    '方向与执行分离；证据不足、重大反向事件或价差异常时 decision=暂缓。入场价由你按数据独立确定，不按固定百分比偏离现价。只做 Maker：做多限价低于当前最优卖价，做空限价高于当前最优买价。fundamentalBias 必须根据实际提供的基本面、事件或新闻判断，不得因技术形态推测基本面。',
    mode === 'ladder' ? '若 marketState=趋势，生成初始单和恰好两档有 5/15 分钟结构依据的加仓单；做多价格逐档降低，做空逐档升高。若 marketState=震荡且符合试探条件，改为一笔可试探单。' : '趋势时仅生成一笔初始单；震荡且符合试探条件时生成一笔可试探单。',
    '趋势计划所有档位同方向、同一杠杆（整数 1-5 倍）；各档保证金大于零且合计不超过 1000 USDT；预计全部止损亏损不超过总保证金 30%。震荡试探最多 100 USDT 保证金、1-2 倍杠杆、预计止损亏损不超过保证金 10%。做多止损低于全部挂单价，止盈高于现价与全部挂单价；做空相反。',
    'JSON 字段：{"marketState":"趋势|震荡|不明确","decision":"可挂单|可试探|暂缓","fundamentalBias":"偏多|偏空|中性|数据不足","direction":"做多|做空|观望","reason":"...","thesis":"盘中价格结构的主判断","invalidation":"判断失效的具体条件","rangeLow":数字或null,"rangeHigh":数字或null,"shortView":"分钟线执行依据","longView":"小时线趋势","dayView":"日线背景与风险","evidence":["..."],"leverage":数字,"stop":数字,"takeProfit":数字,"orders":[{"price":数字,"marginUsdt":数字,"reason":"..."}]}。暂缓时 orders=[]；可试探时 rangeLow/rangeHigh 与 orders[0] 必填。不要 Markdown。',
    JSON.stringify(context),
  ].join('\n');
  const requestPlan = async (repairReason = '') => {
    const repair = repairReason
      ? `\n上一次 JSON 未通过执行校验：${repairReason}。请重新输出完整 JSON。${mode === 'single' ? '单笔模式的 orders 必须只含一笔主入场单。' : '加仓模式在趋势计划中必须包含恰好三笔订单。'}`
      : '';
    const data = await deepseekFetch(apiKey, '/chat/completions', { method: 'POST', timeoutMs: 120_000, body: {
      model: DEFAULT_MODEL, temperature: repairReason ? 0.1 : 0.25, max_tokens: 3000, response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: '严格按 JSON 输出，不得编造金融数据。' }, { role: 'user', content: `${prompt}${repair}` }],
    } });
    if (data?.choices?.[0]?.finish_reason === 'length') throw invalid('AI 计划输出超出长度限制，请重新分析', 502);
    let raw;
    try { raw = JSON.parse(String(data?.choices?.[0]?.message?.content || '')); } catch { throw invalid('AI 计划格式不完整，请重新分析', 502); }
    return normalizeModelPlan(raw, mode, referencePrice);
  };
  let plan;
  try {
    plan = await requestPlan();
  } catch (error) {
    const modelPlanError = Number(error.status) === 502 && /AI|计划|方向|杠杆|止盈|止损|档位|结构|交易依据/.test(String(error.message || ''));
    if (!modelPlanError) throw error;
    plan = await requestPlan(String(error.message || '输出不符合要求').slice(0, 220));
  }
  const analysisId = crypto.randomUUID();
  saved.set(analysisId, { userId, symbol, context, plan, createdAt: Date.now() });
  for (const [key, row] of saved) if (Date.now() - row.createdAt > MAX_AGE_MS) saved.delete(key);
  return { analysisId, symbol, context: { referencePrice, markPrice: context.markPrice, indexPrice: context.indexPrice, underlyingSession: context.underlyingSession, dataStatus: context.dataStatus }, plan };
}
function getSaved(userId, analysisId) {
  const row = saved.get(String(analysisId || ''));
  if (!row || row.userId !== userId || Date.now() - row.createdAt > MAX_AGE_MS) throw invalid('AI 计划已过期或不属于当前用户，请重新分析');
  return row;
}
async function previewTradfiAi(userId, analysisId) {
  const row = getSaved(userId, analysisId);
  const { symbol, plan } = row;
  if (!['可挂单', '可试探'].includes(plan.decision)) throw invalid('AI 建议暂缓挂单');
  const [rules, book, ticker] = await Promise.all([
    symbolRules(symbol), publicGet('/fapi/v1/ticker/bookTicker', { symbol }), publicGet('/fapi/v1/ticker/price', { symbol }),
  ]);
  if (!rules || rules.status !== 'TRADING') throw invalid('合约当前不可交易');
  const filters = new Map((rules.filters || []).map((item) => [item.filterType, item]));
  const tick = filters.get('PRICE_FILTER')?.tickSize;
  const lot = filters.get('LOT_SIZE');
  if (!tick || !lot) throw invalid('币安合约价格或数量规则缺失');
  const bestOpposite = positive(plan.direction === 'BUY' ? book.askPrice : book.bidPrice);
  const last = positive(ticker.price);
  if (!bestOpposite || !last) throw invalid('盘口价格不可用，请稍后重试');
  if (plan.mode === 'probe') {
    const edge = (plan.rangeHigh - plan.rangeLow) * 0.25;
    if (plan.direction === 'BUY' ? !(last >= plan.rangeLow && last <= plan.rangeLow + edge)
      : !(last <= plan.rangeHigh && last >= plan.rangeHigh - edge)) throw invalid('现价已离开震荡区间边缘，请重新分析');
  }
  const orders = plan.orders.map((order) => {
    const price = Number(stepped(order.price, tick, plan.direction === 'BUY' ? 'floor' : 'ceil'));
    if (!price || (plan.direction === 'BUY' ? price >= bestOpposite : price <= bestOpposite)) throw invalid('AI 某档价格会立即吃单，无法作为 Maker 挂单；请重新分析');
    const quantity = stepped(order.marginUsdt * plan.leverage / price, lot.stepSize);
    if (!positive(quantity) || Number(quantity) < Number(lot.minQty || 0) || Number(quantity) > Number(lot.maxQty || Infinity)) throw invalid('某档挂单数量不符合币安规则');
    if (Number(quantity) * price < Number(filters.get('MIN_NOTIONAL')?.notional || 0)) throw invalid('某档挂单低于币安最小名义价值');
    return { ...order, price, quantity, notionalUsdt: Number(quantity) * price };
  });
  const stopPrice = stepped(plan.stop, tick, plan.direction === 'BUY' ? 'ceil' : 'floor');
  const takePrice = stepped(plan.takeProfit, tick, plan.direction === 'BUY' ? 'floor' : 'ceil');
  if (orders.some((order) => plan.direction === 'BUY' ? !(Number(stopPrice) < order.price && Number(takePrice) > Math.max(order.price, last)) : !(Number(takePrice) < Math.min(order.price, last) && Number(stopPrice) > order.price))) throw invalid('按交易所精度取整后止盈止损无效');
  const totalMarginUsdt = orders.reduce((sum, order) => sum + order.marginUsdt, 0);
  const totalNotionalUsdt = orders.reduce((sum, order) => sum + order.notionalUsdt, 0);
  const estimatedLossUsdt = orders.reduce((sum, order) => sum + Math.abs(order.price - Number(stopPrice)) * Number(order.quantity), 0);
  if (estimatedLossUsdt > totalMarginUsdt * (plan.mode === 'probe' ? 0.1 : 0.3)) throw invalid('触及止损的预计损失超过当前策略上限，请重新分析');
  return {
    analysisId, symbol, mode: plan.mode, direction: plan.direction, leverage: plan.leverage, last,
    orders, stopPrice, takePrice, totalMarginUsdt, totalNotionalUsdt, estimatedLossUsdt,
    expiresAt: row.createdAt + 4 * 60 * 60_000,
    averagePrice: totalNotionalUsdt / orders.reduce((sum, order) => sum + Number(order.quantity), 0),
  };
}
async function placeTradfiAi(creds, userId, analysisId, expected, onProgress) {
  const report = (stage) => { try { onProgress?.(stage); } catch { /* A closed progress stream must not interrupt exchange cleanup. */ } };
  if (!tradfiAiMonitor.isRunning()) throw invalid('整套挂单需要常驻后端核对保护单；当前监控服务未运行', 503);
  const savedPlan = getSaved(userId, analysisId);
  if (savedPlan.submitted || savedPlan.submitting) throw invalid('该 AI 计划正在提交或已提交，请在币安核对订单');
  // Reserve before asynchronous preflight so concurrent confirmations cannot submit twice.
  savedPlan.submitting = true;
  let preview;
  let hedge;
  let positionSide;
  try {
    report({ id: 'prepare', status: 'running', progress: 3, message: '核对订单预览与币安账户…' });
    preview = await previewTradfiAi(userId, analysisId);
    if (!expected || expected !== previewFingerprint(preview)) throw invalid('计划或行情已变化，请重新预览');
    const mode = await signedRequest(creds, 'GET', '/fapi/v1/positionSide/dual');
    report({ id: 'prepare', status: 'running', progress: 6, message: '账户持仓模式已核对' });
    hedge = mode.dualSidePosition === true || mode.dualSidePosition === 'true';
    positionSide = hedge ? (preview.direction === 'BUY' ? 'LONG' : 'SHORT') : 'BOTH';
    const positions = await signedRequest(creds, 'GET', '/fapi/v2/positionRisk', { symbol: preview.symbol });
    report({ id: 'prepare', status: 'running', progress: 10, message: '现有仓位已核对' });
    if ((Array.isArray(positions) ? positions : []).some((position) => position.symbol === preview.symbol && Number(position.positionAmt || 0) !== 0)) throw invalid('该合约已有持仓，请先处理，避免保护单影响原仓位');
    await signedRequest(creds, 'POST', '/fapi/v1/leverage', { symbol: preview.symbol, leverage: String(preview.leverage) });
    savedPlan.submitted = true;
    report({ id: 'prepare', status: 'done', progress: 15, message: '账户和杠杆已核对，开始逐笔提交' });
  } finally {
    savedPlan.submitting = false;
  }
  const opposite = preview.direction === 'BUY' ? 'SELL' : 'BUY';
  const group = crypto.randomUUID().replace(/-/g, '').slice(0, 14);
  const placed = [];
  const attemptedIds = [];
  const protections = [];
  const totalActions = preview.orders.length * 3;
  let completedActions = 0;
  const actionProgress = () => 15 + Math.floor(75 * completedActions / totalActions);
  try {
    for (const leg of preview.orders) {
      const id = `wtf_${group}_${leg.level}`;
      attemptedIds.push(id);
      report({ id: `leg-${leg.level}-entry`, status: 'running', progress: actionProgress(), message: `正在提交第 ${leg.level + 1}/${preview.orders.length} 笔 Maker 入场单` });
      const order = await signedRequest(creds, 'POST', '/fapi/v1/order', {
        symbol: preview.symbol, side: preview.direction, positionSide, type: 'LIMIT', timeInForce: 'GTX',
        price: String(leg.price), quantity: leg.quantity, newClientOrderId: id,
      });
      placed.push({ ...leg, orderId: order.orderId, clientOrderId: id, status: order.status });
      completedActions += 1;
      report({ id: `leg-${leg.level}-entry`, status: 'done', progress: actionProgress(), message: `第 ${leg.level + 1} 笔入场单已提交` });
      const base = { algoType: 'CONDITIONAL', symbol: preview.symbol, side: opposite, positionSide, quantity: leg.quantity, workingType: 'CONTRACT_PRICE' };
      if (!hedge) base.reduceOnly = 'true';
      for (const [kind, type, triggerPrice] of [['stop', 'STOP_MARKET', preview.stopPrice], ['take', 'TAKE_PROFIT_MARKET', preview.takePrice]]) {
        const label = kind === 'stop' ? '止损' : '止盈';
        report({ id: `leg-${leg.level}-${kind}`, status: 'running', progress: actionProgress(), message: `正在提交第 ${leg.level + 1} 笔${label}保护单` });
        const clientAlgoId = `${id}_${kind}`;
        const protection = await signedRequest(creds, 'POST', '/fapi/v1/algoOrder', { ...base, type, triggerPrice, clientAlgoId });
        protections.push({ level: leg.level, kind, algoId: protection.algoId, clientAlgoId });
        if (!protection.algoId) throw invalid(`第 ${leg.level + 1} 笔${label}保护单未返回币安订单 ID，请核对条件单`, 502);
        completedActions += 1;
        report({ id: `leg-${leg.level}-${kind}`, status: 'done', progress: actionProgress(), message: `第 ${leg.level + 1} 笔${label}保护单已提交` });
      }
    }
    report({ id: 'verify', status: 'running', progress: 92, message: '正在逐笔核对止盈止损状态…' });
    for (let index = 0; index < protections.length; index += 1) {
      const item = protections[index];
      let checked;
      try { checked = await verifyAlgoOrder(creds, item); }
      catch (error) { throw invalid(`核验第 ${item.level + 1} 笔${item.kind === 'stop' ? '止损' : '止盈'}保护单失败（algoId ${item.algoId}）：${error.message}`, 502); }
      if (String(checked.algoStatus) !== 'NEW' || checked.side !== opposite || Number(checked.quantity) !== Number(preview.orders[item.level].quantity)) {
        throw invalid(`第 ${item.level + 1} 笔${item.kind === 'stop' ? '止损' : '止盈'}保护单状态或数量异常：${checked.algoStatus || '未知'}`, 502);
      }
      report({ id: 'verify', status: 'running', progress: 92 + Math.floor(5 * (index + 1) / protections.length), message: `已核验 ${index + 1}/${protections.length} 笔保护单` });
    }
    report({ id: 'verify', status: 'done', progress: 97, message: '全部保护单已确认' });
  } catch (error) {
    report({ id: 'cleanup', status: 'running', progress: actionProgress(), message: '提交未完成，正在核对并撤销可能已提交的订单…' });
    const cleanup = [];
    let unresolvedPosition = false;
    for (const clientOrderId of attemptedIds) {
      try {
        const current = await signedRequest(creds, 'GET', '/fapi/v1/order', { symbol: preview.symbol, origClientOrderId: clientOrderId });
        if (!['FILLED', 'CANCELED', 'EXPIRED', 'REJECTED'].includes(String(current.status))) {
          await signedRequest(creds, 'DELETE', '/fapi/v1/order', { symbol: preview.symbol, orderId: String(current.orderId) });
        }
        const latest = await signedRequest(creds, 'GET', '/fapi/v1/order', { symbol: preview.symbol, orderId: String(current.orderId) });
        const filled = Number(latest.executedQty || 0);
        if (filled > 0) {
          const close = { symbol: preview.symbol, side: opposite, positionSide, type: 'MARKET', quantity: String(filled) };
          if (!hedge) close.reduceOnly = 'true';
          await signedRequest(creds, 'POST', '/fapi/v1/order', close);
        }
      } catch (err) {
        if (Number(err.code) !== -2013) { cleanup.push(err.message); unresolvedPosition = true; }
      }
    }
    if (!unresolvedPosition) for (const item of protections) {
      try { await signedRequest(creds, 'DELETE', '/fapi/v1/algoOrder', item.algoId ? { algoId: String(item.algoId) } : { clientAlgoId: item.clientAlgoId }); } catch (err) { cleanup.push(err.message); }
    }
    throw invalid(`整套挂单未完成，已尝试撤销已提交委托。请立即在币安核对持仓与条件单。原因：${error.message}${cleanup.length ? `；撤销异常：${cleanup.join('、')}` : ''}`, 502);
  }
  tradfiAiMonitor.register({
    userId, symbol: preview.symbol, simulated: creds.simulated, positionSide, direction: preview.direction,
    orders: placed.map((item) => ({ orderId: item.orderId })),
    protections: protections.map((item) => ({ algoId: item.algoId })),
    expiresAt: preview.expiresAt,
  });
  report({ id: 'done', status: 'done', progress: 100, message: `${preview.orders.length} 笔入场单及保护单已提交并纳入监控` });
  return { ok: true, simulated: creds.simulated, preview, orders: placed, protections };
}
function previewFingerprint(preview) {
  const stable = {
    symbol: preview.symbol, mode: preview.mode, direction: preview.direction, leverage: preview.leverage,
    orders: preview.orders.map((order) => ({ price: order.price, quantity: order.quantity, marginUsdt: order.marginUsdt })),
    stopPrice: preview.stopPrice, takePrice: preview.takePrice,
  };
  return crypto.createHash('sha256').update(JSON.stringify(stable)).digest('hex');
}

module.exports = { analyzeTradfiAi, previewTradfiAi, placeTradfiAi, previewFingerprint, normalizeModelPlan, briefCandles };
