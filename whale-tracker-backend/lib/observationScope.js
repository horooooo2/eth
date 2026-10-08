// Preferences are already persisted by authStore. Compute the union for users,
// while each browser receives only its own watchlist.
const DEFAULT_COINS=['BTC','ETH'];
function normalize(coins) {
  const values=Array.isArray(coins)?coins:[];
  const result=[...new Set(values.filter(v=>typeof v==='string').map(v=>v.trim().toUpperCase().replace(/[^A-Z0-9]/g,'')).filter(Boolean))].slice(0,12);
  return result.length?result:[...DEFAULT_COINS];
}
function matches(coin, watched) {
  const key=String(coin||'').trim().toUpperCase().replace(/[^A-Z0-9]/g,'');
  return Boolean(key)&&watched.some(w=>key===w||key===`U${w}`||key===`K${w}`||
    (key.endsWith(w)&&key.length<=w.length+4)||key.replace(/^U/,'').replace(/^K/,'')===w);
}
function watchlists(db) {
  const rows=db.prepare('SELECT s.settings_json FROM users u LEFT JOIN user_settings s ON s.user_id=u.id').all();
  const lists=rows.map(row=>{try{return normalize(JSON.parse(row.settings_json||'{}').preferredCoins);}catch{return [...DEFAULT_COINS];}});
  return lists.length?lists:[[...DEFAULT_COINS]];
}
function coins(db){return [...new Set(watchlists(db).flat())].sort();}
function retainedCoins(db,watched) {
  return db.prepare('SELECT DISTINCT coin FROM observation_versions').all().map(r=>r.coin).filter(c=>matches(c,watched));
}
module.exports={normalize,matches,watchlists,coins,retainedCoins};
