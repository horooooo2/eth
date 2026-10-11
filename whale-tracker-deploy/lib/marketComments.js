const axios = require('axios');
const TTL = 600000;
const markets = { HK1810: 'hk01810', XIAOMI: 'hk01810', KUAISHOU: 'hk01024', HK1024: 'hk01024', TENCENT: 'hk00700', HK0700: 'hk00700', MEITUAN: 'hk03690', HK0992: 'hk00992', BYD: 'hk01211', POPMART: 'hk09992', ZHONGJI: '300308' };
// Exact US tickers only; never substitute a leveraged fund with its underlying stock.
for (const ticker of 'WDC NVDA MU MUU AAPL TSLA MSFT AMZN GOOG GOOGL META AMD INTC SNDK PLTR COIN BABA PDD TSM QQQ SPY SMH BITO XLE XOM GDX IWM TQQQ SQQQ SOXL SOXS'.split(' ')) markets[ticker] = `us${ticker.toLowerCase()}`;
function boardFor(symbol) { return markets[String(symbol).replace(/USDT$/, '')] || null; }
function readData(html) {
  const match = /\bvar\s+article_list\s*=\s*/.exec(html);
  if (!match) throw new Error('讨论来源页面暂不可读取');
  const start = match.index + match[0].length;
  let depth = 0, quoted = false, escape = false;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (quoted) { if (escape) escape = false; else if (c === '\\') escape = true; else if (c === '"') quoted = false; }
    else if (c === '"') quoted = true;
    else if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') { if (--depth === 0) return JSON.parse(html.slice(start, i + 1)); }
  }
  throw new Error('讨论来源响应不完整');
}
const plain = value => String(value || '').replace(/<[^>]*>/g, '').trim();
function parseComments(html, board) {
  const data = readData(html);
  if (!Array.isArray(data.re)) throw new Error('讨论来源结构已变化');
  if (data.bar_code && data.bar_code !== board) throw new Error('讨论标的与来源不匹配');
  const seen = new Set();
  return data.re.filter(p => {
    const code = p.stockbar_code || p.post_guba?.stockbar_code || p.post_guba?.stockbar_external_code;
    return code === board && Number(p.post_type) === 0 && /^\d+$/.test(String(p.post_id)) && plain(p.post_title);
  }).filter(p => { const id = String(p.post_id); if (seen.has(id)) return false; seen.add(id); return true; }).map(p => {
    const rawTime = String(p.post_publish_time || '');
    const timestamp = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(rawTime) ? Date.parse(rawTime.replace(' ', 'T') + '+08:00') : NaN;
    return { id: String(p.post_id), title: plain(p.post_title).slice(0, 300), summary: plain(p.post_content || p.post_abstract).slice(0, 500), source: '东方财富股吧', author: plain(p.user_nickname || p.post_user?.user_nickname).slice(0, 80) || '用户', publishedAt: Number.isFinite(timestamp) ? timestamp : null, url: `https://guba.eastmoney.com/news,${board},${p.post_id}.html` };
  }).sort((a, b) => (b.publishedAt || 0) - (a.publishedAt || 0)).slice(0, 50);
}
async function fetchBoard(board) {
  const response = await axios.get(`https://guba.eastmoney.com/list,${board}.html`, { timeout: 10000, maxContentLength: 2 * 1024 * 1024, maxRedirects: 0, proxy: false, responseType: 'text', headers: { 'User-Agent': 'WhaleTracker/1.0 (public market discussions)' } });
  return parseComments(response.data, board);
}
function createCommentService({ fetcher = fetchBoard, now = Date.now } = {}) {
  const cache = new Map(), queue = [], pending = new Set(); let running = 0;
  function drain() {
    while (running < 2 && queue.length) {
      const board = queue.shift(); running++;
      Promise.resolve().then(() => fetcher(board)).then(items => {
        cache.set(board, { items, updatedAt: now(), retryAt: now() + TTL, error: '' });
      }).catch(() => {
        const old = cache.get(board);
        cache.set(board, { items: old?.items || [], updatedAt: old?.updatedAt || null, retryAt: now() + 60000, error: '讨论来源暂不可用，请稍后重试' });
      }).finally(() => { pending.delete(board); running--; drain(); });
    }
  }
  function get(symbol) {
    const board = boardFor(symbol);
    if (!board) return { items: [], supported: false, pending: false, updatedAt: null, error: '该标的暂无已确认的中文讨论源' };
    const old = cache.get(board);
    if ((!old || old.retryAt <= now()) && !pending.has(board) && pending.size < 64) { pending.add(board); queue.push(board); drain(); }
    return { items: old?.items || [], supported: true, pending: pending.has(board), updatedAt: old?.updatedAt || null, stale: !!old && (!!old.error || now() - old.updatedAt >= TTL), error: old?.error || '', sourceUrl: `https://guba.eastmoney.com/list,${board}.html` };
  }
  return { get };
}
const service = createCommentService();
module.exports = { getComments: service.get, createCommentService, parseComments, boardFor };
