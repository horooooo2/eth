const axios = require('axios');
const { readCache, writeCache } = require('./cache');

const FF_URL = 'https://nfs.faireconomy.media/ff_calendar_thisweek.json';
const CACHE_KEY = 'calendar-ff';
const CACHE_MS = 4 * 60 * 60 * 1000;

const client = axios.create({
  timeout: 15000,
  headers: {
    Accept: 'application/json',
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  },
  validateStatus: (code) => code < 500,
});

const FF_TITLE_MAP = [
  [/ISM Manufacturing PMI/i, 'ISM 制造业 PMI'],
  [/ISM Services PMI/i, 'ISM 服务业 PMI'],
  [/ADP Non-Farm Employment Change|ADP/i, 'ADP 就业'],
  [/Non-Farm Employment Change|Nonfarm Payrolls/i, '非农就业'],
  [/Unemployment Rate/i, '失业率'],
  [/Average Hourly Earnings/i, '平均时薪'],
  [/Core CPI/i, '核心 CPI'],
  [/\bCPI\b/i, 'CPI'],
  [/Core PCE Price Index/i, '核心 PCE'],
  [/\bPPI\b/i, 'PPI'],
  [/FOMC|Federal Funds Rate/i, 'FOMC 利率决议'],
  [/GDP/i, 'GDP'],
  [/Retail Sales/i, '零售销售'],
  [/Initial Jobless Claims|Unemployment Claims/i, '初请失业金'],
  [/JOLTS Job Openings/i, 'JOLTS 职位空缺'],
  [/Consumer Confidence/i, '消费者信心'],
  [/Crude Oil Inventories/i, '原油库存'],
];

function shanghaiParts(ts) {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date(ts)).map((item) => [item.type, item.value]));
  return {
    ymd: `${parts.year}-${parts.month}-${parts.day}`,
    hm: `${parts.hour}:${parts.minute}`,
  };
}

function translateFfTitle(title) {
  for (const [pattern, label] of FF_TITLE_MAP) {
    if (pattern.test(title)) return label;
  }
  return String(title || '').trim();
}

function shiftYmd(ymd, days) {
  const ts = Date.parse(`${ymd}T12:00:00+08:00`);
  if (!Number.isFinite(ts)) return '';
  return shanghaiParts(ts + days * 86400000).ymd;
}

function inferPreviousDate(eventDate, title) {
  if (/初请|Claims/i.test(title)) return shiftYmd(eventDate, -7);
  if (/非农|ADP|失业|时薪/i.test(title)) return shiftYmd(eventDate, -28);
  if (/JOLTS|ISM|PMI|CPI|PPI/i.test(title)) return shiftYmd(eventDate, -31);
  if (/FOMC|欧央行|日央行/i.test(title)) return shiftYmd(eventDate, -49);
  return '';
}

function mapFfImpact(title, ffImpact) {
  if (/Holiday|Bank Holiday/i.test(title)) return 'liquidity';
  if (/FOMC|Fed|非农|NFP|CPI|核心 CPI|PPI|GDP|PCE/i.test(title)) return 'volatile';
  if (/High/i.test(ffImpact)) return 'volatile';
  return 'watch';
}

function mapFfImportance(ffImpact) {
  return /high/i.test(ffImpact) ? 'high' : 'mid';
}

