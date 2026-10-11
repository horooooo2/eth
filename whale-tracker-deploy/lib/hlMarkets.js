// Shared HIP-3 snapshots. Never treat a failed/partial market read as an empty position.
const { hlPost } = require('./hlInfoClient');
const snapshots = new Map();
let dexCache;
let dexPending;
const pending = new Map();

async function fetchDexNames() {
  if (dexCache && Date.now() - dexCache.at < 600000) return dexCache.names;
  if (dexPending) return dexPending;
  dexPending = hlPost({ type: 'perpDexs' }).then(rows => {
    if (!Array.isArray(rows)) throw new Error('Invalid perpDexs response');
    const names = [...new Set(rows.map(row => row?.name).filter(name => typeof name === 'string' && name))];
    dexCache = { names, at: Date.now() };
    return names;
  }).finally(() => { dexPending = null; });
  return dexPending;
}

function mergeMarketStates(entries) {
  if (!Array.isArray(entries) || !entries.length) throw new Error('Invalid all-market snapshot');
  const seen = new Set();
  const positions = [];
  let native;
  let observedAt = Date.now();
  for (const entry of entries) {
    if (!Array.isArray(entry) || typeof entry[0] !== 'string' || seen.has(entry[0]) || !Array.isArray(entry[1]?.assetPositions)) {
      throw new Error('Invalid clearinghouse state');
    }
    const [dex, state] = entry;
    seen.add(dex);
    observedAt = Math.min(observedAt, Number(state.observedAt || state.time) || Date.now());
    if (!dex) native = state;
    for (const row of state.assetPositions) {
      const pos = row?.position;
      if (!pos || typeof pos.coin !== 'string' || !pos.coin) throw new Error('Invalid position');
      if (dex && pos.coin.includes(':') && !pos.coin.startsWith(`${dex}:`)) throw new Error('Mismatched position market');
      positions.push({ ...row, position: { ...pos, coin: dex && !pos.coin.includes(':') ? `${dex}:${pos.coin}` : pos.coin } });
    }
  }
  if (!native) throw new Error('Missing native market in snapshot');
  // Keep native margin accounting: summing DEX balances can double-count shared collateral.
  return { ...native, assetPositions: positions, positionScope: 'all-perp', observedAt };
}

function rememberMarketSnapshot(user, entries) {
  const state = mergeMarketStates(entries);
  const key = String(user).toLowerCase();
  snapshots.delete(key);
  snapshots.set(key, { entries, state, at: Date.now(), live: true });
  while (snapshots.size > 100) snapshots.delete(snapshots.keys().next().value);
  return state;
}

function latestMarketSnapshot(user) {
  const hit = snapshots.get(String(user).toLowerCase());
  return hit?.live && Date.now() - hit.at < 20000 ? hit.state : null;
}

async function fetchExtendedStates(user) {
  const key = String(user).toLowerCase();
  const hit = snapshots.get(key);
  if (hit && Date.now() - hit.at < 120000) return hit.entries.filter(([dex]) => dex);
  if (pending.has(key)) return pending.get(key);
  const work = (async () => {
    const names = await fetchDexNames();
    const entries = [];
    // Sequential per wallet; hlInfoClient also enforces a global concurrency/weight budget.
    for (const dex of names) {
      const state = await hlPost({ type: 'clearinghouseState', user, dex });
      if (!Array.isArray(state?.assetPositions)) throw new Error('Invalid clearinghouse state');
      entries.push([dex, { ...state, observedAt: Date.now() }]);
    }
    const newer = snapshots.get(key);
    if (newer !== hit && newer?.live) return newer.entries.filter(([dex]) => dex);
    snapshots.delete(key);
    snapshots.set(key, { entries, at: Date.now(), live: false });
    while (snapshots.size > 100) snapshots.delete(snapshots.keys().next().value);
    return entries;
  })().finally(() => pending.delete(key));
  pending.set(key, work);
  return work;
}

module.exports = { fetchDexNames, mergeMarketStates, rememberMarketSnapshot, latestMarketSnapshot, fetchExtendedStates };
