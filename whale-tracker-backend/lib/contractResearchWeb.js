'use strict';
const axios = require('axios');
const https = require('node:https');
const dns = require('node:dns').promises;
const { createHash } = require('node:crypto');
const { BoundedCache } = require('./boundedCache');
const { searchNewsWeb } = require('./newsWebSearch');

// Only read public research publishers. Never fetch arbitrary model-supplied URLs.
const PUBLISHERS = ['sec.gov', 'sandisk.com', 'westerndigital.com', 'samsung.com', 'samsungsem.com', 'skhynix.com',
  'tsmc.com', 'direxion.com', 'ishares.com', 'federalreserve.gov', 'bls.gov', 'bea.gov', 'treasury.gov',
  'fred.stlouisfed.org', 'krx.co.kr', 'trendforce.com', 's3partners.com', 'finra.org', 'reuters.com',
  'cnbc.com', 'marketwatch.com', 'finance.yahoo.com', 'morningstar.com', 'nasdaq.com', 'investing.com',
  'bloomberg.com', 'stockanalysis.com', 'holdingschannel.com', 'benzinga.com', 'barchart.com', 'tipranks.com', 'marketbeat.com', 'fool.com', 'metricduck.com', 'wsj.com', 'ft.com',
  'blackrock.com', 'vanguard.com', 'fidelity.com', 'statestreet.com', 'jpmorgan.com',
  'morganstanley.com', 'citigroup.com', 'citi.com', 'ubs.com', 'bernstein.com', 'mizuho-fg.com'];
