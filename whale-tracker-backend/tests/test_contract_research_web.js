'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
require('./helpers/isolateSqlite');
const web = require('../lib/contractResearchWeb');
const rules = require('../lib/contractResearchRules');
const store = require('../lib/contractResearchStore');
const now = Date.parse('2026-10-15T12:00:00+08:00');
const quote = 'On October 14, 2026 Citi maintained Buy on Sandisk with a $200 price target. The average consensus target was 180 and the stock price was 140.';
const source = { id: 'web-1', url: 'https://www.reuters.com/example', title: 'Sandisk research', kind: 'web', verification: 'read', text: quote, asOf: '2026-10-14T09:00:00Z' };
const snapshot = () => ({ id: 'web-fixture', version: rules.VERSION, symbol: 'SNDKUSDT', horizon: 3, generatedAt: now,
  market: { name: '闪迪', baseAsset: 'SNDK' }, sources: [], events: [], quote: null,
  technical: { frames: [] }, dimensions: rules.DIMENSIONS.map(d => ({ ...d, bull: null, bear: null, sourceIds: [] })) });
const institution = { type: 'sellside', name: '花旗', originalName: 'Citi', rating: 'Buy', target: '$200', asOf: '2026-10-14', sourceId: source.id, quote, logic: '维持买入' };

