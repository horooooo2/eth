/**
 * Alpha EXECUTE pre-submit sanity. Fail-closed. Does not place orders.
 * Quantity unit is BASE (BTC). Node converts BASE → OKX contracts via ctVal.
 */

const BTC_USDT_SWAP = {
  instId: 'BTC-USDT-SWAP',
  ctVal: 0.01,
  ctValCcy: 'BTC',
  lotSz: 1,
  minSz: 1,
  tickSz: 0.1,
  state: 'live',
  source: 'test_catalog',
};

let instrumentOverride = null;
let instrumentCache = { spec: null, at: 0, instId: '' };
const METADATA_TTL_MS = 5 * 60 * 1000;

function setInstrumentSpec(spec) {
  instrumentOverride = spec && typeof spec === 'object' ? spec : null;
  instrumentCache = { spec: null, at: 0, instId: '' };
}

function fail(code, message, details) {
  const err = new Error(message);
  err.status = 403;
  err.code = code;
  err.details = details || {};
  return err;
}

function decimalsOf(step) {
  const s = String(step);
  const i = s.indexOf('.');
  return i < 0 ? 0 : s.length - i - 1;
}

function snapLot(raw, lotSz) {
  const lot = Number(lotSz);
  if (!(lot > 0)) return NaN;
  const n = Math.floor((Number(raw) + 1e-12) / lot) * lot;
  return Number(n.toFixed(Math.max(0, decimalsOf(lot))));
}

function getCachedInstrument(instId) {
  const id = String(instId || '').trim().toUpperCase();
  if (instrumentOverride) {
    const ov = instrumentOverride;
    if (ov.stale === true) {
      throw fail('INSTRUMENT_METADATA_STALE', 'instrument metadata stale', { instId: id });
    }
    if (ov.missing === true || ov.unavailable === true) {
      throw fail('INSTRUMENT_METADATA_UNAVAILABLE', 'instrument metadata unavailable', { instId: id });
    }
    if (ov.state && String(ov.state).toLowerCase() !== 'live') {
      throw fail('INSTRUMENT_NOT_TRADABLE', 'instrument not live', { instId: id, state: ov.state });
    }
    return ov;
  }
  if (
    instrumentCache.spec &&
    instrumentCache.instId === id &&
    Date.now() - instrumentCache.at < METADATA_TTL_MS
  ) {
    return instrumentCache.spec;
  }
  return null;
}

function rememberInstrument(instId, spec) {
  instrumentCache = { spec, at: Date.now(), instId: String(instId || '').toUpperCase() };
}

/**
 * BASE qty → OKX SWAP contracts (sz).
 * contracts_raw = base_quantity / ctVal; then floor to lotSz.
 */
function convertBaseToOkxSz(orderIntent, spec) {
  if (!spec) {
    throw fail('INSTRUMENT_METADATA_UNAVAILABLE', 'instrument metadata missing', {
      instId: orderIntent && orderIntent.symbol,
    });
  }
  if (spec.stale) {
    throw fail('INSTRUMENT_METADATA_STALE', 'instrument metadata stale', {
      instId: orderIntent && orderIntent.symbol,
    });
  }
  if (spec.state && String(spec.state).toLowerCase() !== 'live') {
    throw fail('INSTRUMENT_NOT_TRADABLE', 'instrument not tradable', { state: spec.state });
  }
  const base = Number(orderIntent.base_quantity);
  const ctVal = Number(spec.ctVal);
  if (!(base > 0)) {
    throw fail('MIN_SIZE_REJECTED', 'base_quantity is not a positive BASE size', {
      base_quantity: orderIntent.base_quantity,
    });
  }
  if (!(ctVal > 0)) {
    throw fail('INSTRUMENT_METADATA_UNAVAILABLE', 'ctVal missing', { spec });
  }
  const rawContracts = base / ctVal;
  const lot = Number(spec.lotSz);
  const min = Number(spec.minSz);
  const rounded = snapLot(rawContracts, lot);
  if (!Number.isFinite(rounded) || rounded <= 0) {
    throw fail('PRECISION_ROUNDED_TO_ZERO', 'lot rounding produced sz=0; refuse submit', {
      requested_base_qty: base,
      ctVal,
      raw_contracts: rawContracts,
      lotSz: lot,
    });
  }
  if (rounded + 1e-12 < min) {
    throw fail('MIN_SIZE_REJECTED', 'sz below instrument minSz; refuse submit', {
      requested_base_qty: base,
      ctVal,
      raw_contracts: rawContracts,
      rounded_contracts: rounded,
      minSz: min,
    });
  }
  return {
    requested_base_qty: base,
    ctVal,
    ctValCcy: spec.ctValCcy || 'BTC',
    raw_contracts: rawContracts,
    rounded_contracts: rounded,
    final_okx_sz: String(rounded),
    sz: String(rounded),
    contracts: rounded,
    lotSz: lot,
    minSz: min,
    tickSz: spec.tickSz,
    source: spec.source || 'okx_public',
  };
}

