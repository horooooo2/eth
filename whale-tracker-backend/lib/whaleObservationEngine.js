const { createHash } = require('node:crypto');
const { canonicalTradeId, isRawTrade } = require('./positionEventPolicy');
const POLICY = Object.freeze({ version: 1, gapMs: 15 * 60000, maxMs: 60 * 60000,
  reversalMs: 30 * 60000, minSpanMs: 5 * 60000, minFills: 3, minUsd: 500000, reduction: 0.3 });
const finite = value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
const near = (a, b) => Math.abs(a - b) <= Math.max(1e-8, Math.abs(a) * 1e-6, Math.abs(b) * 1e-6);
const sideOf = n => n > 0 ? 'long' : 'short';
const cn = side => side === 'long' ? '多' : '空';
const money = value => value >= 10000 ? `${(value / 10000).toFixed(1)} 万美元` : `${value.toFixed(0)} 美元`;

// Uses the same execution classifier as the original feed. No snapshots or prices
// from a later moment enter these calculations. Unknown starting positions are excluded.
function normalize(trade, classify) {
  if (!isRawTrade(trade) || !finite(trade.startPosition) || !finite(trade.price) || Number(trade.price) <= 0) return null;
  const size = Math.abs(Number(trade.amount)), time = Number(trade.time);
  if (!(size > 0) || !(time > 0) || !trade.whaleId) return null;
  const start = Number(trade.startPosition), buy = ['buy', 'B', 'in'].includes(trade.side);
  const legs = classify({ ...trade, amountUsd: size * Number(trade.price) });
  if (!legs.length) return null;
  return { id: canonicalTradeId(trade), whaleId: String(trade.whaleId), coin: legs[0].coin,
    address: [trade.address,trade.from,trade.to].find(value=>/^0x[0-9a-f]{40}$/i.test(String(value || ''))) || '', time, start, end: start + (buy ? size : -size),
    size, price: Number(trade.price), legs: legs.map(e => ({ kind: e.kind, side: e.side, usd: e.usd })),
    closedPnl: finite(trade.closedPnl) ? Number(trade.closedPnl) : null,
    // Liquidations must not be described as voluntary decisions.
    special: Boolean(trade.liquidation || /liquidat|adl/i.test(String(trade.dir || ''))) };
}

