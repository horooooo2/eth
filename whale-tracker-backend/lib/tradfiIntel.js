const axios = require('axios');
const { getCatalog } = require('./tradfiMarkets');
const { getCalendar } = require('./calendar');

const http = axios.create({ timeout: 14000, proxy: false, headers: { 'User-Agent': 'WhaleTracker/1.0 (personal market dashboard)' } });
const cache = new Map();
const NEWS_TTL = 5 * 60 * 1000;
const FUND_TTL = 6 * 60 * 60 * 1000;
const EVENT_TTL = 20 * 60 * 1000;
const SEC_CIK = { TSLA: '0001318605', INTC: '0000050863' };
const ETF_URL = { EWY: 'https://www.ishares.com/us/products/239681/ishares-msci-south-korea-etf' };
const TREASURY_BASE = 'https://home.treasury.gov/resource-center/data-chart-center/interest-rates';

async function cached(key, ttl, loader) {
  const old = cache.get(key);
  if (old?.expiresAt > Date.now()) return old.value;
  try {
    const value = await loader();
    cache.set(key, { value, expiresAt: Date.now() + ttl });
    return value;
  } catch (err) {
    if (old) return { ...old.value, stale: true, error: err.message };
    throw err;
  }
}

function decodeXml(value) {
  return String(value || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#(\d+);/g, (_all, num) => String.fromCodePoint(Number(num)))
    .replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'")
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}
function xmlField(block, name) {
  return decodeXml((block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, 'i')) || [])[1] || '');
}
function newsQuery(market) {
  const base = market.baseAsset;
  if (base === 'XAU') return '黄金 金价 美联储';
  if (base === 'XAG') return '白银 银价 工业需求';
  if (base === 'TSLA') return 'Tesla 特斯拉 财报 交付';
  if (base === 'EWY') return '韩国 股票 ETF 半导体';
  const name = market.name && market.name !== base ? market.name : base;
  return market.category === 'COMMODITY' ? `${name} ${base} 商品价格` : `${name} ${base} 股票 财报`;
}
function newsCategory(title, market) {
  if (/美联储|Fed|通胀|CPI|PCE|利率|非农|央行|汇率|GDP/i.test(title)) return '宏观';
  if (market.category === 'EQUITY' && /财报|业绩|营收|利润|交付|公司|股东|earnings|revenue|filing/i.test(title)) return '公司';
  return '行业';
}
function rssRows(xml, market) {
  const out = [];
  const seen = new Set();
  for (const match of xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)) {
    const block = match[1];
    const title = xmlField(block, 'title').trim();
    const link = xmlField(block, 'link').trim();
    const date = new Date(xmlField(block, 'pubDate'));
    if (!title || !/^https:\/\/(?:news\.google\.com|www\.google\.com)\//i.test(link)) continue;
    if (!Number.isFinite(date.getTime()) || Date.now() - date.getTime() > 10 * 86400000) continue;
    const key = title.toLowerCase().replace(/\s+-\s+[^-]+$/, '');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      title: title.slice(0, 180),
      category: newsCategory(title, market),
      publishedAt: Number.isFinite(date.getTime()) ? date.toISOString() : null,
      source: xmlField(block, 'source') || 'Google 新闻收录',
      url: link,
      summary: '',
    });
    if (out.length >= 15) break;
  }
  return out;
}
async function getNews(market) {
  return cached(`news:${market.symbol}`, NEWS_TTL, async () => {
    const query = newsQuery(market);
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(`${query} when:7d`)}&hl=zh-CN&gl=CN&ceid=CN:zh-Hans`;
    const { data } = await http.get(url, { responseType: 'text', headers: { Accept: 'application/rss+xml,text/xml,*/*' } });
    if (typeof data !== 'string' || !data.includes('<rss')) throw new Error('新闻 RSS 响应格式异常');
    return { items: rssRows(data, market), source: 'Google 新闻 RSS', sourceUrl: url, query, updatedAt: new Date().toISOString(), stale: false };
  });
}

function latestUsdFact(facts, names, duration) {
  for (const name of names) {
    const units = facts?.['us-gaap']?.[name]?.units?.USD;
    if (!Array.isArray(units)) continue;
    const values = units.filter((item) => {
      if (!['10-Q', '10-K'].includes(item.form) || !Number.isFinite(item.val) || !item.end) return false;
      if (duration === 'instant') return !item.start;
      if (!item.start) return false;
      const days = (Date.parse(item.end) - Date.parse(item.start)) / 86400000;
      return duration === 'quarter' ? days >= 70 && days <= 110 : days >= 330 && days <= 380;
    }).sort((a, b) => b.end.localeCompare(a.end) || b.filed.localeCompare(a.filed));
    if (values[0]) return values[0];
  }
  return null;
}
function money(value) {
  const abs = Math.abs(value);
  if (abs >= 1e9) return `${(value / 1e9).toFixed(2)} 十亿美元`;
  if (abs >= 1e6) return `${(value / 1e6).toFixed(1)} 百万美元`;
  return `${value.toLocaleString('en-US')} 美元`;
}
async function getCompanyFundamentals(market) {
  const cik = SEC_CIK[market.baseAsset];
  if (!cik) return { rows: [], source: 'SEC EDGAR', sourceUrl: 'https://www.sec.gov/search-filings', asOf: null, note: '该股票尚未建立经过核对的 SEC 公司映射，暂无财报数值。', status: 'unavailable' };
  const url = `https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`;
  const { data } = await http.get(url, { headers: { Accept: 'application/json', 'User-Agent': process.env.SEC_USER_AGENT || 'WhaleTracker/1.0 (personal research dashboard)' }, maxContentLength: 12 * 1024 * 1024 });
  if (!data?.facts?.['us-gaap']) throw new Error('SEC 财报响应格式异常');
  const metrics = [
    ['最新季度营收', ['RevenueFromContractWithCustomerExcludingAssessedTax', 'Revenues', 'SalesRevenueNet'], 'quarter'],
    ['最新季度净利润', ['NetIncomeLoss'], 'quarter'],
    ['最新季度毛利', ['GrossProfit'], 'quarter'],
    ['总资产', ['Assets'], 'instant'],
  ];
  const rows = metrics.map(([label, names, duration]) => {
    const fact = latestUsdFact(data.facts, names, duration);
    return fact && { label, value: money(fact.val), asOf: fact.end, sourceUrl: url };
  }).filter(Boolean);
  return { rows, source: 'SEC EDGAR · 公司申报', sourceUrl: url, asOf: rows[0]?.asOf || null, note: '财务数据取自公司申报，按报告期显示；不等同于当前股价或分析师预测。', status: rows.length ? 'ok' : 'unavailable' };
}

function parseTreasuryCsv(csv) {
  const lines = String(csv).trim().split(/\r?\n/);
  const headers = lines[0]?.split(',').map((s) => s.replace(/"/g, '').trim().toUpperCase()) || [];
  const index = headers.indexOf('10 YR');
  if (index < 0) throw new Error('财政部 CSV 缺少 10 年期字段');
  for (const line of lines.slice(1)) {
    const cells = line.split(',');
    const value = Number(cells[index]);
    if (Number.isFinite(value) && value > -10 && value < 30) return { date: cells[0], value };
  }
  throw new Error('财政部 CSV 无可用数据');
}
async function treasuryRate(type) {
  const year = new Date().getUTCFullYear();
  const url = `${TREASURY_BASE}/daily-treasury-rates.csv/${year}/all?type=${type}&field_tdr_date_value=${year}&page&_format=csv`;
  const { data } = await http.get(url, { responseType: 'text', headers: { Accept: 'text/csv,*/*' } });
  return { ...parseTreasuryCsv(data), url };
}
async function getMetalFundamentals() {
  const [real, nominal] = await Promise.all([
    treasuryRate('daily_treasury_real_yield_curve'),
    treasuryRate('daily_treasury_yield_curve'),
  ]);
  const rows = [
    { label: '美国 10 年期实际收益率', value: `${real.value.toFixed(2)}%`, asOf: real.date, sourceUrl: real.url },
    { label: '美国 10 年期名义收益率', value: `${nominal.value.toFixed(2)}%`, asOf: nominal.date, sourceUrl: nominal.url },
  ];
  if (real.date === nominal.date) rows.push({ label: '10 年期通胀补偿', value: `${(nominal.value - real.value).toFixed(2)}%`, asOf: real.date, sourceUrl: nominal.url });
  return { rows, source: '美国财政部', sourceUrl: real.url, asOf: real.date, note: '实际收益率与通胀补偿是贵金属的宏观观察指标，不能单独代表金银供需。', status: 'ok' };
}

function htmlUnescape(text) { return String(text).replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#39;/g, "'"); }
function issuerValue(html, name) {
  const plain = htmlUnescape(html);
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`"name":"${escaped}","value":"([^\"]+)"(?:,"unitText":"[^\"]+")?(?:,"valueReference":\\{[^}]*"value":"([^\"]+)")?`);
  const match = plain.match(pattern);
  return match ? { value: match[1], asOf: match[2] || null } : null;
}
async function getEtfFundamentals(market) {
  const url = ETF_URL[market.baseAsset];
  if (!url) return { rows: [], source: '基金发行方', sourceUrl: null, asOf: null, note: '该 ETF 尚未建立经过核对的发行方数据映射。', status: 'unavailable' };
  const { data } = await http.get(url, { responseType: 'text', maxContentLength: 3 * 1024 * 1024 });
  if (typeof data !== 'string') throw new Error('基金页面响应格式异常');
  const fields = [['基金净资产', 'Net Assets of Fund'], ['费用率', 'Expense Ratio:'], ['基准指数', 'Benchmark Index']];
  const rows = fields.map(([label, name]) => {
    const found = issuerValue(data, name);
    return found && { label, value: found.value + (name === 'Expense Ratio:' ? '%' : ''), asOf: found.asOf, sourceUrl: url };
  }).filter(Boolean);
  return { rows, source: 'iShares 基金发行方', sourceUrl: url, asOf: rows[0]?.asOf || null, note: '基金基本资料对应 ETF 本身，并非币安永续合约净值。', status: rows.length ? 'ok' : 'unavailable' };
}

async function getFundamentals(market) {
  return cached(`fund:${market.symbol}`, FUND_TTL, async () => {
    let result;
    if (['XAU', 'XAG', 'XPT', 'XPD'].includes(market.baseAsset)) result = await getMetalFundamentals();
    else if (ETF_URL[market.baseAsset] || ['EWY', 'EWJ'].includes(market.baseAsset)) result = await getEtfFundamentals(market);
    else if (market.category === 'EQUITY') result = await getCompanyFundamentals(market);
    else result = { rows: [], source: null, sourceUrl: null, asOf: null, note: '该商品的基础面数据源尚未接入。', status: 'unavailable' };
    return { ...result, updatedAt: new Date().toISOString(), stale: false };
  });
}

async function getEvents(market) {
  return cached(`events:${market.symbol}`, EVENT_TTL, async () => {
    const calendar = await getCalendar(false);
    const pattern = market.baseAsset === 'EWY' ? /韩国|韩央行|Korea/i : /美联储|FOMC|Fed|CPI|PCE|非农|利率|通胀|就业|GDP|ISM/i;
    const items = (calendar.events || []).filter((event) => event.daysUntil >= 0 && pattern.test(`${event.title} ${(event.tags || []).join(' ')}`))
      .slice(0, 6).map((event) => ({ title: event.title, date: event.date, time: event.time || null, forecast: event.forecast || null, previous: event.previous || null, actual: event.actual || null, source: event.source || '经济日历' }));
    return { items, source: calendar.sources?.provider || '经济日历', stale: Boolean(calendar.stale), updatedAt: new Date().toISOString() };
  });
}

async function getIntel(symbol) {
  const catalog = await getCatalog();
  const market = catalog.symbols.find((row) => row.symbol === String(symbol || '').toUpperCase());
  if (!market) { const error = new Error('该交易对不是当前可交易的 TradFi 合约'); error.status = 404; throw error; }
  const entries = await Promise.allSettled([getNews(market), getFundamentals(market), getEvents(market)]);
  const [news, fundamentals, events] = entries.map((entry, index) => entry.status === 'fulfilled' ? entry.value : ({
    ...(index === 1 ? { rows: [], status: 'unavailable', note: '基础面数据源暂不可用。' } : { items: [] }),
    source: null, updatedAt: null, stale: true, error: entry.reason?.message || '数据源暂不可用',
  }));
  return { symbol: market.symbol, news, fundamentals, events };
}

module.exports = { getIntel, rssRows, latestUsdFact, parseTreasuryCsv, issuerValue };