/** 宏观数据对加密走势的方向说明（替换「关注市场风险偏好变化」） */
function cryptoImpactHint(title) {
  if (/非农|NFP|Non-Farm|Nonfarm/i.test(title)) {
    return '非农过高→美元走强、资金回流美元资产→加密偏空；过低则相反偏多';
  }
  if (/ADP/i.test(title)) {
    return 'ADP 偏强预示就业热→美联储偏鹰、美元偏强→加密承压；偏弱则加密易反弹';
  }
  if (/失业|Unemployment/i.test(title)) {
    return '失业率下降→经济偏热、加息预期升温→加密承压；上升则利多加密';
  }
  if (/时薪|Hourly Earnings|Average Hourly/i.test(title)) {
    return '时薪偏热→通胀黏性、紧缩预期↑→加密偏空；偏冷则偏多';
  }
  if (/初请|Claims/i.test(title)) {
    return '初请偏低→就业仍强→加密偏空；偏高→失业加快→加密偏多';
  }
  if (/JOLTS|职位空缺|Job Openings/i.test(title)) {
    return '空缺偏多→招工仍热→加密承压；空缺回落→降温叙事→加密偏多';
  }
  if (/核心 CPI|Core CPI/i.test(title)) {
    return '核心 CPI 超预期→抗通胀加息预期↑、美元强→加密下跌；低于预期则偏多';
  }
  if (/\bCPI\b|通胀/i.test(title)) {
    return 'CPI 超预期→美元走强、风险资产承压→加密偏空；不及预期则偏多';
  }
  if (/核心 PCE|PCE/i.test(title)) {
    return 'PCE 偏热→联储更鹰→加密承压；偏冷→降息预期升温→加密偏多';
  }
  if (/\bPPI\b/i.test(title)) {
    return 'PPI 偏高→成本推升通胀预期→加密偏空；偏低则偏多';
  }
  if (/ISM|PMI/i.test(title)) {
    return 'PMI 强于预期→经济偏热、利率预期↑→加密短线承压；弱于预期则偏多';
  }
  if (/FOMC|Federal Funds|利率决议/i.test(title)) {
    return '偏鹰/加息→美元强、流动性收紧→加密偏空；偏鸽/降息则偏多';
  }
  if (/GDP/i.test(title)) {
    return 'GDP 过热→加息预期↑→加密承压；明显走弱→宽松预期↑→加密偏多';
  }
  if (/零售|Retail Sales/i.test(title)) {
    return '零售强→消费热、利率预期偏鹰→加密承压；偏弱则偏多';
  }
  if (/消费者信心|Consumer Confidence/i.test(title)) {
    return '信心大升→风险偏好分化，美元或走强压制加密；大降则避险与宽松叙事交织，波动加大';
  }
  if (/原油|Oil Inventories/i.test(title)) {
    return '库存骤降→油价涨、通胀预期↑→加密偏空；骤增则偏多';
  }
  if (/Holiday|休市|Bank Holiday/i.test(title)) {
    return '美股休市时加密仍交易，流动性薄、方向易失真，宜降杠杆';
  }
  return '超预期偏热→美元走强、资金偏向美元资产→加密偏空；不及预期则偏多';
}

function buildFfNote(row, title) {
  const bits = [];
  if (row.forecast) bits.push(`预期 ${row.forecast}`);
  if (row.previous) bits.push(`前值 ${row.previous}`);
  const impact = cryptoImpactHint(title);
  if (!bits.length) return impact;
  return `${bits.join(' · ')}；${impact}`;
}

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

function eventsRoughlyMatch(a, b) {
  if (a.date !== b.date) return false;
  const left = String(a.title || '');
  const right = String(b.title || '');
  if (!left || !right) return false;
  if (left.includes(right) || right.includes(left)) return true;
  return left.slice(0, 4) === right.slice(0, 4);
}

function readFfCache() {
  const cached = readCache(CACHE_KEY);
  if (!cached?.data?.rows) return null;
  const fresh = Date.now() - (cached.updatedAt || 0) < CACHE_MS;
  return { rows: cached.data.rows, fresh, updatedAt: cached.updatedAt, source: cached.data.source || 'ForexFactory' };
}

async function fetchFfRows(force = false) {
  if (!force) {
    const cached = readFfCache();
    if (cached?.fresh) return cached;
  }

  try {
    const { data, status } = await client.get(FF_URL);
    if (status === 200 && Array.isArray(data)) {
      writeCache(CACHE_KEY, { rows: data, source: 'ForexFactory' });
      return { rows: data, fresh: true, source: 'ForexFactory' };
    }
    if (status === 429) {
      console.warn('[calendar] ForexFactory 限流 429，使用缓存');
    }
  } catch (err) {
    console.warn('[calendar] ForexFactory 拉取失败:', err.message);
  }

  const cached = readFfCache();
  if (cached?.rows?.length) {
    return { ...cached, stale: true };
  }
  return { rows: [], fresh: false, source: 'ForexFactory' };
}