function convertToOkxSz(orderIntent, spec) {
  return convertBaseToOkxSz(orderIntent, spec);
}

function assertPosModeKnown(posMode) {
  const m = String(posMode || '').toLowerCase();
  if (m === 'net_mode' || m === 'long_short_mode') return m;
  throw fail('POSITION_MODE_UNKNOWN', 'OKX position mode is unknown; EXECUTE fail-closed', {
    posMode: posMode || null,
  });
}

function assertTdMode(tdMode) {
  const m = String(tdMode || 'cross').toLowerCase();
  if (m === 'cross') return m;
  throw fail('UNSUPPORTED_MARGIN_MODE', 'Demo Execute V1 only supports tdMode=cross', { tdMode });
}

function assertNetPosMode(posMode) {
  const m = String(posMode || '').toLowerCase();
  if (m === 'net_mode') return m;
  if (m === 'long_short_mode') {
    throw fail(
      'UNSUPPORTED_POSITION_MODE_FOR_DEMO_V1',
      'Demo Execute V1 only supports net_mode; will not change OKX account config',
      { posMode },
    );
  }
  throw fail('POSITION_MODE_UNKNOWN', 'OKX position mode is unknown; EXECUTE fail-closed', {
    posMode: posMode || null,
  });
}

function assertStopDirection(orderIntent) {
  const side = String(orderIntent.position_side || orderIntent.side || '').toLowerCase();
  const entry = Number(orderIntent.entry_price);
  const stop = Number(orderIntent.stop_price);
  if (!(entry > 0) || !(stop > 0) || Math.abs(entry - stop) <= 0) {
    throw fail('INVALID_STOP_PRICE', 'stop distance must be > 0', { entry, stop });
  }
  const isLong = side === 'long' || side === 'buy';
  if (isLong && !(stop < entry)) {
    throw fail('INVALID_STOP_PRICE', 'LONG stop_price must be < entry_price', { entry, stop });
  }
  if (!isLong && !(stop > entry)) {
    throw fail('INVALID_STOP_PRICE', 'SHORT stop_price must be > entry_price', { entry, stop });
  }
  return { entry, stop, side: isLong ? 'long' : 'short' };
}

function snapStopToTick(stopPrice, tickSz, { entryPrice, side } = {}) {
  const tick = Number(tickSz);
  const stop = Number(stopPrice);
  const entry = Number(entryPrice);
  if (!(tick > 0) || !(stop > 0)) return stop;
  const isLong = String(side || '').toLowerCase() === 'long' || String(side || '').toLowerCase() === 'buy';
  // Round toward entry so risk does not increase.
  let snapped;
  if (isLong) {
    snapped = Math.ceil((stop - 1e-12) / tick) * tick;
    if (entry > 0 && snapped >= entry) snapped = Math.floor((entry - tick) / tick) * tick;
  } else {
    snapped = Math.floor((stop + 1e-12) / tick) * tick;
    if (entry > 0 && snapped <= entry) snapped = Math.ceil((entry + tick) / tick) * tick;
  }
  return Number(snapped.toFixed(Math.max(0, decimalsOf(tick))));
}

