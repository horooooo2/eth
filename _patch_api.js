const fs = require('fs');
const p = 'E:/demo/Eth/whale-tracker-frontend/src/api/index.ts';
let t = fs.readFileSync(p, 'utf8');
const old = "export async function fetchDexFlowCoins(period = '24h', coins: string[] = []) {\r\n  const { data } = await http.get<DexFlowCoinsResponse>('/flow/coins', {\r\n    params: {\r\n      period,\r\n      coins: coins.length ? coins.join(',') : undefined,\r\n    },\r\n    timeout: 15000,\r\n  });\r\n  return data;\r\n}";
const newStr = "export async function fetchDexFlowCoins(period = '24h', coins: string[] = [], marketType: 'spot' | 'swap' = 'spot') {\r\n  const { data } = await http.get<DexFlowCoinsResponse>('/flow/coins', {\r\n    params: {\r\n      period,\r\n      coins: coins.length ? coins.join(',') : undefined,\r\n      marketType,\r\n    },\r\n    timeout: 15000,\r\n  });\r\n  return data;\r\n}";
if (t.includes(old)) {
  t = t.replace(old, newStr);
  fs.writeFileSync(p, t, 'utf8');
  console.log('ok');
} else {
  console.log('not found');
}
