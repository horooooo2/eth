/** Binance AI order ledger. Manual orders are never inserted here. */
const { getDb } = require('./db');

function scopeOf(value) { return value === 'tradfi' ? 'tradfi' : 'crypto'; }

function recordBinanceAiOrder(userId, scope, row = {}) {
  const orderId = String(row.orderId || '').trim();
  const symbol = String(row.symbol || '').trim().toUpperCase();
  if (!userId || !orderId || !symbol) return null;
  getDb().prepare(`
    INSERT INTO binance_ai_orders (
      user_id, order_id, client_order_id, symbol, scope, side, position_side,
      price, quantity, margin_usdt, leverage, simulated, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, order_id) DO UPDATE SET
      client_order_id=excluded.client_order_id, price=excluded.price,
      quantity=excluded.quantity, margin_usdt=excluded.margin_usdt,
      leverage=excluded.leverage
  `).run(
    String(userId), orderId, String(row.clientOrderId || ''), symbol, scopeOf(scope),
    String(row.side || ''), String(row.positionSide || 'BOTH'), Number(row.price) || null,
    String(row.quantity || ''), Number(row.marginUsdt) || null, Number(row.leverage) || null,
    row.simulated ? 1 : 0, Number(row.createdAt) || Date.now(),
  );
  return orderId;
}

function listBinanceAiOrders(userId, scope, limit = 120) {
  return getDb().prepare(`
    SELECT order_id, client_order_id, symbol, scope, side, position_side,
           price, quantity, margin_usdt, leverage, simulated, created_at
    FROM binance_ai_orders WHERE user_id = ? AND scope = ?
    ORDER BY created_at DESC LIMIT ?
  `).all(String(userId), scopeOf(scope), Math.max(1, Math.min(300, Number(limit) || 120)));
}

function isAiClientId(value, scope) {
  const id = String(value || '');
  return scopeOf(scope) === 'tradfi' ? id.startsWith('wtf_') : id.startsWith('wtai_');
}

module.exports = { recordBinanceAiOrder, listBinanceAiOrders, isAiClientId };