function buildObservations(trades, classify, policy = POLICY) {
  const unique = new Map();
  for (const trade of trades) {
    const row = normalize(trade, classify);
    // Unknown executions break continuity, rather than disappearing between two facts.
    const barrier = !row && trade.whaleId && Number(trade.time)>0 ? {id:canonicalTradeId(trade),whaleId:String(trade.whaleId),coin:String(trade.assetLabel||trade.asset||''),time:Number(trade.time),barrier:true} : null;
    if (row || barrier) unique.set((row || barrier).id,row || barrier);
  }
  const pairs = new Map();
  for (const row of unique.values()) {
    const key = JSON.stringify([row.whaleId, row.coin]);
    if (!pairs.has(key)) pairs.set(key, []);
    pairs.get(key).push(row);
  }
  const result = [];
  function emit(type, side, rows, text, metrics) {
    const first = rows[0], last = rows.at(-1);
    const key = [policy.version, first.whaleId, first.coin, type, side, first.id].join('|');
    result.push({ id: createHash('sha256').update(key).digest('hex').slice(0, 32),
      ruleVersion: policy.version, whaleId: first.whaleId, address: first.address, coin: first.coin,
      type, side, startAt: first.time, lastAt: last.time, text, metrics,
      quality: 'observed-executions', evidence: rows,
      title: `${first.coin} · ${type === 'build' ? `持续增加${cn(side)}仓` : type === 'reverse' ? `转为${cn(side)}仓` : near(last.end, 0) ? '已观测到平仓' : '显著减少仓位'}` });
  }
  function session(rows) {
    if (!rows.length || rows.some(r => r.special)) return;
    for (const side of ['long', 'short']) {
      const opens = rows.filter(r => r.legs.some(l => l.side === side && ['open', 'increase'].includes(l.kind)));
      const addUsd = rows.reduce((sum,r) => sum + r.legs.filter(l => l.side === side && ['open','increase'].includes(l.kind)).reduce((n,l) => n+l.usd,0),0);
      const reduceUsd = rows.reduce((sum,r) => sum + r.legs.filter(l => l.side === side && ['close','decrease'].includes(l.kind)).reduce((n,l) => n+l.usd,0),0);
      if (opens.length >= policy.minFills && opens.at(-1).time - opens[0].time >= policy.minSpanMs && addUsd >= policy.minUsd) {
        emit('build', side, rows, `这段已采集记录中，${opens.length} 笔成交增加${cn(side)}仓 ${money(addUsd)}；同时记录到减${cn(side)}仓 ${money(reduceUsd)}。`, { addUsd, reduceUsd, fillCount: opens.length });
      }
    }
    // A prior opening in this session must not hide a subsequent large reduction.
    const lastOpening = rows.findLastIndex(r=>r.legs.some(l=>['open','increase'].includes(l.kind)));
    const reductions = rows.slice(lastOpening+1);
    if (!reductions.length) return;
    const first = reductions[0], last = reductions.at(-1), start = Math.abs(first.start);
    const continuous = reductions.every((r,i) => !i || (r.time !== reductions[i-1].time && near(r.start, reductions[i-1].end)));
    const sameSide = start > 0 && reductions.every(r => (near(r.start,0) || sideOf(r.start) === sideOf(first.start)) && (near(r.end,0) || sideOf(r.end) === sideOf(first.start)));
    const reduction = start > 0 ? (start - Math.abs(last.end)) / start : 0;
    const closes = reductions.filter(r => r.legs.some(l => ['close','decrease'].includes(l.kind)));
    const usd = closes.reduce((s,r) => s+r.legs.filter(l => ['close','decrease'].includes(l.kind)).reduce((n,l) => n+l.usd,0),0);
    if (continuous && sameSide && reduction >= policy.reduction && usd >= policy.minUsd) {
      const pnl = closes.every(r => r.closedPnl !== null) ? closes.reduce((s,r) => s+r.closedPnl,0) : null;
      emit('reduce', sideOf(first.start), reductions, `可衔接的成交记录显示，${cn(sideOf(first.start))}仓数量由 ${start.toLocaleString('en-US',{maximumFractionDigits:10})} 减至 ${Math.abs(last.end).toLocaleString('en-US',{maximumFractionDigits:10})} ${first.coin}，净减少 ${(reduction*100).toFixed(1)}%；减仓成交 ${money(usd)}。`,
        { reduceUsd: usd, reduction, startSize: start, endSize: Math.abs(last.end), closedPnl: pnl });
    }
  }
  for (const rows of pairs.values()) {
    rows.sort((a,b) => a.time-b.time || a.id.localeCompare(b.id));
    let group = [], lastClose = null;
    for (const r of rows) {
      if (r.barrier) {session(group);group=[];lastClose=null;continue;}
      if (group.length && (r.time-group.at(-1).time > policy.gapMs || r.time-group[0].time > policy.maxMs || !near(r.start,group.at(-1).end))) { session(group); group=[]; }
      const directReverse = !near(r.start,0) && !near(r.end,0) && sideOf(r.start) !== sideOf(r.end);
      if (directReverse) {
        session(group); group=[];
        if (!r.special && r.legs.find(l=>l.kind==='open').usd>=policy.minUsd) emit('reverse',sideOf(r.end),[r],`同一笔成交平掉${cn(sideOf(r.start))}仓并建立${cn(sideOf(r.end))}仓；新方向建仓成交 ${money(r.legs.find(l=>l.kind==='open').usd)}。`, { addUsd:r.legs.find(l=>l.kind==='open').usd });
        lastClose=null;
        continue;
      }
      if (lastClose && near(r.start,0) && !near(r.end,0) && sideOf(r.end)!==sideOf(lastClose.start) && r.time>lastClose.time && r.time-lastClose.time<=policy.reversalMs && !r.special && !lastClose.special && r.size*r.price>=policy.minUsd) {
        emit('reverse',sideOf(r.end),[lastClose,r],`已采集到平${cn(sideOf(lastClose.start))}后开${cn(sideOf(r.end))}，新方向开仓成交 ${money(r.size*r.price)}。`, {addUsd:r.size*r.price});
      }
      lastClose = !near(r.start,0) && near(r.end,0) ? r : null;
      group.push(r);
      if (near(r.end,0)) { session(group); group=[]; }
    }
    session(group);
  }
  return result.sort((a,b)=>b.lastAt-a.lastAt || a.id.localeCompare(b.id));
}
module.exports = { POLICY, buildObservations, normalize };
