/** Verified TradFi candidates take up to 30 slots; manual accounts always win. */
function selectWhaleRoster(manuals, ranked, selection, limit = 50) {
  const max = Math.max(1, Math.min(50, Number(limit) || 50));
  const byAddress = new Map(ranked.map(w => [String(w.address).toLowerCase(), w]));
  const preferred = [];
  const seen = new Set();
  for (const item of Array.isArray(selection?.addresses) ? selection.addresses : []) {
    const address = String(item.address || '').toLowerCase();
    const whale = byAddress.get(address);
    if (!whale || whale.enabled === false || seen.has(address)) continue;
    seen.add(address);
    preferred.push(whale);
    if (preferred.length >= 30) break;
  }
  const result = [];
  seen.clear();
  for (const whale of [...manuals, ...preferred, ...ranked]) {
    const address = String(whale.address || '').toLowerCase();
    if (!address || seen.has(address) || whale.enabled === false) continue;
    seen.add(address);
    result.push(whale);
    if (result.length >= max) break;
  }
  return result;
}
module.exports = { selectWhaleRoster };
