const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const ts=require('typescript');
const vm=require('node:vm');
const root=path.resolve(__dirname,'..');
function load(name){
  if(name.endsWith('.json'))return JSON.parse(fs.readFileSync(path.join(root,'src/utils',name),'utf8'));
  const exports={};
  const code=ts.transpileModule(fs.readFileSync(path.join(root,'src/utils',name+'.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
  vm.runInNewContext(code,{exports,require:load});return exports;
}
const {contractLogoCandidates:logos}=load('contractLogo');
assert.equal(logos('HK1024USDT')[0],'/contract-logos/KUAISHOU.ico');
assert.equal(logos('BTCUSDT','CRYPTO')[0],'/contract-logos/crypto-BTC.png');
assert.equal(logos('NVDAUSDT')[0],'/contract-logos/nvidia.com.ico');
assert.equal(logos('nvd ausdt').length,0);
assert.equal(logos('../badUSDT').length,0);
assert.equal(logos('UNKNOWNUSDT').length,0);
assert.equal(logos('OTHERUSDT','TRADFI','NVDA')[0],logos('NVDAUSDT')[0]);
assert.equal(logos('NVDAUSDT').at(-1),'https://www.google.com/s2/favicons?domain=nvidia.com&sz=64');
assert.equal(new Set(logos('WDCUSDT')).size,logos('WDCUSDT').length);
for(const file of Object.values(load('contractLogoAssets.json'))){
  assert.ok(file.startsWith('/contract-logos/'));
  const bytes=fs.readFileSync(path.join(root,'public',file));
  assert.ok(bytes.length>0&&bytes.length<=512*1024);
}
console.log('Logo normalization, aliases, bounded fallback and bundled asset checks passed.');
