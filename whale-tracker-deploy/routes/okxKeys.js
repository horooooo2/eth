const express = require('express');
const { requireUser } = require('../lib/authStore');
const {
  listExchangeKeys,
  upsertExchangeKeys,
  patchOkxFlags,
  deleteExchangeKeys,
} = require('../lib/userExchangeKeys');

const router = express.Router();

function sendErr(res, err) {
  const status = Number(err.status) || 500;
  res.status(status).json({ error: err.message || '密钥操作失败' });
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

router.get('/', (req, res) => {
  if (!assertLogin(req, res)) return;
  res.json(listExchangeKeys(req.user.user.id));
});

router.put('/:exchange', (req, res) => {
  if (!assertLogin(req, res)) return;
  try {
    const exchange = String(req.params.exchange || '').toLowerCase();
    const body = req.body || {};
    const hasKeys = Boolean(
      String(body.apiKey || body.api_key || '').trim() &&
        String(body.apiSecret || body.api_secret || '').trim() &&
        String(body.apiPassphrase || body.api_passphrase || '').trim(),
    );
    const data =
      !hasKeys && (body.flagsOnly || body.simulated != null || body.enabled != null)
        ? patchOkxFlags(req.user.user.id, body)
        : upsertExchangeKeys(req.user.user.id, exchange, body);
    res.json({ ok: true, ...data });
  } catch (err) {
    sendErr(res, err);
  }
});

router.delete('/:exchange', (req, res) => {
  if (!assertLogin(req, res)) return;
  try {
    const data = deleteExchangeKeys(req.user.user.id, req.params.exchange);
    res.json({ ok: true, ...data });
  } catch (err) {
    sendErr(res, err);
  }
});

module.exports = router;