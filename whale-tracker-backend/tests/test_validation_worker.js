const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),{EventEmitter}=require('node:events');
function fixture(){let worker;class Worker extends EventEmitter{constructor(){super();worker=this;}terminate(){this.terminated=true;return Promise.resolve();}}
 const context={module:{exports:{}},require:key=>key==='worker_threads'?{Worker}:key==='path'?require('path'):key==='crypto'?require('crypto'):{},__dirname:__dirname+'/../lib',AbortController,Date,setTimeout,clearTimeout};vm.runInNewContext(fs.readFileSync(require.resolve('../lib/whaleValidation'),'utf8'),context);return {api:context.module.exports,worker:()=>worker};}
test('leaderboard worker cancellation terminates the worker without caching a late response',async()=>{
 const f=fixture(),controller=new AbortController();const pending=f.api.loadLeaderboard(controller.signal),worker=f.worker();controller.abort();await assert.rejects(pending,/取消/);assert.equal(worker.terminated,true);
 worker.emit('message',{pool:[],eligible:0});const second=f.api.loadLeaderboard(new AbortController().signal);assert.notEqual(f.worker(),worker);f.worker().emit('message',{pool:[],eligible:3});assert.equal((await second).eligible,3);
});
test('worker errors and premature exit reject rather than returning empty results',async()=>{
 for(const event of ['error','exit']){const f=fixture();const pending=f.api.loadLeaderboard(new AbortController().signal);f.worker().emit(event,new Error('worker failed'));await assert.rejects(pending);assert.equal(f.worker().terminated,true);}
});
