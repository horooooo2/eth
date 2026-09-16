const fs = require('fs');
const p = 'E:/demo/Eth/whale-tracker-frontend/src/components/FundFlowBanner.vue';
let t = fs.readFileSync(p, 'utf8');

// market 改 56px，period 改 64px，coin 改 76px
t = t.replace('.ctrl.coin {\n  width: 84px;\n}', '.ctrl.coin {\n  width: 76px;\n}');
t = t.replace('.ctrl.market {\n  width: 72px;\n}', '.ctrl.market {\n  width: 56px;\n}');
t = t.replace('.ctrl.period {\n  width: 72px;\n}', '.ctrl.period {\n  width: 64px;\n}');

// 下拉文字小一点
t = t.replace(
  '.ctrl :deep(.el-select__wrapper) {\n  min-height: 38px;\n  height: 38px;\n  padding: 0 8px;',
  '.ctrl :deep(.el-select__wrapper) {\n  min-height: 32px;\n  height: 32px;\n  padding: 0 6px;'
);
t = t.replace(
  '.ctrl :deep(.el-select__wrapper) {\n  min-height: 38px;\n  height: 38px;\n  padding: 0 8px;',
  '.ctrl :deep(.el-select__wrapper) {\n  min-height: 32px;\n  height: 32px;\n  padding: 0 6px;'
);

fs.writeFileSync(p, t, 'utf8');
console.log('done');
