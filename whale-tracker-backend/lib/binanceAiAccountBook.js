const { signedRequest } = require('./binanceTradfiTrade');
const { listBinanceAiOrders, isAiClientId } = require('./binanceAiLedger');

async function accountBook(creds, userId, scope = 'crypto') {
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
      aiQtyByPosition.set(key, (aiQtyByPosition.get(key) || 0) + filled);
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
  const trades = userTrades.filter((trade) => aiOrderIds.has(String(trade.orderId))).map((trade) => {
    const positionSide = String(trade.positionSide || 'BOTH').toUpperCase();
    const side = String(trade.side || '').toUpperCase();
    const closesPosition = positionSide === 'LONG' ? side === 'SELL' : positionSide === 'SHORT' ? side === 'BUY' : Number(trade.realizedPnl) !== 0;
    return {
      tradeId: String(trade.id || `${trade.orderId}:${trade.time}`), orderId: String(trade.orderId),
      instId: trade.symbol, coin: String(trade.symbol || '').replace(/USDT$/, ''), side: side.toLowerCase(),
      posSide: positionSide.toLowerCase(), action: closesPosition ? 'close' : 'open',
      px: Number(trade.price) || null, sz: String(trade.qty || ''),
      amountUsd: Number(trade.quoteQty) || Number(trade.price) * Number(trade.qty) || null,
      realizedPnl: Number(trade.realizedPnl) || 0, commission: Number(trade.commission) || 0,
      commissionAsset: trade.commissionAsset || 'USDT', createdAt: Number(trade.time) || 0,
    };
  }).sort((a, b) => b.createdAt - a.createdAt).slice(0, 100);
  const historyPnl = scope === 'tradfi' ? trades.reduce((sum, trade) => sum + trade.realizedPnl - (trade.commissionAsset === 'USDT' ? trade.commission : 0), 0) : null;
  return { ok: true, configured: true, simulated: creds.simulated, scope: 'ai-only', balance: { totalEq: Number(usdt?.balance) || null, usdtEq: Number(usdt?.balance) || null, availBal: Number(usdt?.availableBalance) || null }, openPnl: pos.reduce((sum, item) => sum + Number(item.row.unRealizedProfit || 0) * item.share, 0), historyPnl, records, trades };
}

module.exports = { accountBook };
