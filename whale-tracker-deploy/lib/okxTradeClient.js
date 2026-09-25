/**
 * OKX ?????? REST??MAC ????? * ?????????????????? withTradeCredentials / options.credentials ??????????? *
 * OKX_API_KEY / OKX_API_SECRET / OKX_API_PASSPHRASE
 * OKX_TRADE_SIMULATED=1  ?????????????????
 * OKX_TRADE_BASE         ????? https://www.okx.com
 */
const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');
const axios = require('axios');
const https = require('https');

const FORCE_IPV4 = String(process.env.OKX_FORCE_IPV4 || '1') !== '0';
const httpsAgent = FORCE_IPV4 ? new https.Agent({ family: 4, keepAlive: true }) : undefined;
const OKX_PROXY = String(
  process.env.OKX_PROXY || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '',
).trim();

const credAls = new AsyncLocalStorage();

function tradeBase() {
  return String(process.env.OKX_TRADE_BASE || process.env.OKX_BASE || 'https://www.okx.com').replace(
    /\/$/,
    '',
  );
}

function envCredentials() {
  return {
    apiKey: String(process.env.OKX_API_KEY || '').trim(),
    secret: String(process.env.OKX_API_SECRET || '').trim(),
    passphrase: String(process.env.OKX_API_PASSPHRASE || '').trim(),
    simulated: String(process.env.OKX_TRADE_SIMULATED || '1') !== '0',
  };
}

function normalizeCreds(input) {
  if (!input || typeof input !== 'object') return null;
  const apiKey = String(input.apiKey || input.api_key || '').trim();
  const secret = String(input.secret || input.apiSecret || input.api_secret || '').trim();
  const passphrase = String(
    input.passphrase || input.apiPassphrase || input.api_passphrase || '',
  ).trim();
  if (!apiKey || !secret || !passphrase) return null;
  const simulated =
    input.simulated === false || input.simulated === 0 || input.simulated === '0'
      ? false
      : input.simulated === true || input.simulated === 1 || input.simulated === '1'
        ? true
        : String(process.env.OKX_TRADE_SIMULATED || '1') !== '0';
  return { apiKey, secret, passphrase, simulated };
}

function getCredentials(override) {
  const fromOpt = normalizeCreds(override);
  if (fromOpt) return fromOpt;
  const fromAls = normalizeCreds(credAls.getStore());
  if (fromAls) return fromAls;
  return envCredentials();
}

function isSimulated(override) {
  const c = getCredentials(override);
  if (c && (c.apiKey || credAls.getStore() || override)) {
    return Boolean(c.simulated);
  }
  return String(process.env.OKX_TRADE_SIMULATED || '1') !== '0';
}

function isTradeConfigured(override) {
  const { apiKey, secret, passphrase } = getCredentials(override);
  return Boolean(apiKey && secret && passphrase);
}

function getTradeStatus(override) {
  const c = getCredentials(override);
  return {
    configured: Boolean(c.apiKey && c.secret && c.passphrase),
    simulated: isSimulated(override),
    simulatedHeader: isSimulated(override) ? '1' : '0',
    base: tradeBase(),
    hasProxy: Boolean(OKX_PROXY),
    keyHint: c.apiKey ? `${c.apiKey.slice(0, 4)}??{c.apiKey.slice(-4)}` : '',
    source: normalizeCreds(override) || normalizeCreds(credAls.getStore()) ? 'user' : 'env',
  };
}

/** ?????????????????????placeOrder / ????????? */
function withTradeCredentials(creds, fn) {
  const normalized = normalizeCreds(creds);
  if (!normalized) {
    const err = new Error('OKX API ??????');
    err.status = 400;
    throw err;
  }
  return credAls.run(normalized, fn);
}

function sign(timestamp, method, requestPath, body, secret) {
  const prehash = `${timestamp}${method.toUpperCase()}${requestPath}${body || ''}`;
  return crypto.createHmac('sha256', secret).update(prehash).digest('base64');
}

