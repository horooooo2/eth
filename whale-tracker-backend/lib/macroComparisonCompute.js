'use strict';
const Database = require('better-sqlite3');
const { createHash } = require('node:crypto');
const { eventsFromTrade } = require('./executionClassification');
const { RULE_VERSION } = require('./macroComparisonRules');
function computeWindow({ database, releaseAt, mode, roster = [], now = Date.now(), frozenEvidenceHash }) {
  const db = new Database(database, { readonly: true, fileMustExist: true, timeout: 100 });
  db.pragma('query_only = ON'); db.pragma('cache_size = -2048');
  const from = releaseAt - 3600000;
  const sides = { BTC: { longUsd: 0, shortUsd: 0, fills: 0, longWhales: new Set(), shortWhales: new Set() },
    ETH: { longUsd: 0, shortUsd: 0, fills: 0, longWhales: new Set(), shortWhales: new Set() } };
  const quality = { scanned: 0, unknownReceipts: 0, lateFills: 0, revisedFills: 0, invalidRows: 0, unclassifiedFills: 0 };
  const hash = createHash('sha256'), timelyHash = frozenEvidenceHash ? createHash('sha256') : null, seen = new Set();
  const cohort = new Set(roster.map(row => row.id));
  let coverage;
  try {
    db.transaction(() => {
      const columns = new Set(db.prepare('PRAGMA table_info(fills)').all().map(row => row.name));
      const receipt = columns.has('received_at') ? 'received_at' : 'NULL AS received_at';
      const changed = columns.has('fact_updated_at') ? 'fact_updated_at' : 'NULL AS fact_updated_at';
      // The existing time index bounds reads to one hour. No history projection or migration in this process.
      const query = db.prepare(`SELECT id,payload_json,${receipt},${changed} FROM fills
        WHERE time>=? AND time<? AND asset IN ('BTC','ETH') AND COALESCE(source,'')!='onchain' ORDER BY time,id`);
      // An empty monitored cohort must never broaden the scan to every account.
      for (const row of cohort.size ? query.iterate(from, releaseAt) : []) {
        quality.scanned++;
        let trade; try { trade = JSON.parse(row.payload_json); } catch { quality.invalidRows++; continue; }
        if (!['BTC','ETH'].includes(String(trade.asset || trade.assetLabel || '').toUpperCase())) continue;
        if (!cohort.has(trade.whaleId)) continue;
        if (trade.instrumentType === 'spot') continue;
        const classified = eventsFromTrade(trade);
        if (!classified.length) { quality.unclassifiedFills++; continue; }
        const events = classified.filter(event => ['BTC','ETH'].includes(event.coin) && ['open','increase'].includes(event.kind) && event.time>=from && event.time<releaseAt);
        // A post-release correction from an opening trade to an exit is also uncertain evidence.
        if (!events.length && !(row.fact_updated_at >= releaseAt)) continue;
        const unknown = row.received_at == null || row.fact_updated_at == null;
        const late = !unknown && row.received_at >= releaseAt;
        const revised = !unknown && row.fact_updated_at >= releaseAt;
        if (unknown) quality.unknownReceipts++;
        if (late) quality.lateFills++;
        if (revised && !late) quality.revisedFills++;
        if (mode === 'PRE_RELEASE' && (unknown || late || revised)) continue;
        for (const event of events) {
          if (!Number.isFinite(event.usd) || !(event.usd > 0) || !event.whaleId || !event.sourceId) { quality.invalidRows++; continue; }
          if (seen.has(event.sourceId)) continue;
          seen.add(event.sourceId);
          const total = sides[event.coin]; total[`${event.side}Usd`] += event.usd; total[`${event.side}Whales`].add(event.whaleId); total.fills++;
          const evidence = JSON.stringify([event.sourceId,event.time,event.coin,event.side,event.usd]) + '\n';
          hash.update(evidence);
          if (timelyHash && !unknown && !late && !revised) timelyHash.update(evidence);
        }
      }
      let marks = {};
      try { marks = JSON.parse(db.prepare('SELECT value FROM sync_meta WHERE key=?').get('fills_address_watermarks_v2')?.value || '{}'); } catch { /* unavailable */ }
      const covered = roster.filter(whale => {
        const mark = marks[String(whale.address || '').toLowerCase()];
        return mark && mark.coverageStart <= from && mark.through >= releaseAt && !mark.gap && !mark.historyGap;
      }).length;
      coverage = { monitored: roster.length, covered, complete: roster.length > 0 && covered === roster.length,
        scope: 'locally-observed', upstreamCompleteness: 'unknown' };
    })();
  } finally { db.close(); }
  const coins = Object.fromEntries(Object.entries(sides).map(([coin, total]) => {
    const sum = total.longUsd + total.shortUsd;
    return [coin, { longUsd: total.longUsd, shortUsd: total.shortUsd, longShare: sum ? total.longUsd / sum : null,
      shortShare: sum ? total.shortUsd / sum : null, fills: total.fills, longWhales: total.longWhales.size,
      shortWhales: total.shortWhales.size, whales: new Set([...total.longWhales,...total.shortWhales]).size }];
  }));
  const retentionExpired = now - from > 86400000;
  const verification = timelyHash ? { ruleVersion: RULE_VERSION, verifiedAt: now,
    evidenceUnchanged: timelyHash.digest('hex') === frozenEvidenceHash, frozenEvidenceHash,
    coverage, quality, retentionExpired } : null;
  return { ruleVersion: RULE_VERSION, mode, sinceMs: from, untilMs: releaseAt, computedAt: now,
    coins, coverage, quality, cohort:roster, evidenceHash: hash.digest('hex'), retentionExpired,
    ...(verification ? { verification } : {}) };
}
if (require.main === module) {
  process.once('message', input => {
    const started = Date.now();
    try { const result = computeWindow(input); process.send({ ok: true, result, metrics:{computeMs:Date.now()-started,rssAtEnd:process.memoryUsage().rss} }); }
    catch (error) { process.send({ ok: false, error: error.message }); }
    finally { process.disconnect(); }
  });
}
module.exports = { computeWindow };