test('research weights match the approved five dimensions and permit both sides to be weak', () => {
  assert.deepEqual(rules.DIMENSIONS.map(d => d.weight), [25, 25, 20, 20, 10]);
  const result = rules.aggregate(rules.DIMENSIONS.map(d => ({ ...d, bull: 2, bear: 3 })));
  assert.deepEqual(result.bull, { low: 2, high: 2 }); assert.deepEqual(result.bear, { low: 3, high: 3 });
});
test('article reader rejects private destinations, off-list domains and credentials before requesting', async () => {
  let called = false;
  for (const url of ['http://www.sec.gov/', 'https://127.0.0.1/', 'https://www.sec.gov.evil.test/', 'https://name:secret@sec.gov/', 'https://sec.gov:444/']) {
    assert.equal(web.allowedUrl(url), null);
    assert.equal((await web.readPage(url, { get: () => { called = true; } })).verification, 'unread');
  }
  assert.equal(called, false);
  for (const address of ['127.0.0.1', '10.0.0.1', '100.64.0.1', '169.254.169.254', '172.16.0.1', '192.168.0.1', '224.0.0.1', '::1']) assert.equal(web.publicIpv4(address), false, address);
  assert.equal(web.publicIpv4('1.1.1.1'), true); assert.equal(web.allowedUrl(source.url), source.url);
});
test('bounded article reads extract text but never run scripts, follow redirects or trust failed pages', async () => {
  const html = '<html><script>alert("malicious")</script><style>.hidden{}</style><article>' + quote + '</article></html>';
  const result = await web.readPage('https://www.sec.gov/test-fixture', { now, get: async (_url, options) => {
    assert.equal(options.maxRedirects, 0); assert.equal(options.maxContentLength, 512 * 1024); assert.equal(options.proxy, false);
    return { headers: { 'content-type': 'text/html' }, data: html };
  } });
  assert.equal(result.verification, 'read'); assert.ok(result.text.includes(quote)); assert.ok(!result.text.includes('malicious'));
  const failed = await web.readPage('https://www.sec.gov/fail-fixture', { get: async () => { throw Error('blocked'); } });
  assert.equal(failed.verification, 'unread'); assert.equal(failed.text, '');
});
test('checked DNS addresses expire instead of remaining pinned indefinitely', async () => {
  const dns = require('node:dns').promises, original = dns.lookup, originalNow = Date.now;
  let stamp = originalNow(), calls = 0;
  dns.lookup = async () => { calls++; return [{ address: calls === 1 ? '1.1.1.1' : '8.8.8.8', family: 4 }]; };
  Date.now = () => stamp;
  const lookup = () => new Promise((resolve, reject) => web.publicLookup('dns-fixture.sec.gov', {}, (error, address) => error ? reject(error) : resolve(address)));
  try {
    assert.equal(await lookup(), '1.1.1.1'); assert.equal(await lookup(), '1.1.1.1'); assert.equal(calls, 1);
    stamp += 300001; assert.equal(await lookup(), '8.8.8.8'); assert.equal(calls, 2);
  } finally { dns.lookup = original; Date.now = originalNow; }
});
test('unread snippets, invented excerpts, invented numbers and unsupported dates cannot fill institution data', () => {
  const facts = web.extractFacts({ institutions: [institution, { ...institution, originalName: 'Morgan Stanley' }], metrics: [
    { id: 'targetConsensus', originalValue: '180', currency: 'USD', asOf: '2026-10-14', sourceId: source.id, quote },
    { id: 'squeezeRisk', originalValue: '82.5', asOf: '2026-10-14', sourceId: source.id, quote },
  ] }, { sources: [source] }, now);
  assert.equal(facts.institutions.length, 1); assert.equal(facts.institutions[0].target, '$200'); assert.equal(facts.metrics.length, 1);
  assert.equal(web.extractFacts({ institutions: [institution] }, { sources: [{ ...source, verification: 'unread' }] }, now).institutions.length, 0);
  const changed = web.extractFacts({ institutions: [{ ...institution, target: '$999', asOf: '2026-10-15' }] }, { sources: [source] }, now).institutions[0];
  assert.equal(changed.target, null); assert.equal(changed.asOf, null); assert.equal(changed.stale, true);
  const substring = web.extractFacts({ institutions: [{ ...institution, target: '$20' }], metrics: [
    { id: 'targetConsensus', originalValue: '18', currency: 'USD', asOf: '2026-10-14', sourceId: source.id, quote },
  ] }, { sources: [source] }, now);
  assert.equal(substring.institutions[0].target, null); assert.equal(substring.metrics.length, 0);
  assert.equal(web.dateOnly('2026-02-30', now), null);
});
test('holdings cannot silently become a buy-side opinion, and only the most recent same-firm record survives', () => {
  const buyQuote = quote + ' Citi holds 100 shares.';
  const facts = web.extractFacts({ institutions: [{ ...institution, type: 'buyside', holding: '100 shares', quote: buyQuote, explicitView: false }, institution, { ...institution, asOf: '2026-10-15' }] }, { sources: [{...source,text:buyQuote}] }, now);
  const buyer = facts.institutions.find(i => i.type === 'buyside'); assert.equal(buyer.rating, null); assert.equal(buyer.target, null); assert.match(buyer.logic, /未取得/);
  assert.equal(facts.institutions.filter(i => i.type === 'sellside').length, 1);
});
test('AI scoring requires a dated exact excerpt and a real institution rating; it cannot replace program scores', () => {
  const raw = { summary: '多空分歧', institutions: [institution], dimensions: [{ id: 'institutional', bull: 6, bear: 4, reason: '公开评级', sourceIds: [source.id], sourceId: source.id, quote, asOf: '2026-10-14' }] };
  const result = rules.parseAnalysis(JSON.stringify(raw), snapshot(), { sources: [source] });
  assert.equal(result.dimensions.find(d => d.id === 'institutional').bull, 6);
  raw.dimensions[0].quote = 'This excerpt is fabricated and not present in the original article.';
  assert.equal(rules.parseAnalysis(JSON.stringify(raw), snapshot(), { sources: [source] }).dimensions.find(d => d.id === 'institutional').bull, null);
});
test('forecast table rows survive an empty AI institution array and abbreviated dates', () => {
  const text = 'Analyst Firm Rating Rating Action Price Target Upside Date\nAsiya Merchant Citi Citi Buy Maintains $2,100 +49.64% Oct 9, 2026\nVijay Rakesh Mizuho Securities Mizuho Securities Buy Reiterates $1,875 to $2,050 +46.08% Oct 6, 2026';
  const materials = [{...source,url:'https://stockanalysis.com/stocks/sndk/forecast/',text}];
  const facts = web.extractFacts({institutions:[]},{sources:materials},now);
  assert.equal(facts.institutions.length,2); assert.equal(facts.institutions[0].asOf,'2026-10-09');
  assert.equal(facts.institutions[1].target,'$2,050'); assert.equal(facts.institutions[1].logicKind,'inferred');
});
test('institution fields match their own source row without requiring one giant verbatim quote', () => {
  const text='Oct 9, 2026 Citi Buy target $200\nOct 9, 2026 UBS Hold target $999';
  const facts=web.extractFacts({institutions:[{...institution,quote:'AI paraphrase, not a verbatim excerpt',asOf:'2026-10-09',rating:'买入'}, {...institution,name:'UBS',originalName:'UBS',rating:'Hold',target:'$200',quote:'another paraphrase',asOf:'2026-10-09'}]}, {sources:[{...source,text}]},now);
  assert.equal(facts.institutions.length,2); assert.equal(facts.institutions[0].rating,'买入');
  assert.equal(facts.institutions[1].target,null); // Cannot borrow Citi's price for UBS.
});

