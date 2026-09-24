const crypto = require('node:crypto');
const { signedRequest, symbolRules, publicGet, stepped } = require('./binanceTradfiTrade');

function invalid(message) { const err = new Error(message); err.status = 400; return err; }
function finitePositive(value) { const n = Number(value); return Number.isFinite(n) && n > 0 ? n : null; }
function actionSide(action) {
  const value = String(action || '');
  if (/做多|^long$|^buy$/i.test(value)) return 'BUY';
  if (/做空|^short$|^sell$/i.test(value)) return 'SELL';
  throw invalid('AI 建议不是明确的做多或做空');
}

async function planStance(input) {
  const coin = String(input.coin || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{2,15}$/.test(coin)) throw invalid('无效币种');
  const symbol = `${coin}USDT`;
  const side = actionSide(input.action);
  const margin = finitePositive(input.amountUsd);
  const leverage = Number(input.leverage);
  const stop = finitePositive(input.stop);
  const take = finitePositive(input.takeProfit);
  if (!margin || margin > 100) throw invalid('保证金需在 0–100 USDT 之间');
  if (!Number.isInteger(leverage) || leverage < 1 || leverage > 20) throw invalid('杠杆需在 1–20 倍之间');
  if (!stop || !take) throw invalid('止损和止盈价格无效');
  const [rules, ticker] = await Promise.all([symbolRules(symbol), publicGet('/fapi/v1/ticker/price', { symbol })]);
  if (!rules || rules.status !== 'TRADING' || rules.contractType !== 'PERPETUAL' || rules.quoteAsset !== 'USDT') throw invalid('币安暂不支持该 U 本位永续合约');
  const last = finitePositive(ticker.price);
  if (!last) throw invalid('无法获取当前价格');
  if (side === 'BUY' ? !(stop < last && take > last) : !(take < last && stop > last)) throw invalid('AI 止损止盈方向与当前价格不符，请刷新建议');
  const filters = new Map((rules.filters || []).map((item) => [item.filterType, item]));
  const tick = filters.get('PRICE_FILTER')?.tickSize;
  const lot = filters.get('LOT_SIZE');
  if (!tick || !lot) throw invalid('币安合约交易规则缺失');
  const makerPrice = Number(stepped(last * (side === 'BUY' ? 0.999 : 1.001), tick, side === 'BUY' ? 'floor' : 'ceil'));
  if (side === 'BUY' ? !(stop < makerPrice && take > makerPrice) : !(take < makerPrice && stop > makerPrice)) throw invalid('止损止盈方向与实际 Maker 委托价不符，请刷新建议');
  const quantity = stepped(margin * leverage / makerPrice, lot.stepSize);
  if (!finitePositive(quantity) || Number(quantity) < Number(lot.minQty || 0) || Number(quantity) > Number(lot.maxQty || Infinity)) throw invalid('订单数量不符合币安合约规则，请增加保证金');
  if (Number(quantity) * makerPrice < Number(filters.get('MIN_NOTIONAL')?.notional || 0)) throw invalid('订单金额低于币安最小名义价值');
  return {
    symbol, side, quantity, price: String(makerPrice), leverage, marginUsdt: margin,
    notionalUsdt: Number(quantity) * makerPrice,
    stopPrice: stepped(stop, tick, side === 'BUY' ? 'ceil' : 'floor'),
    takePrice: stepped(take, tick, side === 'BUY' ? 'floor' : 'ceil'),
  };
}

