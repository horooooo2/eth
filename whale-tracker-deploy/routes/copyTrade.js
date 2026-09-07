const express = require('express');
const { requireUser } = require('../lib/authStore');
const {
  getSnapshot,
  listTasks,
  findDuplicateAddress,
  upsertTask,
  removeTask,
  replaceTasks,
  syncPositionsFromExchange,
  normAddr,
} = require('../lib/hlCopyEngine');
const {
  listExchangeKeys,
  upsertExchangeKeys,
  deleteExchangeKeys,
  isOkxReadyForUser,
} = require('../lib/userExchangeKeys');

const router = express.Router();

function sendErr(res, err) {
  const status = Number(err.status) || 500;
  res.status(status).json({ error: err.message || '跟单请求失败' });
}

function assertLogin(req, res) {
  try {
    req.user = requireUser(req);
    return true;
  } catch (err) {
    sendErr(res, err);
    return false;
  }
}

function newId() {
  return `ct_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function normalizeTask(input = {}, prev = null, userId = '') {
  const exchange = input.exchange === 'binance' ? 'binance' : 'okx';
  const whaleAddress = String(input.whaleAddress || '').trim();
  const followCapitalUsd = Number(input.followCapitalUsd);
  const maxLeverage = Math.max(0, Number(input.maxLeverage) || 0);
  const maxNotionalUsd = Math.max(0, Number(input.maxNotionalUsd) || 0);
  let enabled = Boolean(input.enabled);
  if (exchange === 'binance') enabled = false;

  if (enabled && !whaleAddress) {
    const err = new Error('开启跟单前请填写巨鲸地址');
    err.status = 400;
    throw err;
  }
  if (!Number.isFinite(followCapitalUsd) || followCapitalUsd <= 0) {
    const err = new Error('跟单本金需大于 0');
    err.status = 400;
    throw err;
  }
  if (enabled && exchange === 'okx' && userId && !isOkxReadyForUser(userId)) {
    const err = new Error('请先绑定 OKX API Key 再开启跟单');
    err.status = 400;
    throw err;
  }

  return {
    id: prev?.id || String(input.id || '').trim() || newId(),
    userId: userId || prev?.userId || '',
    name:
      String(input.name || '').trim() ||
      (exchange === 'okx' ? 'OKX 跟单' : '币安跟单'),
    exchange,
    enabled,
    whaleAddress,
    followCapitalUsd,
    maxLeverage,
    maxNotionalUsd,
    note: String(input.note || '').trim(),
    updatedAt: Date.now(),
  };
}

/** GET /api/copy-trade — 需登录；按用户返回快照并同步持仓 */
router.get('/', async (req, res) => {
  if (!assertLogin(req, res)) return;
  const userId = req.user.user.id;
  try {
    await syncPositionsFromExchange(false, userId);
  } catch {
    /* 同步失败仍返回本地快照 */
  }
  const snap = getSnapshot(userId);
  res.json({
    ...snap,
    exchangeKeys: listExchangeKeys(userId),
  });
});

/** GET /api/copy-trade/exchange-keys */
router.get('/exchange-keys', (req, res) => {
  if (!assertLogin(req, res)) return;
  res.json(listExchangeKeys(req.user.user.id));
});

/** PUT /api/copy-trade/exchange-keys/:exchange */
router.put('/exchange-keys/:exchange', (req, res) => {
  if (!assertLogin(req, res)) return;
  try {
    const exchange = String(req.params.exchange || '').toLowerCase();
    if (exchange === 'binance') {
      const err = new Error('币安跟单对接中，暂不可配置');
      err.status = 400;
      throw err;
    }
    const data = upsertExchangeKeys(req.user.user.id, exchange, req.body || {});
    res.json({ ok: true, ...data });
  } catch (err) {
    sendErr(res, err);
  }
});

/** DELETE /api/copy-trade/exchange-keys/:exchange */
router.delete('/exchange-keys/:exchange', (req, res) => {
  if (!assertLogin(req, res)) return;
  try {
    const data = deleteExchangeKeys(req.user.user.id, req.params.exchange);
    res.json({ ok: true, ...data });
  } catch (err) {
    sendErr(res, err);
  }
});

/** GET /api/copy-trade/tasks */
router.get('/tasks', (req, res) => {
  if (!assertLogin(req, res)) return;
  const userId = req.user.user.id;
  res.json({ tasks: listTasks(userId), updatedAt: getSnapshot(userId).updatedAt });
});

/** PUT /api/copy-trade/tasks — 全量同步当前用户任务 */
router.put('/tasks', (req, res) => {
  if (!assertLogin(req, res)) return;
  try {
    const userId = req.user.user.id;
    const incoming = Array.isArray(req.body?.tasks) ? req.body.tasks : [];
    const seen = new Map();
    const next = [];
    for (const raw of incoming) {
      const task = normalizeTask(raw, raw?.id ? { id: raw.id } : null, userId);
      const key = `${task.exchange}:${normAddr(task.whaleAddress)}`;
      if (normAddr(task.whaleAddress)) {
        if (seen.has(key)) {
          const err = new Error(`地址已存在跟单：${task.whaleAddress}（${task.exchange}）`);
          err.status = 400;
          throw err;
        }
        seen.set(key, true);
      }
      next.push(task);
    }
    res.json({ ok: true, tasks: replaceTasks(next, userId) });
  } catch (err) {
    sendErr(res, err);
  }
});

/** POST /api/copy-trade/tasks — 新建或更新单条 */
router.post('/tasks', (req, res) => {
  if (!assertLogin(req, res)) return;
  try {
    const userId = req.user.user.id;
    const id = String(req.body?.id || '').trim();
    const prev = id ? listTasks(userId).find((t) => t.id === id) : null;
    if (id && !prev) {
      const err = new Error('任务不存在');
      err.status = 404;
      throw err;
    }
    const task = normalizeTask(req.body || {}, prev, userId);
    const dup = findDuplicateAddress(task.whaleAddress, task.id, task.exchange, userId);
    if (dup) {
      const err = new Error(`该地址已存在跟单（${dup.name || dup.id}）`);
      err.status = 400;
      throw err;
    }
    res.json({ ok: true, task: upsertTask(task) });
  } catch (err) {
    sendErr(res, err);
  }
});

/** POST /api/copy-trade/follow — 从持仓详情一键跟单并开仓 */
router.post('/follow', async (req, res) => {
  if (!assertLogin(req, res)) return;
  try {
    const { followFromPosition } = require('../lib/hlCopyEngine');
    const target = String(req.body?.target || req.body?.exchange || '').toLowerCase();
    let exchanges = Array.isArray(req.body?.exchanges) ? req.body.exchanges : [];
    if (!exchanges.length) {
      if (target === 'all') exchanges = ['okx']; // 币安未对接，全部仅走 OKX
      else if (target === 'okx' || target === 'binance') exchanges = [target];
    }
    if (exchanges.includes('binance') && !exchanges.includes('okx') && exchanges.length === 1) {
      const err = new Error('币安跟单对接中');
      err.status = 400;
      throw err;
    }
    exchanges = exchanges.filter((e) => e === 'okx');
    if (!exchanges.length) {
      const err = new Error('请选择 OKX 跟单（币安对接中）');
      err.status = 400;
      throw err;
    }
    const result = await followFromPosition({
      exchanges,
      userId: req.user.user.id,
      whaleAddress: req.body?.whaleAddress,
      whaleName: req.body?.whaleName,
      whaleAccountValue: req.body?.whaleAccountValue,
      whaleTotalPositionUsd: req.body?.whaleTotalPositionUsd,
      position: req.body?.position,
    });
    res.json(result);
  } catch (err) {
    sendErr(res, err);
  }
});

/** DELETE /api/copy-trade/tasks/:id */
router.delete('/tasks/:id', (req, res) => {
  if (!assertLogin(req, res)) return;
  try {
    removeTask(String(req.params.id || ''), req.user.user.id);
    res.json({ ok: true });
  } catch (err) {
    sendErr(res, err);
  }
});

/** POST /api/copy-trade/positions/:id/close — 手动平仓 */
router.post('/positions/:id/close', async (req, res) => {
  if (!assertLogin(req, res)) return;
  try {
    const { closePositionManual } = require('../lib/hlCopyEngine');
    const result = await closePositionManual(req.params.id, req.user.user.id);
    res.json(result);
  } catch (err) {
    sendErr(res, err);
  }
});

module.exports = router;
