const { signedRequest } = require('./binanceTradfiTrade');
const { listBinanceAiOrders, isAiClientId } = require('./binanceAiLedger');
const { getDb } = require('./db');

function rememberManualStrategyClosure(userId, trade) {
  if (!userId || !trade?.id) return;
  try {
    getDb().prepare(`INSERT OR IGNORE INTO tradfi_manual_strategy_closures
      (user_id,trade_id,order_id,symbol,side,position_side,price,quantity,amount_usd,realized_pnl,commission,commission_asset,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      String(userId), String(trade.id), String(trade.orderId || ''), String(trade.symbol || ''), String(trade.side || ''),
      String(trade.positionSide || 'BOTH'), Number(trade.price) || null, Number(trade.qty) || 0,
      Number(trade.quoteQty) || Number(trade.price) * Number(trade.qty) || null, Number(trade.realizedPnl) || 0,
      Number(trade.commission) || 0, String(trade.commissionAsset || 'USDT'), Number(trade.time) || Date.now(),
    );
  } catch (err) { console.warn('[binance-ai-book] manual closure ledger:', err.message); }
}

function storedManualStrategyClosures(userId) {
  if (!userId) return [];
  try {
    return getDb().prepare(`SELECT * FROM tradfi_manual_strategy_closures WHERE user_id=? ORDER BY created_at DESC LIMIT 1000`)
      .all(String(userId));
  } catch { return []; }
}

async function accountBook(creds, userId, scope = 'crypto', fundingSinceBySymbol = {}) {
  const [balances, positions, orders] = await Promise.all([
    signedRequest(creds, 'GET', '/fapi/v2/balance'),
    signedRequest(creds, 'GET', '/fapi/v2/positionRisk'),
    signedRequest(creds, 'GET', '/fapi/v1/openOrders'),
  ]);
  const usdt = (Array.isArray(balances) ? balances : []).find((r) => r.asset === 'USDT');
  const ledger = userId ? listBinanceAiOrders(userId, scope) : [];
  const ledgerIds = new Set(ledger.map((row) => String(row.order_id)));
  const ledgerClients = new Set(ledger.map((row) => String(row.client_order_id)).filter(Boolean));
  const allPositions = (Array.isArray(positions) ? positions : []).filter((r) => Number(r.positionAmt) !== 0 && r.symbol?.endsWith('USDT'));
  const candidateSymbols = [...new Set([...ledger.map((row) => row.symbol), ...allPositions.map((row) => row.symbol)])].slice(0, 10);
  const orderHistory = (await Promise.all(candidateSymbols.map((symbol) => {
    const firstLedgerId = ledger.filter((row) => row.symbol === symbol)
      .map((row) => Number(row.order_id)).filter(Number.isFinite).sort((a, b) => a - b)[0];
    const params = { symbol, limit: '1000' };
    if (firstLedgerId) params.orderId = String(firstLedgerId);
    return signedRequest(creds, 'GET', '/fapi/v1/allOrders', params).catch(() => []);
  }))).flat();
  const userTrades = scope === 'tradfi' ? (await Promise.all(candidateSymbols.map((symbol) =>
    signedRequest(creds, 'GET', '/fapi/v1/userTrades', { symbol, limit: '1000' }).catch(() => []),
  ))).flat() : [];
  const fundingRows = scope === 'tradfi' ? (await Promise.all(candidateSymbols.map((symbol) => {
    const cycleStartedAt = Number(fundingSinceBySymbol[symbol]);
    if (!(cycleStartedAt > 0)) return [];
    const params = { symbol, incomeType: 'FUNDING_FEE', limit: '1000' };
    params.startTime = String(cycleStartedAt);
    return signedRequest(creds, 'GET', '/fapi/v1/income', params).catch(() => []);
  }))).flat() : [];
  const aiOrderIds = new Set(orderHistory.filter((order) =>
    isAiClientId(order.clientOrderId, scope)
      || ledgerIds.has(String(order.orderId))
      || ledgerClients.has(String(order.clientOrderId || '')),
  ).map((order) => String(order.orderId)));
  const pending = (Array.isArray(orders) ? orders : []).filter((row) =>
    isAiClientId(row.clientOrderId, scope) || ledgerIds.has(String(row.orderId)) || ledgerClients.has(String(row.clientOrderId || '')));
  const aiQtyByPosition = new Map();
  for (const order of orderHistory.sort((a, b) => Number(a.time || a.updateTime || 0) - Number(b.time || b.updateTime || 0))) {
    const filled = Number(order.executedQty || 0);
    if (!(filled > 0)) continue;
    const positionSide = String(order.positionSide || 'BOTH');
    const orderSide = String(order.side || '');
    const direction = positionSide === 'BOTH' ? (orderSide === 'SELL' ? 'SHORT' : 'LONG') : positionSide;
    const key = `${order.symbol}|${direction}`;
    const isAiEntry = isAiClientId(order.clientOrderId, scope)
      || ledgerIds.has(String(order.orderId))
      || ledgerClients.has(String(order.clientOrderId || ''));
    if (isAiEntry) {
      // Strategy exits share the same AI client-id prefix. Count them as a
      // reduction or a completed cycle will keep appearing as an AI position.
      const isClosing = order.reduceOnly === true || order.reduceOnly === 'true'
        || order.closePosition === true || /_close_/.test(String(order.clientOrderId || ''));
      aiQtyByPosition.set(key, Math.max(0, (aiQtyByPosition.get(key) || 0) + (isClosing ? -filled : filled)));
      continue;
    }
    // Manual adds never increase the AI share. Any later opposite fill consumes the
    // AI share first, so a manually reopened position cannot revive an old AI record.
    const closingDirection = positionSide === 'LONG' || (positionSide === 'BOTH' && orderSide === 'SELL')
      ? 'LONG'
      : positionSide === 'SHORT' || (positionSide === 'BOTH' && orderSide === 'BUY') ? 'SHORT' : '';
    if (closingDirection) {
      const closingKey = `${order.symbol}|${closingDirection}`;
      aiQtyByPosition.set(closingKey, Math.max(0, (aiQtyByPosition.get(closingKey) || 0) - filled));
    }
  }
  const pos = allPositions.map((row) => {
    const direction = row.positionSide === 'BOTH' ? (Number(row.positionAmt) < 0 ? 'SHORT' : 'LONG') : row.positionSide;
    const aiQty = aiQtyByPosition.get(`${row.symbol}|${direction}`) || 0;
    const totalQty = Math.abs(Number(row.positionAmt));
    const share = totalQty > 0 ? Math.min(1, aiQty / totalQty) : 0;
    return { row, share, aiQty: Math.min(totalQty, aiQty) };
  }).filter((item) => item.share > 0);
  const records = [
    ...pos.map(({ row: p, share, aiQty }) => ({ kind: 'position', ordId: `pos:${p.symbol}:${p.positionSide}`, instId: p.symbol, coin: p.symbol.slice(0, -4), side: Number(p.positionAmt) < 0 ? 'sell' : 'buy', posSide: p.positionSide?.toLowerCase(), px: Number(p.entryPrice), sz: String(aiQty), amountUsd: Math.abs(Number(p.notional)) * share, leverage: Number(p.leverage), state: 'filled', createdAt: Number(p.updateTime) || 0, openUpl: Number(p.unRealizedProfit) * share, realizedPnl: null, source: 'ai' })),
    ...pending.map((o) => { const saved = ledger.find((row) => row.order_id === String(o.orderId)); return ({ kind: 'pending', ordId: String(o.orderId), instId: o.symbol, coin: o.symbol.slice(0, -4), side: String(o.side).toLowerCase(), posSide: String(o.positionSide).toLowerCase(), px: Number(o.price), sz: String(Number(o.origQty) - Number(o.executedQty || 0)), amountUsd: (Number(o.origQty) - Number(o.executedQty || 0)) * Number(o.price), leverage: Number(saved?.leverage) || null, state: 'live', createdAt: Number(o.time) || 0, openUpl: null, realizedPnl: null, source: 'ai' }); }),
  ];
  const strategyQty = new Map();
  const manualClosures = [];
  const orderedTrades = [...userTrades].sort((a, b) => Number(a.time || 0) - Number(b.time || 0));
  for (const trade of orderedTrades) {
    const positionSide = String(trade.positionSide || 'BOTH').toUpperCase();
    const side = String(trade.side || '').toUpperCase();
    const closes = positionSide === 'LONG' ? side === 'SELL' : positionSide === 'SHORT' ? side === 'BUY' : Number(trade.realizedPnl) !== 0;
    const direction = positionSide === 'BOTH'
      ? (closes ? (side === 'SELL' ? 'LONG' : 'SHORT') : (side === 'BUY' ? 'LONG' : 'SHORT'))
      : positionSide;
    const key = `${trade.symbol}|${direction}`;
    const quantity = Number(trade.qty || 0);
    if (aiOrderIds.has(String(trade.orderId))) {
      strategyQty.set(key, Math.max(0, (strategyQty.get(key) || 0) + (closes ? -quantity : quantity)));
      continue;
    }
    if (!closes || !(quantity > 0)) continue;
    const attributedQty = Math.min(quantity, strategyQty.get(key) || 0);
    if (!(attributedQty > 0)) continue;
    strategyQty.set(key, (strategyQty.get(key) || 0) - attributedQty);
    const share = attributedQty / quantity;
    manualClosures.push({ ...trade, qty: String(attributedQty), quoteQty: Number(trade.quoteQty || 0) * share,
      realizedPnl: Number(trade.realizedPnl || 0) * share, commission: Number(trade.commission || 0) * share, manualStrategyClose: true });
  }
  for (const trade of manualClosures) rememberManualStrategyClosure(userId, trade);
  const storedManual = scope === 'tradfi' ? storedManualStrategyClosures(userId).map((trade) => ({
    id: trade.trade_id, orderId: trade.order_id, symbol: trade.symbol, side: trade.side, positionSide: trade.position_side,
    price: trade.price, qty: trade.quantity, quoteQty: trade.amount_usd, realizedPnl: trade.realized_pnl,
    commission: trade.commission, commissionAsset: trade.commission_asset, time: trade.created_at, manualStrategyClose: true,
  })) : [];
  const uniqueTrades = new Map();
  for (const trade of [...userTrades.filter((trade) => aiOrderIds.has(String(trade.orderId))), ...manualClosures, ...storedManual]) {
    const key = String(trade.id || `${trade.orderId}:${trade.time}`);
    if (!uniqueTrades.has(key)) uniqueTrades.set(key, trade);
  }
  const allTrades = [...uniqueTrades.values()].map((trade) => {
    const positionSide = String(trade.positionSide || 'BOTH').toUpperCase();
    const side = String(trade.side || '').toUpperCase();
    const closesPosition = positionSide === 'LONG' ? side === 'SELL' : positionSide === 'SHORT' ? side === 'BUY' : Number(trade.realizedPnl) !== 0;
    return {
      tradeId: String(trade.id || `${trade.orderId}:${trade.time}`), orderId: String(trade.orderId),
      instId: trade.symbol, coin: String(trade.symbol || '').replace(/USDT$/, ''), side: side.toLowerCase(),
      posSide: positionSide.toLowerCase(), action: closesPosition ? 'close' : 'open', source: trade.manualStrategyClose ? 'manual' : 'ai',
      px: Number(trade.price) || null, sz: String(trade.qty || ''),
      amountUsd: Number(trade.quoteQty) || Number(trade.price) * Number(trade.qty) || null,
      realizedPnl: Number(trade.realizedPnl) || 0, commission: Number(trade.commission) || 0,
      commissionAsset: trade.commissionAsset || 'USDT', createdAt: Number(trade.time) || 0,
    };
  }).filter((trade) => Number(trade.sz) > 0 && Number(trade.amountUsd) > 0 && Number(trade.createdAt) > 0)
    .sort((a, b) => b.createdAt - a.createdAt);
  // The sidebar is scoped to the selected symbol. Retain 50 rows per symbol so
  // XAU activity cannot push XAG history out of the UI (or vice versa).
  const perSymbolCount = new Map();
  const trades = allTrades.filter((trade) => {
    const count = perSymbolCount.get(trade.instId) || 0;
    perSymbolCount.set(trade.instId, count + 1);
    return count < 50;
  });
  const feesBySymbol = {};
  for (const symbol of candidateSymbols) feesBySymbol[symbol] = { tradingFees: 0, fundingFees: 0, netCost: 0 };
  for (const trade of allTrades) {
    if (trade.source !== 'ai' || trade.action !== 'open') continue;
    if (trade.commissionAsset !== 'USDT') continue;
    const fees = feesBySymbol[trade.instId] || (feesBySymbol[trade.instId] = { tradingFees: 0, fundingFees: 0, netCost: 0 });
    fees.tradingFees += Number(trade.commission) || 0;
  }
  for (const income of fundingRows) {
    const symbol = String(income.symbol || '');
    if (!feesBySymbol[symbol]) continue;
    feesBySymbol[symbol].fundingFees += Number(income.income) || 0;
  }
  for (const fees of Object.values(feesBySymbol)) fees.netCost = fees.fundingFees - fees.tradingFees;
  const costs = Object.values(feesBySymbol).reduce((sum, fees) => ({
    tradingFees: sum.tradingFees + fees.tradingFees,
    fundingFees: sum.fundingFees + fees.fundingFees,
    netCost: sum.netCost + fees.netCost,
  }), { tradingFees: 0, fundingFees: 0, netCost: 0 });
  const realizedPnl = scope === 'tradfi' ? allTrades.reduce((sum, trade) => sum + Number(trade.realizedPnl || 0), 0) : null;
  const historyPnl = scope === 'tradfi' ? allTrades.reduce((sum, trade) => sum + trade.realizedPnl - (trade.commissionAsset === 'USDT' ? trade.commission : 0), 0) : null;
  const openPnl = pos.reduce((sum, item) => sum + Number(item.row.unRealizedProfit || 0) * item.share, 0);
  return { ok: true, configured: true, simulated: creds.simulated, scope: 'ai-only', balance: { totalEq: Number(usdt?.balance) || null, usdtEq: Number(usdt?.balance) || null, availBal: Number(usdt?.availableBalance) || null }, openPnl, realizedPnl, historyPnl, records, trades, costs, feesBySymbol };
}

module.exports = { accountBook };
