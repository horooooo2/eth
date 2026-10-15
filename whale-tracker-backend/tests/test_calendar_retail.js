const test = require('node:test');
const assert = require('node:assert/strict');
require('./helpers/isolateSqlite');
const { normalizeFfRows, mergeCalendarEvents, mergeFfMacroEvents, translateFfTitle } = require('../lib/calendarFeed');

const raw = [
  { title: 'Core Retail Sales m/m', forecast: '0.6%', previous: '1.4%', actual: '0.5%' },
  { title: 'Retail Sales m/m', forecast: '0.3%', previous: '1.2%', actual: '0.2%' },
  { title: 'Retail Sales y/y', forecast: '5.0%', previous: '6.0%', actual: '5.1%' },
  { title: 'Core Retail Sales y/y', forecast: '4.0%', previous: '4.5%', actual: '4.1%' },
].map(row => ({ ...row, country: 'USD', impact: 'High', date: '2026-10-15T08:30:00-04:00' }));
const options = { today: '2026-10-15', until: '2026-10-15', since: '2026-10-15' };

function checkReadings(events) {
  assert.equal(events.length, 4);
  assert.equal(new Set(events.map(event => event.id)).size, 4);
  for (const row of raw) {
    const event = events.find(item => item.title === translateFfTitle(row.title));
    assert.ok(event, row.title);
    assert.equal(event.forecast, row.forecast);
    assert.equal(event.previous, row.previous);
    assert.equal(event.actual, row.actual);
    assert.ok(event.note.includes(`预期 ${row.forecast} · 前值 ${row.previous} · 实际 ${row.actual}`));
    assert.equal(event.time, '20:30');
  }
}

test('retail sales retain core/headline and month/year identities, IDs and readings in both calendar paths', () => {
  const events = normalizeFfRows(raw, options);
  assert.deepEqual(events.map(event => event.title), ['核心零售销售（环比）', '零售销售（环比）', '零售销售（同比）', '核心零售销售（同比）']);
  for (const rows of [raw, [...raw].reverse()]) {
    checkReadings(mergeCalendarEvents([], normalizeFfRows(rows, options)));
    checkReadings(mergeFfMacroEvents([], rows, options));
  }
});

test('ambiguous local retail titles cannot swallow independently identified releases', () => {
  const local = [{ id: 'manual', date: '2026-10-15', title: '零售销售', forecast: '9%', note: 'manual' }];
  for (const merged of [mergeCalendarEvents(local, normalizeFfRows(raw, options)), mergeFfMacroEvents(local, raw, options)]) {
    assert.equal(merged.length, 5);
    assert.equal(merged.find(event => event.id === 'manual').forecast, '9%');
    checkReadings(merged.filter(event => event.id !== 'manual'));
  }
});

test('matching English and Chinese retail indicators merge without crossing core or period boundaries', () => {
  const local = [{ id: 'local-headline', date: '2026-10-15', title: '零售销售（环比）' }];
  checkReadings(mergeCalendarEvents(local, normalizeFfRows(raw, options)));
  checkReadings(mergeFfMacroEvents([{ ...local[0], title: 'Retail Sales m/m' }], raw, options).map(event => ({ ...event, title: translateFfTitle(event.title) })));
});