function assertRiskSanity(orderIntent, converted) {
  const entry = Number(orderIntent.entry_price || orderIntent.risk_snapshot?.entry_price || 0);
  const stop = Number(orderIntent.stop_price || orderIntent.stop_policy_snapshot?.stop_price || 0);
  const planned = Number(
    orderIntent.risk_amount_quote || orderIntent.risk_snapshot?.risk_amount_quote || 0,
  );
  const ctVal = Number(converted.ctVal) || 0;
  if (!(entry > 0) || !(stop > 0) || !(planned > 0) || !(ctVal > 0)) {
    throw fail(
      'RISK_SANITY_INCOMPLETE',
      'EXECUTE requires entry_price, stop_price, risk_amount_quote, ctVal',
      { entry, stop, risk_amount_quote: planned, ctVal },
    );
  }
  const actualBase = converted.contracts * ctVal;
  const actualRisk = Math.abs(entry - stop) * actualBase;
  const notional = entry * actualBase;
  if (actualRisk > planned * 1.05 + 1e-12) {
    throw fail('RISK_SANITY_FAILED', 'actual risk exceeds planned risk_amount_quote × 1.05', {
      actual_risk: actualRisk,
      planned_risk: planned,
      actual_base_qty: actualBase,
      notional,
    });
  }
  return {
    actual_risk: actualRisk,
    planned_risk: planned,
    actual_base_qty: actualBase,
    notional,
    ratio: planned > 0 ? actualRisk / planned : null,
  };
}

function assertReduceOnlyExit(orderIntent) {
  const purpose = String(orderIntent.purpose || orderIntent.order_purpose || '').toLowerCase();
  const isExit =
    Boolean(orderIntent.reduce_only) ||
    ['stop_loss', 'take_profit', 'reduce', 'exit', 'close', 'flatten'].includes(purpose);
  if (!isExit) return { reduceOnly: false };
  if (!orderIntent.reduce_only) {
    throw fail('REDUCE_ONLY_REQUIRED', 'exit OrderIntent must set reduce_only', { purpose });
  }
  return { reduceOnly: true };
}

function capExitToOwned(orderIntent, ownedBaseQty) {
  const req = Number(orderIntent.base_quantity || orderIntent.exit_base_quantity || 0);
  const owned = Number(ownedBaseQty);
  if (!(owned > 0)) {
    throw fail('ALREADY_FLAT', 'no owned quantity to exit', { owned: ownedBaseQty });
  }
  if (req > owned + 1e-12) {
    return { base_quantity: owned, capped: true, requested: req, owned };
  }
  return { base_quantity: req, capped: false, requested: req, owned };
}

function assertBeforeAlphaSubmit(orderIntent, extras = {}) {
  const instId = String(extras.instId || orderIntent.symbol || '').trim();
  const spec = extras.instrument || getCachedInstrument(instId);
  const converted = convertBaseToOkxSz({ ...orderIntent, symbol: instId }, spec);
  const posMode = extras.requireNet === false ? assertPosModeKnown(extras.posMode) : assertNetPosMode(extras.posMode);
  const tdMode = assertTdMode(extras.tdMode || 'cross');
  assertReduceOnlyExit(orderIntent);
  const dir = assertStopDirection(orderIntent);
  const snappedStop = snapStopToTick(dir.stop, spec && spec.tickSz, {
    entryPrice: dir.entry,
    side: dir.side,
  });
  const intentForRisk = { ...orderIntent, stop_price: snappedStop };
  assertStopDirection(intentForRisk);
  const risk = assertRiskSanity(intentForRisk, converted);
  return {
    instId,
    converted,
    posMode,
    tdMode,
    risk,
    spec,
    stop_price: snappedStop,
    stop_trigger_type: 'last',
  };
}

function getInstrumentSpec(instId) {
  try {
    return getCachedInstrument(instId);
  } catch {
    return null;
  }
}

module.exports = {
  BTC_USDT_SWAP,
  METADATA_TTL_MS,
  setInstrumentSpec,
  getInstrumentSpec,
  getCachedInstrument,
  rememberInstrument,
  convertToOkxSz,
  convertBaseToOkxSz,
  assertPosModeKnown,
  assertTdMode,
  assertNetPosMode,
  assertStopDirection,
  snapStopToTick,
  assertRiskSanity,
  assertReduceOnlyExit,
  capExitToOwned,
  assertBeforeAlphaSubmit,
};
