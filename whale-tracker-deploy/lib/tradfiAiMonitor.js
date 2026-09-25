const { readCache, writeCache } = require('./cache');
const { signedRequest } = require('./binanceTradfiTrade');
const { getBinanceCredentialsForUser } = require('./userExchangeKeys');

const CACHE_KEY = 'tradfi-ai-active-orders';
const cachedJobs = readCache(CACHE_KEY)?.data;
const jobs = Array.isArray(cachedJobs) ? cachedJobs : [];
let timer = null;
let busy = false;

function persist() { writeCache(CACHE_KEY, jobs, { strict: true }); }
function register(job) {
  if (!timer) throw Object.assign(new Error('订单监控服务未启动，不能提交 AI 挂单'), { status: 503 });
  jobs.push(job);
  try { persist(); } catch (err) {
    throw Object.assign(new Error(`订单已提交且当前进程仍在监控，但监控任务未能持久保存；请立即在币安核对订单：${err.message}`), { status: 503 });
  }
}
function isRunning() { return Boolean(timer); }

async function cancelOpenEntry(creds, symbol, state) {
  if (!state || ['FILLED', 'CANCELED', 'EXPIRED', 'REJECTED'].includes(String(state.status))) return;
  await signedRequest(creds, 'DELETE', '/fapi/v1/order', { symbol, orderId: String(state.orderId) });
}

async function checkJob(job) {
  const creds = getBinanceCredentialsForUser(job.userId);
  if (!creds || creds.simulated !== job.simulated) throw new Error('币安密钥或环境已变化，无法继续核对');
  const entries = await Promise.all(job.orders.map((order) => signedRequest(creds, 'GET', '/fapi/v1/order', { symbol: job.symbol, orderId: String(order.orderId) })));
  const protections = await Promise.all(job.protections.map((item) => signedRequest(creds, 'GET', '/fapi/v1/algoOrder', { algoId: String(item.algoId) })));
  const risk = await signedRequest(creds, 'GET', '/fapi/v2/positionRisk', { symbol: job.symbol });
  const position = (Array.isArray(risk) ? risk : []).find((row) => row.symbol === job.symbol && row.positionSide === job.positionSide);
  const openPosition = Math.abs(Number(position?.positionAmt || 0)) > 0;
  const anyFilled = entries.some((row) => Number(row.executedQty || 0) > 0);
  const missingProtection = protections.some((row) => String(row.algoStatus) !== 'NEW');
  let positionClosed = !openPosition;
  const shouldCancelEntries = Date.now() >= job.expiresAt || missingProtection || (anyFilled && !openPosition);
  if (shouldCancelEntries) {
    await Promise.all(entries.map((state) => cancelOpenEntry(creds, job.symbol, state)));
  }
  if (missingProtection && openPosition) {
    const close = {
      symbol: job.symbol, side: job.direction === 'BUY' ? 'SELL' : 'BUY', positionSide: job.positionSide,
      type: 'MARKET', quantity: String(Math.abs(Number(position.positionAmt))),
    };
    if (job.positionSide === 'BOTH') close.reduceOnly = 'true';
    await signedRequest(creds, 'POST', '/fapi/v1/order', close);
    const afterClose = await signedRequest(creds, 'GET', '/fapi/v2/positionRisk', { symbol: job.symbol });
    positionClosed = !(Array.isArray(afterClose) ? afterClose : []).some((row) => row.symbol === job.symbol && row.positionSide === job.positionSide && Math.abs(Number(row.positionAmt || 0)) > 0);
    console.warn(`[tradfi-ai-monitor] ${job.symbol} 保护单失效，已尝试市价平仓并撤销剩余挂单`);
  }
  const remaining = entries.some((row) => !['FILLED', 'CANCELED', 'EXPIRED', 'REJECTED'].includes(String(row.status))) && !shouldCancelEntries;
  if (!remaining && positionClosed) {
    await Promise.all(job.protections.map(async (item, index) => {
      if (String(protections[index].algoStatus) === 'NEW') await signedRequest(creds, 'DELETE', '/fapi/v1/algoOrder', { algoId: String(item.algoId) });
    }));
    return true;
  }
  return false;
}

async function reconcile() {
  if (busy || !jobs.length) return;
  busy = true;
  try {
    for (let index = jobs.length - 1; index >= 0; index -= 1) {
      try {
        if (await checkJob(jobs[index])) { jobs.splice(index, 1); persist(); }
      } catch (err) {
        console.error(`[tradfi-ai-monitor] ${jobs[index].symbol}: ${err.message}`);
      }
    }
  } finally { busy = false; }
}

function start() {
  if (timer) return;
  timer = setInterval(() => { void reconcile(); }, 15_000);
  timer.unref?.();
  void reconcile();
}

module.exports = { start, register, isRunning, reconcile };
