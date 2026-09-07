/**
 * OKX 私有交易 REST（HMAC 签名）
 * 默认读环境变量；也可通过 withTradeCredentials / options.credentials 传入用户密钥。
 *
 * OKX_API_KEY / OKX_API_SECRET / OKX_API_PASSPHRASE
 * OKX_TRADE_SIMULATED=1  → 模拟盘（默认，安全）
 * OKX_TRADE_BASE         → 默认 https://www.okx.com
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
    keyHint: c.apiKey ? `${c.apiKey.slice(0, 4)}…${c.apiKey.slice(-4)}` : '',
    source: normalizeCreds(override) || normalizeCreds(credAls.getStore()) ? 'user' : 'env',
  };
}

/** 在指定用户凭证上下文中执行（placeOrder / 持仓查询等） */
function withTradeCredentials(creds, fn) {
  const normalized = normalizeCreds(creds);
  if (!normalized) {
    const err = new Error('OKX API 凭证无效');
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

async function okxPrivate(method, pathWithQuery, bodyObj, options = {}) {
  const creds = getCredentials(options.credentials);
  if (!creds.apiKey || !creds.secret || !creds.passphrase) {
    const err = new Error('未配置 OKX_API_KEY / OKX_API_SECRET / OKX_API_PASSPHRASE');
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
    // 官方要求：实盘 0、模拟盘 1（必须显式带上，不能省略）
    'x-simulated-trading': isSimulated(options.credentials) ? '1' : '0',
  };

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
    });
  }

  const data = res.data;
  if (!data || typeof data !== 'object') {
    const err = new Error(`OKX 无响应 HTTP ${res.status}`);
    err.status = 502;
    throw err;
  }
  if (String(data.code) !== '0') {
    let message = data.msg || `OKX 错误 code=${data.code}`;
    const detail = Array.isArray(data.data) ? data.data[0] : null;
    if (detail && (detail.sMsg || detail.sCode)) {
      message = `${detail.sMsg || message}${detail.sCode ? ` [${detail.sCode}]` : ''}`;
    }
    if (String(data.code) === '50101' || String(detail?.sCode) === '50101') {
      message += isSimulated(options.credentials)
        ? '（当前按模拟盘请求；请确认 Key 是在「模拟交易」里创建的，且 Secret/Passphrase 也是同一套）'
        : '（当前按实盘请求；请确认 Key 是实盘 API，或关闭模拟盘开关）';
    }
    const err = new Error(message);
    err.status = 400;
    err.code = detail?.sCode || data.code;
    err.okx = data;
    throw err;
  }
  // 部分接口 code=0 但条目 sCode 非 0
  if (Array.isArray(data.data) && data.data[0] && data.data[0].sCode && String(data.data[0].sCode) !== '0') {
    const detail = data.data[0];
    const err = new Error(`${detail.sMsg || '下单失败'}${detail.sCode ? ` [${detail.sCode}]` : ''}`);
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

async function getAccountConfig(options = {}) {
  const timeoutMs =
    Number(options.timeoutMs) || Number(process.env.OKX_TIMEOUT_MS) || 60_000;
  const data = await okxPrivate('GET', '/api/v5/account/config', null, { timeoutMs });
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
 * 下单。SWAP：自动识别账户持仓模式（net / long_short）
 * 51000 posSide 错误时自动切换模式重试一次。
 */
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
  // 默认先按买卖模式（不传 posSide）。模拟盘/多数账户如此；
  // 若实际是开平仓模式，placeOrder 遇 51000 会自动切到 long_short 重试。
  cachedPosMode = 'net_mode';
  try {
    const cfg = await getAccountConfig();
    const mode = String(cfg?.posMode || '').toLowerCase();
    console.log('[okx-trade] account posMode=', mode || '(empty)', '→ use net first');
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
    // 买卖模式：禁止传 posSide（否则常见 51000）
    posSide = '';
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
      throw Object.assign(new Error('限价单需要有效 px'), { status: 400 });
    }
    body.px = px;
  }
  if (input.reduceOnly === true || input.reduceOnly === 'true') body.reduceOnly = true;
  if (input.clOrdId) body.clOrdId = String(input.clOrdId).slice(0, 32);
  if (input.tag) body.tag = String(input.tag).slice(0, 16);
  return { body, posSide, side, tdMode, ordType, instId };
}

async function placeOrder(input = {}) {
  const instId = String(input.instId || '').trim();
  const side = String(input.side || '').toLowerCase();
  const ordType = String(input.ordType || 'market').toLowerCase();
  const tdMode = String(input.tdMode || 'cross').toLowerCase();
  const sz = String(input.sz ?? '').trim();

  if (!instId) throw Object.assign(new Error('缺少 instId'), { status: 400 });
  if (side !== 'buy' && side !== 'sell') {
    throw Object.assign(new Error('side 须为 buy 或 sell'), { status: 400 });
  }
  if (!sz || !(Number(sz) > 0)) {
    throw Object.assign(new Error('数量 sz 无效'), { status: 400 });
  }
  if (!['market', 'limit', 'ioc', 'fok', 'post_only'].includes(ordType)) {
    throw Object.assign(new Error('不支持的 ordType'), { status: 400 });
  }
  if (!['cross', 'isolated', 'cash'].includes(tdMode)) {
    throw Object.assign(new Error('tdMode 无效'), { status: 400 });
  }

  let posMode = await resolvePosMode();

  // 默认不下单前改杠杆（易 socket hang up）；需要时 setLeverage=1
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
          // net 模式 set-leverage 也不要带 posSide
          posSide: mode === 'net_mode' ? undefined : posSide || undefined,
        });
      } catch (err) {
        console.warn('[okx-trade] set-leverage:', err.message || err);
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
    console.warn(`[okx-trade] posSide 51000，切换 ${posMode} → ${alt} 重试`);
    try {
      const result = await submit(alt);
      cachedPosMode = alt;
      return result;
    } catch (err2) {
      // 二次失败：清缓存，避免错误模式固化
      cachedPosMode = '';
      throw err2;
    }
  }
}

async function cancelOrder({ instId, ordId, clOrdId }) {
  const body = { instId: String(instId || '').trim() };
  if (ordId) body.ordId = String(ordId);
  if (clOrdId) body.clOrdId = String(clOrdId);
  if (!body.instId || (!body.ordId && !body.clOrdId)) {
    throw Object.assign(new Error('取消订单需要 instId + ordId/clOrdId'), { status: 400 });
  }
  const data = await okxPrivate('POST', '/api/v5/trade/cancel-order', body);
  return { result: (data.data && data.data[0]) || null, raw: data };
}

/** 精简余额展示：USDT 等 */
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

module.exports = {
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
  cancelOrder,
  summarizeBalance,
};
