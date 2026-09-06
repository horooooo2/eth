const fs = require('fs');
const path = require('path');
const histRoot = path.join(process.env.APPDATA, 'Cursor', 'User', 'History');
const cutoff = new Date('2026-09-04T02:45:00Z').getTime(); // 10:45 BJT — after 10:35 edits
const startDay = new Date('2026-09-04T01:00:00Z').getTime(); // 9:00 BJT

function decodeResource(uri) {
  try {
    const u = uri.replace(/^file:\/\/\//, '').replace(/^file:\/\//, '');
    return decodeURIComponent(u).replace(/^\/([a-zA-Z]):/, '$1:').replace(/\//g, path.sep);
  } catch { return null; }
}

const dirs = fs.readdirSync(histRoot, { withFileTypes: true }).filter(d => d.isDirectory());
const plan = [];
for (const d of dirs) {
  const metaPath = path.join(histRoot, d.name, 'entries.json');
  if (!fs.existsSync(metaPath)) continue;
  let meta;
  try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch { continue; }
  const res = String(meta.resource || '');
  if (!/demo\/Virtual|demo%2FVirtual/i.test(res) && !/e%3A\/demo\/Virtual/i.test(res)) continue;
  const filePath = decodeResource(res);
  if (!filePath) continue;
  if (/node_modules|\\dist\\|whale-tracker-edgeone|whale-tracker-deploy[\\/]public|\\cache\\/i.test(filePath)) continue;
  const entries = Array.isArray(meta.entries) ? meta.entries : [];
  const before = entries.filter(e => Number(e.timestamp) <= cutoff).sort((a,b)=>b.timestamp-a.timestamp);
  const after = entries.filter(e => Number(e.timestamp) > cutoff).sort((a,b)=>a.timestamp-a.timestamp);
  const pick = before[0] || null;
  if (!pick) {
    plan.push({ filePath, action: 'skip-no-history-before-cutoff', entries: entries.length });
    continue;
  }
  const src = path.join(histRoot, d.name, pick.id);
  if (!fs.existsSync(src)) {
    plan.push({ filePath, action: 'missing-blob', id: pick.id });
    continue;
  }
  const bj = new Date(Number(pick.timestamp) + 8*3600000);
  const stamp = `${bj.getUTCFullYear()}-${String(bj.getUTCMonth()+1).padStart(2,'0')}-${String(bj.getUTCDate()).padStart(2,'0')} ${String(bj.getUTCHours()).padStart(2,'0')}:${String(bj.getUTCMinutes()).padStart(2,'0')}`;
  plan.push({
    filePath,
    action: 'restore',
    histId: d.name,
    blob: pick.id,
    stamp,
    ts: pick.timestamp,
    laterEdits: entries.filter(e => Number(e.timestamp) > cutoff).length,
  });
}
const restore = plan.filter(p => p.action === 'restore');
console.log('restore candidates', restore.length);
console.log('skip', plan.filter(p=>p.action!=='restore').length);
// show sample of restore with later edits (most important)
restore.filter(p=>p.laterEdits>0).slice(0,30).forEach(p => console.log(p.stamp, p.laterEdits, p.filePath.replace('E:\\demo\\Virtual\\','')));
console.log('--- files with no later edits but still restoreable ---', restore.filter(p=>p.laterEdits===0).length);
