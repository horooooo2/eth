const path = require('path');
const fs = require('fs');

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  for (const raw of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] == null || process.env[key] === '') process.env[key] = value;
  }
}

loadEnvFile(path.join(__dirname, '..', '.env'));
console.log('V41_HFT_SIM_ENABLED=', process.env.V41_HFT_SIM_ENABLED);
const v41 = require('../lib/v41EngineClient');

(async () => {
  try {
    const st = await v41.hftSimStatus();
    console.log('status.enabled=', st.enabled, 'env=', st.env_resolved);
    const sel = await v41.executionSelections();
    for (const i of sel.items || []) {
      console.log(i.id, i.kind, 'available=', i.available, i.disabled_reason || '');
    }
  } catch (e) {
    console.error('FAIL', e.code, e.message, JSON.stringify(e.details || ''));
    process.exit(1);
  }
})();