function buildAxiosConfig(timeoutMs) {
  const cfg = {
    timeout: Math.max(
      5_000,
      Number(timeoutMs) || Number(process.env.OKX_TIMEOUT_MS) || 30_000,
    ),
    httpsAgent,
    validateStatus: () => true,
  };
  if (OKX_PROXY) {
    try {
      const u = new URL(OKX_PROXY);
      cfg.proxy = {
        protocol: u.protocol.replace(':', ''),
        host: u.hostname,
        port: Number(u.port) || (u.protocol === 'https:' ? 443 : 80),
        auth:
          u.username || u.password
            ? {
                username: decodeURIComponent(u.username || ''),
                password: decodeURIComponent(u.password || ''),
              }
            : undefined,
      };
    } catch {
      /* ignore bad proxy */
    }
  }
  return cfg;
}

function okxErrText(errOrMsg) {
  return String(errOrMsg && errOrMsg.message != null ? errOrMsg.message : errOrMsg || '');
}

function okxErrCode(errOrMsg) {
  return String(errOrMsg && errOrMsg.code != null ? errOrMsg.code : '');
}

/** 50101: key belongs to the other environment */
function isOkxEnvMismatch(errOrMsg) {
  const msg = okxErrText(errOrMsg);
  const code = okxErrCode(errOrMsg);
  return (
    code === '50101' ||
    /50101/.test(msg) ||
    /does not match current environment/i.test(msg) ||
    /APIKey does not match/i.test(msg)
  );
}

/** 50111: this environment does not recognize the key */
function isOkxKeyMissing(errOrMsg) {
  const msg = okxErrText(errOrMsg);
  const code = okxErrCode(errOrMsg);
  return (
    code === '50111' ||
    /50111/.test(msg) ||
    /API key doesn.?t exist/i.test(msg) ||
    /API key does not exist/i.test(msg) ||
    /Invalid OK-ACCESS-KEY/i.test(msg)
  );
}

function isOkxEnvAuthError(errOrMsg) {
  return isOkxEnvMismatch(errOrMsg) || isOkxKeyMissing(errOrMsg);
}

function isOkxBadSign(errOrMsg) {
  const msg = okxErrText(errOrMsg);
  const code = okxErrCode(errOrMsg);
  return code === '50113' || /50113/.test(msg) || /Invalid Sign/i.test(msg);
}

function appendSignHint(message, secretLen) {
  const msg = String(message || '');
  if (!isOkxBadSign(msg)) return msg;
  const n = Number(secretLen) || 0;
  const lenNote = n && n !== 32 ? '当前保存的 Secret 为 ' + n + ' 位，OKX 一般为 32 位，多半是复制少了字符。' : '请确认 Secret 与这把 Key 是同一次创建的。';
  return msg + ' —— 签名不匹配。' + lenNote + '请重新完整粘贴 Key / Secret / Passphrase 后一起保存。';
}

function enhanceEnvMismatchMessage(message, credentialsOverride) {
  const msg = String(message || '');
  const sim = isSimulated(credentialsOverride);
  if (isOkxEnvMismatch(msg)) {
    return sim
      ? msg +
          ' —— 当前按【模拟盘】请求，但这把 Key 属于实盘。请到侧栏「API 设置」取消勾选「使用模拟盘」后保存。'
      : msg +
          ' —— 当前按【实盘】请求，但这把 Key 属于模拟盘。请到侧栏「API 设置」勾选「使用模拟盘」后保存。';
  }
  if (isOkxKeyMissing(msg)) {
    return sim
      ? msg +
          ' —— 当前按【模拟盘】请求，OKX 不认识这把 Key。请从「模拟盘交易 → API」重新复制 Key/Secret/Passphrase 再保存；若这是实盘 Key，请取消勾选「使用模拟盘」。'
      : msg +
          ' —— 当前按【实盘】请求，OKX 不认识这把 Key。请确认三者来自 OKX「实盘 API」、配套且未被删除或限制 IP，并保持「使用模拟盘」未勾选。';
  }
  return msg;
}