const pages = new BoundedCache(96, 3600000), searches = new BoundedCache(48, 3600000), pending = new Map();
const addressesCache = new BoundedCache(128, 300000);
let macroValue = null, macroPending = null;
const normalizeText = value => String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
function allowedUrl(raw) {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')
      || !PUBLISHERS.some(host => url.hostname === host || url.hostname.endsWith('.' + host))) return null;
    url.hash = ''; return url.href;
  } catch { return null; }
}
function publicIpv4(address) {
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(address)) return false;
  const [a, b, c, d] = address.split('.').map(Number);
  if ([a, b, c, d].some(n => n > 255)) return false;
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99)))
    || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
    || (a === 203 && b === 0 && c === 113));
}
async function publicLookup(hostname, _options, callback) {
  let timer;
  try {
    const cached = addressesCache.get(hostname);
    let addresses = cached?.expiresAt > Date.now() ? cached.rows : await Promise.race([
      dns.lookup(hostname, { family: 4, all: true }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(Error('DNS timeout')), 1500); }),
    ]);
    if (!addresses.length || addresses.some(row => !publicIpv4(row.address))) {
      // Some developer VPNs use synthetic/private DNS answers. Resolve the same
      // fixed publisher over authenticated HTTPS instead of permitting private IPs.
      const response = await axios.get('https://cloudflare-dns.com/dns-query', {
        params: { name: hostname, type: 'A' }, headers: { Accept: 'application/dns-json' },
        timeout: 1500, proxy: false, maxRedirects: 0, maxContentLength: 16384,
      });
      addresses = (response.data?.Answer || []).filter(row => row.type === 1).map(row => ({ address: row.data, family: 4 }));
    }
    if (!addresses.length || addresses.some(row => !publicIpv4(row.address))) throw Error('Non-public address');
    addressesCache.set(hostname, { rows: addresses, expiresAt: Date.now() + 300000 });
    // Pin the checked address, including when Node requests an array of addresses.
    callback(null, _options?.all ? [{ address: addresses[0].address, family: 4 }] : addresses[0].address, 4);
  } catch (error) { callback(error); } finally { clearTimeout(timer); }
}
function decode(text) {
  return text.replace(/&#(x[\da-f]+|\d+);/gi, (whole, code) => {
    const n = code[0].toLowerCase() === 'x' ? parseInt(code.slice(1), 16) : Number(code);
    return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : whole;
  }).replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ');
}
function documentText(html) {
  const date = html.match(/(?:datePublished|article:published_time|dateModified)["']?\s*[:=]\s*["']([^"']+)/i)
    || html.match(/<meta[^>]+(?:name|property)=["'](?:article:published_time|date|pubdate)["'][^>]+content=["']([^"']+)/i);
  const asOf = date && Number.isFinite(Date.parse(date[1])) ? new Date(date[1]).toISOString() : null;
  // Linear bounded extraction avoids expensive repeated regex scans of malformed HTML.
  const lower = html.toLowerCase(), parts = []; let cursor = 0, length = 0;
  while (cursor < html.length && length < 36000) {
    const open = html.indexOf('<', cursor);
    const text = html.slice(cursor, open < 0 ? html.length : open).slice(0, 36000 - length);
    parts.push(text); length += text.length;
    if (open < 0) break;
    if (html.startsWith('<!--', open)) { const end = html.indexOf('-->', open + 4); cursor = end < 0 ? html.length : end + 3; continue; }
    const close = html.indexOf('>', open + 1); if (close < 0) break;
    const tag = lower.slice(open + 1, Math.min(close, open + 100)).match(/^\s*(script|style|nav|footer|header)\b/);
    if (tag) {
      const end = lower.indexOf('</' + tag[1], close + 1);
      const endTag = end < 0 ? -1 : html.indexOf('>', end + 2);
      cursor = endTag < 0 ? html.length : endTag + 1;
    } else cursor = close + 1;
    parts.push(/^\s*\/?(?:tr|p|li|h[1-6])\b/.test(lower.slice(open + 1, close)) ? '\n' : ' ');
  }
  return { text: decode(parts.join(' ')).normalize('NFKC').replace(/[\t ]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim().slice(0, 12000), asOf };
}
async function readPage(raw, { get = axios.get, now = Date.now() } = {}) {
  const url = allowedUrl(raw);
  if (!url) return { verification: 'unread', text: '', asOf: null, note: '来源未在公开研究站点范围内，仅保留链接供核对。' };
  const cached = pages.get(url);
  if (cached && now - cached.readAt < 3600000) return cached;
  const agent = new https.Agent({ lookup: publicLookup, keepAlive: false });
  try {
    const response = await get(url, { timeout: 3500, httpsAgent: agent, proxy: false, maxRedirects: 0,
      maxContentLength: 512 * 1024, responseType: 'text', headers: { 'User-Agent': 'WhaleTracker/1.0 public research reader', Accept: 'text/html,text/plain' } });
    if (!/text\/html|text\/plain/i.test(response.headers?.['content-type'] || '')) throw Error('Unsupported content');
    const result = documentText(String(response.data));
    if (result.text.length < 100 || /^(Access Denied|Just a moment|Sign in to continue)/i.test(result.text)) throw Error('Unavailable body');
    const value = { ...result, verification: 'read', readAt: now, expiresAt: now + 3600000, note: '已读取页面；具体事实仍需匹配原文摘录，读取时间不是资料日期。' };
    pages.set(url, value); return value;
  } catch { return { verification: 'unread', text: '', asOf: null, note: '正文读取失败、需登录或格式不支持；搜索摘要不作为已核对数字。' }; }
  finally { agent.destroy(); }
}
async function getMacroContext() {
  if (macroValue && Date.now() - macroValue.fetchedAt < 30 * 60000) return macroValue;
  if (macroPending) return macroPending;
  macroPending = (async () => {
    const since = new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10);
    const rows = await Promise.all([['DGS10', '10年美债', '%'], ['DEXKOUS', '美元／韩元', 'KRW']].map(async ([id, label, unit]) => {
      const agent = new https.Agent({ lookup: publicLookup, keepAlive: false });
      const sourceUrl = `https://fred.stlouisfed.org/series/${id}`;
      try {
        const response = await axios.get(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}&cosd=${since}`, {
          timeout: 3500, httpsAgent: agent, proxy: false, maxRedirects: 0, maxContentLength: 65536, responseType: 'text' });
        const lines = String(response.data).trim().split(/\r?\n/).slice(1).map(line => line.split(','));
        const row = lines.reverse().find(([date, value]) => /^\d{4}-\d{2}-\d{2}$/.test(date) && value?.trim() && Number.isFinite(Number(value)));
        if (!row) throw Error('Missing observation');
        return { id, label, unit, value: Number(row[1]), asOf: row[0], sourceUrl, frequency: '日频', stale: Date.now() - Date.parse(row[0]) > 7 * 86400000 };
      } catch {
        const old = macroValue?.rows.find(r => r.id === id);
        return old ? { ...old, stale: true } : { id, label, unit, value: null, asOf: null, sourceUrl, frequency: '日频', stale: true };
      } finally { agent.destroy(); }
    }));
    macroValue = { fetchedAt: Date.now(), rows }; return macroValue;
  })().finally(() => { macroPending = null; });
  return macroPending;
}
async function collectResearch({ apiKey, userId, snapshot, fetchImpl }, deps = {}) {
  // Search accounts/keys stay isolated. Public article bodies alone share a bounded cache.
  const key = createHash('sha256').update(`${userId}:${apiKey}:${snapshot.symbol}:${snapshot.version}`).digest('hex');
  const old = searches.get(key);
  if (old && Date.now() - old.at < 30 * 60000) return { ...old, cached: true };
  if (pending.has(key)) return pending.get(key);
  const task = (async () => {
    const base = snapshot.market.baseAsset || snapshot.symbol.replace(/USDT$/, '');
    const identity = `${snapshot.market.name} ${base}，${snapshot.market.classification?.stockMarket || '按实际底层上市地'}，截至${new Date(snapshot.generatedAt).toISOString()}，新闻/评级重点回看最近30天（自${new Date(snapshot.generatedAt - 30 * 86400000).toISOString().slice(0,10)}起），分析未来${snapshot.horizon}天。最新13F持仓及财务报告可早于30天，但必须标明报告期，仅作背景`;
    const results = [], warnings = [];
    const plans = [
      `${identity}。本次只查买方持仓，查询 ${base} institutional holders latest 13F BlackRock Vanguard Fidelity State Street，找前几家机构的持股数量、报告期、增减仓。优先SEC或公开持仓表。禁止返回利润表、现金流量表、同代码的加拿大上市地、2016年前旧实体。没有主动配置论述就仅列持仓，不推导看多。给来源链接、对应摘录和日期。`,
      `${identity}。查 ${base} analyst price target rating latest Citi Mizuho Bernstein，找卖方评级/目标价及核心理由，并核对与该标的相关的近期供需变化、财报或政策风险。不要重复财务表格。分别标出机构原话、公开转述、分析推断，给来源URL与日期。`,
    ];
    // Sequential searches honor the existing per-account search limit, with a fixed job budget.
    for (const message of plans) {
      try {
        const result = await (deps.search || searchNewsWeb)({ apiKey, userId, coin: base, fetchImpl, message, research: true, timeoutMs: 18000 });
        results.push(result);
        if (result.partial) warnings.push('检索续接未完成，已保留搜索工具实际返回的来源。');
      }
      catch { results.push(null); warnings.push('部分定向检索未完成，继续使用已取得的公开资料。'); }
    }
    const equity = snapshot.market.category === 'EQUITY' && snapshot.market.classification?.stockMarket === 'US';
    const seeds = equity && /^[A-Z]{1,8}$/.test(base) ? [
      { title: `${base} · 机构评级与目标价`, url: `https://stockanalysis.com/stocks/${base.toLowerCase()}/forecast/` },
      { title: `${base} · 公开13F机构持仓`, url: `https://www.holdingschannel.com/institutional/holders-of-${base.toLowerCase()}/` },
    ] : [];
    const calendarSource = (snapshot.sources || []).find(s => s.kind === 'reference' && /events|事件日历/i.test(s.title + ' ' + s.url));
    if (calendarSource) seeds.push({ title: calendarSource.title, url: calendarSource.url });
    // Alternate plans so the first search cannot consume every reading slot.
    const candidates = [...seeds];
    for (let i = 0; i < 5; i++) for (const result of results) {
      if (result?.sources?.[i]) candidates.push(result.sources[i]);
    }
    const seen = new Set(), sources = [];
    for (const row of candidates) {
      let url; try { url = new URL(row.url); url.hash = ''; } catch { continue; }
      if (equity && (/\/(?:quote|stock-market|exchanges)\/(tsx|tsxv|cse|otc|fra)\//i.test(url.pathname)
        || /Canadian Depositary|加拿大存托/i.test(row.title || ''))) continue;
      if (seen.has(url.href) || sources.length >= 8) continue; seen.add(url.href);
      sources.push({ id: `web-${sources.length + 1}`, title: row.title, url: url.href, kind: 'web',
        snippet: String(row.snippet || '').slice(0, 2200), publishedAt: row.publishedAt || null });
    }
    let next = 0;
    await Promise.all(Array.from({ length: 2 }, async () => {
      while (next < sources.length) {
        const row = sources[next++], read = await (deps.read || readPage)(row.url);
        Object.assign(row, read);
        if (row.verification !== 'read' && row.snippet) Object.assign(row, { verification: 'indexed', text: row.snippet, asOf: row.publishedAt, note: '来自搜索工具对应链接的摘录，尚未取得网页原文。' });
      }
    }));
    let remaining = 70000;
    for (const row of sources) {
      row.text = String(row.text || '').slice(0, row.url.includes('/forecast/') ? 10000 : 6500);
      if (Buffer.byteLength(row.text) > remaining) row.text = row.text.slice(0, Math.max(0, Math.floor(remaining / 3)));
      remaining -= Buffer.byteLength(row.text);
    }
    const value = { at: Date.now(), expiresAt: Date.now() + 30 * 60000, summary: results.map(r => r?.summary || '').join('\n').slice(0, 6000), sources, cached: false,
      diagnostics: { searchCount: results.filter(Boolean).length, readCount: sources.filter(s => s.verification === 'read').length, indexedCount: sources.filter(s => s.verification === 'indexed').length },
      warning: [...warnings, '机构字段分别匹配来源内容；搜索摘录与已读原文分开标记，不能把资料缺失当作中性结论。'].join(' ') };
    searches.set(key, value); return value;
  })().finally(() => pending.delete(key));
  pending.set(key, task); return task;
}
function quoteEvidence(item, sources) {
  const sourceId = item?.sourceId || item?.sourceIds?.[0];
  const source = sources.find(s => s.id === sourceId && ['read', 'indexed'].includes(s.verification) && s.text);
  const quote = normalizeText(item?.quote).slice(0, 650);
  return source && quote.length >= 16 && normalizeText(source.text).includes(quote) ? { source, quote } : null;
}
function dateOnly(value, now = Date.now(), future = false) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return null;
  const stamp = Date.parse(value + 'T00:00:00+08:00');
  if (!Number.isFinite(stamp) || new Date(stamp + 8 * 3600000).toISOString().slice(0, 10) !== value || (!future && stamp > now)) return null;
  return value;
}
function dateSupported(value, source, quote) {
  if (!dateOnly(value, Date.now(), true)) return false;
  if (source?.asOf?.slice(0, 10) === value) return true;
  const [year, month, day] = value.split('-').map(Number);
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const name = `(?:${months[month - 1]}|${months[month - 1].slice(0, 3)}\\.?)`, text = normalizeText(quote);
  return text.includes(value) || text.includes(`${year}年${month}月${day}日`)
    || new RegExp(`\\b0?${month}/0?${day}/${year}\\b`).test(text)
    || new RegExp(`\\b${name}\\s+0?${day}(?:st|nd|rd|th)?[,]?\\s+${year}\\b`, 'i').test(text)
    || new RegExp(`\\b0?${day}\\s+${name}[,]?\\s+${year}\\b`, 'i').test(text);
}
const FIRM_NAMES = { '花旗': 'Citi', '摩根士丹利': 'Morgan Stanley', '瑞银': 'UBS', '瑞穗': 'Mizuho', '贝莱德': 'BlackRock', '先锋领航': 'Vanguard', '富达': 'Fidelity', '道富': 'State Street', '摩根大通': 'JPMorgan', '伯恩斯坦': 'Bernstein' };
function institutionEvidence(item, sources) {
  const exact = quoteEvidence(item, sources);
  const names = [item.originalName || FIRM_NAMES[item.name] || item.name].filter(v => typeof v === 'string' && v.trim());
  const matches = text => names.some(name => normalizeText(text).toLowerCase().includes(normalizeText(name).toLowerCase()));
  if (exact && matches(exact.quote)) return exact;
  const id = item.sourceId || item.sourceIds?.[0];
  const source = sources.find(s => s.id === id && ['read', 'indexed'].includes(s.verification) && s.text);
  if (!source) return null;
  // Match each institution's own row/paragraph. Do not demand every field in a
  // single LLM-produced verbatim quote or borrow another bank's table values.
  const lines = source.text.split(/\n+/).filter(line => matches(line));
  const line = lines.find(line => [item.target, item.holding, item.rating].some(v => includesValue(line, v))) || lines[0];
  if (!line) return null;
  if (line.length <= 900) return { source, quote: line.trim() };
  const name = names.find(n => line.toLowerCase().includes(n.toLowerCase()));
  const at = line.toLowerCase().indexOf(name.toLowerCase());
  return { source, quote: line.slice(Math.max(0, at - 100), at + 650).trim() };
}
function originalRating(text, value) {
  if (includesValue(text, value)) return value.slice(0, 80);
  const aliases = { '买入': 'buy', '强烈买入': 'strong buy', '增持': 'overweight', '跑赢大盘': 'outperform', '持有': 'hold', '中性': 'neutral', '卖出': 'sell', '减持': 'underweight', '跑输大盘': 'underperform' };
  const word = aliases[value]; return word && new RegExp('\\b' + word + '\\b', 'i').test(text) ? value : null;
}
function forecastInstitutions(sources) {
  const rows = [], months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  for (const source of sources.filter(s => s.verification === 'read' && /stockanalysis\.com\/stocks\/[^/]+\/forecast\//.test(s.url || ''))) {
    for (const line of source.text.split('\n')) {
      const match = line.match(/^(.+?)\s+(Strong Buy|Buy|Hold|Sell|Strong Sell|Neutral|Overweight|Outperform)\s+(Maintains|Reiterates|Initiates|Upgrades|Downgrades|Reiterated|Maintained)\b.+?\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2}),?\s+(\d{4})$/i);
      if (!match) continue;
      const words = match[1].split(/\s+/); let firm = '';
      for (let n = 1; n <= Math.min(6, Math.floor(words.length / 2)); n++) {
        const tail = words.slice(-n).join(' ');
        if (tail === words.slice(-2*n, -n).join(' ')) firm = tail;
      }
      const targets = [...line.matchAll(/\$[\d,]+(?:\.\d+)?/g)];
      if (!firm || !targets.length) continue;
      const asOf = `${match[6]}-${String(months.findIndex(m => m.toLowerCase() === match[4].toLowerCase()) + 1).padStart(2,'0')}-${match[5].padStart(2,'0')}`;
      rows.push({ type: 'sellside', name: Object.keys(FIRM_NAMES).find(k => FIRM_NAMES[k].toLowerCase() === firm.toLowerCase()) || firm,
        originalName: firm, rating: match[2], target: targets.at(-1)[0], asOf, sourceId: source.id, quote: line,
        logic: `公开评级表记录 ${match[2]}、目标价 ${targets.at(-1)[0]}；表格未提供完整研报理由。目标价不能等同于当前分析周期收益，需结合基本面与近期事件判断。` });
    }
  }
  return rows;
}
function holderInstitutions(sources) {
  const rows = [];
  for (const source of sources.filter(s => s.verification === 'read' && /holdingschannel\.com\/institutional\/holders-of-[a-z]+\//i.test(s.url || ''))) {
    for (const line of source.text.split('\n')) {
      // Only complete institution rows: never combine stock/option subrows.
      const match = line.match(/^([A-Za-z][A-Za-z .,&'()-]+?)\s+([\d,]+)\s+\$[\d,]+\s+(\d{2})\/(\d{2})\/(\d{4})$/);
      if (!match || /^(?:COM|COMMON|COMM STK|SNDK|Call|Put|Equity)$/i.test(match[1])) continue;
      rows.push({ type: 'buyside', name: match[1], originalName: match[1], holding: match[2],
        asOf: `${match[5]}-${match[3]}-${match[4]}`, sourceId: source.id, quote: line,
        logic: '公开13F持仓表中的股数；这是报告期快照，不能据此判断实时增仓、主动看多或未来价格方向。' });
      if (rows.length >= 6) return rows;
    }
  }
  return rows;
}
function includesValue(quote, value) {
  const clean = x => normalizeText(x).replace(/[,，\s]/g, '').toLowerCase();
  if (typeof value !== 'string' || !value.trim() || !clean(quote).includes(clean(value))) return false;
  const numbers = text => (String(text).match(/[-+]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?/g) || []).map(n => Number(n.replace(/,/g, '')));
  const actual = numbers(quote);
  return numbers(value).every(n => actual.includes(n));
}
function originalEventTime(quote, date) {
  const exact = quote.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:\d{2})/);
  if (exact && exact[0].startsWith(date) && Number.isFinite(Date.parse(exact[0]))) return exact[0];
  const time = quote.match(/\b(\d{1,2})(?::(\d{2}))?\s*(AM|PM)\s*(EDT|EST|PDT|PST|UTC|GMT)\b/i);
  if (!time || Number(time[1]) < 1 || Number(time[1]) > 12 || Number(time[2] || 0) > 59) return null;
  const hour = Number(time[1]) % 12 + (time[3].toUpperCase() === 'PM' ? 12 : 0);
  const zone = { EDT: '-04:00', EST: '-05:00', PDT: '-07:00', PST: '-08:00', UTC: '+00:00', GMT: '+00:00' }[time[4].toUpperCase()];
  return `${date}T${String(hour).padStart(2, '0')}:${time[2] || '00'}:00${zone}`;
}
function extractFacts(parsed, research, now = Date.now()) {
  const sources = research?.sources || [], institutions = [], metrics = [], events = [], seen = new Set();
  const institutionRows = [...(Array.isArray(parsed.institutions) ? parsed.institutions : []), ...forecastInstitutions(sources), ...holderInstitutions(sources)];
  for (const item of institutionRows.slice(0, 40)) {
    if (!item || typeof item.name !== 'string') continue;
    const evidence = institutionEvidence(item, sources);
    const type = ({ buyside: 'buyside', 'buy-side': 'buyside', '买方': 'buyside', '资管': 'buyside', sellside: 'sellside', 'sell-side': 'sellside', '卖方': 'sellside', '投行': 'sellside' })[item.type];
    if (!evidence || !type) continue;
    if (type === 'sellside' && /^(S&P Global(?: Ratings| Market Intelligence)?|TipRanks|Stock ?Analysis|Yahoo Finance)$/i.test(item.originalName || item.name)) continue;
    const asOf = dateOnly(item.asOf, now) && dateSupported(item.asOf, evidence.source, evidence.quote) ? item.asOf : null;
    const age = asOf ? now - Date.parse(asOf + 'T00:00:00+08:00') : Infinity;
    const identity = `${type}:${normalizeText(item.originalName || FIRM_NAMES[item.name] || item.name).toLowerCase()}`;
    const row = { type, name: item.name.slice(0, 100), asOf, sourceIds: [evidence.source.id], quote: evidence.quote,
      verification: evidence.source.verification, logicKind: 'inferred',
      rating: originalRating(evidence.quote, item.rating),
      target: includesValue(evidence.quote, item.target) ? item.target.slice(0, 60) : null,
      holding: includesValue(evidence.quote, item.holding) ? item.holding.slice(0, 80) : null,
      change: includesValue(evidence.quote, item.change) ? item.change.slice(0, 80) : null,
      support: includesValue(evidence.quote, item.support) ? item.support.slice(0, 60) : null,
      logic: typeof item.logic === 'string' ? item.logic.slice(0, 500) : '', stale: age > (type === 'buyside' ? 200 : 120) * 86400000 };
    // Holdings alone cannot be converted into a rating, target, or allocation thesis.
    if (item.logicQuote && quoteEvidence({ sourceId: evidence.source.id, quote: item.logicQuote }, sources)) row.logicKind = 'reported';
    if (type === 'buyside' && item.explicitView !== true) {
      row.rating = null; row.target = null;
      row.logic = (row.logic ? row.logic + ' ' : '') + '仅据公开持仓解读，未取得明确的主动配置观点。';
    }
    if (![row.rating, row.target, row.holding, row.change].some(Boolean)) continue;
    const previous = institutions.findIndex(r => r.identity === identity);
    if (previous < 0) institutions.push({ ...row, identity });
    else if ((asOf || '') > (institutions[previous].asOf || '')) institutions[previous] = { ...row, identity };
  }
  for (const item of (Array.isArray(parsed.metrics) ? parsed.metrics : []).slice(0, 12)) {
    const evidence = quoteEvidence(item, sources), asOf = dateOnly(item.asOf, now);
    if (!evidence || !asOf || !dateSupported(asOf, evidence.source, evidence.quote) || !['targetConsensus', 'underlyingPrice', 'shortInterest', 'squeezeRisk'].includes(item.id)
      || !includesValue(evidence.quote, item.originalValue) || seen.has(item.id)) continue;
    const value = Number(String(item.originalValue).replace(/[$₩,%\s，,]/g, ''));
    if (!Number.isFinite(value) || value < 0 || (['shortInterest', 'squeezeRisk'].includes(item.id) && value > 100)) continue;
    if (item.id === 'targetConsensus' && !/consensus|average|mean|median|平均|一致|中位/i.test(evidence.quote)) continue;
    if (item.id === 'squeezeRisk' && !/s3partners\.com|s3 partners/i.test(`${evidence.source.url} ${evidence.quote}`)) continue;
    if (item.id === 'shortInterest' && !/short interest|空头仓位|做空比例|空头占/i.test(evidence.quote)) continue;
    if (['targetConsensus', 'underlyingPrice'].includes(item.id) && !['USD', 'KRW'].includes(item.currency)) continue;
    const stale = now - Date.parse(asOf + 'T00:00:00+08:00') > ({ targetConsensus: 30, underlyingPrice: 1, shortInterest: 35, squeezeRisk: 2 }[item.id]) * 86400000;
    metrics.push({ id: item.id, value, currency: item.currency || null, asOf, stale, sourceIds: [evidence.source.id], quote: evidence.quote }); seen.add(item.id);
  }
  for (const item of (Array.isArray(parsed.events) ? parsed.events : []).slice(0, 12)) {
    const evidence = quoteEvidence(item, sources), date = dateOnly(item.date, now, true);
    const ongoing = item.ongoing === true && !item.date;
    const officialCalendar = evidence && evidence.source.verification === 'read' && /\/events\b/i.test(evidence.source.url) && /sandisk\.com|westerndigital\.com|samsung\.com|skhynix\.com|tsmc\.com/i.test(new URL(evidence.source.url).hostname);
    const publicationKnown = evidence && dateOnly(item.publishedAt, now) && dateSupported(item.publishedAt, evidence.source, evidence.quote);
    if (!evidence || (!ongoing && (!date || !dateSupported(date, null, evidence.quote))) || (!publicationKnown && !officialCalendar) || (ongoing && !publicationKnown) || typeof item.title !== 'string') continue;
    const at = ongoing ? null : originalEventTime(evidence.quote, date);
    const stamp = at ? Date.parse(at) : Date.parse((ongoing ? item.publishedAt : date) + 'T00:00:00+08:00');
    if (stamp < now - 30 * 86400000 || stamp > now + 30 * 86400000) continue;
    const id = `web-event-${createHash('sha256').update(`${item.title}:${date || 'ongoing'}`).digest('hex').slice(0, 12)}`;
    if (seen.has(id)) continue; seen.add(id);
    events.push({ id, title: item.title.slice(0, 150), ...(date ? { date } : {}), ongoing, ...(at ? { at } : {}), source: evidence.source.title,
      sourceUrl: evidence.source.url, sourceIds: [evidence.source.id], publishedAt: publicationKnown ? item.publishedAt : null, verifiedAt: officialCalendar ? new Date(now).toISOString().slice(0,10) : null, quote: evidence.quote,
      relation: ['公司直接事件', '行业相关事件', '宏观间接影响'].includes(item.relation) ? item.relation : '相关性待核对',
      note: typeof item.note === 'string' ? item.note.slice(0, 500) : '', importance: ['high', 'medium', 'low'].includes(item.importance) ? item.importance : 'medium' });
  }
  return { institutions: institutions.map(({ identity, ...row }) => row), metrics, events };
}
module.exports = { allowedUrl, publicIpv4, publicLookup, documentText, readPage, collectResearch, getMacroContext, normalizeText, quoteEvidence, institutionEvidence, forecastInstitutions, dateOnly, dateSupported, originalEventTime, extractFacts };
