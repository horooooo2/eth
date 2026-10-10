const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript');
const source=fs.readFileSync(__dirname+'/../components/WhaleValidation.vue','utf8');
const start=source.indexOf('function message('),end=source.indexOf('async function poll',start);
const context={};vm.createContext(context);vm.runInContext(ts.transpileModule(source.slice(start,end),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,context);
test('validation preserves backend conflict message after shared HTTP error normalization',()=>{
 const message='有其他用户正在进行深度验证，请稍后再试。';
 assert.equal(context.message(new Error(message)),message);
 assert.equal(context.message({details:{error:message}}),message);
 assert.equal(context.message({response:{data:{error:message}}}),message);
 assert.equal(context.message(new Error('TIMEOUT')),'请求超时，请重试');
});
