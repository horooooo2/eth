const fs = require('fs');
const path = require('path');
const histRoot = path.join(process.env.APPDATA, 'Cursor', 'User', 'History');
const t935 = new Date('2026-09-04T01:00:00Z').getTime();
const t1045 = new Date('2026-09-04T02:45:00Z').getTime();
const tNow = Date.now();
function decodeResource(uri) {
  try {
    const u = uri.replace(/^file:\/\/\//, '').replace(/^file:\/\//, '');
    return decodeURIComponent(u).replace(/^\/([a-zA-Z]):/, '$1:').replace(/\//g, path.sep);
  } catch { return null; }
}
const dirs = fs.readdirSync(histRoot, { withFileTypes: true }).filter((d) => d.isDirectory());
const todayEdits = [];
for (const d of dirs) {
  const metaPath = path.join(histRoot, d.name, 'entries.json');
  if (!fs.existsSync(metaPath)) continue;
  let meta;
  try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch { continue; }
  const res = String(meta.resource || '');
  if (!/e%3A\/demo\/Virtual/i.test(res)) continue;
  const filePath = decodeResource(res);
  if (!filePath) continue;
  if (/node_modules|\\dist\\|edgeone/i.test(filePath)) continue;
  for (const e of meta.entries || []) {
    const ts = Number(e.timestamp);
    if (ts >= t935 && ts <= tNow) {
      const bj = new Date(ts + 8 * 3600000);
      const stamp = `${String(bj.getUTCHours()).padStart(2, '0')}:${String(bj.getUTCMinutes()).padStart(2, '0')}`;
      todayEdits.push({
        stamp,
        ts,
        file: filePath.replace(/.*Virtual\\/i, ''),
        id: e.id,
        dir: d.name,
        before1045: ts <= t1045,
      });
    }
  }
}
todayEdits.sort((a, b) => a.ts - b.ts);
console.log('today history snapshots', todayEdits.length);
todayEdits.forEach((e) => console.log(e.stamp, e.before1045 ? '<=10:45' : 'AFTER ', e.file));
