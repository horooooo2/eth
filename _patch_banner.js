const fs = require('fs');
const p = 'E:/demo/Eth/whale-tracker-frontend/src/components/FundFlowBanner.vue';
let t = fs.readFileSync(p, 'utf8');

// 1. script: 加 marketType ref 和传参
t = t.replace(
  "const coin = ref(preferredCoinsState.value[0] || 'BTC');\r\nconst period = ref<PeriodKey>('1h');",
  "const coin = ref(preferredCoinsState.value[0] || 'BTC');\r\nconst period = ref<PeriodKey>('1h');\r\nconst marketType = ref<'spot' | 'swap'>('spot');"
);

t = t.replace(
  "const data = await fetchDexFlowCoins(period.value, [coin.value]);",
  "const data = await fetchDexFlowCoins(period.value, [coin.value], marketType.value);"
);

// 2. watch marketType
t = t.replace(
  "watch(coin, () => void load());\r\nwatch(period, () => void load());",
  "watch(coin, () => void load());\r\nwatch(period, () => void load());\r\nwatch(marketType, () => void load());"
);

// 3. template: 在 period 下拉前加 marketType 切换
const oldTpl = `      <el-select
        v-model="period"
        size="small"
        class="ctrl period"
        :disabled="loading"
        @click.stop
      >`;
const newTpl = `      <el-select
        v-model="marketType"
        size="small"
        class="ctrl market"
        :disabled="loading"
        @click.stop
      >
        <el-option label="现货" value="spot" />
        <el-option label="合约" value="swap" />
      </el-select>

      <el-select
        v-model="period"
        size="small"
        class="ctrl period"
        :disabled="loading"
        @click.stop
      >`;
t = t.replace(oldTpl, newTpl);

// 4. style: market 宽度
t = t.replace(
  ".ctrl.period {\r\n  width: 72px;\r\n}",
  ".ctrl.market {\r\n  width: 72px;\r\n}\r\n\r\n.ctrl.period {\r\n  width: 72px;\r\n}"
);

fs.writeFileSync(p, t, 'utf8');
console.log('done');