async function okxPrivate(method, pathWithQuery, bodyObj, options = {}) {
  const creds = getCredentials(options.credentials);
  if (!creds.apiKey || !creds.secret || !creds.passphrase) {
    const err = new Error('?????OKX_API_KEY / OKX_API_SECRET / OKX_API_PASSPHRASE');
    err.status = 503;
    throw err;
  }
  const { apiKey, secret, passphrase } = creds;
  const methodU = String(method || 'GET').toUpperCase();
  const requestPath = pathWithQuery.startsWith('/') ? pathWithQuery : `/${pathWithQuery}`;
  const body = bodyObj == null ? '' : JSON.stringify(bodyObj);
  const timestamp = new Date().toISOString();
  const headers = {
    'OK-ACCESS-KEY': apiKey,
    'OK-ACCESS-SIGN': sign(timestamp, methodU, requestPath, body, secret),
    'OK-ACCESS-TIMESTAMP': timestamp,
    'OK-ACCESS-PASSPHRASE': passphrase,
    'Content-Type': 'application/json',
  };
  // Live requests must omit this header. Sending 0 makes OKX reject a valid live key.
  const sim = creds.apiKey ? Boolean(creds.simulated) : isSimulated(options.credentials);
  if (sim) headers['x-simulated-trading'] = '1';

  console.log('[okx-trade] auth mode', sim ? 'simulated' : 'live', 'key', apiKey.slice(0, 6) + '…');
  const url = `${tradeBase()}${requestPath}`;
  const axiosCfg = buildAxiosConfig(options.timeoutMs);
  axiosCfg.headers = { ...(axiosCfg.headers || {}), ...headers };
  let res;
  if (methodU === 'GET' || methodU === 'DELETE') {
    res = await axios.request({
      ...axiosCfg,
      method: methodU,
      url,
      headers,
    });
  } else {
    res = await axios.request({
      ...axiosCfg,
      method: methodU,
      url,
      headers,
      data: body || undefined,
      transformRequest: [(payload) => payload],
    });
  }

  const data = res.data;
  if (!data || typeof data !== 'object') {
    const err = new Error(`OKX ?????HTTP ${res.status}`);
    err.status = 502;
    throw err;
  }
  if (String(data.code) !== '0') {
    let message = data.msg || ('OKX error code=' + data.code);
    const detail = Array.isArray(data.data) ? data.data[0] : null;
    if (detail && (detail.sMsg || detail.sCode)) {
      message = (detail.sMsg || message) + (detail.sCode ? (' [' + detail.sCode + ']') : '');
    }
    message = appendSignHint(message, secret.length);
    message = enhanceEnvMismatchMessage(message, options.credentials);
    const err = new Error(message);
    err.status = 400;
    err.code = detail?.sCode || data.code;
    err.okx = data;
    throw err;
  }
  // code=0 but business sCode != 0
  if (Array.isArray(data.data) && data.data[0] && data.data[0].sCode && String(data.data[0].sCode) !== '0') {
    const detail = data.data[0];
    let message = (detail.sMsg || '下单失败') + (detail.sCode ? (' [' + detail.sCode + ']') : '');
    message = appendSignHint(message, secret.length);
    message = enhanceEnvMismatchMessage(message, options.credentials);
    const err = new Error(message);
    err.status = 400;
    err.code = detail.sCode;
    err.okx = data;
    throw err;
  }
  return data;
}

function qs(params) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null || v === '') continue;
    sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

async function getAccountConfig() {
  const data = await okxPrivate('GET', '/api/v5/account/config', null, { timeoutMs: 8_000 });
  return (data.data && data.data[0]) || null;
}

async function getBalance(ccy) {
  const path = `/api/v5/account/balance${qs(ccy ? { ccy } : {})}`;
  const data = await okxPrivate('GET', path);
  return data.data || [];
}

async function getAccountPositions(instType = 'SWAP', instId) {
  const path = `/api/v5/account/positions${qs({ instType, instId })}`;
  const data = await okxPrivate('GET', path);
  return data.data || [];
}

async function getPendingOrders(instType = 'SWAP', instId) {
  const path = `/api/v5/trade/orders-pending${qs({ instType, instId })}`;
  const data = await okxPrivate('GET', path);
  return data.data || [];
}

async function setLeverage({ instId, lever, mgnMode, posSide }) {
  const body = {
    instId: String(instId || '').trim(),
    lever: String(lever),
    mgnMode: mgnMode === 'isolated' ? 'isolated' : 'cross',
  };
  if (posSide === 'long' || posSide === 'short') body.posSide = posSide;
  const data = await okxPrivate('POST', '/api/v5/account/set-leverage', body);
  return data.data || [];
}

/**
 * ?????WAP??????????????????net / long_short?? * 51000 posSide ?????????????????????? */
let cachedPosMode = ''; // net_mode | long_short_mode

