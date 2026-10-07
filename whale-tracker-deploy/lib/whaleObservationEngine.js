const { createHash } = require('node:crypto');
const { canonicalTradeId, isRawTrade } = require('./positionEventPolicy');
const POLICY = Object.freeze({ version: 1, gapMs: 15 * 60000, maxMs: 60 * 60000,
  reversalMs: 30 * 60000, minSpanMs: 5 * 60000, minFills: 3, minUsd: 500000, reduction: 0.3 });
const finite = value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
const near = (a, b) => Math.abs(a - b) <= Math.max(1e-8, Math.abs(a) * 1e-6, Math.abs(b) * 1e-6);
const sideOf = n => n > 0 ? 'long' : 'short';
const cn = side => side === 'long' ? '多' : '空';
const money = value => value >= 10000 ? `${(value / 10000).toFixed(1)} 万美元` : `${value.toFixed(0)} 美元`;

// Reorder a timestamp bucket only if ALL executions form one unique position chain.
// Cycles, branches, missing fields and large buckets remain ambiguous.
function orderExecutions(rows) {
  const sorted=[...rows].sort((a,b)=>a.time-b.time||a.id.localeCompare(b.id)), result=[];
  for(let i=0;i<sorted.length;) {
    let j=i+1;while(j<sorted.length&&sorted[j].time===sorted[i].time)j++;
    const bucket=sorted.slice(i,j);i=j;
    if(bucket.length===1){result.push(...bucket);continue;}
    let ordered=[];
    if(bucket.length<=256&&!bucket.some(r=>r.barrier)) {
      const roots=bucket.filter(r=>!bucket.some(p=>p!==r&&near(p.end,r.start)));
      if(roots.length===1) {
        const remaining=new Set(bucket);let current=roots[0];
        while(current) {
          ordered.push(current);remaining.delete(current);
          const next=[...remaining].filter(r=>near(current.end,r.start));
          if(next.length!==1)break;
          current=next[0];
        }
      }
    }
    const verified=ordered.length===bucket.length;
    for (const row of verified ? ordered : bucket) result.push({...row,...(verified?{orderVerified:true}:{orderAmbiguous:true})});
  }
  return result;
}

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
    size, receivedAt:finite(trade.observationReceivedAt)?Number(trade.observationReceivedAt):null,
    price: Number(trade.price), legs: legs.map(e => ({ kind: e.kind, side: e.side, usd: e.usd })),
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
    const continuous = reductions.every((r,i) => !i || ((r.time !== reductions[i-1].time || (r.orderVerified&&reductions[i-1].orderVerified)) && near(r.start, reductions[i-1].end)));
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
  for (const [key,unsorted] of pairs) {
    const rows=orderExecutions(unsorted);pairs.set(key,rows);
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
  // Follow the original event through later executions, even across session windows.
  // Stop at an unknown/discontinuous position, close, or reversal: no invented holdings.
  const indexes = new Map([...pairs].map(([key, rows]) => [key, new Map(rows.map((r,i)=>[r.id,i]))]));
  for (const event of result) {
    if (!['build','reverse'].includes(event.type)) continue;
    const history = pairs.get(JSON.stringify([event.whaleId,event.coin])) || [];
    const anchor = event.evidence.at(-1);
    const index = indexes.get(JSON.stringify([event.whaleId,event.coin]))?.get(anchor.id) ?? -1;
    let previous=anchor, status='last-observed', addUsd=0, reduceUsd=0, interruption=null;
    const follow=[];
    for (let cursor=index+1; cursor<history.length; cursor++) {
      const row=history[cursor];
      if(row.time-anchor.time>86400000)break;
      if (near(previous.end,0) || sideOf(previous.end)!==event.side) break;
      const ambiguous=row.orderAmbiguous || previous.orderAmbiguous || (row.time<=previous.time && !(row.time===previous.time&&row.orderVerified&&previous.orderVerified));
      if (row.barrier || ambiguous || !near(row.start,previous.end)) {
        status='gap';
        interruption={reason:row.barrier?'missing-fields':ambiguous?'ambiguous-order':'position-mismatch',
          at:row.time,expectedSize:previous.end,actualSize:row.barrier?null:row.start};
        break;
      }
      follow.push(row);
      for (const leg of row.legs) {
        if(leg.side!==event.side) continue;
        if(['open','increase'].includes(leg.kind)) addUsd+=leg.usd;
        else reduceUsd+=leg.usd;
      }
      previous=row;
      if(row.special){status='forced';break;}
      if(near(row.end,0)){status='closed';break;}
      if(sideOf(row.end)!==event.side){status='reversed';break;}
    }
    if(follow.length || status==='gap') {
      event.tracking={status,asOf:previous.time,lastSize:previous.end,addUsd,reduceUsd,fillCount:follow.length,interruption};
      for (const row of follow) event.evidence.push(row);
      // Keep event timestamps tied to its original trigger; follow-up has its own asOf.
    }
  }
  return result.sort((a,b)=>b.lastAt-a.lastAt || a.id.localeCompare(b.id));
}
function buildCollective(events) {
  const buckets=new Map();
  for(const event of events) {
    if(!['build','reverse'].includes(event.type))continue;
    for(const row of event.evidence || []) {
      if(row.time>event.lastAt || row.special)continue;
      for(const leg of row.legs) {
        if(!['open','increase'].includes(leg.kind) || leg.side!==event.side)continue;
        const hour=Math.floor(row.time/3600000)*3600000;
        const key=JSON.stringify([event.coin,leg.side,hour]);
        if(!buckets.has(key))buckets.set(key,{coin:event.coin,side:leg.side,hour,fills:new Map()});
        buckets.get(key).fills.set(`${row.whaleId}|${row.id}`,row);
      }
    }
  }
  const result=[];
  for(const bucket of buckets.values()) {
    const members=new Map();
    for(const row of bucket.fills.values()) {
      const identity=row.address?.toLowerCase() || row.whaleId;
      if(!members.has(identity))members.set(identity,{whaleId:row.whaleId,address:row.address,addUsd:0,rows:[]});
      const member=members.get(identity);
      member.addUsd+=row.legs.filter(l=>l.side===bucket.side&&['open','increase'].includes(l.kind)).reduce((s,l)=>s+l.usd,0);
      member.rows.push(row);
    }
    const eligible=[...members.values()].filter(m=>m.addUsd>=POLICY.minUsd);
    if(eligible.length<3)continue;
    const evidence=eligible.flatMap(m=>m.rows).sort((a,b)=>a.time-b.time||a.id.localeCompare(b.id));
    const addUsd=eligible.reduce((s,m)=>s+m.addUsd,0);
    result.push({id:createHash('sha256').update(`collective-v1|${bucket.coin}|${bucket.side}|${bucket.hour}`).digest('hex').slice(0,32),
      ruleVersion:1,whaleId:'__collective__',address:'',coin:bucket.coin,type:'collective',side:bucket.side,
      startAt:bucket.hour,lastAt:evidence.at(-1).time,
      title:`${bucket.coin} · ${eligible.length} 个地址共同增${cn(bucket.side)}仓`,
      text:`该小时达到观察门槛的 ${eligible.length} 个监控地址，累计增${cn(bucket.side)}仓成交 ${money(addUsd)}。这是历史增仓成交额，未减去减仓，不代表当前持仓方向、净持仓变化或关联账户。`,
      metrics:{addUsd,addressCount:eligible.length},quality:'observed-executions',evidence,
      members:eligible.map(({rows,...member})=>member)});
  }
  return result;
}
module.exports = { POLICY, buildObservations, normalize, buildCollective, orderExecutions };
