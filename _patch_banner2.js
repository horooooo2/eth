const fs = require('fs');
const p = 'E:/demo/Eth/whale-tracker-frontend/src/components/FundFlowBanner.vue';
let t = fs.readFileSync(p, 'utf8');

// 加 marketType ref
if (!t.includes('const marketType')) {
  t = t.replace(
    "const period = ref<PeriodKey>('1h');\n",
    "const period = ref<PeriodKey>('1h');\nconst marketType = ref<'spot' | 'swap'>('spot');\n"
  );
}

// 加 watch(marketType)
if (!t.includes('watch(marketType')) {
  t = t.replace(
    "watch(period, () => void load());\n",
    "watch(period, () => void load());\nwatch(marketType, () => void load());\n"
  );
}

fs.writeFileSync(p, t, 'utf8');
console.log('done');