test('13F table fallback keeps complete share rows without treating option totals as shares', () => {
  const text='Holder Amount Position Size ($ in 1000s) As of\nState Street Corp $26,954,856 06/30/2026\nSNDK 5,927,453 $13,477,428 06/30/2026\nBlackRock Inc. 10,295,300 $23,408,732 06/30/2026\nCall 100 $227 06/30/2026\nVanguard Capital Management LLC 9,668,255 $21,983,001 06/30/2026';
  const facts=web.extractFacts({institutions:[]},{sources:[{...source,url:'https://www.holdingschannel.com/institutional/holders-of-sndk/',text,asOf:null}]},now);
  assert.equal(facts.institutions.length,2);
  assert.equal(facts.institutions[0].holding,'10,295,300'); assert.equal(facts.institutions[0].asOf,'2026-06-30');
  assert.equal(facts.institutions[0].rating,null); assert.equal(facts.institutions[0].logicKind,'inferred');
  const aggregator='S&P Global Ratings Buy target $200 October 14, 2026';
  assert.equal(web.extractFacts({institutions:[{...institution,name:'S&P Global Ratings',originalName:'S&P Global Ratings',quote:aggregator}]},{sources:[{...source,text:aggregator}]},now).institutions.length,0);
});

test('current official events calendar may omit publication date but must prove event date', () => {
  const text='Upcoming Events\nOctober 29, 2026 at 4:30 PM EDT Sandisk Quarterly Earnings';
  const materials={sources:[{...source,url:'https://investor.sandisk.com/events',text,asOf:null}]};
  const item={title:'闪迪财报',date:'2026-10-29',publishedAt:null,sourceId:source.id,quote:text};
  const events=web.extractFacts({events:[item,{...item,date:'2026-10-30'}]},materials,now).events;
  assert.equal(events.length,1); assert.equal(events[0].publishedAt,null); assert.equal(events[0].verifiedAt,'2026-10-15');
  assert.equal(events[0].at,'2026-10-29T16:30:00-04:00');
});