function normalizeFfRows(rows, { today, until, since } = {}) {
  const output = [];
  const from = since || today;
  for (const row of rows || []) {
    if (!row || row.country !== 'USD') continue;
    if (!/high|medium/i.test(row.impact || '')) continue;
    const ts = Date.parse(row.date);
    if (!Number.isFinite(ts)) continue;
    const parts = shanghaiParts(ts);
    if (from && parts.ymd < from) continue;
    if (until && parts.ymd > until) continue;
    const title = translateFfTitle(row.title);
    output.push({
      id: `ff-${parts.ymd}-${slugify(title)}`,
      date: parts.ymd,
      title,
      note: buildFfNote(row, title),
      time: parts.hm,
      tags: ['宏观', '美国', 'API'],
      impact: mapFfImpact(title, row.impact),
      importance: mapFfImportance(row.impact),
      forecast: row.forecast || '',
      previous: row.previous || '',
      actual: row.actual || '',
      previousDate: inferPreviousDate(parts.ymd, title),
      source: 'ForexFactory',
    });
  }
  return output;
}

function mergeCalendarEvents(localEvents, apiEvents) {
  const merged = (localEvents || []).map((item) => ({ ...item, source: item.source || 'local' }));
  for (const api of apiEvents || []) {
    const existing = merged.find((item) => eventsRoughlyMatch(item, api));
    if (existing) {
      if (!existing.forecast && api.forecast) existing.forecast = api.forecast;
      if (!existing.previous && api.previous) existing.previous = api.previous;
      if (!existing.actual && api.actual) existing.actual = api.actual;
      if (!existing.time && api.time) existing.time = api.time;
      if (!existing.previousDate && api.previousDate) existing.previousDate = api.previousDate;
      if (api.note) existing.note = api.note;
      if (!existing.tags?.includes('API') && api.tags?.includes('API')) {
        existing.tags = [...(existing.tags || []), 'API'];
      }
      continue;
    }
    merged.push(api);
  }
  return merged;
}

function eventSeverity(importance, impact) {
  if (importance === 'high' && (impact === 'volatile' || impact === 'High')) return 'extreme';
  if (importance === 'high' || impact === 'High' || impact === 'volatile') return 'high';
  if (impact === 'Medium' || importance === 'mid') return 'mid';
  return 'low';
}

function mergeFfMacroEvents(baseEvents, rows, { since } = {}) {
  const events = [...(baseEvents || [])];
  const fromYmd = since || shanghaiParts(Date.now() - 7 * 86400000).ymd;
  for (const row of rows || []) {
    if (!row || row.country !== 'USD') continue;
    if (!/high|medium/i.test(row.impact || '')) continue;
    const ts = Date.parse(row.date);
    if (!Number.isFinite(ts)) continue;
    const parts = shanghaiParts(ts);
    if (parts.ymd < fromYmd) continue;
    const title = translateFfTitle(row.title);
    const actual = String(row.actual || '').trim();
    const existing = events.find((item) => eventsRoughlyMatch(item, { date: parts.ymd, title }));
    if (existing) {
      if (row.forecast) existing.forecast = existing.forecast || row.forecast;
      if (row.previous) existing.previous = existing.previous || row.previous;
      if (actual) existing.actual = actual;
      if (!existing.time) existing.time = parts.hm;
      if (!existing.previousDate) existing.previousDate = inferPreviousDate(parts.ymd, title);
      existing.note = buildFfNote(row, title);
      if (/high/i.test(row.impact)) existing.severity = existing.severity === 'extreme' ? 'extreme' : 'high';
      continue;
    }
    events.push({
      id: `ff-${parts.ymd}-${slugify(title)}`,
      date: parts.ymd,
      time: parts.hm,
      title,
      note: buildFfNote(row, title),
      forecast: row.forecast || '',
      previous: row.previous || '',
      actual,
      previousDate: inferPreviousDate(parts.ymd, title),
      severity: /high/i.test(row.impact) ? 'high' : 'mid',
      source: 'ForexFactory',
      sortKey: `${parts.ymd} ${parts.hm}`,
    });
  }
  return events.sort((a, b) => String(a.sortKey).localeCompare(String(b.sortKey)));
}

module.exports = {
  fetchFfRows,
  normalizeFfRows,
  mergeCalendarEvents,
  mergeFfMacroEvents,
  translateFfTitle,
  inferPreviousDate,
  eventSeverity,
  shanghaiParts,
  shiftYmd,
};
