'use strict';
const { isRawTrade, canonicalTradeId, fillSourceId } = require('./positionEventPolicy');
function coinOfTrade(trade) { return String(trade?.assetLabel || trade?.asset || '').trim(); }

/** 由成交派生开/补/减/平事件（结合 startPosition，避免买=多卖=空误判） */
function eventsFromTrade(trade) {
  const asset = String(trade?.asset || trade?.assetLabel || '');
  if (/^@/.test(asset) || asset.includes('/') || trade?.instrumentType === 'spot') return [];
  if (!['buy', 'sell', 'B', 'A', 'in', 'out'].includes(trade?.side)) return [];
  const start = trade.startPosition == null || trade.startPosition === '' ? NaN : Number(trade.startPosition);
  const size = Math.abs(Number(trade.amount));
  const buy = ['buy', 'B', 'in'].includes(trade.side);
  if (Number.isFinite(start) && size > Math.abs(start) && start !== 0 && (start > 0) !== buy) {
    const oldSize = Math.abs(start);
    return [['close', oldSize, start], ['open', size - oldSize, 0]].flatMap(([leg, amount, position]) =>
      classifyTrade({ ...trade, amount, startPosition: position, amountUsd: Math.abs(Number(trade.amountUsd)) * amount / size })
        .map(event => ({ ...event, id: event.id + ':' + leg, sourceId: event.sourceId + ':' + leg })));
  }
  return classifyTrade(trade);
}
function classifyTrade(trade) {
  if (!isRawTrade(trade) || trade.source === 'onchain') return [];
  const coin = coinOfTrade(trade);
  if (!coin) return [];
  const usd = Math.abs(Number(trade.amountUsd) || 0);
  const ts = Number(trade.time) || 0;
  const buy = trade.side === 'buy' || trade.side === 'B' || trade.side === 'in';
  const dir = String(trade.dir || '');
  const startValue = trade.startPosition;
  const start = startValue == null || startValue === '' ? NaN : Number(startValue);
  const sz = Math.abs(Number(trade.amount) || 0);
  const eps = 1e-8;

  let side = null;
  let isClose = false;
  let isOpen = false;

  if (Number.isFinite(start)) {
    if (Math.abs(start) < eps) {
      isOpen = true;
      side = buy ? 'long' : 'short';
    } else if (start > 0) {
      side = 'long';
      isClose = !buy;
    } else {
      side = 'short';
      isClose = buy;
    }
  } else if (/close|reduce/i.test(dir)) {
    isClose = true;
    side = /short/i.test(dir) ? 'short' : 'long';
  } else {
    // HL 的 Open Long/Short 也可能是补仓。缺少 startPosition 时不再把 dir
    // 当作新开仓证据，以免加仓误入开仓/共振记录。
    return [];
  }

  if (!side) return [];

  let openKind;
  if (isClose) {
    const remaining =
      Number.isFinite(start) && sz > 0 ? Math.abs(start) - sz : null;
    openKind =
      remaining != null && remaining <= Math.max(eps, Math.abs(start) * 1e-6)
        ? 'close'
        : 'decrease';
  } else if (isOpen || Number(trade._asOpen)) {
    openKind = 'open';
  } else {
    openKind = 'increase';
  }

  if (!(usd > 0) || !(ts > 0)) return [];

  const title =
    openKind === 'close'
      ? side === 'long'
        ? `平多 ${coin}`
        : `平空 ${coin}`
      : openKind === 'decrease'
        ? side === 'long'
          ? `减多 ${coin}`
          : `减空 ${coin}`
        : openKind === 'open'
          ? side === 'long'
            ? `开多 ${coin}`
            : `开空 ${coin}`
          : side === 'long'
            ? `加多 ${coin}`
            : `加空 ${coin}`;

  return [
    {
      id: `evt-${openKind}-${canonicalTradeId(trade) || `${trade.whaleId}-${ts}-${coin}`}`,
      sourceId: fillSourceId(trade),
      whaleId: trade.whaleId || null,
      time: ts,
      kind: openKind,
      coin,
      side,
      usd,
      title,
      payload: trade,
      mergedCount: 1,
    },
  ];
}


function tradeSignature(trade) {
  return JSON.stringify([Number(trade.time),coinOfTrade(trade),trade.side,Number(trade.amount),Number(trade.amountUsd),
    trade.source || 'hyperliquid',trade.startPosition == null || trade.startPosition === '' ? null : Number(trade.startPosition),
    trade.dir || '',trade.instrumentType || '',Number(trade.fillCount || 1),Number(trade._fillCount || 1)]);
}
module.exports = { eventsFromTrade, tradeSignature };