async function placeStance(creds, input) {
  const plan = await planStance(input);
  const [mode, positions] = await Promise.all([
    signedRequest(creds, 'GET', '/fapi/v1/positionSide/dual'),
    signedRequest(creds, 'GET', '/fapi/v2/positionRisk', { symbol: plan.symbol }),
  ]);
  const hedge = mode.dualSidePosition === true || mode.dualSidePosition === 'true';
  const positionSide = hedge ? (plan.side === 'BUY' ? 'LONG' : 'SHORT') : 'BOTH';
  const existing = (Array.isArray(positions) ? positions : []).find((p) => p.positionSide === positionSide);
  if (!hedge && (plan.side === 'BUY' ? Number(existing?.positionAmt) < 0 : Number(existing?.positionAmt) > 0)) throw invalid('现有反向仓位会使开仓变为平仓，请先处理该仓位');
  if (Number(existing?.positionAmt || 0) !== 0) throw invalid('该合约已有同向仓位，避免止损止盈误作用于原仓位，请先处理已有仓位');
  await signedRequest(creds, 'POST', '/fapi/v1/leverage', { symbol: plan.symbol, leverage: String(plan.leverage) });
  const opposite = plan.side === 'BUY' ? 'SELL' : 'BUY';
  const groupId = crypto.randomUUID().replace(/-/g, '').slice(0, 22);
  const base = { algoType: 'CONDITIONAL', symbol: plan.symbol, side: opposite, positionSide, closePosition: 'true', workingType: 'CONTRACT_PRICE' };
  const protection = [];
  let order;
  try {
    // Stop orders are registered first; a rejected protection never leaves a fresh entry order.
    protection.push(await signedRequest(creds, 'POST', '/fapi/v1/algoOrder', { ...base, type: 'STOP_MARKET', triggerPrice: plan.stopPrice, clientAlgoId: `wtai_${groupId}_s` }));
    protection.push(await signedRequest(creds, 'POST', '/fapi/v1/algoOrder', { ...base, type: 'TAKE_PROFIT_MARKET', triggerPrice: plan.takePrice, clientAlgoId: `wtai_${groupId}_t` }));
    order = await signedRequest(creds, 'POST', '/fapi/v1/order', {
      symbol: plan.symbol, side: plan.side, positionSide, type: 'LIMIT', timeInForce: 'GTX',
      price: plan.price, quantity: plan.quantity,
      newClientOrderId: `wtai_${groupId}_e`,
    });
  } catch (err) {
    const cleanup = await Promise.allSettled(protection.map((p) => signedRequest(creds, 'DELETE', '/fapi/v1/algoOrder', { algoId: String(p.algoId) })));
    if (cleanup.some((item) => item.status === 'rejected')) {
      const failure = invalid(`开仓未完成，部分止损止盈条件单清理失败；请立即在币安检查 ${plan.symbol} 条件单。原错误：${err.message}`);
      failure.status = 502;
      throw failure;
    }
    throw err;
  }
  return { ok: true, simulated: creds.simulated, order, protection, plan };
}

async function accountBook(creds) {
  const [balances, positions, orders] = await Promise.all([
    signedRequest(creds, 'GET', '/fapi/v2/balance'),
    signedRequest(creds, 'GET', '/fapi/v2/positionRisk'),
    signedRequest(creds, 'GET', '/fapi/v1/openOrders'),
  ]);
  const usdt = (Array.isArray(balances) ? balances : []).find((r) => r.asset === 'USDT');
  const pos = (Array.isArray(positions) ? positions : []).filter((r) => Number(r.positionAmt) !== 0 && r.symbol?.endsWith('USDT'));
  const pending = (Array.isArray(orders) ? orders : []).filter((r) => r.symbol?.endsWith('USDT'));
  const records = [
    ...pos.map((p) => ({ kind: 'position', ordId: `pos:${p.symbol}:${p.positionSide}`, instId: p.symbol, coin: p.symbol.slice(0, -4), side: Number(p.positionAmt) < 0 ? 'sell' : 'buy', posSide: p.positionSide?.toLowerCase(), px: Number(p.entryPrice), sz: String(Math.abs(Number(p.positionAmt))), amountUsd: Math.abs(Number(p.notional)), leverage: Number(p.leverage), state: 'filled', createdAt: Number(p.updateTime) || 0, openUpl: Number(p.unRealizedProfit), realizedPnl: null, source: 'binance' })),
    ...pending.map((o) => ({ kind: 'pending', ordId: String(o.orderId), instId: o.symbol, coin: o.symbol.slice(0, -4), side: String(o.side).toLowerCase(), posSide: String(o.positionSide).toLowerCase(), px: Number(o.price), sz: String(Number(o.origQty) - Number(o.executedQty || 0)), amountUsd: (Number(o.origQty) - Number(o.executedQty || 0)) * Number(o.price), leverage: null, state: 'live', createdAt: Number(o.time) || 0, openUpl: null, realizedPnl: null, source: 'binance' })),
  ];
  return { ok: true, configured: true, simulated: creds.simulated, scope: 'all', balance: { totalEq: Number(usdt?.balance) || null, usdtEq: Number(usdt?.balance) || null, availBal: Number(usdt?.availableBalance) || null }, openPnl: pos.reduce((sum, p) => sum + Number(p.unRealizedProfit || 0), 0), historyPnl: null, records };
}

module.exports = { planStance, placeStance, accountBook };
