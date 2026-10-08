// Synthetic facts only. Compare the full-history baseline with the published horizon.
require('../tests/helpers/isolateSqlite');
const assert=require('node:assert/strict');
const {performance}=require('node:perf_hooks');
const {buildObservations}=require('../lib/whaleObservationEngine');
const {eventsFromTrade}=require('../lib/sqliteStore');
const now=Date.now(),day=86400000,step=60000;
const fills=Array.from({length:7*day/step},(_,i)=>({id:'bench-'+i,whaleId:'bench',asset:'BTC',
  side:'buy',startPosition:i,amount:1,price:100000,time:now-7*day+i*step}));
const start=performance.now();
const full=buildObservations(fills,eventsFromTrade),fullMs=performance.now()-start;
const next=performance.now();
const bounded=buildObservations(fills,eventsFromTrade,undefined,{since:now-25*3600000});
const boundedMs=performance.now()-next;
assert.deepEqual(bounded,full.filter(event=>event.lastAt>=now-25*3600000));
const evidenceCount=events=>events.reduce((sum,event)=>sum+event.evidence.length,0);
console.log(JSON.stringify({inputFills:fills.length,fullMs:Math.round(fullMs),boundedMs:Math.round(boundedMs),
  fullEvents:full.length,boundedEvents:bounded.length,fullEvidenceRows:evidenceCount(full),
  boundedEvidenceRows:evidenceCount(bounded),resultsEqual:true},null,2));
