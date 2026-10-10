const { randomUUID } = require('crypto');
const { hlPost } = require('./hlInfoClient');
const { readConfig, loadPresetWhales, mergeWhalesByAddress } = require('./config');

function matchingPosition(state, coin) {
  if (!Array.isArray(state?.assetPositions)) throw new Error('仓位响应不完整');
  const rows = [];
  for (const row of state.assetPositions) {
    const p = row?.position;
    if (!p || typeof p.coin !== 'string') throw new Error('仓位数据异常');
    if (p.coin.toUpperCase() !== coin.toUpperCase()) continue;
    const size = Number(p.szi), usd = Number(p.positionValue);
    if (p.szi == null || p.positionValue == null || !Number.isFinite(size) || !Number.isFinite(usd) || usd < 0) throw new Error('仓位数值异常');
    const numberOrNull = value => value == null || value === '' || !Number.isFinite(Number(value)) ? null : Number(value);
    if (size) rows.push({ side: size > 0 ? 'long' : 'short', size: Math.abs(size), usd,
      entryPx: numberOrNull(p.entryPx), unrealizedPnl: numberOrNull(p.unrealizedPnl),
      liquidationPx: numberOrNull(p.liquidationPx), marginUsed: numberOrNull(p.marginUsed),
      leverage: numberOrNull(p.leverage?.value), leverageType: p.leverage?.type === 'cross' ? 'cross' : p.leverage?.type === 'isolated' ? 'isolated' : null,
      returnOnEquity: numberOrNull(p.returnOnEquity),
    });
  }
  return rows;
}