async function resolvePosMode() {
  if (cachedPosMode === 'net_mode' || cachedPosMode === 'long_short_mode') {
    return cachedPosMode;
  }
  const envMode = String(process.env.OKX_POS_MODE || '').trim().toLowerCase();
  if (envMode === 'net' || envMode === 'net_mode') {
    cachedPosMode = 'net_mode';
    return cachedPosMode;
  }
  if (envMode === 'long_short' || envMode === 'long_short_mode' || envMode === 'hedge') {
    cachedPosMode = 'long_short_mode';
    return cachedPosMode;
  }
  // ?????????????????posSide????????/???????????  // ????????????????laceOrder ??51000 ????????long_short ?????  cachedPosMode = 'net_mode';
  try {
    const cfg = await getAccountConfig();
    const mode = String(cfg?.posMode || '').toLowerCase();
    console.log('[okx-trade] account posMode=', mode || '(empty)', '??use net first');
  } catch (err) {
    console.warn('[okx-trade] account/config:', err.message || err);
  }
  return cachedPosMode;
}

function buildOrderBody(input, posMode) {
  const instId = String(input.instId || '').trim();
  const side = String(input.side || '').toLowerCase();
  const ordType = String(input.ordType || 'market').toLowerCase();
  const tdMode = String(input.tdMode || 'cross').toLowerCase();
  const sz = String(input.sz ?? '').trim();
  let posSide = String(input.posSide || '').toLowerCase();

  if (posMode === 'net_mode') {
    // ???????????? posSide????????51000??    posSide = '';
  } else if (posSide !== 'long' && posSide !== 'short') {
    posSide = side === 'sell' ? 'short' : 'long';
  }

  const body = {
    instId,
    tdMode,
    side,
    ordType,
    sz,
  };
  if (posSide === 'long' || posSide === 'short') body.posSide = posSide;
  if (ordType === 'limit' || ordType === 'post_only' || ordType === 'ioc' || ordType === 'fok') {
    const px = String(input.px ?? '').trim();
    if (!px || !(Number(px) > 0)) {
      throw Object.assign(new Error('???????????px'), { status: 400 });
    }
    body.px = px;
  }
  if (input.reduceOnly === true || input.reduceOnly === 'true') body.reduceOnly = true;
  if (input.clOrdId) body.clOrdId = String(input.clOrdId).slice(0, 32);
  if (input.tag) body.tag = String(input.tag).slice(0, 16);
  if (Array.isArray(input.attachAlgoOrds) && input.attachAlgoOrds.length) {
    body.attachAlgoOrds = input.attachAlgoOrds;
  }
  return { body, posSide, side, tdMode, ordType, instId };
}

async function placeOrder(input = {}) {
  const instId = String(input.instId || '').trim();
  const side = String(input.side || '').toLowerCase();
  const ordType = String(input.ordType || 'market').toLowerCase();
  const tdMode = String(input.tdMode || 'cross').toLowerCase();
  const sz = String(input.sz ?? '').trim();

  if (!instId) throw Object.assign(new Error('??? instId'), { status: 400 });
  if (side !== 'buy' && side !== 'sell') {
    throw Object.assign(new Error('side ??? buy ??sell'), { status: 400 });
  }
  if (!sz || !(Number(sz) > 0)) {
    throw Object.assign(new Error('??? sz ???'), { status: 400 });
  }
  if (!['market', 'limit', 'ioc', 'fok', 'post_only'].includes(ordType)) {
    throw Object.assign(new Error('?????? ordType'), { status: 400 });
  }
  if (!['cross', 'isolated', 'cash'].includes(tdMode)) {
    throw Object.assign(new Error('tdMode ???'), { status: 400 });
  }

  let posMode = await resolvePosMode();

  // ?????????????????socket hang up???????? setLeverage=1
  const wantLeverage =
    String(input.setLeverage || process.env.OKX_TRADE_SET_LEVERAGE || '') === '1';
  const lever = Number(input.lever);

  async function submit(mode) {
    const { body, posSide } = buildOrderBody(input, mode);
    if (wantLeverage && Number.isFinite(lever) && lever > 0 && tdMode !== 'cash') {
      try {
        await setLeverage({
          instId,
          lever,
          mgnMode: tdMode,
          // net ??? set-leverage ?????? posSide
          posSide: mode === 'net_mode' ? undefined : posSide || undefined,
        });
      } catch (err) {
        console.warn('[okx-trade] set-leverage:', err.message || err);
        if (input.requireLeverage === true) throw err;
      }
    }
    console.log('[okx-trade] place', JSON.stringify({ ...body, posMode: mode }));
    const data = await okxPrivate('POST', '/api/v5/trade/order', body, { timeoutMs: 45_000 });
    return { order: (data.data && data.data[0]) || null, raw: data, posMode: mode };
  }

  try {
    const result = await submit(posMode);
    cachedPosMode = posMode;
    return result;
  } catch (err) {
    const msg = String(err.message || '');
    const code = String(err.code || '');
    const isPosSideErr =
      code === '51000' || /posSide|51000/i.test(msg) || /Parameter posSide/i.test(msg);
    if (!isPosSideErr) throw err;

    const alt = posMode === 'net_mode' ? 'long_short_mode' : 'net_mode';
    console.warn(`[okx-trade] posSide 51000?????${posMode} ??${alt} ???`);
    try {
      const result = await submit(alt);
      cachedPosMode = alt;
      return result;
    } catch (err2) {
      // ??????????????????????????      cachedPosMode = '';
      throw err2;
    }
  }
}

