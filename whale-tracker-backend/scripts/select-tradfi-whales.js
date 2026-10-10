// Explicit one-shot screening; never started by server.js. Apply only with --apply.
const fs = require('fs');
const path = require('path');
const { readConfig, loadPresetWhales, mergeWhalesByAddress, getActiveWhales } = require('../lib/config');
const { normalizeAvailableRadarCatalog } = require('../lib/tradfiMarkets');
const ROOT = path.join(__dirname, '..');
const REPORT = path.join(ROOT, 'data', 'tradfi-roster-screen.json');
const SELECTION = path.join(process.env.CONFIG_DIR || path.join(ROOT, 'config'), 'whales-tradfi-selection.json');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function json(url, body) {
  const response = await fetch(url, { signal: AbortSignal.timeout(12000), ...(body ? {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  } : {}) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function main() {
  const apply = process.argv.includes('--apply');
  if (apply) {
    const report = JSON.parse(fs.readFileSync(REPORT, 'utf8'));
    if (Date.now() - report.checkedAt > 3600000 || !report.selected?.length) throw new Error('Run a fresh successful scan before applying');
    const existing = fs.existsSync(SELECTION) ? fs.readFileSync(SELECTION) : Buffer.from('{"addresses":[]}');
    fs.mkdirSync(path.join(ROOT, 'data', 'backups'), { recursive: true });
    fs.writeFileSync(path.join(ROOT, 'data', 'backups', `tradfi-selection-${Date.now()}.json`), existing);
    const payload = { checkedAt: report.checkedAt, scope: report.scope, minimumPositionUsd: 10000,
      note: 'Current verified holdings, not a profitability ranking or complete trading history.', addresses: report.selected };
    fs.writeFileSync(SELECTION + '.tmp', JSON.stringify(payload, null, 2) + '\n');
    fs.renameSync(SELECTION + '.tmp', SELECTION);
    console.log(JSON.stringify({ applied: report.selected.length, active: getActiveWhales().length }));
    return;
  }
  const candidates = mergeWhalesByAddress(readConfig().whales, loadPresetWhales('hf'))
    .filter(w => w.enabled !== false && /^0x[0-9a-f]{40}$/i.test(w.address)).slice(0, 200);
  const previousActive = getActiveWhales().map(w => w.address.toLowerCase());
  const info = await json('https://fapi.binance.com/fapi/v1/exchangeInfo');
  const catalog = normalizeAvailableRadarCatalog(info).filter(row => row.assetType === 'TRADFI');
  const names = new Set(catalog.map(row => row.baseAsset.toUpperCase()));
  for (const [base, alias] of [['XAU', 'GOLD'], ['XAG', 'SILVER'], ['XPT', 'PLATINUM'], ['XPD', 'PALLADIUM']]) {
    if (names.has(base)) names.add(alias);
  }
  if (names.size < 5) throw new Error('TradFi catalog unavailable');
  // Existing observed TradFi exposure is overwhelmingly in xyz. This pass is intentionally
  // scoped to that DEX, not a claim of discovery across all Hyperliquid markets/addresses.
  let bootstrap = [];
  try { bootstrap = (await json('http://127.0.0.1:3001/api/whales/bootstrap')).whales || []; } catch {}
  const cached = new Map(bootstrap.map(w => [w.address.toLowerCase(), w]));
  const results = [], failures = [];
  let requests = 0;
  for (const [index, whale] of candidates.entries()) {
    try {
      const hit = cached.get(whale.address.toLowerCase());
      let positions;
      if (hit?.positionScope === 'all-perp' && !hit.error && Date.now() - hit.positionObservedAt < 180000) {
        positions = hit.positions.map(p => ({ coin: p.coin, positionValue: p.positionValue, szi: p.size }));
      } else {
        // At most one request/second in this process, leaving room for the live backend.
        await sleep(1000);
        requests++;
        const state = await json('https://api.hyperliquid.xyz/info', { type: 'clearinghouseState', user: whale.address, dex: 'xyz' });
        if (!Array.isArray(state.assetPositions)) throw new Error('Invalid market snapshot');
        positions = state.assetPositions.map(row => row.position);
      }
      const matching = positions.filter(p => p && String(p.coin).startsWith('xyz:') &&
        names.has(p.coin.slice(4).toUpperCase()) && Math.abs(Number(p.szi)) > 0);
      const usd = matching.reduce((sum, p) => sum + Math.abs(Number(p.positionValue) || 0), 0);
      results.push({ address: whale.address.toLowerCase(), name: whale.name, positionUsd: usd,
        coins: [...new Set(matching.map(p => p.coin))], checkedAt: Date.now() });
    } catch (err) {
      failures.push({ address: whale.address.toLowerCase(), error: err.message });
      if (/429/.test(err.message)) break;
    }
    if ((index + 1) % 20 === 0) console.log(`scanned=${index + 1}/${candidates.length} qualifying=${results.filter(r => r.positionUsd >= 10000).length} errors=${failures.length}`);
  }
  const eligible = results.filter(row => row.positionUsd >= 10000).sort((a, b) => b.positionUsd - a.positionUsd);
  const selected = eligible.slice(0, 30);
  const report = { checkedAt: Date.now(), scope: 'Existing candidate pool; xyz DEX; Binance-identified TradFi underlyings',
    candidates: candidates.length, scanned: results.length, requests, previousActive,
    selected, eligible: eligible.length, failures, results };
  fs.mkdirSync(path.dirname(REPORT), { recursive: true });
  fs.writeFileSync(REPORT, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ candidates: candidates.length, scanned: results.length, eligible: eligible.length,
    selected: selected.length, replacements: selected.filter(r => !previousActive.includes(r.address)).length, errors: failures.length }));
}

if (require.main === module) main().catch(err => { console.error(err.message); process.exitCode = 1; });
