// UTC weekly context + daily price ladder. No network/AI and at most one position.
export type Candle = { t:number; o:number; h:number; l:number; c:number; v:number };
export type Funding = { t:number; rate:number; price?:number };
export type Side = 'long' | 'short';
export type Tier = { movePct:number; allocationPct:number };
export const LADDER_RULES = Object.freeze({ version:'weekly-daily-ladder-v3.0', dayTimezone:'UTC', backgroundDays:7, maxEquityRiskPct:1 });
export const DEFAULT_TIERS: Tier[] = [{movePct:5,allocationPct:10},{movePct:10,allocationPct:30},{movePct:20,allocationPct:60}];
export type Settings = { symbol:string; marginUsdt:number; leverage:number; walletBalance:number; makerFee:number;
  takerFee:number; slippage:number; tickSize:number; qtyStep:number; riskUsdt:number; maxHoldHours:number;
  weekMinPct:number; stopPct:number; takeProfitPct:number; tiers:Tier[] };
type Episode = { id:string; t:number; side:Side; dayOpen:number; weekPct:number; stop:number;
  marginBudget:number; riskBudget:number; maxTier:number; status:string; reason?:string; skips:string[] };
type Position = { side:Side; qty:number; avg:number; margin:number; fee:number; funding:number; openedAt:number;
  stop:number; target:number; plannedRisk:number; event:Episode; adds:number; fills:Fill[] };
type Fill = { time:number; price:number; qty:number; margin:number; purpose:'open'|'add'; tierStart:number; tierEnd:number;
  label:string; dayOpen:number; movePct:number; cumulativeMargin:number; plannedRisk:number };