async function cancelOrder({ instId, ordId, clOrdId }) {
  const body = { instId: String(instId || '').trim() };
  if (ordId) body.ordId = String(ordId);
  if (clOrdId) body.clOrdId = String(clOrdId);
  if (!body.instId || (!body.ordId && !body.clOrdId)) {
    throw Object.assign(new Error('??????????instId + ordId/clOrdId'), { status: 400 });
  }
  const data = await okxPrivate('POST', '/api/v5/trade/cancel-order', body);
  return { result: (data.data && data.data[0]) || null, raw: data };
}

/** ???????????SDT ??*/
function summarizeBalance(balanceRows) {
  const details = [];
  for (const acct of balanceRows || []) {
    for (const d of acct.details || []) {
      const eq = Number(d.eq);
      const avail = Number(d.availBal ?? d.availEq);
      if (!Number.isFinite(eq) && !Number.isFinite(avail)) continue;
      if ((eq || 0) === 0 && (avail || 0) === 0) continue;
      details.push({
        ccy: d.ccy,
        eq: Number.isFinite(eq) ? eq : 0,
        availBal: Number.isFinite(avail) ? avail : 0,
        frozenBal: Number(d.frozenBal) || 0,
      });
    }
  }
  details.sort((a, b) => b.eq - a.eq);
  const totalEqUsd = Number(balanceRows?.[0]?.totalEq);
  return {
    totalEq: Number.isFinite(totalEqUsd) ? totalEqUsd : null,
    details: details.slice(0, 20),
  };
}


async function getSwapInstrument(instId) {
  const id = String(instId || '').trim();
  if (!id) throw Object.assign(new Error('missing instId'), { status: 400 });
  const url = tradeBase() + '/api/v5/public/instruments';
  const res = await axios.get(url, {
    params: { instType: 'SWAP', instId: id },
    timeout: 15000,
    httpsAgent,
  });
  const row = res.data && res.data.data && res.data.data[0];
  if (!row) throw Object.assign(new Error('instrument not found ' + id), { status: 404 });
  return row;
}

async function getSwapTicker(instId) {
  const id = String(instId || '').trim();
  if (!id) throw Object.assign(new Error('missing instId'), { status: 400 });
  const url = tradeBase() + '/api/v5/market/ticker';
  const res = await axios.get(url, {
    params: { instId: id },
    timeout: 12000,
    httpsAgent,
  });
  const row = res.data && res.data.data && res.data.data[0];
  if (!row) throw Object.assign(new Error('ticker not found ' + id), { status: 404 });
  return row;
}

function roundToLot(sz, lotSz) {
  const lot = Number(lotSz) || 1;
  if (!(lot > 0)) return String(sz);
  const n = Math.floor(Number(sz) / lot + 1e-12) * lot;
  const decimals = String(lot).includes('.') ? String(lot).split('.')[1].length : 0;
  return n.toFixed(decimals);
}

function roundToTick(px, tickSz, mode = 'nearest') {
  const tick = Number(tickSz);
  const price = Number(px);
  if (!(price > 0)) return String(px);
  if (!(tick > 0)) {
    const s = String(px);
    return s.includes('.') ? Number(price).toFixed(s.split('.')[1].length) : String(Math.round(price));
  }
  const decimals = String(tickSz).includes('.') ? String(tickSz).split('.')[1].length : 0;
  const units = price / tick;
  const n = (mode === 'floor' ? Math.floor(units + 1e-10) : mode === 'ceil' ? Math.ceil(units - 1e-10) : Math.round(units)) * tick;
  return n.toFixed(decimals);
}

