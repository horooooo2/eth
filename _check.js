const fs = require('fs');
const t = fs.readFileSync('E:/demo/Eth/whale-tracker-frontend/src/components/FundFlowBanner.vue', 'utf8');
console.log('has marketType ref:', t.includes('const marketType'));
console.log('has watch marketType:', t.includes('watch(marketType'));
console.log('has market in load:', t.includes('marketType.value'));
console.log('CRLF:', t.includes('\r\n'));
