const axios = require('axios');
const crypto = require('node:crypto');
const { getCatalog } = require('./tradfiMarkets');

const LIVE_URL = 'https://fapi.binance.com';
const DEMO_URL = 'https://demo-fapi.binance.com';
const client = axios.create({ timeout: 12_000, proxy: false });
let rulesCache = { until: 0, symbols: [] };

function invalid(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

function exchangeError(err, creds) {
  const code = err.response?.data?.code;
  let message = String(err.response?.data?.msg || err.message || '币安请求失败');
  if (Number(code) === -1022 || /signature for this request is not valid/i.test(message)) {
    const len = String(creds?.secret || '').length;
    const env = creds?.simulated ? '演示盘' : '实盘';
    message += ` —— 当前按【${env}】签名。已保存的 Secret 长度为 ${len} 位，币安 Secret 一般是 64 位。请到币安 API 管理里重新完整复制 Secret，不要用 API Key 或备注代替。`;
  }
  const next = new Error(message);
  next.status = Number(err.response?.status) || 502;
  next.code = code;
  return next;
}

async function publicGet(path, params = {}) {
  try { return (await client.get(`${LIVE_URL}${path}`, { params })).data; }
  catch (err) { throw exchangeError(err); }
}

async function signedRequest(creds, method, path, params = {}) {
  const body = new URLSearchParams({ ...params, recvWindow: '5000', timestamp: String(Date.now()) });
  const signature = crypto.createHmac('sha256', creds.secret).update(body.toString()).digest('hex');
  body.set('signature', signature);
  const base = creds.simulated ? DEMO_URL : LIVE_URL;
  try {
    const response = await client.request({
      method,
      url: method === 'GET' || method === 'DELETE' ? `${base}${path}?${body}` : `${base}${path}`,
      data: method === 'GET' || method === 'DELETE' ? undefined : body.toString(),
      headers: { 'X-MBX-APIKEY': creds.apiKey, 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    return response.data;
  } catch (err) { throw exchangeError(err, creds); }
}

async function symbolRules(symbol) {
  if (rulesCache.until < Date.now()) {
    const data = await publicGet('/fapi/v1/exchangeInfo');
    if (!Array.isArray(data.symbols)) throw invalid('币安合约规则暂不可用');
    rulesCache = { symbols: data.symbols, until: Date.now() + 10 * 60_000 };
  }
  return rulesCache.symbols.find((item) => item.symbol === symbol);
}

function decimalPlaces(step) {
  const value = String(step || '1');
  return value.includes('.') ? value.replace(/0+$/, '').split('.')[1]?.length || 0 : 0;
}

function stepped(value, step, mode = 'floor') {
  const size = Number(step);
  if (!Number.isFinite(size) || size <= 0) return String(value);
  const scaled = mode === 'ceil' ? Math.ceil(value / size - 1e-9) : Math.floor(value / size + 1e-9);
  return (scaled * size).toFixed(decimalPlaces(step));
}

async function previewTradfiOrder(input = {}) {
  const symbol = String(input.symbol || '').trim().toUpperCase();
  const side = input.side === 'SELL' ? 'SELL' : input.side === 'BUY' ? 'BUY' : '';
  const type = input.type === 'MARKET' ? 'MARKET' : input.type === 'LIMIT' ? 'LIMIT' : '';
  const margin = Number(input.marginUsdt);
  const leverage = Number(input.leverage);
  if (!/^[A-Z0-9]{3,30}$/.test(symbol) || !side || !type) throw invalid('请选择有效合约、方向和订单类型');
  if (!Number.isFinite(margin) || margin < 1 || margin > 1000) throw invalid('保证金需为 1–1000 USDT');
  if (!Number.isInteger(leverage) || leverage < 1 || leverage > 5) throw invalid('杠杆需为 1–5 倍');
  const catalog = await getCatalog();
  if (!catalog.symbols.some((item) => item.symbol === symbol)) throw invalid('该合约不是当前可交易的 TradFi 永续合约');
  const [rules, ticker] = await Promise.all([symbolRules(symbol), publicGet('/fapi/v1/ticker/price', { symbol })]);
  if (!rules || rules.status !== 'TRADING') throw invalid('该合约当前不可交易');
  const referencePrice = Number(ticker.price);
  if (!Number.isFinite(referencePrice) || referencePrice <= 0) throw invalid('无法获取最新价格');
  const filters = new Map((rules.filters || []).map((item) => [item.filterType, item]));
  const lot = filters.get(type === 'MARKET' ? 'MARKET_LOT_SIZE' : 'LOT_SIZE') || filters.get('LOT_SIZE');
  if (!lot) throw invalid('该合约缺少数量规则');
  let price = null;
  if (type === 'LIMIT') {
    const requestedPrice = Number(input.price);
    if (!Number.isFinite(requestedPrice) || requestedPrice <= 0) throw invalid('请输入有效限价');
    price = stepped(requestedPrice, filters.get('PRICE_FILTER')?.tickSize, side === 'SELL' ? 'ceil' : 'floor');
    if (Number(price) <= 0) throw invalid('限价低于最小价格单位');
  }
  const notional = margin * leverage;
  const quantity = stepped(notional / (price ? Number(price) : referencePrice), lot.stepSize);
  if (Number(quantity) <= 0 || Number(quantity) < Number(lot.minQty || 0) || Number(quantity) > Number(lot.maxQty || Infinity)) {
    throw invalid('按当前保证金计算的数量不符合交易所规则');
  }
  const actualNotional = Number(quantity) * (price ? Number(price) : referencePrice);
  if (actualNotional < Number(filters.get('MIN_NOTIONAL')?.notional || 0)) throw invalid('订单金额低于交易所最小名义价值');
  return { symbol, side, type, marginUsdt: margin, leverage, quantity, price, referencePrice, estimatedNotional: actualNotional, testnet: Boolean(input.testnet) };
}

async function placeTradfiOrder(creds, input = {}, testOnly = false) {
  if (input.expectedTestnet !== creds.simulated) throw invalid('币安密钥环境已变化，请重新预览订单');
  const plan = await previewTradfiOrder(input);
  if (String(input.expectedQuantity || '') !== plan.quantity
    || (plan.type === 'LIMIT' && String(input.expectedPrice || '') !== plan.price)
    || !Number.isFinite(Number(input.expectedReferencePrice))
    || Math.abs(plan.referencePrice / Number(input.expectedReferencePrice) - 1) > 0.005) {
    throw invalid('订单参数或行情已变化，请重新预览');
  }
  const [mode, positions] = await Promise.all([
    signedRequest(creds, 'GET', '/fapi/v1/positionSide/dual'),
    signedRequest(creds, 'GET', '/fapi/v2/positionRisk', { symbol: plan.symbol }),
  ]);
  const hedgeMode = mode.dualSidePosition === true || mode.dualSidePosition === 'true';
  if (!hedgeMode) {
    const current = (Array.isArray(positions) ? positions : []).find((item) => item.symbol === plan.symbol && item.positionSide === 'BOTH');
    const signedPosition = Number(current?.positionAmt || 0);
    if ((plan.side === 'BUY' && signedPosition < 0) || (plan.side === 'SELL' && signedPosition > 0)) {
      throw invalid('单向持仓模式下存在反向仓位，此订单可能平仓；请先在币安处理该仓位');
    }
  }
  const leverageResult = testOnly ? null : await signedRequest(creds, 'POST', '/fapi/v1/leverage', { symbol: plan.symbol, leverage: String(plan.leverage) });
  const params = {
    symbol: plan.symbol, side: plan.side, type: plan.type, quantity: plan.quantity,
    positionSide: hedgeMode ? (plan.side === 'BUY' ? 'LONG' : 'SHORT') : 'BOTH',
    newClientOrderId: `tf_${crypto.randomUUID().replace(/-/g, '').slice(0, 29)}`,
  };
  if (plan.type === 'LIMIT') { params.price = plan.price; params.timeInForce = 'GTC'; }
  const order = await signedRequest(creds, 'POST', testOnly ? '/fapi/v1/order/test' : '/fapi/v1/order', params);
  return { ok: true, testOnly, simulated: creds.simulated, plan: { ...plan, testnet: creds.simulated }, leverage: leverageResult?.leverage || null, order };
}

module.exports = { previewTradfiOrder, placeTradfiOrder, signedRequest, stepped, symbolRules, publicGet };
