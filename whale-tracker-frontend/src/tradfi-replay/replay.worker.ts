import core from '@core/tradfiRangeCore.cjs';

type Candle = { t: number; o: number; h: number; l: number; c: number; v: number };
type Funding = { t: number; rate: number };
type Side = 'long' | 'short';
type Position = { side: Side; qty: number; avg: number; margin: number; adds: number; lastAdd: number; fee: number; funding: number; realized: number; openedAt: number; minNet: number; recovery: boolean; recoveryArmed: boolean; recoveryPeak: number; recoveryTrail: number; sparseMode: boolean };
type Order = { side: Side; purpose: 'open' | 'add' | 'close'; price: number; qty: number; margin: number; createdAt: number; expiresAt: number; adds: number; label: string };

const scope: any = self as any;
let candles: Candle[] = []; let funding: Funding[] = []; let settings: any; let index = 0; let warmupState: any = null; let expectedCandles = 0;
const aggregateCache = new Map<number, Candle[]>();
let positions: Record<Side, Position | null> = { long: null, short: null };
let orders: Record<Side, Order | null> = { long: null, short: null };
let rebuildAt: Record<Side, number> = { long: 0, short: 0 };
let fundingIndex = 0; let timer: number | null = null; let speed = 10;
let logs: any[] = []; let tradeCount = 0; let realized = 0; let realizedFunding = 0; let fees = 0; let fundingTotal = 0;
let maxLossPeak: Record<Side | 'total', number> = { long: 0, short: 0, total: 0 };
let startedAt = 0; let stateLabel = '等待有效数据'; let lastMarket: any = null; let cooldownUntil = 0; let sentLogCount = 0;

