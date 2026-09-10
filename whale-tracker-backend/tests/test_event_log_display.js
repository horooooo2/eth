'use strict';

require('./helpers/isolateSqlite');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const ev = require('../lib/v41RuntimeEvents');
const display = require('../lib/eventLogDisplay');
const { reasonZh, statusZh, eventZh } = require('../lib/strategyDisplayZh');

function cat(event) {
  return display.classifyDisplayCategory(event);
}

test('classification matrix POSITION XOR SYSTEM', () => {
  const cases = [
    [{ event_type: 'STRATEGY_NO_TRADE' }, 'SYSTEM'],
    [{ event_type: 'TRADE_INTENT_CREATED' }, 'SYSTEM'],
    [{ event_type: 'ORDER_INTENT_CREATED' }, 'SYSTEM'],
    [{ event_type: 'ORDER_SUBMITTED', details: { accFillSz: 0, sz: 10 } }, 'SYSTEM'],
    [{ event_type: 'ORDER_PARTIALLY_FILLED', details: { accFillSz: 4, sz: 10 } }, 'POSITION'],
    [{ event_type: 'ORDER_FILLED', details: { accFillSz: 10, sz: 10 } }, 'POSITION'],
    [{ event_type: 'FILLED' }, 'POSITION'],
    [{ event_type: 'POSITION_OPENED' }, 'POSITION'],
    [{ event_type: 'PROTECTIVE_STOP_ACTIVE', position_id: 'pos-1' }, 'POSITION'],
    [{ event_type: 'TAKE_PROFIT_TRIGGERED', position_id: 'pos-1' }, 'POSITION'],
    [{ event_type: 'POSITION_CLOSED', position_id: 'pos-1' }, 'POSITION'],
    [{ event_type: 'SYMBOL_OWNERSHIP_CONFLICT', strategy_id: 'S9' }, 'SYSTEM'],
    [{ event_type: 'S9_ORDERBOOK_STALE' }, 'SYSTEM'],
    [{ event_type: 'ENGINE_STARTED' }, 'SYSTEM'],
    [{ event_type: 'ENGINE_START' }, 'SYSTEM'],
    [{ event_type: 'ORDER_REJECTED', details: { accFillSz: 0 } }, 'SYSTEM'],
    [{ event_type: 'RECONCILIATION_MATCHED' }, 'SYSTEM'],
    [{ event_type: 'RECONCILIATION_MISMATCH', position_id: 'pos-1', details: { owned_contracts: 10, exchange_qty: 7 } }, 'POSITION'],
    [{ event_type: 'RECONCILIATION_MISMATCH' }, 'SYSTEM'],
    [{ event_type: 'S5_RISK_CHANGED' }, 'SYSTEM'],
    [{ event_type: 'S6_BLOCK' }, 'SYSTEM'],
    [{ event_type: 'ORDER_SUBMITTED', reduce_only: true }, 'POSITION'],
  ];
  for (const [event, expected] of cases) {
    const got = cat(event);
    assert.equal(got, expected, `${event.event_type} -> ${got}`);
    assert.notEqual(got, expected === 'POSITION' ? 'SYSTEM' : 'POSITION');
  }
});

