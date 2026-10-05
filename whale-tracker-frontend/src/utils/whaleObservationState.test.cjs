const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript');
const api={};vm.runInNewContext(ts.transpileModule(fs.readFileSync(require('node:path').join(__dirname,'whaleObservationState.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports:api});
const {applyObservationCommit:apply}=api;
const snapshot={epoch:'one',seq:1,rows:[{id:'a',revision:1},{id:'b',revision:1}]};
const commit={epoch:'one',seq:2,rows:[{id:'a',revision:2}],ids:['a']};
test('patch replaces revisions and removes absent records without mutating old snapshot',()=>{
 const next=apply(snapshot,commit);assert.equal(next.rows.length,1);assert.equal(next.rows[0].revision,2);assert.equal(snapshot.rows[0].revision,1);
 assert.equal(apply(next,commit),next);
});
test('gaps, restart, unknown ids and invalid sequences require a fresh snapshot',()=>{
 for(const change of [{seq:3},{epoch:'two'},{ids:['missing']},{seq:NaN},{ids:['a','a']}])assert.equal(apply(snapshot,{...commit,...change}),null);
});