test('researched events cover the past 30 days without admitting older or distant future items', () => {
  const text='September 25, 2026 Sandisk announced an industry update. September 1, 2026 archive. November 25, 2026 distant event.';
  const events=['2026-09-25','2026-09-01','2026-11-25'].map(date=>({title:'研究事件-'+date,date,publishedAt:'2026-09-25',sourceId:source.id,quote:text}));
  const facts=web.extractFacts({events},{sources:[{...source,text,asOf:null}]},now);
  assert.deepEqual(facts.events.map(e=>e.date),['2026-09-25']);
});
test('source-specific indexed excerpts remain visible and labelled, while unsupported prose stays excluded', () => {
  const facts=web.extractFacts({institutions:[institution]}, {sources:[{...source,verification:'indexed'}]},now);
  assert.equal(facts.institutions[0].verification,'indexed');
  assert.equal(web.extractFacts({institutions:[institution]}, {sources:[{...source,verification:'unread',text:''}]},now).institutions.length,0);
});
test('AI events require a date in the original excerpt and retain past events without assigning a fake time', () => {
  const text = 'Sandisk announced on October 14, 2026 that its earnings call will take place on October 29, 2026.';
  const research = { sources: [{ ...source, text }] };
  const item = { title: '闪迪财报', date: '2026-10-29', publishedAt: '2026-10-14', sourceId: source.id, quote: text };
  const facts = web.extractFacts({ events: [item, { ...item, date: '2026-10-30' }] }, research, now);
  assert.equal(facts.events.length, 1); assert.equal(facts.events[0].at, undefined);
  const inventedTime = web.extractFacts({ events: [{ ...item, at: '2026-10-29T20:30:00+08:00' }] }, research, now);
  assert.equal(inventedTime.events[0].at, undefined);
  assert.equal(web.originalEventTime('October 29, 2026 4:30 PM EDT', '2026-10-29'), '2026-10-29T16:30:00-04:00');
  const ongoing = web.extractFacts({ events: [{ title: '行业供需持续风险', ongoing: true, publishedAt: '2026-10-14', sourceId: source.id, quote: text }] }, research, now);
  assert.equal(ongoing.events[0].ongoing, true); assert.equal(ongoing.events[0].date, undefined); assert.equal(ongoing.events[0].at, undefined);
});
test('search coalesces per-account jobs and does not share credential-scoped search results', async () => {
  let searches = 0, reads = 0;
  const deps = { search: async () => { searches++; return { summary: 'search lead', sources: [{ title: 'filing', url: source.url }] }; }, read: async () => { reads++; return { ...source }; } };
  const input = { apiKey: 'never-sent', userId: 'fixture-a', snapshot: snapshot() };
  const [a, b] = await Promise.all([web.collectResearch(input, deps), web.collectResearch(input, deps)]);
  assert.equal(searches, 2); assert.equal(reads, 1); assert.deepEqual(a, b);
  await web.collectResearch(input, deps); assert.equal(searches, 2);
  await web.collectResearch({ ...input, userId: 'fixture-b' }, deps); assert.equal(searches, 4);
});

test('US stock research excludes other-listing holder pages before reading', async () => {
  const data=snapshot(); data.market={...data.market,category:'EQUITY',classification:{stockMarket:'US'}};
  const result=await web.collectResearch({apiKey:'fixture',userId:'listing-fixture',snapshot:data},{
    search:async()=>({summary:'',sources:[{title:'Canadian Depositary Receipts',url:'https://www.advfn.com/stock-market/TSX/SNDK/holders'},{title:'US holder',url:source.url}]}),
    read:async url=>{assert.ok(!url.includes('/TSX/'));return {...source};},
  });
  assert.ok(!result.sources.some(s=>s.url.includes('/TSX/')));
});