function emitStage(onStage, payload) {
  if (typeof onStage !== 'function') return;
  try {
    onStage(payload);
  } catch {
    /* ignore listener errors */
  }
}

/**
 * Maker-first stance order:
 * 1) fetch last price and best bid/ask
 * 2) place the AI price as a post_only limit after tick-size rounding
 * 3) attach SL/TP algo on the same order
 */
async function placeStanceOrder(input, opts = {}) {
  input = input || {};
  const pendingMode = input.orderMode === 'pending';
  if (pendingMode ? input.execution !== '等待触发' : input.execution !== '现在可开') throw Object.assign(new Error('该 AI 方案不适用于所选下单模式，请重新分析'), { status: 400 });
  const onStage = opts && typeof opts.onStage === 'function' ? opts.onStage : null;
  const coin = String(input.coin || '').trim().toUpperCase();
  const action = String(input.action || '');
  const amountUsd = Number(input.amountUsd);
  const leverage = Number(input.leverage);
  const entryHint = Number(input.entry);
  const stop = Number(input.stop);
  const takeProfit = Number(input.takeProfit != null ? input.takeProfit : input.take_profit);

  if (!coin) throw Object.assign(new Error('missing coin'), { status: 400 });
  const isLong = /做多|^long$|^buy$/i.test(action);
  const isShort = /做空|^short$|^sell$/i.test(action);
  if (!isLong && !isShort) throw Object.assign(new Error('invalid action'), { status: 400 });
  if (!(amountUsd > 0) || amountUsd > 100) {
    throw Object.assign(new Error('amount must be 0-100 USDT'), { status: 400 });
  }
  if (leverage !== 10) {
    throw Object.assign(new Error('虚拟币 AI 策略固定使用 10 倍杠杆'), { status: 400 });
  }
  if (!(stop > 0) || !(takeProfit > 0)) {
    throw Object.assign(new Error('invalid stop/tp'), { status: 400 });
  }

  const side = isLong ? 'buy' : 'sell';
  const posSide = isLong ? 'long' : 'short';
  const instId = coin.includes('-') ? coin : coin + '-USDT-SWAP';

  emitStage(onStage, {
    id: 'price',
    status: 'running',
    progress: 12,
    message: '正在获取当前最新价格…',
  });

  const [inst, ticker] = await Promise.all([getSwapInstrument(instId), getSwapTicker(instId)]);
  const last = Number(ticker.last) || Number(ticker.markPx) || Number(ticker.askPx) || Number(ticker.bidPx);
  if (!(last > 0)) throw Object.assign(new Error('无法获取最新价'), { status: 502 });
  if (pendingMode && (isLong ? !(entryHint < last) : !(entryHint > last))) throw Object.assign(new Error('挂单价必须位于有利于当前方向的一侧：做多低于现价，做空高于现价'), { status: 400 });

  const ctVal = Number(inst.ctVal) || 1;
  const lotSz = inst.lotSz || '1';
  const tickSz = inst.tickSz || '0.1';
  const minSz = Number(inst.minSz) || Number(lotSz) || 1;

  emitStage(onStage, {
    id: 'price',
    status: 'done',
    progress: 28,
    message: '已获取最新价 ' + last,
    last,
  });

  if (!(entryHint > 0) || !Number.isFinite(entryHint)) throw Object.assign(new Error('缺少 AI 入场价，请重新分析'), { status: 400 });
  const limitPx = roundToTick(entryHint, tickSz, isLong ? 'floor' : 'ceil');
  const limitNum = Number(limitPx);
  if (!(limitNum > 0)) throw Object.assign(new Error('invalid limit price'), { status: 400 });
  const oppositeBest = Number(isLong ? ticker.askPx : ticker.bidPx);
  if (!(oppositeBest > 0)) throw Object.assign(new Error('无法获取盘口报价，请稍后重新预览'), { status: 502 });
  if (isLong ? limitNum >= oppositeBest : limitNum <= oppositeBest) throw Object.assign(new Error('AI 入场价会立即成交，无法作为 Maker 挂单；请重新分析'), { status: 400 });
  if (input.expectedPrice != null && Number(input.expectedPrice) !== limitNum) {
    throw Object.assign(new Error('行情已变化，请重新预览订单'), { status: 400 });
  }
  if (isLong ? !(stop < limitNum && takeProfit > limitNum) : !(takeProfit < limitNum && stop > limitNum)) {
    throw Object.assign(new Error('止盈止损方向与实际委托价不符'), { status: 400 });
  }

  const notional = amountUsd * leverage;
  const sz = roundToLot(notional / (limitNum * ctVal), lotSz);
  if (!(Number(sz) >= minSz)) {
    throw Object.assign(new Error('amount too small for minSz=' + minSz), { status: 400 });
  }

  const plan = {
    instId, side, posSide, amountUsd, leverage, orderMode: pendingMode ? 'pending' : 'direct', entry: limitNum,
    entryHint, last, stop, takeProfit, sz, notional, ctVal,
    ordType: 'post_only',
    estimatedLossUsdt: Math.abs(limitNum - stop) * Number(sz) * ctVal,
  };
  if (opts.dryRun) return { plan, simulated: isSimulated() };
  if (input.expectedPrice == null) throw Object.assign(new Error('缺少已确认的订单预览价'), { status: 400 });

  const sideLabel = isLong ? '低于' : '高于';
  const sideVerb = isLong ? '买单' : '卖单';
  emitStage(onStage, {
    id: 'limit',
    status: 'running',
    progress: 48,
    message: '以 AI 入场价挂' + sideLabel + '现价的只做 Maker ' + sideVerb + ' ' + limitPx + '…',
    last,
    limitPx: limitNum,
  });

  emitStage(onStage, {
    id: 'sltp',
    status: 'running',
    progress: 68,
    message: '设置止损 ' + stop + ' / 止盈 ' + takeProfit + '…',
    stop,
    takeProfit,
  });

  const clOrdId = String(input.clOrdId || makeAiClOrdId()).replace(/[^A-Za-z0-9]/g, '').slice(0, 32);
  const result = await placeOrder({
    instId,
    side,
    posSide,
    tdMode: 'cross',
    ordType: 'post_only',
    px: String(limitPx),
    sz,
    lever: leverage,
    setLeverage: '1',
    requireLeverage: true,
    clOrdId,
    attachAlgoOrds: [
      {
        tpTriggerPx: String(takeProfit),
        tpOrdPx: '-1',
        slTriggerPx: String(stop),
        slOrdPx: '-1',
        tpTriggerPxType: 'last',
        slTriggerPxType: 'last',
      },
    ],
  });

  plan.clOrdId = clOrdId;

  emitStage(onStage, {
    id: 'done',
    status: 'done',
    progress: 100,
    message: '挂单已提交（限价 Maker + 止损止盈）',
    orderId: result?.result?.ordId || result?.order?.ordId || null,
    plan,
  });

  return { order: result.result || result.order || null, raw: result.raw, plan, simulated: isSimulated() };
}

