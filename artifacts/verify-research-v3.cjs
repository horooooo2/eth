'use strict';
// One bounded diagnostic using the owner of the latest SNDK research record.
// Never print credentials, account IDs, session tokens or private conversations.
const fs=require('fs'),path=require('path');
const backend=path.resolve(__dirname,'../whale-tracker-backend');
for(const raw of fs.readFileSync(path.join(backend,'.env'),'utf8').split(/\r?\n/)){
 const line=raw.trim(),eq=line.indexOf('=');if(!line||line.startsWith('#')||eq<1)continue;
 const name=line.slice(0,eq).trim(),value=line.slice(eq+1).trim().replace(/^["']|["']$/g,'');
 if(!process.env[name])process.env[name]=value;
}
const proxy=String(process.env.OUTBOUND_PROXY_URL||'').trim();
if(proxy==='direct'){for(const name of ['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','http_proxy','https_proxy','all_proxy'])delete process.env[name];}
else if(proxy){process.env.HTTPS_PROXY=proxy;process.env.HTTP_PROXY=proxy;}
const req=name=>require(path.join(backend,name));
(async()=>{
 const Database=req('node_modules/better-sqlite3');
 const db=new Database(process.env.SQLITE_PATH||path.join(backend,'data/whale.db'),{readonly:true,fileMustExist:true});
 const owner=db.prepare("SELECT user_id FROM contract_research_history WHERE symbol='SNDKUSDT' AND status='COMPLETED' AND json_extract(payload_json,'$.web')=1 ORDER BY created_at DESC LIMIT 1").get();db.close();
 if(!owner)throw Error('NO_RESEARCH_OWNER');
 const key=req('lib/userAiKeys').getRawAiKey(owner.user_id,'deepseek')?.apiKey;
 if(!key)throw Error('NO_CONFIGURED_KEY');
 const service=req('lib/contractResearch'),web=req('lib/contractResearchWeb'),client=req('lib/deepseekClient'),rules=req('lib/contractResearchRules');
 const snapshot=await service.getSnapshot({symbol:'SNDKUSDT',horizon:3});
 const research=await web.collectResearch({apiKey:key,userId:owner.user_id,snapshot,fetchImpl:client.deepseekHttpFetch});
 console.log(JSON.stringify({stage:'sources',...research.diagnostics}));
 const response=await client.deepseekFetch(key,'/chat/completions',{method:'POST',timeoutMs:55000,body:{model:'deepseek-chat',temperature:0.1,max_tokens:6500,messages:[{role:'system',content:'你是基于证据的合约研究助手，只输出要求的JSON。'},{role:'user',content:service.buildPrompt(snapshot,research)}]}});
 const analysis=rules.parseAnalysis(response?.choices?.[0]?.message?.content,snapshot,research);
 const result={sourceDiagnostics:research.sources.map(s=>({id:s.id,title:s.title,url:s.url,verification:s.verification,textLength:s.text?.length||0})),dimensions:analysis.dimensions.map(d=>({id:d.id,bull:d.bull,bear:d.bear,reason:d.reason})),version:snapshot.version,symbol:snapshot.symbol,sourceCount:research.sources.length,readCount:research.diagnostics.readCount,indexedCount:research.diagnostics.indexedCount,
  buyCount:analysis.institutions.filter(i=>i.type==='buyside').length,sellCount:analysis.institutions.filter(i=>i.type==='sellside').length,
  scoreCoverage:analysis.scores.coverage,eventCount:analysis.events.length,stopReason:response.choices?.[0]?.finish_reason,
  institutions:analysis.institutions.map(i=>({type:i.type,name:i.name,target:i.target,asOf:i.asOf,verification:i.verification})),payloadBytes:Buffer.byteLength(JSON.stringify({snapshot,research,analysis}))};
 fs.writeFileSync(path.join(__dirname,'research-v3-live-check.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
})().catch(error=>{console.log(JSON.stringify({stage:'failed',name:error.name,status:error.status||null,code:/^NO_/.test(error.message)?error.message:'DIAGNOSTIC_FAILED'}));process.exitCode=1;});
