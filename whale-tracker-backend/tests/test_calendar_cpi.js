const test = require('node:test');
const assert = require('node:assert/strict');
const isolated = require('./helpers/isolateSqlite');
process.env.CACHE_DIR = require('node:path').join(isolated.dir,'cache');
const { normalizeFfRows, mergeCalendarEvents, mergeFfMacroEvents, translateFfTitle } = require('../lib/calendarFeed');
const { cpiIdentity, calculateActual, enrichCpiActuals } = require('../lib/cpiActuals');
const release = Date.parse('2026-10-14T20:30:00+08:00');
const titles = ['Core CPI m/m', 'Core CPI y/y', 'CPI m/m', 'CPI y/y'];
const raw = titles.map((title, index) => ({ title, country: 'USD', date: '2026-10-14T08:30:00-04:00', impact: 'High',
  forecast: ['0.2%', '2.5%', '0.6%', '3.6%'][index], previous: ['0.3%', '2.4%', '0.4%', '3.4%'][index] }));
const events = normalizeFfRows(raw, { today: '2026-10-14', until: '2026-10-15' });
const point = (year, month, value) => ({ year: String(year), period: `M${String(month).padStart(2,'0')}`, value: String(value) });
const indexes = { status: 'REQUEST_SUCCEEDED', Results: { series: [
  { seriesID: 'CUSR0000SA0L1E', data: [point(2026,9,100.3),point(2026,8,100)] },
  { seriesID: 'CUUR0000SA0L1E', data: [point(2026,9,102.6),point(2025,9,100)] },
  { seriesID: 'CUSR0000SA0', data: [point(2026,9,100.6),point(2026,8,100)] },
  { seriesID: 'CUUR0000SA0', data: [point(2026,9,103.7),point(2025,9,100)] },
] } };
test('CPI and core CPI keep distinct month/year identities, IDs, forecasts and notes in both merge paths', () => {
  assert.deepEqual(events.map(event => event.title), ['核心 CPI（环比）','核心 CPI（同比）','CPI（环比）','CPI（同比）']);
  assert.equal(new Set(events.map(event => event.id)).size, 4);
  const merged = mergeCalendarEvents([], events); assert.equal(merged.length, 4);
  assert.deepEqual(merged.map(event => event.forecast), ['0.2%','2.5%','0.6%','3.6%']);
  assert.ok(merged[0].note.includes('预期 0.2%')); assert.ok(!merged[0].note.includes('3.6%'));
  assert.equal(mergeFfMacroEvents([], raw, { since: '2026-10-14' }).length, 4);
});
test('ambiguous local CPI rows are never used as a bucket for four independent indicators', () => {
  const merged = mergeCalendarEvents([{ date: '2026-10-14', title: '核心 CPI', forecast: '9%' }], events);
  assert.equal(merged.length, 5); assert.equal(merged[0].forecast, '9%');
  assert.equal(translateFfTitle('Core CPI m/m'), '核心 CPI（环比）');
  assert.equal(cpiIdentity('核心 CPI'), 'core:unknown');
});
test('BLS month changes use seasonally adjusted indexes; year changes use unadjusted same month last year', () => {
  assert.deepEqual(events.map(event => calculateActual(indexes,event)), ['0.3%','2.6%','0.6%','3.7%']);
  const dec = { status: 'REQUEST_SUCCEEDED', Results: { series: [{ seriesID: 'CUSR0000SA0L1E', data: [point(2025,12,100.2),point(2025,11,100)] }] } };
  assert.equal(calculateActual(dec, { date: '2026-01-14', title: '核心 CPI（环比）' }), '0.2%');
});
test('missing exact periods, zero/invalid indexes and unsupported or unknown indicators remain unfilled', () => {
  assert.equal(calculateActual(indexes,{...events[0], date:'2026-11-14'}),'');
  assert.equal(calculateActual(indexes,{...events[0], title:'核心 CPI'}),'');
  assert.equal(calculateActual({ ...indexes, status:'REQUEST_FAILED' },events[0]),'');
  const bad = structuredClone(indexes); bad.Results.series[0].data[1].value = '0';
  assert.equal(calculateActual(bad,events[0]),'');
});
test('only released missing CPI values are enriched; existing actuals and unrelated events are preserved', async () => {
  let calls = 0;
  const fetchIndexes = async () => { calls++; return indexes; };
  assert.deepEqual(await enrichCpiActuals(events,{now:release,fetchIndexes}),events); assert.equal(calls,0);
  const result = await enrichCpiActuals([...events, {...events[0], actual:'0.4%'}, {title:'初请失业金',date:'2026-10-14',time:'20:30'}],{now:release+61000,fetchIndexes});
  assert.equal(calls,1); assert.deepEqual(result.slice(0,4).map(event=>event.actual),['0.3%','2.6%','0.6%','3.7%']);
  assert.equal(result[0].actualSource,'BLS'); assert.equal(result[0].referencePeriod,'2026-09');
  assert.equal(result[4].actual,'0.4%'); assert.equal(result[5].actual,undefined);
});

test('a newly released incomplete CPI response retries after two minutes, deduplicates viewers and caches complete data',async()=>{
  const axios=require('axios'),originalPost=axios.post,originalNow=Date.now;
  let clock=release+61000,calls=0,resolve;
  Date.now=()=>clock;
  axios.post=async()=>{calls++;if(calls===1)return {data:{status:'REQUEST_SUCCEEDED',Results:{series:[]}}};return new Promise(done=>{resolve=()=>done({data:indexes});});};
  try {
    assert.equal((await enrichCpiActuals(events))[0].actual,'');
    clock+=119999;assert.equal((await enrichCpiActuals(events))[0].actual,'');assert.equal(calls,1);
    clock++;const one=enrichCpiActuals(events),two=enrichCpiActuals(events);assert.equal(calls,2);resolve();
    assert.equal((await one)[0].actual,'0.3%');assert.equal((await two)[3].actual,'3.7%');
    clock+=300000;assert.equal((await enrichCpiActuals(events))[0].actual,'0.3%');assert.equal(calls,2);
  } finally {axios.post=originalPost;Date.now=originalNow;}
});

test('unavailable CPI data uses bounded exponential backoff and preserves the daily request budget',async()=>{
  const axios=require('axios'),originalPost=axios.post,originalNow=Date.now;
  // A distinct year range isolates this scenario from the successful response above.
  const missing=events.map(event=>({...event,date:'2027-10-14'})),published=Date.parse('2027-10-14T20:30:00+08:00');
  let clock=published+61000,calls=0;
  Date.now=()=>clock;axios.post=async()=>{calls++;throw Error('temporary outage');};
  try {
    await enrichCpiActuals(missing);assert.equal(calls,1);
    clock+=120000;await enrichCpiActuals(missing);assert.equal(calls,2);
    clock+=120000;await enrichCpiActuals(missing);assert.equal(calls,2);
    clock+=120000;await enrichCpiActuals(missing);assert.equal(calls,3);
    clock+=479999;await enrichCpiActuals(missing);assert.equal(calls,3);
    clock++;await enrichCpiActuals(missing);assert.equal(calls,4);
    // Distinct historical year ranges exhaust the shared budget without moving time backwards.
    for(let year=1990;year<2020;year++)await enrichCpiActuals(missing.map(event=>({...event,date:`${year}-10-14`})));
    assert.equal(calls,20);
  } finally {axios.post=originalPost;Date.now=originalNow;}
});
