const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const source = fs.readFileSync(path.join(__dirname, '../src/utils/contractDetails.ts'), 'utf8');
const context = { exports: {} };
vm.runInNewContext(ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, context);
const { contractDetails } = context.exports;

// These distinct exchanges and aliases caused missing or incorrect links.
for (const [contract, underlying] of Object.entries({
  BITO: 'AMEX-BITO', MUU: 'NASDAQ-MUU', MU: 'NASDAQ-MU',
  NVDL: 'NASDAQ-NVDL', TSLL: 'NASDAQ-TSLL', SMH: 'NASDAQ-SMH',
  UVXY: 'CBOE-UVXY', SNXX: 'CBOE-SNXX', BRKB: 'NYSE-BRK.B',
  HK0700: 'HKEX-700', HK0992: 'HKEX-992', SKHYNIX: 'KRX-000660',
  CSOPSKHYNIX2L: 'HKEX-7709', KODEX200: 'KRX-069500',
  CL: 'NYMEX-CL1!', XAU: 'TVC-GOLD',
})) {
  assert.equal(contractDetails(contract+'USDT','TRADFI').href, `https://cn.tradingview.com/symbols/${underlying}/`);
}
assert.equal(contractDetails(' ethusdt ','CRYPTO').href,'https://www.binance.com/zh-CN/futures/ETHUSDT');
assert.equal(contractDetails('NEWSTOCKUSDT','TRADFI','新标的').href,'https://www.binance.com/zh-CN/futures/NEWSTOCKUSDT');
assert.equal(contractDetails('javascript:alert(1)','TRADFI'),null);
assert.equal(contractDetails('../MUUUSDT','TRADFI'),null);
console.log('PASS: underlying exchange links, contract fallback, crypto links and input validation');
