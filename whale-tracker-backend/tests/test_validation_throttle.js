const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
test('deep verification slows both HTTP loops tenfold and restores without a catch-up burst',()=>{
 let now=0,deep=true;
 const source=fs.readFileSync(require.resolve('../lib/fillBackfill'),'utf8');
 const begin=source.indexOf('const deepTickAt'),end=source.indexOf('let historyRunning',begin);
 const ctx={Map,Date:{now:()=>now},require:()=>({validator:{isDeepRunning:()=>deep}})};
 vm.createContext(ctx);vm.runInContext(source.slice(begin,end)+';this.defer=deferForDeepValidation;',ctx);
 assert.equal(ctx.defer('latest',5000),false);assert.equal(ctx.defer('history',15000),false);
 for(now=5000;now<50000;now+=5000)assert.equal(ctx.defer('latest',5000),true);
 assert.equal(ctx.defer('latest',5000),false);assert.equal(ctx.defer('history',15000),true);
 now=150000;assert.equal(ctx.defer('history',15000),false);
 deep=false;assert.equal(ctx.defer('latest',5000),false);assert.equal(ctx.defer('history',15000),false);
 deep=true;assert.equal(ctx.defer('latest',5000),false);assert.equal(ctx.defer('latest',5000),true);
});
