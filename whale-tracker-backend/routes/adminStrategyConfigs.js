'use strict';

const express = require('express');
const configs = require('../lib/v41StrategyConfigs');
const v41 = require('../lib/v41EngineClient');

const router = express.Router();

function sendErr(res, err) {
  const status = Number(err.status) || 500;
  res.status(status).json({
    error: {
      code: err.code || 'STRATEGY_CONFIG_ERROR',
      message: err.message || 'strategy config failed',
      details: err.details || {},
    },
  });
}

function rejectWrites(_req, res) {
  res.set('Allow', 'GET');
  return res.status(405).json({
    error: {
      code: 'STRATEGY_CONFIG_READ_ONLY',
      message: 'strategy configuration is read-only',
    },
  });
}

async function fetchRuntimeConfig(id) {
  if (!id) return v41.getStrategyConfigList();
  return v41.getStrategyConfig(id);
}

router.get('/', async (_req, res) => {
  try {
    const data = await configs.listConfigsWithRuntime({ fetchRuntimeConfig });
    res.json(data);
  } catch (err) {
    sendErr(res, err);
  }
});

router.get('/:id', async (req, res) => {
  try {
    const data = await configs.getConfigWithRuntime(req.params.id, { fetchRuntimeConfig });
    res.json(data);
  } catch (err) {
    sendErr(res, err);
  }
});

router.post('/', rejectWrites);
router.put('/', rejectWrites);
router.patch('/', rejectWrites);
router.delete('/', rejectWrites);
router.post('/:id', rejectWrites);
router.put('/:id', rejectWrites);
router.patch('/:id', rejectWrites);
router.delete('/:id', rejectWrites);

module.exports = router;
