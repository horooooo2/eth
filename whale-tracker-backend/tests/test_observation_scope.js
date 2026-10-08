process.env.WHALE_OBSERVATIONS_ENABLED='1';
const test=require('node:test'),assert=require('node:assert/strict');
require('./helpers/isolateSqlite');
const {getDb}=require('../lib/db');
const scope=require('../lib/observationScope');
const store=require('../lib/whaleObservationStore');
const {buildObservations}=require('../lib/whaleObservationEngine');
const {eventsFromTrade}=require('../lib/sqliteStore');
const db=getDb(),now=Date.now(),hour=3600000;
function user(id,coins) {
  db.prepare('INSERT OR IGNORE INTO users(id,username,password_hash,password_salt,created_at) VALUES(?,?,?,?,?)').run(id,id,'unused','unused',now);
  db.prepare('INSERT OR REPLACE INTO user_settings VALUES(?,?,?)').run(id,JSON.stringify({preferredCoins:coins}),now);
}
test('watchlists use persisted preferences, preserve aliases, and union users without adding default coins',()=>{
  assert.deepEqual(scope.coins(db),['BTC','ETH']);
  user('one',['SOL']);user('two',['PEPE','SOL']);
  assert.deepEqual(scope.coins(db),['PEPE','SOL']);
  assert.equal(scope.matches('kPEPE',['PEPE']),true);
  assert.equal(scope.matches('BTC',['SOL']),false);
  assert.deepEqual(scope.normalize([' sol ','SOL','eth']),['SOL','ETH']);
});
test('preference filter precedes the latest 50-record cap',()=>{
  for(const coin of ['BTC','ADA'])db.prepare('INSERT OR IGNORE INTO observation_versions VALUES(?,?,1)').run('cap',coin);
  const put=db.prepare('INSERT INTO whale_observations VALUES(?,?,?,?,?)');
  for(let i=0;i<120;i++) {
    const row={id:'cap-'+i,whaleId:'cap',coin:i===0?'BTC':'ADA',lastAt:now-1000+i,type:'build',side:'long'};
    put.run(row.id,row.whaleId,row.coin,row.lastAt,JSON.stringify(row));
  }
  assert.deepEqual(store.list(db,now,['BTC']).map(r=>r.coin),['BTC']);
  const latest=store.list(db,now,['ADA']);
  assert.equal(latest.length,50);
  assert.equal(latest[0].id,'cap-119');
  assert.equal(latest.at(-1).id,'cap-70');
  assert.equal(store.list(db,now).length,50);
  db.prepare("DELETE FROM whale_observations WHERE whale_id='cap'").run();
  db.prepare("DELETE FROM observation_versions WHERE whale_id='cap'").run();
});
test('bounded event horizon exactly matches full-history results including sessions crossing the cutoff',()=>{
  const fills=[];
  // Continuous sessions must retain their historical anchor, not restart at cutoff.
  for(let i=0;i<7*24*12;i++)fills.push({id:'h-'+i,whaleId:'h',asset:'BTC',side:'buy',
    amount:2,startPosition:i*2,price:100000,time:now-7*24*hour+i*300000});
  for(const since of [now-25*hour,now-24*hour+12345,now-3600000]) {
    const expected=buildObservations(fills,eventsFromTrade).filter(e=>e.lastAt>=since);
    const actual=buildObservations(fills,eventsFromTrade,undefined,{since});
    assert.deepEqual(actual,expected);
  }
});
test('worker skips unselected pairs, adds preferred history, and restart does not rebuild unchanged pairs',async()=>{
  user('one',['BTC']);user('two',['BTC']);
  for(const coin of ['BTC','SOL'])for(let i=0;i<3;i++)store.recordInput(db,{id:coin+i,whaleId:'scope',asset:coin,
    side:'buy',amount:2,startPosition:i*2,price:100000,time:now-900000+i*300000},now);
  let worker=require('../lib/whaleObservationWorker');
  try {
    await worker.tick();
    assert.equal(worker.getStatus().pendingPairs,0);
    assert.equal(worker.getStatus().failedRuns,0);
    assert.ok(db.prepare("SELECT 1 FROM observation_jobs WHERE coin='SOL'").get());
    assert.equal(worker.snapshot(['SOL']).rows.length,0);
    assert.equal(worker.snapshot(['BTC']).rows.length,1);
    user('one',['SOL']);
    await worker.tick();
    assert.equal(worker.snapshot(['SOL']).rows.length,1);
    assert.equal(worker.snapshot(['BTC']).rows.length,1);
    worker.stop();
    delete require.cache[require.resolve('../lib/whaleObservationWorker')];
    worker=require('../lib/whaleObservationWorker');
    await worker.tick();
    assert.equal(worker.getStatus().pendingPairs,0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM observation_jobs').get().n,0);
    assert.equal(worker.snapshot(['SOL']).rows.length,1);
  }finally{worker.stop();}
});

test('two websocket clients receive separate preferred-coin snapshots and deltas',async()=>{
  const http=require('node:http'),WebSocket=require('ws'),hub=require('../lib/realtimeHub');
  const worker=require('../lib/whaleObservationWorker');
  const server=http.createServer();hub.attachRealtimeHub(server);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const sockets=[];
  function next(socket,type) {
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{socket.off('message',read);reject(Error('socket timeout'));},4000);
      function read(raw){const msg=JSON.parse(raw);if(msg.type===type){clearTimeout(timer);socket.off('message',read);resolve(msg);}}
      socket.on('message',read);
    });
  }
  try {
    for(const coin of ['BTC','SOL']) {
      const socket=new WebSocket(`ws://127.0.0.1:${server.address().port}/realtime?coins=${coin}`);
      sockets.push(socket);
      const frame=await next(socket,'observationSnapshot');
      assert.equal(frame.rows.length,1);assert.equal(frame.rows[0].coin,coin);
    }
    const updates=sockets.map(s=>next(s,'observationCommit'));
    store.recordInput(db,{id:'BTC3',whaleId:'scope',asset:'BTC',side:'buy',amount:2,startPosition:6,price:100000,time:now},now);
    db.prepare("UPDATE observation_pair_runs SET last_run=0 WHERE coin='BTC'").run();
    await worker.tick();
    const [btc,sol]=await Promise.all(updates);
    assert.ok(btc.rows.length);assert.ok(btc.rows.every(r=>r.coin==='BTC'));
    assert.equal(sol.rows.length,0);assert.equal(sol.ids.length,1);
    assert.equal(btc.seq,sol.seq);
  }finally{
    for(const socket of sockets)socket.terminate();
    await new Promise(resolve=>server.close(resolve));worker.stop();
  }
});