test('chinese primary copy', () => {
  const noTrade = display.formatUserMessage({
    event_type: 'STRATEGY_NO_TRADE',
    strategy_id: 'S1',
    symbol: 'BTC-USDT-SWAP',
    reason_codes: ['CLOSE_VS_EMA20', 'EMA20_VS_EMA50', 'S3_DIRECTION_BLOCK', 'S3_REGIME_BLOCK', 'TREND_SLOPE'],
  });
  assert.match(noTrade, /本轮不交易/);
  assert.match(noTrade, /S1 趋势跟踪/);
  assert.doesNotMatch(noTrade, /\bNO_TRADE\b/);
  const partial = display.formatUserMessage({
    event_type: 'ORDER_PARTIALLY_FILLED',
    details: { accFillSz: 4, sz: 10 },
  });
  assert.match(partial, /开仓部分成交/);
  assert.match(partial, /4 张/);
  assert.match(partial, /10 张/);
  assert.doesNotMatch(partial, /ORDER_PARTIALLY_FILLED/);
  assert.match(display.formatUserMessage({ event_type: 'ORDER_FILLED', details: { accFillSz: 10 } }), /仓位建立完成/);
  assert.equal(display.formatUserMessage({ event_type: 'POSITION_CLOSED' }), '仓位已全部平仓');
  assert.match(display.formatUserMessage({ event_type: 'PROTECTIVE_STOP_ACTIVE', details: { covered_contracts: 10 } }), /保护止损已生效/);
  assert.equal(display.formatUserMessage({ event_type: 'ORDER_SUBMITTED', details: { accFillSz: 0 } }), '开仓订单已提交，等待成交');
  assert.equal(display.formatUserMessage({ event_type: 'ENGINE_START' }), '交易引擎已启动');
  assert.equal(display.formatUserMessage({ event_type: 'S9_ORDERBOOK_STALE' }), '盘口数据已过期');

  assert.equal(reasonZh('CLOSE_VS_EMA20'), '收盘价与 EMA20 的位置不符合趋势要求');
  assert.equal(reasonZh('EMA20_VS_EMA50'), 'EMA20 与 EMA50 未形成有效趋势排列');
  assert.equal(reasonZh('S3_DIRECTION_BLOCK'), '市场方向不支持当前交易方向');
  assert.equal(reasonZh('S3_REGIME_BLOCK'), '当前市场状态不适合该策略交易');
  assert.equal(reasonZh('TREND_SLOPE'), '趋势斜率不足');
  assert.equal(reasonZh('CODEX'), '未识别的交易提示（CODEX）');
  assert.equal(statusZh('NO_TRADE'), '本轮不交易');
  assert.equal(statusZh('PARTIALLY_FILLED'), '部分成交');
  assert.equal(statusZh('FILLED'), '已成交');
  assert.equal(statusZh('READY'), '就绪');
  assert.equal(statusZh('WARMING_UP'), '预热中');
  assert.equal(statusZh('BLOCKED'), '已阻止');
  assert.equal(statusZh('ZZZ'), '未识别的系统状态（ZZZ）');
  assert.equal(eventZh('WEIRD_EVENT'), '未识别的系统状态（WEIRD_EVENT）');
});

test('symbol display canonicalizes BTC aliases', () => {
  assert.equal(display.displaySymbol('BTC/USDT:USDT'), 'BTC-USDT-SWAP');
  const msg = display.formatUserMessage({
    event_type: 'STRATEGY_NO_TRADE',
    strategy_id: 'S1',
    symbol: 'BTC/USDT:USDT',
    reason_codes: ['CLOSE_VS_EMA20'],
  });
  assert.match(msg, /BTC-USDT-SWAP/);
  assert.doesNotMatch(msg, /BTC\/USDT:USDT/);
});

test('historical stored english messages reclassify on read', () => {
  const db = new Database(':memory:');
  ev.ensureTable(db);
  ev.append({
    event_id: 'hist-nt',
    event_type: 'STRATEGY_NO_TRADE',
    occurred_at: '2026-09-01T00:00:00.000Z',
    strategy_id: 'S1',
    symbol: 'BTC/USDT:USDT',
    decision: 'NO_TRADE',
    reason_codes: ['CLOSE_VS_EMA20', 'S3_DIRECTION_BLOCK'],
    message: 'S1 · BTC/USDT:USDT · NO_TRADE · CLOSE_VS_EMA20',
  }, db, { allowInjected: true });
  ev.append({
    event_id: 'hist-sub',
    event_type: 'ORDER_SUBMITTED',
    occurred_at: '2026-09-01T00:01:00.000Z',
    message: 'ORDER_SUBMITTED 0 fill',
    details: { accFillSz: 0, sz: 10 },
  }, db, { allowInjected: true });
  ev.append({
    event_id: 'hist-pf',
    event_type: 'ORDER_PARTIALLY_FILLED',
    occurred_at: '2026-09-01T00:02:00.000Z',
    message: 'ORDER_PARTIALLY_FILLED 4/10',
    details: { accFillSz: 4, sz: 10 },
  }, db, { allowInjected: true });
  ev.append({
    event_id: 'hist-fill',
    event_type: 'ORDER_FILLED',
    occurred_at: '2026-09-01T00:03:00.000Z',
    message: 'FILLED',
    details: { accFillSz: 10 },
  }, db, { allowInjected: true });
  const rows = Object.fromEntries(ev.list({ limit: 20 }, db).map((row) => [row.event_id, display.annotateEvent(row)]));
  assert.equal(rows['hist-nt'].display_category, 'SYSTEM');
  assert.match(rows['hist-nt'].display_message, /本轮不交易/);
  assert.match(rows['hist-nt'].display_message, /BTC-USDT-SWAP/);
  assert.equal(rows['hist-sub'].display_category, 'SYSTEM');
  assert.equal(rows['hist-pf'].display_category, 'POSITION');
  assert.match(rows['hist-pf'].display_message, /开仓部分成交/);
  assert.equal(rows['hist-fill'].display_category, 'POSITION');
});
