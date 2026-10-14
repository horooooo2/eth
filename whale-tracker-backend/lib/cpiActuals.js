'use strict';
const axios = require('axios');
const { readCache, writeCache } = require('./cache');
const API_URL = 'https://api.bls.gov/publicAPI/v2/timeseries/data/';
const SERIES = { 'core:mom': 'CUSR0000SA0L1E', 'core:yoy': 'CUUR0000SA0L1E',
  'headline:mom': 'CUSR0000SA0', 'headline:yoy': 'CUUR0000SA0' };
const memory = new Map(), inFlight = new Map();
let budget;
function cpiIdentity(title) {
  const text = String(title || '');
  if (!/\bCPI\b/i.test(text)) return null;
  const family = /核心|\bCore\b/i.test(text) ? 'core' : 'headline';
  const period = /m\/m|\bMoM\b|环比|月率/i.test(text) ? 'mom'
    : /y\/y|\bYoY\b|同比|年率/i.test(text) ? 'yoy' : 'unknown';
  return `${family}:${period}`;
}
function reportingMonth(date) {
  const time = new Date(`${date}T00:00:00Z`);
  if (!Number.isFinite(time.getTime())) return null;
  time.setUTCDate(1); time.setUTCMonth(time.getUTCMonth() - 1);
  return { year: time.getUTCFullYear(), month: time.getUTCMonth() + 1 };
}
function calculateActual(payload, event) {
  const identity = cpiIdentity(event.title), seriesId = SERIES[identity], target = reportingMonth(event.date);
  if (!seriesId || !target || payload?.status !== 'REQUEST_SUCCEEDED') return '';
  const rows = payload.Results?.series?.find(row => row.seriesID === seriesId)?.data;
  if (!Array.isArray(rows)) return '';
  const lookup = (year, month) => {
    const found = rows.find(row => Number(row.year) === year && row.period === `M${String(month).padStart(2, '0')}`);
    const value = Number(found?.value); return Number.isFinite(value) && value > 0 ? value : null;
  };
  const current = lookup(target.year, target.month);
  const base = identity.endsWith(':yoy') ? lookup(target.year - 1, target.month)
    : lookup(target.month === 1 ? target.year - 1 : target.year, target.month === 1 ? 12 : target.month - 1);
  if (current == null || base == null) return '';
  const result = ((current / base - 1) * 100).toFixed(1);
  return `${result === '-0.0' ? '0.0' : result}%`;
}
function released(event, now) {
  if (!/^\d{2}:\d{2}$/.test(event.time || '')) return false;
  const at = Date.parse(`${event.date}T${event.time}:00+08:00`);
  return Number.isFinite(at) && now >= at + 60000;
}
async function getIndexes(events, now) {
  const years = events.map(event => reportingMonth(event.date)?.year).filter(Number.isFinite);
  if (!years.length) return null;
  const startyear = Math.min(...years) - 1, endyear = Math.max(...years), key = `calendar-cpi-bls-${startyear}-${endyear}`;
  if (!memory.has(key)) { memory.set(key, readCache(key)); while (memory.size > 4) memory.delete(memory.keys().next().value); }
  const cached = memory.get(key);
  const complete = events.every(event => calculateActual(cached?.data, event));
  const recentRelease = events.some(event => {
    const releaseAt = Date.parse(`${event.date}T${event.time}:00+08:00`);
    return Number.isFinite(releaseAt) && now - releaseAt >= 0 && now - releaseAt <= 6 * 3600000;
  });
  const retrySteps = [120000,240000,480000,900000,1800000,3600000];
  const ttl = complete ? 86400000 : recentRelease ? cached?.retryMs || retrySteps[0] : 3600000;
  if (cached && now - cached.updatedAt < ttl) return cached.data;
  if (inFlight.has(key)) return inFlight.get(key);
  const utcDay = new Date(now).toISOString().slice(0, 10);
  if (!budget || budget.day !== utcDay) {
    budget = readCache('calendar-cpi-bls-budget')?.data;
    if (budget?.day !== utcDay) budget = { day: utcDay, count: 0 };
  }
  // No key required. Keep this feature below the unregistered API's daily quota.
  if (budget.count >= 20) return cached?.data || null;
  budget.count++; writeCache('calendar-cpi-bls-budget', budget);
  const task = axios.post(API_URL, { seriesid: Object.values(SERIES), startyear: String(startyear), endyear: String(endyear) },
    { timeout: 6000, maxContentLength: 1024 * 1024, ...(process.env.OUTBOUND_PROXY_URL ? {} : { proxy: false }) })
    .then(({ data }) => {
      if (data?.status !== 'REQUEST_SUCCEEDED' || !Array.isArray(data.Results?.series)) throw new Error('BLS 数据暂不可用');
      const filled = events.every(event => calculateActual(data, event));
      const missingAttempts = filled ? 0 : (cached?.missingAttempts || 0) + 1;
      memory.set(key, { ...writeCache(key, data), missingAttempts,
        retryMs: retrySteps[Math.min(Math.max(0,missingAttempts-1),retrySteps.length-1)] }); return data;
    }).catch(() => {
      // Also cache failed attempts: multiple viewers must not retry the upstream at once.
      const fallback = cached?.data || null, missingAttempts = (cached?.missingAttempts || 0) + 1;
      memory.set(key, { data: fallback, updatedAt: now, missingAttempts,
        retryMs: retrySteps[Math.min(missingAttempts-1,retrySteps.length-1)] });
      return fallback;
    }).finally(() => inFlight.delete(key));
  inFlight.set(key, task); return task;
}
async function enrichCpiActuals(events, { now = Date.now(), fetchIndexes = getIndexes } = {}) {
  const pending = events.filter(event => !String(event.actual || '').trim() && SERIES[cpiIdentity(event.title)] && released(event, now));
  if (!pending.length) return events;
  const payload = await fetchIndexes(pending, now);
  return events.map(event => {
    if (!pending.includes(event)) return event;
    const actual = calculateActual(payload, event);
    return actual ? { ...event, actual, actualSource: 'BLS', actualMethod: 'index-percent-change-1dp', actualUrl: API_URL,
      referencePeriod: `${reportingMonth(event.date).year}-${String(reportingMonth(event.date).month).padStart(2, '0')}` } : event;
  });
}
module.exports = { cpiIdentity, calculateActual, enrichCpiActuals };