type Limit = { tier:number; side:Side; price:number; day:number; dayOpen:number };
const MIN=60000, HOUR=60*MIN, DAY=24*HOUR;
export function validateSettings(s:Settings) {
  if (!s.symbol || ![s.marginUsdt,s.leverage,s.walletBalance,s.makerFee,s.takerFee,s.slippage,s.tickSize,s.qtyStep,s.riskUsdt,s.maxHoldHours,s.weekMinPct,s.stopPct,s.takeProfitPct].every(Number.isFinite)
    || s.marginUsdt<=0 || s.marginUsdt>s.walletBalance || s.walletBalance<=0 || s.riskUsdt<=0 || s.tickSize<=0 || s.qtyStep<=0
    || s.leverage<1 || s.leverage>10 || s.makerFee<0 || s.makerFee>.05 || s.takerFee<0 || s.takerFee>.05 || s.slippage<0 || s.slippage>.05
    || s.maxHoldHours<1 || s.maxHoldHours>168 || s.weekMinPct<0 || s.weekMinPct>100 || s.stopPct<=0 || s.stopPct>=95 || s.takeProfitPct<=0 || s.takeProfitPct>30)
    throw new Error('参数无效：保证金不超过权益、杠杆1–10×、持仓1–168小时，费率/滑点0–5%，止盈/止损和资金为正');
  if (!Array.isArray(s.tiers) || s.tiers.length!==3 || s.tiers.some((v,i)=>!Number.isFinite(v.movePct)||!Number.isFinite(v.allocationPct)
    || v.movePct<=0 || v.movePct>=s.stopPct || v.allocationPct<=0 || v.allocationPct>100
    || (i>0 && (v.movePct<=s.tiers[i-1].movePct || v.allocationPct<=s.tiers[i-1].allocationPct))))
    throw new Error('三个日内涨跌档位和累计比例必须严格递增；比例不超过100%，止损幅度须大于最高档');
}
export class DailyLadderEngine {
  readonly settings:Settings;
  private funding:Funding[]; private fundingIndex=0; private lastTime:number|null=null;
  private days:Candle[]=[]; private currentDay:Candle|null=null; private dayCount=0; private dayCompleteStart=false;
  private limits:Limit[]=[]; private episode:Episode|null=null; private blockedDay=-1;
  dayOpen=0; weekPct:number|null=null; bias:Side|null=null;
  position:Position|null=null;
  logs:any[]=[]; events:Episode[]=[];
  state='空仓等待 · 预热七根完整 UTC 日线';
  counts={observations:0,opened:0,additions:0,skipped:0,canceled:0,closed:0};
  realized=0; fees=0; fundingTotal=0; realizedFunding=0; tradeCount=0;
  realizedBySide={long:0,short:0}; distribution={large:0,small:0};
  equity:number; equityPeak:number; maxDrawdown=0; maxDrawdownPct=0; marginPeak=0;
  lossPeak={long:0,short:0,total:0}; lossContext:Record<Side,any>={long:null,short:null}; totalLossPeakTime=0;
  losingMinutes={long:0,short:0}; losingStreak={long:0,short:0}; maxLosingStreak={long:0,short:0};
  constructor(settings:Settings,funding:Funding[]=[]) {
    validateSettings(settings); this.settings={...settings,tiers:settings.tiers.map(t=>({...t}))};
    this.equity=this.equityPeak=settings.walletBalance; this.funding=funding.map(f=>({...f}));
    funding.forEach((f,i)=>{if(!Number.isFinite(f.t)||f.t%MIN||!Number.isFinite(f.rate)||(f.price!==undefined&&!(Number.isFinite(f.price)&&f.price>0))||(i&&f.t<=funding[i-1].t))throw new Error('资金费须严格按分钟递增、参考价有效');});
  }
  pnl(price:number) { const p=this.position;return p?(p.side==='long'?price-p.avg:p.avg-price)*p.qty+p.funding-p.fee:0; }
  private round(price:number,up:boolean) { const s=this.settings; return (up?Math.ceil(price/s.tickSize-1e-9):Math.floor(price/s.tickSize+1e-9))*s.tickSize; }
  private execution(price:number,buy:boolean) { return this.round(price*(1+(buy?1:-1)*this.settings.slippage),buy); }
  private cancelLimits() { this.counts.canceled+=this.limits.length;this.limits=[]; }
  private startDay(b:Candle) {
    const day=Math.floor(b.t/DAY)*DAY;
    if(this.currentDay && this.dayCompleteStart && this.dayCount===1440) { this.days.push({...this.currentDay});if(this.days.length>7)this.days.shift(); }
    this.cancelLimits();
    if(this.episode&&!this.position){this.episode.status='EXPIRED';this.episode.reason='UTC换日撤单；当日未成交';this.episode=null;}
    this.currentDay={...b,t:day};this.dayCount=0;this.dayCompleteStart=b.t===day;this.dayOpen=b.t===day?b.o:0;
    this.weekPct=this.days.length===7?(this.days[6].c/this.days[0].o-1)*100:null;
    const w=this.weekPct,min=this.settings.weekMinPct;
    this.bias=w!==null&&w<0&&w<=-min?'long':w!==null&&w>0&&w>=min?'short':null;
    if(!this.dayOpen||w===null){this.state=!this.dayOpen?'空仓等待 · 文件起始日不完整，等待下一 UTC 日':`空仓等待 · 已积累 ${this.days.length}/7 根完整 UTC 日线`;return;}
    if(this.position){
      if(this.bias!==this.position.side){this.state='周度方向不再一致 · 暂停补仓，保留原止损与期限';return;}
    }else{
      if(!this.bias){this.state='周度方向不明显 · 当日空仓';return;}
      if(day===this.blockedDay)return;
      const equity=this.settings.walletBalance+this.realized;
      if(equity<=0){this.state='权益耗尽 · 停止开仓';return;}
      const side=this.bias;
      const stop=this.round(this.dayOpen*(1+(side==='long'?-1:1)*this.settings.stopPct/100),side==='short');
      this.episode={id:`${this.settings.symbol}-${day}-${side}`,t:b.t,side,dayOpen:this.dayOpen,weekPct:w,stop,
        marginBudget:Math.min(this.settings.marginUsdt,equity),riskBudget:Math.min(this.settings.riskUsdt,equity*LADDER_RULES.maxEquityRiskPct/100),
        maxTier:-1,status:'WAITING',skips:[]};
      this.events.push(this.episode);this.counts.observations++;
    }
    const e=this.episode!;
    this.limits=this.settings.tiers.flatMap((tier,i)=>{
      if(i<=e.maxTier)return [];
      const price=this.round(this.dayOpen*(1+(e.side==='long'?-1:1)*tier.movePct/100),e.side==='short');
      // Do not move the episode stop across midnight or add at a worse entry price.
      if(price<=0||(e.side==='long'?price<=e.stop:price>=e.stop))return [];
      if(this.position&&(e.side==='long'?price>=this.position.avg:price<=this.position.avg))return [];
      return [{tier:i,side:e.side,price,day,dayOpen:this.dayOpen}];
    });
    this.state=this.limits.length?`${e.side==='long'?'周跌观察做多':'周涨观察做空'} · 日开盘分档限价，等待穿价成交`:'原事件预算/档位保留 · 暂无可补仓档位';
  }
  private plannedRisk(stop:number,side:Side,qty:number,cost:number,entryFee:number,funding:number) {
    const exit=this.execution(stop,side==='short');
    return Math.max(0,(side==='long'?cost-exit*qty:exit*qty-cost)+entryFee+exit*qty*this.settings.takerFee-Math.min(0,funding));
  }
  private target(p:Position) {
    const s=this.settings, profit=p.avg*p.qty*s.takeProfitPct/100;
    // Invert exit fee/slippage so the trigger covers ALL entries and settled funding.
    const exit=p.side==='long'?(profit+p.avg*p.qty+p.fee-p.funding)/(p.qty*(1-s.takerFee))
      :(p.avg*p.qty+p.funding-p.fee-profit)/(p.qty*(1+s.takerFee));
    const executableExit=this.round(exit,p.side==='long');
    return this.round(executableExit/(1+(p.side==='long'?-1:1)*s.slippage),p.side==='long');
  }
  private fill(limit:Limit,b:Candle) {
    const s=this.settings,e=this.episode!,old=this.position,price=limit.price,exit=this.execution(e.stop,e.side==='short');
    const allocation=s.tiers[limit.tier].allocationPct/100;
    const oldRisk=old?this.plannedRisk(e.stop,e.side,old.qty,old.avg*old.qty,old.fee,old.funding):0;
    const unitRisk=(e.side==='long'?price-exit:exit-price)+price*s.makerFee+exit*s.takerFee;
    const equity=s.walletBalance+this.realized+this.pnl(price),available=equity-(old?.margin||0);
    const raw=Math.min((e.marginBudget*allocation-(old?.margin||0))*s.leverage/price,
      (e.riskBudget*allocation-oldRisk)/unitRisk,available/(price/s.leverage+price*s.makerFee));
    const qty=Math.floor(Math.max(0,raw)/s.qtyStep)*s.qtyStep;
    const reason=exit<=0||unitRisk<=0?'止损/价格距离无效'
      :Math.abs(price-e.stop)/price>=.8/s.leverage?'止损距离超过杠杆保守限制'
      :qty<=0?'累计风险或保证金额度内数量不足一个步进':'';
    if(reason){this.counts.skipped++;e.skips.push(`${new Date(b.t).toISOString()} 第${limit.tier+1}档：${reason}`);this.state=reason;return;}
    const totalQty=(old?.qty||0)+qty,fee=price*qty*s.makerFee,margin=price*qty/s.leverage;
    const cost=(old?old.qty*old.avg:0)+price*qty;
    const plannedRisk=this.plannedRisk(e.stop,e.side,totalQty,cost,(old?.fee||0)+fee,old?.funding||0);
    if(plannedRisk>e.riskBudget*allocation+1e-7 || (old?.margin||0)+margin>e.marginBudget*allocation+1e-7)throw new Error('累计预算约束异常');
    const fill:Fill={time:b.t,price,qty,margin,purpose:old?'add':'open',tierStart:limit.tier+1,tierEnd:limit.tier+1,
      label:`日${e.side==='long'?'跌':'涨'} ${s.tiers[limit.tier].movePct}% · 累计额度 ${s.tiers[limit.tier].allocationPct}%`,
      dayOpen:limit.dayOpen,movePct:s.tiers[limit.tier].movePct,cumulativeMargin:(old?.margin||0)+margin,plannedRisk};
    e.maxTier=limit.tier;e.status='HOLDING';
    this.position={side:e.side,qty:totalQty,avg:cost/totalQty,margin:(old?.margin||0)+margin,fee:(old?.fee||0)+fee,
      funding:old?.funding||0,openedAt:old?.openedAt??b.t,stop:e.stop,target:0,plannedRisk,event:e,adds:(old?.adds||0)+(old?1:0),fills:[...(old?.fills||[]),fill]};
    this.position.target=this.target(this.position);
    this.fees+=fee;this.tradeCount++;if(old)this.counts.additions++;else this.counts.opened++;
    this.marginPeak=Math.max(this.marginPeak,this.position.margin);
    this.state=`${e.side==='long'?'多':'空'}仓持有 · 已到第${limit.tier+1}档，原事件预算和期限不重置`;
  }
  private close(price:number,b:Candle,reason:string) {
    const p=this.position!,e=this.episode!,exit=this.execution(price,p.side==='short'),fee=exit*p.qty*this.settings.takerFee,net=this.pnl(exit)-fee;
    this.fees+=fee;this.tradeCount++;this.realized+=net;this.realizedBySide[p.side]+=net;this.realizedFunding+=p.funding;
    if(net>=10)this.distribution.large++;else if(net>=0)this.distribution.small++;
    e.status='CLOSED';e.reason=reason;this.counts.closed++;
    this.logs.push({id:`${e.id}-${b.t}`,type:'position-close',time:b.t,text:reason,reason,side:p.side,symbol:this.settings.symbol,
      openedAt:p.openedAt,closedAt:b.t,openPrice:p.avg,closePrice:exit,qty:p.qty,pnl:net,fee:p.fee+fee,funding:p.funding,
      plannedRisk:p.plannedRisk,stop:p.stop,target:p.target,margin:p.margin,event:{...e,skips:[...e.skips]},fills:p.fills.map(f=>({...f}))});
    this.position=null;this.episode=null;this.blockedDay=Math.floor(b.t/DAY)*DAY;this.cancelLimits();
    this.state=`${reason} · 当日不重建，等待下一 UTC 日重新选向`;
  }
  step(b:Candle) {
    if(![b.t,b.o,b.h,b.l,b.c,b.v].every(Number.isFinite)||b.t%MIN||b.l<=0||b.h<Math.max(b.o,b.c,b.l)||b.l>Math.min(b.o,b.c)||b.v<0||(this.lastTime!==null&&b.t-this.lastTime!==MIN))throw new Error('分钟线须连续且OHLC有效');
    this.lastTime=b.t;
    if(!this.currentDay||Math.floor(b.t/DAY)*DAY!==this.currentDay.t)this.startDay(b);
    // Positions held at the boundary pay/receive funding before same-minute trades.
    while(this.fundingIndex<this.funding.length&&this.funding[this.fundingIndex].t<=b.t){const f=this.funding[this.fundingIndex++];if(this.position&&f.t===b.t){const cash=(this.position.side==='long'?-1:1)*this.position.qty*(f.price??b.o)*f.rate;this.position.funding+=cash;this.fundingTotal+=cash;}}
    let closed=false;
    if(this.position){
      const p=this.position,long=p.side==='long';p.target=this.target(p);
      p.plannedRisk=this.plannedRisk(p.stop,p.side,p.qty,p.avg*p.qty,p.fee,p.funding);
      if(long?b.o<=p.stop:b.o>=p.stop){this.close(b.o,b,'跳空止损');closed=true;}
      else if(b.t-p.openedAt>=this.settings.maxHoldHours*HOUR){this.close(b.o,b,'持仓时间到期');closed=true;}
      else if(long?b.o>=p.target:b.o<=p.target){this.close(b.o,b,'整体回归止盈');closed=true;}
    }
    if(!closed&&this.episode){
      const e=this.episode;
      if(!this.position&&(e.side==='long'?b.o<=e.stop:b.o>=e.stop)){
        e.status='SKIPPED';e.reason='未入场即跳空越过事件止损';this.episode=null;this.cancelLimits();this.blockedDay=Math.floor(b.t/DAY)*DAY;this.state=e.reason;
      }else{
        let filled=false;
        // Conservative adverse-path convention: crossed levels in depth order; cumulative caps, never summed full allocations.
        for(const order of [...this.limits]){
          const crossed=order.side==='long'?b.l<=order.price-this.settings.tickSize:b.h>=order.price+this.settings.tickSize;
          if(!crossed)continue;
          this.limits=this.limits.filter(o=>o!==order);
          const n=this.tradeCount;this.fill(order,b);filled ||= this.tradeCount>n;
        }
        if(this.position){
          const p=this.position,long=p.side==='long';
          if(long?b.l<=p.stop:b.h>=p.stop)this.close(p.stop,b,'价格止损');
          // Do not assume a favorable bounce AFTER fills in the same OHLC minute.
          else if(!filled&&(long?b.h>=p.target:b.l<=p.target))this.close(p.target,b,'整体回归止盈');
        }
      }
    }
    const day=this.currentDay!;day.h=Math.max(day.h,b.h);day.l=Math.min(day.l,b.l);day.c=b.c;day.v=this.dayCount?day.v+b.v:b.v;this.dayCount++;
    this.mark(b);
  }
  private mark(b:Candle) {
    const pnl=this.pnl(b.c),p=this.position;
    if(p){const loss=Math.max(0,-pnl);if(loss>this.lossPeak[p.side]){this.lossPeak[p.side]=loss;this.lossContext[p.side]={time:b.t,price:b.c,entryPrice:p.avg,margin:p.margin,additions:p.adds,phase:'daily-ladder',deepStage:0,deepBudget:p.event.marginBudget,fills:p.fills.map(f=>({...f}))};}if(loss>this.lossPeak.total){this.lossPeak.total=loss;this.totalLossPeakTime=b.t;}}
    for(const side of ['long','short'] as Side[]){if(p?.side===side&&pnl<0){this.losingMinutes[side]++;this.losingStreak[side]++;this.maxLosingStreak[side]=Math.max(this.maxLosingStreak[side],this.losingStreak[side]);}else this.losingStreak[side]=0;}
    this.equity=this.settings.walletBalance+this.realized+pnl;this.equityPeak=Math.max(this.equityPeak,this.equity);
    this.maxDrawdown=Math.max(this.maxDrawdown,this.equityPeak-this.equity);this.maxDrawdownPct=Math.max(this.maxDrawdownPct,(this.equityPeak-this.equity)/this.equityPeak*100);
  }
  view(price:number) {
    const p=this.position,next=this.limits[0];
    return {state:this.state,symbol:this.settings.symbol,positions:{long:null,short:null,...(p?{[p.side]:{...p,event:{...p.event},fills:p.fills.map(f=>({...f})),pnl:this.pnl(price),notional:p.qty*price}}:{})},
      orders:{long:null,short:null,...(next?{[next.side]:{purpose:p?'add':'open',price:next.price,label:`第${next.tier+1}档 · 当日有效`,levels:this.limits.map(o=>({...o}))}}:{})},
      realized:this.realized,realizedBySide:{...this.realizedBySide},realizedFunding:this.realizedFunding,fees:this.fees,funding:this.fundingTotal,
      unrealized:this.pnl(price),net:this.realized+this.pnl(price),tradeCount:this.tradeCount,positionDistribution:{...this.distribution},
      equity:this.equity,maxDrawdown:this.maxDrawdown,maxDrawdownPct:this.maxDrawdownPct,marginPeak:this.marginPeak,maxLossPeak:{...this.lossPeak},lossPeakContext:this.lossContext,totalLossPeakTime:this.totalLossPeakTime,
      losingMinutes:{...this.losingMinutes},maxLosingStreak:{...this.maxLosingStreak},market:null,eventStats:{...this.counts},
      dailyContext:{day:this.currentDay?.t||0,dayOpen:this.dayOpen,weekPct:this.weekPct,bias:this.bias,dailyPct:this.dayOpen?(price/this.dayOpen-1)*100:null,completeDays:this.days.length},
      activeEvent:this.episode?{...this.episode,skips:[...this.episode.skips]}:null,recentEvents:this.events.slice(-20).map(e=>({...e,skips:[...e.skips]}))};
  }
}