function selectDeepCandidates(rows) {
  if (!Array.isArray(rows)) throw new Error('排行榜响应格式异常');
  const unique = new Map();
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const address = String(row.ethAddress || '').toLowerCase();
    const value = Number(row.accountValue);
    const volume = Number(Array.isArray(row.windowPerformances) ? row.windowPerformances.find(p => Array.isArray(p) && p[0] === 'week')?.[1]?.vlm : NaN);
    if (!/^0x[0-9a-f]{40}$/.test(address) || !Number.isFinite(value) || value < 1000000 || !Number.isFinite(volume) || volume <= 0) continue;
    if (!unique.has(address) || unique.get(address).accountValue < value) unique.set(address, { address, name: row.displayName || address, accountValue: value });
  }
  const ranked = [...unique.values()].sort((a,b) => b.accountValue-a.accountValue || a.address.localeCompare(b.address));
  return { eligible: ranked.length, pool: ranked.slice(0,1000) };
}
let leaderboardCache;
async function loadLeaderboard(signal) {
  if (leaderboardCache && Date.now()-leaderboardCache.at < 300000) return leaderboardCache;
  // Fetch and parse the large public leaderboard outside the HTTP event loop.
  const selected = await new Promise((resolve,reject)=>{
    const {Worker}=require('worker_threads');
    const worker=new Worker(require('path').join(__dirname,'validationLeaderboardWorker.js'),{resourceLimits:{maxOldGenerationSizeMb:192}});
    let settled=false;
    const finish=(err,result)=>{if(settled)return;settled=true;clearTimeout(timer);signal.removeEventListener('abort',abort);void worker.terminate();err?reject(err):resolve(result);};
    const abort=()=>finish(new Error('排行榜读取已取消'));
    const timer=setTimeout(()=>finish(new Error('排行榜读取超时')),35000);timer.unref?.();
    worker.once('message',result=>result.error?finish(new Error(result.error)):finish(null,result));
    worker.once('error',err=>finish(err));
    worker.once('exit',()=>{if(!settled)finish(new Error('排行榜处理线程退出'));});
    signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
  });
  leaderboardCache = { ...selected, at: Date.now() };
  return leaderboardCache;
}
function createValidator({ request = hlPost, candidates = () => mergeWhalesByAddress(readConfig().whales, loadPresetWhales('hf')),
  leaderboard = loadLeaderboard, now = Date.now, pause = ms => new Promise(resolve => setTimeout(resolve, ms)),
  timeoutMs = 3600000, cooldownMs = 60000 } = {}) {
  const jobs = new Map(), controllers = new Map();
  let active, lastStarted = -Infinity, queueTimer;
  const queue=[];
  function scheduleQueue(){
    clearTimeout(queueTimer);
    if(active || !queue.length)return;
    queueTimer=setTimeout(()=>{
      if(now()-lastStarted<cooldownMs){scheduleQueue();return;}
      const queued=queue.shift();
      if(!queued)return;
      try{start(queued.coin,queued.mode,queued.owner,undefined,false,queued);}
      catch(err){queued.status='error';queued.error=err.message;queued.finishedAt=now();scheduleQueue();}
    },Math.max(0,cooldownMs-(now()-lastStarted)));
    queueTimer.unref?.();
  }
  const fail = (message,status) => Object.assign(new Error(message),{status});
  function get(id) { return jobs.get(id); }
  function latest(owner) { return [...jobs.values()].reverse().find(j=>j.owner===String(owner)); }
  function isDeepRunning() { return active?.mode==='deep' && active.status==='running'; }
  function stop(id, owner = 'test') {
    const job = jobs.get(id);
    if (!job) return null;
    if(job.owner!==String(owner)) throw fail('只有任务发起者可以停止验证',403);
    if(job.status==='queued'){queue.splice(queue.indexOf(job),1);job.status='stopped';job.finishedAt=now();scheduleQueue();}
    if(job.status==='running') {job.status='stopped';job.finishedAt=now();controllers.get(id)?.abort();}
    return job;
  }
  function view(job, owner, offset=0) {
    if(!job)return null;
    const {owner: _owner, positions, failures, ...summary}=job;
    const start=Number.isSafeInteger(offset)&&offset>=0 ? Math.min(offset,positions.length) : 0;
    return {...summary,queuePosition:job.status==='queued'?queue.indexOf(job)+1:0,canStop:job.owner===String(owner),positions:positions.slice(start,start+100),offset:start,nextOffset:Math.min(start+100,positions.length),positionTotal:positions.length};
  }
  function start(input, mode='normal', owner='test', restartId, enqueue=false, queuedJob=null) {
    owner=String(owner);
    if(!['normal','deep'].includes(mode))throw fail('验证模式无效',400);
    const coin=String(input||'').trim();
    if(!/^(?:[a-z0-9]{1,24}:)?[A-Za-z0-9]{1,30}$/.test(coin))throw fail('请选择具体合约',400);
    const previous=restartId ? jobs.get(restartId) : null;
    if(restartId && (!previous || previous.owner!==owner || previous.status!=='stopped' || previous.restarted || previous.mode!==mode || previous.coin.toUpperCase()!==coin.toUpperCase()))throw fail('无法重新启动该验证任务',403);
    if(!queuedJob){
      const own=queue.find(j=>j.owner===owner);
      if(own)return own;
      if(enqueue && active?.owner===owner && active.status==='running')return active;
      if(enqueue && (active || queue.length || now()-lastStarted<cooldownMs)){
        if(queue.length>=10)throw fail('验证队列已满，请稍后再试',429);
        const waiting={id:randomUUID(),owner,mode,coin,status:'queued',phase:'queued',startedAt:now(),finishedAt:null,total:0,eligible:0,success:0,failed:0,longUsd:0,shortUsd:0,longCount:0,shortCount:0,positions:[],failures:[]};
        while(jobs.size>=20){const old=[...jobs.values()].find(j=>!['queued','running'].includes(j.status));if(!old)break;jobs.delete(old.id);}
        queue.push(waiting);jobs.set(waiting.id,waiting);scheduleQueue();return waiting;
      }
      if(queue.length)throw Object.assign(fail('有其他用户正在排队验证，请稍后再试',409),{queueable:true});
    }
    if(active===previous && active?.status==='stopped')active=null;
    if(active){
      if(active.owner===owner && active.status==='running')return active;
      throw Object.assign(fail(active.mode==='deep'?'有其他用户正在进行深度验证，请稍后再试。':'有其他验证任务正在运行，请稍后再试。',409),{queueable:true});
    }
    if(!previous && !queuedJob)for(const job of [...jobs.values()].reverse()) if(job.mode===mode && job.coin.toUpperCase()===coin.toUpperCase() && job.status==='complete' && now()-job.finishedAt<600000)return job;
    if(!previous && now()-lastStarted<cooldownMs)throw Object.assign(fail('验证任务冷却中，请稍后再试',429),{queueable:true});
    const job=Object.assign(queuedJob||{},{id:queuedJob?.id||randomUUID(),owner,mode,coin,status:'running',phase:mode==='deep'?'leaderboard':'scanning',startedAt:now(),finishedAt:null,total:0,eligible:0,success:0,failed:0,longUsd:0,shortUsd:0,longCount:0,shortCount:0,positions:[],failures:[]});
    if(previous)previous.restarted=true;
    active=job;lastStarted=now();while(jobs.size>=20){const old=[...jobs.values()].find(j=>!['queued','running'].includes(j.status));if(!old)break;jobs.delete(old.id);}jobs.set(job.id,job);
    const controller=new AbortController();controllers.set(job.id,controller);
    void run(job,controller);
    return job;
  }
  async function run(job,controller){
    const signal=controller.signal;
    const deadline=setTimeout(()=>{if(job.status==='running'){job.status='error';job.error='验证超时，剩余账户未扫描';job.finishedAt=now();controller.abort();}},timeoutMs);deadline.unref?.();
    const dex=job.coin.includes(':')?job.coin.split(':')[0].toLowerCase():'';
    const wait=ms=>new Promise((resolve,reject)=>{
      if(signal.aborted)return resolve();
      const abort=()=>{signal.removeEventListener('abort',abort);resolve();};
      signal.addEventListener('abort',abort,{once:true});
      Promise.resolve().then(()=>pause(ms)).then(()=>{signal.removeEventListener('abort',abort);resolve();},err=>{signal.removeEventListener('abort',abort);reject(err);});
    });
    const scheduling={priority:job.mode==='deep'?'interactive':'history',signal};
    try{
      let pool;
      if(job.mode==='deep'){
        const result=await leaderboard(signal);if(signal.aborted)return;
        pool=result.pool;job.eligible=result.eligible;job.leaderboardAt=result.at;
      }else{
        const seen=new Set();pool=candidates().filter(w=>{const address=String(w.address||'').toLowerCase();if(w.enabled===false||!/^0x[0-9a-f]{40}$/.test(address)||seen.has(address))return false;seen.add(address);return true;}).slice(0,200);job.eligible=pool.length;
      }
      job.total=pool.length;job.phase='scanning';
      if(!pool.length)throw new Error('没有符合条件的候选账户');
      const meta=await request({type:'meta',...(dex?{dex}:{})},0,scheduling);if(signal.aborted)return;
      const symbol=meta?.universe?.find(p=>String(p.name).toUpperCase()===job.coin.toUpperCase());
      if(!symbol)throw new Error('该市场未找到此合约，请选择带市场前缀的合约');job.coin=symbol.name;
      for(const whale of pool){
        if(signal.aborted)return;
        await wait(1000);if(signal.aborted)return;
        try{
          let state;
          for(let attempt=0;;attempt++){
            try{state=await request({type:'clearinghouseState',user:whale.address,...(dex?{dex}:{})},0,scheduling);break;}
            catch(err){if(signal.aborted) return;if(attempt>=2 || !(err.status===429 || err.response?.status===429 || /429|过于频繁/.test(err.message) || ['HL_HISTORY_DEFERRED','HL_QUEUE_TIMEOUT'].includes(err.code)))throw err;await wait(10000*(attempt+1));if(signal.aborted)return;}
          }
          if(signal.aborted)return;
          const rows=matchingPosition(state,job.coin);job.success++;
          for(const row of rows){job.positions.push({address:whale.address,name:whale.name||whale.address,...row,observedAt:now()});job[row.side+'Usd']+=row.usd;}
          if(rows.some(p=>p.side==='long'))job.longCount++;if(rows.some(p=>p.side==='short'))job.shortCount++;
        }catch(err){if(signal.aborted)return;job.failed++;job.failures.push({address:whale.address,error:err.message||'读取失败'});}
      }
      job.status=job.failed?'partial':'complete';
    }catch(err){if(!signal.aborted){job.status='error';job.error=err.message||'验证失败';}}
    finally{clearTimeout(deadline);job.finishedAt??=now();controllers.delete(job.id);if(active===job)active=null;scheduleQueue();}
  }
  return { start,get,stop,latest,view,isDeepRunning };
}
module.exports={createValidator,matchingPosition,selectDeepCandidates,loadLeaderboard,validator:createValidator()};
