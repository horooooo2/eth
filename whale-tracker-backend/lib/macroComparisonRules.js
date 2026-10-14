'use strict';
const { createHash } = require('node:crypto');
const { cpiIdentity } = require('./cpiActuals');
const RULE_VERSION = 'macro-compare-v2';
const MIN_WHALES = 2, DOMINANCE = 0.60;
function indicator(title) {
  const cpi = cpiIdentity(title);
  if (cpi) return { family: cpi.startsWith('core:') ? 'CORE_CPI' : 'CPI', key: cpi };
  const text = String(title || '');
  if (/PCE/i.test(text)) {
    const core = /核心|Core/i.test(text), period = /环比|m\/m|MoM/i.test(text) ? 'mom' : /同比|y\/y|YoY/i.test(text) ? 'yoy' : 'unknown';
    return { family: core ? 'CORE_PCE' : 'PCE', key: `${core ? 'core-' : ''}pce:${period}` };
  }
  if (/非农就业|Non-Farm Employment Change|Nonfarm Payrolls/i.test(text)) return { family: 'NFP', key: 'nfp' };
  return null;
}
function releaseTime(event) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(event?.date || '') || !/^\d{2}:\d{2}$/.test(event.time || '')) return null;
  const value = Date.parse(`${event.date}T${event.time}:00+08:00`);
  return Number.isFinite(value) ? value : null;
}
function eventIdentity(event) {
  const kind = indicator(event.title), at = releaseTime(event);
  return kind && at != null ? createHash('sha256').update(`${kind.key}:${at}`).digest('hex').slice(0, 32) : null;
}
function numberReading(input) {
  const match = String(input ?? '').replace(/,/g, '').trim().match(/^([+-]?\d+(?:\.\d+)?)\s*(%|K|M|B|万|千)?$/i);
  if (!match) return null;
  const unit = (match[2] || '').toUpperCase(), factor = { K: 1000, M: 1e6, B: 1e9, 万: 10000, 千: 1000 }[unit] || 1;
  return { value: Number(match[1]) * factor, unit: unit === '%' ? 'percent' : 'number' };
}
function macroDirection(event, now = Date.now()) {
  const actual = numberReading(event.actual), forecast = numberReading(event.forecast), at = releaseTime(event);
  if (!indicator(event.title) || at == null || now < at || !actual || !forecast || actual.unit !== forecast.unit) return 'PENDING';
  const delta = actual.value - forecast.value;
  if (Math.abs(delta) <= 1e-9 * Math.max(1, Math.abs(actual.value), Math.abs(forecast.value))) return 'NEUTRAL';
  return delta > 0 ? 'SHORT' : 'LONG';
}
function flowDirection(flow) {
  const total = flow.longUsd + flow.shortUsd;
  if (!(total > 0) || flow.whales < MIN_WHALES) return 'INSUFFICIENT';
  const share = flow.longUsd / total;
  return share >= DOMINANCE ? 'LONG' : 1 - share >= DOMINANCE ? 'SHORT' : 'NEUTRAL';
}
function compare(direction, flow, result, event = null, verification = null) {
  const whaleDirection = flowDirection(flow);
  const status = direction === 'PENDING' ? 'PENDING' : direction === 'NEUTRAL' ? 'MACRO_NEUTRAL'
    : whaleDirection === 'INSUFFICIENT' ? 'INSUFFICIENT' : whaleDirection === 'NEUTRAL' ? 'FLOW_NEUTRAL'
    : direction === whaleDirection ? 'MATCH' : 'MISMATCH';
  const verified = verification?.ruleVersion === RULE_VERSION && verification.frozenEvidenceHash === result?.evidenceHash;
  const evidence = verified ? verification : result;
  const cleanQuality = quality => quality && ['unknownReceipts','lateFills','revisedFills','invalidRows','unclassifiedFills'].every(key => quality[key] === 0);
  const eligible = ['MATCH', 'MISMATCH'].includes(status) && result?.mode === 'PRE_RELEASE'
    && (verified || result?.ruleVersion === RULE_VERSION) && (!verification || verified) && (!verified || verification.evidenceUnchanged === true)
    && cleanQuality(result?.quality) && cleanQuality(evidence?.quality) && evidence?.coverage?.complete === true
    && result?.retentionExpired === false && evidence?.retentionExpired === false && (!event || (event.forecastObservedAt && event.forecastObservedAt <= result.sinceMs))
    && (!event || !indicator(event.title)?.key.endsWith(':unknown'));
  return { status, whaleDirection, eligible };
}
module.exports = { RULE_VERSION, MIN_WHALES, DOMINANCE, indicator, releaseTime, eventIdentity, numberReading, macroDirection, flowDirection, compare };
