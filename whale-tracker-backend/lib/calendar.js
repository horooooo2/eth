const fs = require('fs');
const path = require('path');
const { fetchFfRows, mergeCalendarEvents, normalizeFfRows } = require('./calendarFeed');

const bundledCalendar = require('../config/calendar.json');
const CALENDAR_FILE = path.join(
  process.env.CONFIG_DIR || path.join(__dirname, '..', 'config'),
  'calendar.json',
);
const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const HORIZON_DAYS = 35;
const PAST_DAYS = 7;
const API_ENABLED = process.env.CALENDAR_API !== '0';

function shanghaiYmd(date = new Date()) {
  return new Date(date).toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
}

function parseShanghai(ymd) {
  return Date.parse(`${ymd}T00:00:00+08:00`);
}

function dateLabel(ymd) {
  const [, month, day] = ymd.split('-');
  return `${Number(month)}月${Number(day)}日`;
}

function weekdayOf(ymd) {
  const date = new Date(`${ymd}T12:00:00+08:00`);
  return WEEKDAYS[date.getUTCDay()];
}

function daysUntil(todayYmd, ymd) {
  return Math.round((parseShanghai(ymd) - parseShanghai(todayYmd)) / 86400000);
}

function readEvents() {
  try {
    if (fs.existsSync(CALENDAR_FILE)) {
      const raw = JSON.parse(fs.readFileSync(CALENDAR_FILE, 'utf8'));
      return Array.isArray(raw.events) ? raw.events : [];
    }
  } catch (err) {
    console.warn('[calendar] 读取失败:', err.message);
  }
  return Array.isArray(bundledCalendar.events) ? bundledCalendar.events : [];
}

function shiftYmd(ymd, days) {
  const ts = parseShanghai(ymd);
  if (!Number.isFinite(ts)) return ymd;
  return shanghaiYmd(new Date(ts + days * 86400000));
}

function enrichEvents(events, today, until, since) {
  const from = since || today;
  return (events || [])
    .filter((item) => item.date >= from && item.date <= until)
    .sort((a, b) => a.date.localeCompare(b.date) || String(a.id).localeCompare(String(b.id)))
    .map((item) => {
      const delta = daysUntil(today, item.date);
      return {
        ...item,
        dateLabel: dateLabel(item.date),
        weekday: weekdayOf(item.date),
        daysUntil: delta,
        isToday: delta === 0,
        isTomorrow: delta === 1,
      };
    });
}

function getLocalCalendar() {
  const today = shanghaiYmd();
  const until = shanghaiYmd(parseShanghai(today) + HORIZON_DAYS * 86400000);
  const since = shiftYmd(today, -PAST_DAYS);
  return {
    today,
    until,
    since,
    events: enrichEvents(readEvents(), today, until, since),
    sources: { local: readEvents().length, api: 0 },
    stale: false,
  };
}

async function getCalendar(force = false) {
  const today = shanghaiYmd();
  const until = shanghaiYmd(parseShanghai(today) + HORIZON_DAYS * 86400000);
  const since = shiftYmd(today, -PAST_DAYS);
  const localEvents = readEvents();
  let apiEvents = [];
  let apiMeta = { fresh: false, stale: false, source: 'ForexFactory' };

  if (API_ENABLED) {
    const ff = await fetchFfRows(force);
    apiMeta = { fresh: Boolean(ff.fresh), stale: Boolean(ff.stale), source: ff.source || 'ForexFactory' };
    apiEvents = normalizeFfRows(ff.rows, { today, until, since });
  }

  const merged = mergeCalendarEvents(localEvents, apiEvents);
  return {
    today,
    until,
    since,
    events: enrichEvents(merged, today, until, since),
    sources: {
      local: localEvents.length,
      api: apiEvents.length,
      merged: merged.length,
      provider: apiMeta.source,
    },
    stale: apiMeta.stale,
  };
}

module.exports = {
  getCalendar,
  getLocalCalendar,
  HORIZON_DAYS,
  PAST_DAYS,
};