function emitLog(time: number, type: string, text: string, detail: any = {}) {
  if (type !== 'position-close') return;
  const event = { id: `${time}-${logs.length}`, time, type, text, ...detail };
  logs.push(event);
}
function asKline(c: Candle, interval: number): number[] { return [c.t, c.o, c.h, c.l, c.c, c.v, c.t + interval - 1]; }
function aggregate(until: number, interval: number, count: number): number[][] {
  const bars = aggregateCache.get(interval) || [];
  const endTime = until - interval * 60_000;
  let low = 0; let high = bars.length;
  while (low < high) { const mid = (low + high) >>> 1; if (bars[mid].t <= endTime) low = mid + 1; else high = mid; }
  return bars.slice(Math.max(0, low - count), low).map((c) => asKline(c, interval * 60_000));
}
async function buildAggregateCache() {
  aggregateCache.clear();
  const intervals = [15, 60]; const barsByInterval = new Map<number, Candle[]>(intervals.map((interval) => [interval, []]));
  const current = new Map<number, Candle | null>(intervals.map((interval) => [interval, null]));
  for (let i = 0; i < candles.length; i += 1) {
    const candle = candles[i];
    for (const interval of intervals) {
      const bucket = Math.floor(candle.t / (interval * 60_000)) * interval * 60_000;
      const active = current.get(interval);
      if (!active || active.t !== bucket) {
        if (active) barsByInterval.get(interval)!.push(active);
        current.set(interval, { t: bucket, o: candle.o, h: candle.h, l: candle.l, c: candle.c, v: candle.v });
      } else {
        active.h = Math.max(active.h, candle.h); active.l = Math.min(active.l, candle.l); active.c = candle.c; active.v += candle.v;
      }
    }
    if (i > 0 && i % 50_000 === 0) {
      scope.postMessage({ type: 'warmup-progress', progress: 78 + Math.floor((i / candles.length) * 5), stage: `预计算 15 分钟 / 1 小时指标K线 · ${i.toLocaleString()} / ${candles.length.toLocaleString()} 根` });
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  for (const interval of intervals) { const active = current.get(interval); const bars = barsByInterval.get(interval) || []; if (active) bars.push(active); aggregateCache.set(interval, bars); }
}
function sidePnl(p: Position, price: number): number { return p.realized + (p.side === 'long' ? (price - p.avg) : (p.avg - price)) * p.qty + p.funding - p.fee; }
function makerFill(order: Order, bar: Candle): boolean {
  const penetration = settings.tickSize;
  if (order.purpose === 'close') {
    // Closing a long sells into bids; closing a short buys from asks.
    return order.side === 'long' ? bar.h >= order.price + penetration : bar.l <= order.price - penetration;
  }
  // Opening a long buys at a lower maker price; opening a short sells at a higher one.
  return order.side === 'long' ? bar.l <= order.price - penetration : bar.h >= order.price + penetration;
}
function fill(order: Order, bar: Candle) {
  const notional = order.qty * order.price;
  const fee = notional * settings.makerFee;
  fees += fee; tradeCount += 1;
  if (order.purpose === 'close') {
    const p = positions[order.side]; if (!p) return;
    const gross = order.side === 'long' ? (order.price - p.avg) * p.qty : (p.avg - order.price) * p.qty;
    const net = gross + p.funding - p.fee - fee;
    realized += net;
    realizedFunding += p.funding;
    cooldownUntil = bar.t + 70_000; // Fill time is unknown within a 1m candle; wait conservatively.
    if (order.label !== '底仓配对失败撤回') rebuildAt[order.side] = bar.t + 70_000;
    emitLog(bar.t, 'position-close', `${order.side === 'long' ? '多' : '空'}仓已平仓 · 净盈亏 ${fmt(net)}U`, {
      side: order.side, symbol: settings.symbol, openedAt: p.openedAt, closedAt: bar.t,
      openPrice: p.avg, closePrice: order.price, pnl: net, funding: p.funding, fee: p.fee + fee,
    });
    positions[order.side] = null;
    stateLabel = `${order.side === 'long' ? '多' : '空'}仓止盈 · 10秒后重建`;
  } else {
    const old = positions[order.side];
    const totalQty = (old?.qty || 0) + order.qty;
    const avg = totalQty ? ((old?.avg || 0) * (old?.qty || 0) + order.price * order.qty) / totalQty : order.price;
    const actualMargin = order.qty * order.price / settings.leverage;
    const count = core.countedAdditions({ longAdditions: order.side === 'long' ? (old?.adds || 0) : 0, shortAdditions: order.side === 'short' ? (old?.adds || 0) : 0 }, order.side === 'long', order.adds);
    positions[order.side] = { side: order.side, qty: totalQty, avg, margin: (old?.margin || 0) + actualMargin,
      adds: count.next, lastAdd: order.price, fee: (old?.fee || 0) + fee,
      funding: old?.funding || 0, realized: old?.realized || 0, openedAt: old?.openedAt || bar.t,
      minNet: old?.minNet || 0, recovery: old?.recovery || false, recoveryArmed: old?.recoveryArmed || false,
      recoveryPeak: old?.recoveryPeak || 0, recoveryTrail: old?.recoveryTrail || 0, sparseMode: old?.sparseMode || false };
    emitLog(bar.t, `${order.purpose}-fill`, `${order.side === 'long' ? '多' : '空'}仓${order.purpose === 'add' ? '补仓' : '开仓'}成交 · ${fmt(order.price)}`, { price: order.price, quantity: order.qty, notional, margin: actualMargin, fee, adds: positions[order.side]?.adds });
  }
  orders[order.side] = null;
}
function expire(order: Order, bar: Candle) {
  const time = bar.t;
  emitLog(time, 'expired', `${order.side === 'long' ? '多' : '空'}仓${order.purpose === 'add' ? '补仓' : order.purpose === 'close' ? '止盈' : '底仓'}委托过期未成交`, { price: order.price });
  orders[order.side] = null;
  if (order.purpose === 'open' && order.label === '止盈后同向重建') {
    // Match live behavior: a maker re-entry that expires returns to the wait
    // state and is retried after the cooldown, even if the opposite leg is open.
    rebuildAt[order.side] = time + 70_000;
    stateLabel = `${order.side === 'long' ? '多' : '空'}仓重建单过期 · 冷却后重试`;
    return;
  }
  if (order.purpose === 'open' && order.label === '双向底仓') {
    const other: Side = order.side === 'long' ? 'short' : 'long';
    if (orders[other]?.label === '双向底仓') {
      emitLog(time, 'cancelled', `${other === 'long' ? '多' : '空'}向底仓撤单：双向建仓未能同时完成`, { price: orders[other]?.price });
      orders[other] = null;
    }
    for (const side of ['long', 'short'] as Side[]) {
      if (!positions[side] || orders[side]) continue;
      place(side, 'close', bar.c + (side === 'long' ? settings.tickSize : -settings.tickSize), 0, time, 0, '底仓配对失败撤回');
    }
    stateLabel = '双向底仓未同时成交 · 撤回已成交侧';
  }
}
function place(side: Side, purpose: Order['purpose'], price: number, margin: number, time: number, adds = 0, label = '') {
  if (orders[side]) return;
  const roundDown = purpose === 'close' ? side === 'short' : side === 'long';
  price = (roundDown ? Math.floor(price / settings.tickSize + 1e-9) : Math.ceil(price / settings.tickSize - 1e-9)) * settings.tickSize;
  // Close orders must use the held position quantity. Their margin is zero by
  // design; deriving quantity from margin silently rejected every take-profit.
  const rawQty = purpose === 'close' ? Number(positions[side]?.qty || 0) : margin * settings.leverage / price;
  const qty = Math.floor((rawQty + settings.qtyStep * 1e-9) / settings.qtyStep) * settings.qtyStep;
  if (!(qty > 0)) { emitLog(time, 'rejected', `${side === 'long' ? '多' : '空'}仓委托数量低于数量步进`, { price, margin, rawQty }); return; }
  orders[side] = { side, purpose, price, qty, margin, createdAt: time, expiresAt: time + settings.orderTtlMs, adds, label };
  emitLog(time, 'placed', `${side === 'long' ? '多' : '空'}仓${purpose === 'add' ? '补仓' : purpose === 'close' ? '止盈' : '底仓'}挂单 · ${fmt(price)} · ${fmt(margin)}U`, { price, qty, margin, label });
}
function fmt(value: number): string { return Number(value || 0).toFixed(2); }
function processBar(bar: Candle) {
  // Funding is charged at its timestamp before orders in that minute can fill.
  while (fundingIndex < funding.length && funding[fundingIndex].t <= bar.t) {
    const f = funding[fundingIndex++];
    for (const side of ['long', 'short'] as Side[]) {
      const p = positions[side]; if (!p) continue;
      // Positive funding: long pays, short receives.
      const cash = (side === 'long' ? -1 : 1) * p.qty * bar.o * f.rate;
      p.funding += cash; fundingTotal += cash;
      emitLog(f.t, 'funding', `${side === 'long' ? '多' : '空'}仓资金费 ${fmt(cash)}U`, { amount: cash, rate: f.rate });
    }
  }
  // Pending orders from earlier minute closes are eligible first; newly created orders
  // at this close cannot see the current bar (prevents look-ahead).
  for (const side of ['long', 'short'] as Side[]) {
    const pending = orders[side];
    if (pending) {
      if (bar.t >= pending.expiresAt) expire(pending, bar);
      else if (bar.t > pending.createdAt && makerFill(pending, bar)) fill(pending, bar);
    }
  }
  const rows15 = aggregate(bar.t + 60_000, 15, 160);
  const rows60 = aggregate(bar.t + 60_000, 60, 60);
  try { lastMarket = index === 1200 && warmupState ? warmupState : core.marketState(rows15, rows60); }
  catch { stateLabel = '累积预热K线'; return; }
  const combinedNet = (['long', 'short'] as Side[]).reduce((sum, side) => {
    const position = positions[side];
    return sum + (position ? sidePnl(position, bar.c) - position.qty * bar.c * settings.makerFee : 0);
  }, 0);
  maxLossPeak.total = Math.max(maxLossPeak.total, Math.abs(Math.min(0, combinedNet)));
  if (['long', 'short'].some((side) => orders[side as Side]?.label === '双向底仓')) {
    stateLabel = '等待双向底仓成交'; return;
  }
  const price = bar.c;
  for (const side of ['long', 'short'] as Side[]) {
    if (!positions[side] && !orders[side] && rebuildAt[side] && bar.t >= rebuildAt[side]) {
      place(side, 'open', price + (side === 'long' ? -settings.tickSize : settings.tickSize), settings.marginUsdt, bar.t, 0, '止盈后同向重建');
      rebuildAt[side] = 0;
    }
  }
  if (!positions.long && !positions.short && !orders.long && !orders.short) {
    if (bar.t + 60_000 < cooldownUntil) stateLabel = `止盈后冷却 · ${Math.ceil((cooldownUntil - (bar.t + 60_000)) / 1000)}秒`;
    else if (lastMarket.rangeReady) {
      const firstMargin = settings.marginUsdt;
      place('long', 'open', Math.max(settings.tickSize, price - settings.tickSize), firstMargin, bar.t, 0, '双向底仓');
      place('short', 'open', price + settings.tickSize, firstMargin, bar.t, 0, '双向底仓');
      stateLabel = '震荡确认 · 建立双向底仓';
    } else stateLabel = lastMarket.trend ? `趋势过滤 · 暂停新开仓（${lastMarket.trendDirection}）` : '等待震荡结构';
  }
  for (const side of ['long', 'short'] as Side[]) {
    const p = positions[side];
    if (!p) continue;
    const pendingClose = orders[side]?.purpose === 'close';
    if (pendingClose) {
      const currentNotional = p.qty * price;
      const currentExitFee = currentNotional * settings.makerFee;
      const currentPricePnl = p.realized + (side === 'long' ? price - p.avg : p.avg - price) * p.qty;
      const pendingNet = core.takeProfitNetPnl({ pricePnl: currentPricePnl, funding: p.funding, entryFee: p.fee, exitFee: currentExitFee });
      if (core.shouldCancelTakeProfit(pendingNet)) {
        orders[side] = null;
        p.recoveryArmed = false; p.recoveryPeak = 0; p.recoveryTrail = 0;
        stateLabel = `${side === 'long' ? '多' : '空'}仓止盈单撤销 · 恢复补仓监控`;
      }
    }
    const notional = p.qty * price;
    const pricePnl = p.realized + (side === 'long' ? price - p.avg : p.avg - price) * p.qty;
    const estimatedCloseFee = notional * settings.makerFee;
    const positionNet = sidePnl(p, price) - estimatedCloseFee;
    const decisionNet = core.takeProfitNetPnl({ pricePnl, funding: p.funding, entryFee: p.fee, exitFee: estimatedCloseFee });
    p.minNet = Math.min(p.minNet, decisionNet);
    maxLossPeak[side] = Math.max(maxLossPeak[side], Math.abs(Math.min(0, positionNet)));
    const recovery = p.recovery || Math.abs(Math.min(0, p.minNet)) >= Math.max(5, notional * 0.002);
    const scalpTarget = Math.max(0.4, notional * 0.0002);
    const target = recovery ? Math.max(scalpTarget * 3, Math.abs(Math.min(0, p.minNet)) * 0.25) : scalpTarget;
    p.recovery = recovery;
    p.recoveryPeak = recovery ? Math.max(p.recoveryPeak, decisionNet) : 0;
    p.recoveryArmed = recovery && p.recoveryPeak >= target;
    p.recoveryTrail = recovery ? Math.max(1.5, p.qty * Number(lastMarket.atr || 0) * 1.2) : 0;
    const recoveryExit = core.recoveryExitState({ recovery, armed: p.recoveryArmed, netPnl: decisionNet, peakNetPnl: p.recoveryPeak,
      trail: p.recoveryTrail, trend: lastMarket.trend, target });
    const shouldClose = recovery ? recoveryExit.shouldClose : decisionNet >= target;
    if (!orders[side] && shouldClose) {
      const triggerFunding = Math.min(0, p.funding);
      const guard = side === 'long' ? p.avg + (target + p.fee + estimatedCloseFee - triggerFunding) / p.qty : p.avg - (target + p.fee + estimatedCloseFee - triggerFunding) / p.qty;
      const limit = side === 'long' ? Math.max(guard, price + settings.tickSize) : Math.min(guard, price - settings.tickSize);
      place(side, 'close', limit, 0, bar.t, 0, recovery ? recoveryExit.reason || '恢复模式回撤保护' : '小额止盈');
    }
    if (orders[side]) continue;
    const isLong = side === 'long';
    const sparse = core.sparseModeDecision({ active: p.sparseMode, side, entryPrice: p.avg, price, atr1h: lastMarket.atr1h,
      trendDirection: lastMarket.trendDirection, trendBars: lastMarket.trendBars,
      trendWeakBars: isLong ? lastMarket.upWeakBars : lastMarket.downWeakBars });
    if (sparse.enter) emitLog(bar.t, 'sparse-enter', `${side === 'long' ? '多' : '空'}仓进入稀疏阶梯`, { distanceAtr: sparse.distanceAtr });
    if (sparse.exit) emitLog(bar.t, 'sparse-exit', `${side === 'long' ? '多' : '空'}仓退出稀疏阶梯`, { distanceAtr: sparse.distanceAtr });
    p.sparseMode = sparse.active;
    if ((lastMarket.trend || lastMarket.trendDirection !== 'neutral') && !sparse.active) continue;
    const step = sparse.active ? core.sparseLadderStep(price, lastMarket.addStep, lastMarket.atr1h) : lastMarket.addStep;
    const counts = { longAdditions: side === 'long' ? p.adds : 0, shortAdditions: side === 'short' ? p.adds : 0 };
    const decision = core.additionDecision(counts, isLong);
    if (decision.action !== 'add') continue;
    const nextTier = decision.next;
    const max = isLong ? core.MAX_LONG_ADDITIONS : core.MAX_SHORT_ADDITIONS;
    const count = sparse.active ? core.sparseGroupCount(p.adds, max) : 1;
    if (count <= 0) continue;
    const trigger = sparse.active ? core.sparseGroupTrigger(p.lastAdd, step, count, isLong) : p.lastAdd + (isLong ? -step : step);
    if (!core.shouldPlaceAddition({ sparseMode: sparse.active, side, price, triggerPrice: trigger }) || pricePnl >= 0) continue;
    const margin = sparse.active ? core.sparseGroupMargin(settings.symbol, nextTier, count, settings.marginUsdt) : core.ladderMargin(settings.symbol, nextTier, settings.marginUsdt);
    const limit = sparse.active ? trigger : (isLong ? price - settings.tickSize : price + settings.tickSize);
    place(side, 'add', limit, margin, bar.t, count, sparse.active ? `稀疏 ${p.adds + 1}-${p.adds + count}/${max}` : `常规 ${nextTier}/${max}`);
  }
  if (positions.long || positions.short) stateLabel = `${lastMarket.trend ? '趋势过滤' : '策略运行中'} · ${lastMarket.trend ? '暂停补仓' : '监控仓位'}`;
}
function snapshot() {
  const bar = candles[Math.max(0, index - 1)]; const price = bar?.c || 0;
  const data: any = { index, total: candles.length, progress: candles.length ? index / candles.length : 0, time: bar?.t || 0, price,
    state: stateLabel, symbol: settings.symbol, positions: {}, orders: {}, realized, realizedFunding, maxLossPeak: { ...maxLossPeak }, fees, funding: fundingTotal,
    unrealized: 0, net: realized, tradeCount, recentLogs: logs.slice(-100), logsTotal: logs.length, market: lastMarket,
    candles: sampledCandles(), paused: timer == null, startedAt };
  for (const side of ['long', 'short'] as Side[]) {
    const p = positions[side]; const o = orders[side];
    data.positions[side] = p ? { ...p, pnl: sidePnl(p, price), notional: p.qty * price } : null;
    if (p) data.unrealized += sidePnl(p, price);
    data.orders[side] = o ? { ...o } : null;
  }
  data.net = realized + data.unrealized;
  return data;
}
function sampledCandles(): Candle[] {
  const start = Math.max(0, index - 720); const subset = candles.slice(start, index);
  if (subset.length <= 240) return subset;
  const stride = Math.ceil(subset.length / 240); return subset.filter((_, i) => i % stride === 0 || i === subset.length - 1);
}
function advance(count = 1) {
  const end = Math.min(candles.length, index + count);
  while (index < end) processBar(candles[index++]);
  scope.postMessage({ type: 'tick', payload: snapshot(), newLogs: logs.slice(sentLogCount) }); sentLogCount = logs.length;
  if (index >= candles.length) { stop(); emitLog(candles.at(-1)?.t || 0, 'done', '回放完成'); scope.postMessage({ type: 'tick', payload: snapshot(), newLogs: logs.slice(sentLogCount) }); sentLogCount = logs.length; }
}
function stop() { if (timer != null) clearInterval(timer); timer = null; }
function beginReplay(message: any) {
  stop(); candles = []; funding = message.funding || []; settings = message.settings; expectedCandles = Number(message.candleCount) || 0; index = 0;
  positions = { long: null, short: null }; orders = { long: null, short: null }; rebuildAt = { long: 0, short: 0 };
  fundingIndex = 0; logs = []; tradeCount = 0; realized = 0; realizedFunding = 0; maxLossPeak = { long: 0, short: 0, total: 0 }; fees = 0; fundingTotal = 0; lastMarket = null; warmupState = null; cooldownUntil = 0; sentLogCount = 0;
  stateLabel = '载入回放数据'; startedAt = Date.now();
  scope.postMessage({ type: 'warmup-progress', progress: 6, stage: '回放引擎已就绪，等待分块数据…' });
}
function appendChunk(message: any) {
  const flat = new Float64Array(message.buffer); const start = Number(message.start) || 0; const count = Number(message.count) || Math.floor(flat.length / 6);
  if (start !== candles.length || flat.length !== count * 6) {
    scope.postMessage({ type: 'replay-error', message: `分块数据顺序异常（预期 ${candles.length}，收到 ${start}）` }); return;
  }
  for (let row = 0; row < count; row += 1) { const offset = row * 6; candles.push({ t: flat[offset], o: flat[offset + 1], h: flat[offset + 2], l: flat[offset + 3], c: flat[offset + 4], v: flat[offset + 5] }); }
  const received = candles.length; const ratio = expectedCandles ? received / expectedCandles : 1;
  scope.postMessage({ type: 'warmup-progress', progress: 8 + Math.floor(ratio * 68), stage: `回放引擎接收并校验 K 线 · ${received.toLocaleString()} / ${expectedCandles.toLocaleString()} 根` });
  scope.postMessage({ type: 'chunk-ack', received, total: expectedCandles });
}
async function finishReplay() {
  if (candles.length !== expectedCandles) { scope.postMessage({ type: 'replay-error', message: `数据未完整传送：收到 ${candles.length} / ${expectedCandles} 根 K 线` }); return; }
  fundingIndex = funding.findIndex((f) => f.t >= (candles[0]?.t || 0)); if (fundingIndex < 0) fundingIndex = funding.length;
  scope.postMessage({ type: 'warmup-progress', progress: 78, stage: `校验完成 · ${candles.length.toLocaleString()} 根 K 线、${funding.length.toLocaleString()} 条资金费` });
  await buildAggregateCache();
  scope.postMessage({ type: 'warmup-progress', progress: 84, stage: '指标K线预计算完成，准备预热策略…' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  scope.postMessage({ type: 'warmup-progress', progress: 88, stage: '计算 15 分钟 ATR 与补仓间距…' });
  if (candles.length >= 1200) {
    index = 1200;
    const warmBar = candles[1199];
    warmupState = core.marketState(aggregate(warmBar.t + 60_000, 15, 160), aggregate(warmBar.t + 60_000, 60, 60));
    index = 0;
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
  scope.postMessage({ type: 'warmup-progress', progress: 95, stage: '计算小时趋势、稀疏阶梯与恢复指标…' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  stateLabel = '等待回放';
  emitLog(candles[0]?.t || 0, 'start', `开始 ${settings.symbol} 分钟回放 · ${candles.length.toLocaleString()} 根K线`);
  scope.postMessage({ type: 'warmup-progress', progress: 100, stage: '准备完成' });
  scope.postMessage({ type: 'ready', payload: snapshot() });
}

scope.onmessage = (event: MessageEvent) => {
  const m = event.data;
  if (m.type === 'init-start') {
    beginReplay(m);
  } else if (m.type === 'init-chunk') {
    appendChunk(m);
  } else if (m.type === 'init-complete') {
    void finishReplay().catch((error) => scope.postMessage({ type: 'replay-error', message: error instanceof Error ? error.message : String(error) }));
  } else if (m.type === 'step') { stop(); advance(1); }
  else if (m.type === 'play') { stop(); speed = Math.max(1, Number(m.speed) || 1); timer = self.setInterval(() => advance(speed), 50); }
  else if (m.type === 'pause') stop();
  else if (m.type === 'export') scope.postMessage({ type: 'export', payload: logs });
  else if (m.type === 'stop') stop();
};