function makeAiClOrdId() {
  const raw = 'wtai' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  return raw.replace(/[^A-Za-z0-9]/g, '').slice(0, 32);
}

async function getOrder({ instId, ordId, clOrdId }) {
  const path = '/api/v5/trade/order' + qs({ instId, ordId, clOrdId });
  const data = await okxPrivate('GET', path);
  return (data.data && data.data[0]) || null;
}

async function getFillsHistory(instType = 'SWAP', limit = 100) {
  const path = '/api/v5/trade/fills-history' + qs({ instType, limit });
  const data = await okxPrivate('GET', path);
  return data.data || [];
}

async function getPositionsHistory(instType = 'SWAP', limit = 100) {
  const path = '/api/v5/account/positions-history' + qs({ instType, limit });
  const data = await okxPrivate('GET', path);
  return data.data || [];
}

module.exports = {
  isOkxEnvAuthError,
  isTradeConfigured,
  isSimulated,
  getTradeStatus,
  getCredentials,
  withTradeCredentials,
  getAccountConfig,
  getBalance,
  getAccountPositions,
  getPendingOrders,
  setLeverage,
  placeOrder,
  placeStanceOrder,
  getOrder,
  getFillsHistory,
  getPositionsHistory,
  getSwapInstrument,
  getSwapTicker,
  cancelOrder,
  summarizeBalance,
};