test('bounded source slots cover both targeted search plans', async () => {
  let plan=0;const data=snapshot();data.market={...data.market,category:'EQUITY',classification:{stockMarket:'US'}};
  const result=await web.collectResearch({apiKey:'fixture',userId:'balanced-plans',snapshot:data},{
    search:async()=>({sources:Array.from({length:5},(_,i)=>({title:'plan'+plan,url:`https://www.reuters.com/plan-${plan}-${i}`})),summary:String(plan++)}),
    read:async()=>({verification:'read',text:quote,asOf:source.asOf}),
  });
  assert.equal(result.sources.length,8);
  assert.ok(result.sources.some(s=>s.url.includes('plan-0-')));assert.ok(result.sources.some(s=>s.url.includes('plan-1-')));
});
test('alerts evaluate missing and stale data as unavailable and deduplicate events', () => {
  const data = snapshot(); data.technical.frames = [{ interval: '1d', available: true, rsi: 25, asOf: now - 1000 }];
  data.quote = { stale: false, priceChangePercent: '-12', closeTime: now - 500 };
  data.events = [{ id: 'release', title: 'CPI', at: new Date(now + 86400000).toISOString() },
    { id: 'already-released', title: '核心 CPI', at: new Date(now - 2 * 3600000).toISOString() }];
  const result = rules.buildAlerts(data, { events: data.events }, now);
  assert.equal(result.alerts.filter(a => a.id.includes('event-')).length, 1);
  assert.ok(result.alerts.some(a => a.id.endsWith(':rsi'))); assert.ok(result.alerts.some(a => a.id.endsWith(':price')));
  const old = rules.buildAlerts(data, null, now + 3 * 86400000);
  assert.equal(old.thresholds.find(t => t.id === 'rsi').value, null); assert.equal(old.thresholds.find(t => t.id === 'price').value, null);
});
test('latest analysis is private, versioned and separate from retired history UI', () => {
  const data = { ...snapshot(), generatedAt: Date.now() }, row = store.create('private-reader', data, 'RUNNING', true);
  store.finish(row.id, 'private-reader', { analysis: { summary: 'test' } });
  assert.equal(store.latest('private-reader', data.symbol, 3, rules.VERSION).id, row.id);
  assert.equal(store.latest('other-reader', data.symbol, 3, rules.VERSION), null);
  assert.equal(store.latest('private-reader', data.symbol, 3, 'old-version'), null);
});
test('web-enabled analysis persists structured institutions, sources and scores through the authenticated job route', async () => {
  const express = require('express'), auth = require('../lib/authStore'), keys = require('../lib/userAiKeys');
  const client = require('../lib/deepseekClient'), service = require('../lib/contractResearch');
  const originalAi = client.deepseekFetch, originalCollect = web.collectResearch, originalFind = service.findSnapshot;
  const user = auth.createUser('web-lifecycle', 'isolated-test-password'); keys.upsertAiKey(user.id, 'deepseek', 'fixture-key-not-sent');
  const token = auth.login('web-lifecycle', 'isolated-test-password').token;
  let searches = 0, modelCalls = 0;
  service.findSnapshot = () => ({ ...snapshot(), generatedAt: Date.now() });
  web.collectResearch = async () => { searches++; return { sources: [source], summary: 'untrusted lead', warning: 'fixture' }; };
  client.deepseekFetch = async () => { modelCalls++; return { choices: [{ message: { content: JSON.stringify({ summary: '已整理公开资料', institutions: [institution], dimensions: [
    { id: 'institutional', bull: 6, bear: 4, reason: '原文评级', sourceIds: [source.id], sourceId: source.id, quote, asOf: '2026-10-14' },
  ] }) } }] }; };
  const routePath = require.resolve('../routes/contractResearch'); delete require.cache[routePath];
  const app = express(); app.use(express.json()); app.use('/research', require(routePath));
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const base = 'http://127.0.0.1:' + server.address().port + '/research';
  const headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
  try {
    const response = await fetch(base + '/analyze', { method: 'POST', headers, body: JSON.stringify({ snapshotId: 'web-fixture', web: true }) });
    assert.equal(response.status, 202); const row = await response.json();
    for (let i = 0; i < 20 && store.get(row.id, user.id).status === 'RUNNING'; i++) await new Promise(resolve => setImmediate(resolve));
    const completed = store.get(row.id, user.id);
    assert.equal(completed.status, 'COMPLETED'); assert.equal(completed.analysis.institutions[0].target, '$200');
    assert.equal(completed.analysis.dimensions.find(d => d.id === 'institutional').bull, 6);
    assert.equal(completed.research.sources[0].verification, 'read'); assert.equal(searches, 1); assert.equal(modelCalls, 1);
    const latest = await (await fetch(base + '/latest?symbol=SNDKUSDT&horizon=3', { headers })).json(); assert.equal(latest.item.id, row.id);
    const alertResponse = await fetch(base + '/alerts', { method: 'POST', headers, body: JSON.stringify({ snapshotId: 'web-fixture', recordId: row.id }) });
    assert.equal(alertResponse.status, 200); assert.equal(modelCalls, 1); assert.equal(searches, 1);
  } finally {
    client.deepseekFetch = originalAi; web.collectResearch = originalCollect; service.findSnapshot = originalFind;
    delete require.cache[routePath]; await new Promise(resolve => server.close(resolve));
  }
});
