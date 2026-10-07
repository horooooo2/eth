// Inputs are canonical execution legs, including split close/open legs on reversals.
function aggregateDirectionFacts(facts, { unique = false } = {}) {
  const coins = new Map(), accounts = new Map();
  const bucket = () => ({ addLong: 0, addShort: 0, reduceLong: 0, reduceShort: 0, lastAt: 0, legs: 0, longIds: new Set(), shortIds: new Set(), amounts: new Map() });
  function add(row, event, key) {
    row[key] += event.usd; row.legs++; row.lastAt = Math.max(row.lastAt, event.time);
    if (key === 'addLong' || key === 'addShort') {
      (key === 'addLong' ? row.longIds : row.shortIds).add(event.whaleId);
      row.amounts.set(event.whaleId, (row.amounts.get(event.whaleId) || 0) + event.usd);
    }
  }
  const seen = new Set();
  for (const event of facts) {
    if (!event.id || (!unique && seen.has(event.id)) || !event.whaleId || !event.coin || !Number.isFinite(event.usd) || event.usd <= 0 || !['long', 'short'].includes(event.side)) continue;
    if (!unique) seen.add(event.id);
    const opening = ['open', 'increase'].includes(event.kind);
    if (!opening && !['close', 'decrease'].includes(event.kind)) continue;
    const key = (opening ? 'add' : 'reduce') + (event.side === 'long' ? 'Long' : 'Short');
    if (!coins.has(event.coin)) coins.set(event.coin, bucket());
    const accountKey = JSON.stringify([event.whaleId, event.coin]);
    if (!accounts.has(accountKey)) accounts.set(accountKey, { ...bucket(), whaleId: event.whaleId, coin: event.coin });
    add(coins.get(event.coin), event, key); add(accounts.get(accountKey), event, key);
  }
  const serialize = row => {
    const { longIds, shortIds, amounts, ...values } = row;
    const added = row.addLong + row.addShort;
    return { ...values, net: row.addLong - row.addShort - row.reduceLong + row.reduceShort,
      longAccounts: longIds.size, shortAccounts: shortIds.size,
      concentration: added ? Math.max(0, ...amounts.values()) / added : null };
  };
  return { coins: [...coins].map(([coin, row]) => ({ coin, ...serialize(row) })).sort((a, b) => Math.abs(b.net) - Math.abs(a.net)), accounts: [...accounts.values()].map(serialize) };
}
module.exports = { aggregateDirectionFacts };
