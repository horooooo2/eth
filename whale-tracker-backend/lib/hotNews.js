'use strict';
const axios = require('axios');
const { createHash } = require('node:crypto');
const MINUTE = 60000, MAX_AGE = 48 * 3600000;
function plain(value, max = 2400) {
  return String(value || '').slice(0, max).replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ').replace(/&amp;/gi, '&').replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'").replace(/\s+/g, ' ').trim();
}
function timestamp(value) {
  if (typeof value === 'number' || /^\d{10,13}$/.test(String(value || ''))) {
    const n = Number(value); return n < 1e12 ? n * 1000 : n;
  }
  const raw = String(value || '').trim();
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(raw)) return Date.parse(raw.replace(' ', 'T') + '+08:00');
  return /(?:Z|[+-]\d{2}:?\d{2})$/.test(raw) ? Date.parse(raw) : NaN;
}
function articleUrl(raw) {
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && !u.username && !u.password && (!u.port || u.port === '443')
      && ['eastmoney.com', 'sina.com.cn', 'sina.cn'].some(host => u.hostname === host || u.hostname.endsWith('.' + host)) ? u.href : '';
  } catch { return ''; }
}
function category(text) {
  if (/美联储|央行|加息|降息|利率|通胀|CPI|PPI|PCE|非农|就业|美债|财政|赤字|FOMC|GDP/i.test(text)) return '宏观';
  if (/比特币|以太坊|加密|稳定币|币安|BTC|ETH|区块链|数字资产/i.test(text)) return '加密';
  if (/半导体|芯片|存储|闪迪|台积电|英伟达|人工智能|AI|科技|苹果|微软/i.test(text)) return '科技';
  if (/原油|黄金|白银|外汇|美元|美股|纳指|标普|关税|战争|停火|伊朗|以色列|俄罗斯|乌克兰/i.test(text)) return '全球市场';
  return '财经';
}
function normalize(rows, provider, now = Date.now()) {
  const items = [], seen = new Set();
  for (const raw of rows.slice(0, 120)) {
    const content = plain(provider === 'eastmoney' ? raw.summary : raw.rich_text);
    const title = plain(raw.title || content.match(/^【([^】]+)】/)?.[1] || content, 180);
    const publishedAt = timestamp(provider === 'eastmoney' ? raw.showTime : raw.create_time);
    if (!title || !Number.isFinite(publishedAt) || publishedAt > now + MINUTE || now - publishedAt > MAX_AGE) continue;
    const key = title.normalize('NFKC').replace(/[\s【】\[\]，。,:：;；.!！?？]/g, '').toLowerCase();
    if (seen.has(key)) continue; seen.add(key);
    const tag = category(title);
    const sourceImportant = provider === 'eastmoney' ? Number(raw.titleColor) > 0 : Number(raw.is_focus) > 0 || Number(raw.top_value) > 0;
    const priority = (sourceImportant ? 3 : 0) + (tag === '宏观' || tag === '加密' ? 3 : tag === '全球市场' || tag === '科技' ? 2 : 0);
    const url = provider === 'eastmoney'
      ? articleUrl(/^\d{12,30}$/.test(String(raw.code)) ? 'https://finance.eastmoney.com/a/' + raw.code + '.html' : '')
      : articleUrl(raw.docurl);
    items.push({ id: createHash('sha256').update(key).digest('hex').slice(0, 20), title, summary: content,
      publishedAt, source: provider === 'eastmoney' ? '东方财富快讯' : '新浪财经7×24', url, category: tag,
      important: sourceImportant, priority });
  }
  return items.sort((a, b) => {
    const score = item => item.priority * 10 - Math.max(0, now - item.publishedAt) / 3600000 * 2;
    return score(b) - score(a) || b.publishedAt - a.publishedAt;
  }).slice(0, 60);
}
async function readFeed(provider) {
  const em = provider === 'eastmoney';
  const response = await axios.get(em ? 'https://np-weblist.eastmoney.com/comm/web/getFastNewsList' : 'https://zhibo.sina.com.cn/api/zhibo/feed', {
    params: em ? { client: 'web', biz: 'web_724', fastColumn: '102', sortEnd: '', pageSize: '100', req_trace: String(Date.now()) }
      : { page: '1', page_size: '100', zhibo_id: '152', tag_id: '0', dire: 'f', dpc: '1', pagesize: '100', type: '1' },
    timeout: 4000, proxy: false, maxRedirects: 0, maxContentLength: 1024 * 1024, responseType: 'json',
    headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
  });
  const rows = em ? response.data?.data?.fastNewsList : response.data?.result?.data?.feed?.list;
  if (!Array.isArray(rows) || !rows.length) throw Error('Empty feed');
  return rows;
}
function createHotNewsService({ fetchers = { eastmoney: () => readFeed('eastmoney'), sina: () => readFeed('sina') }, now = Date.now } = {}) {
  let value = null, pending = null, nextAttemptAt = 0, failed = 0, lastError = '', attemptedAt = null;
  const snapshot = () => ({ items: value?.items || [], provider: value?.provider || null, updatedAt: value?.updatedAt || null,
    fetchedAt: now(), stale: !value || Boolean(lastError) || now() - value.updatedAt >= MINUTE,
    warning: lastError, nextAttemptAt, attemptedAt, ranking: '重要性与时效规则筛选，非阅读量排行' });
  function refresh() {
    if (pending) return pending;
    // Register before calling a source so simultaneous readers share one job.
    pending = Promise.resolve().then(async () => {
      attemptedAt = now();
      for (const [provider, fetcher] of Object.entries(fetchers)) {
        try {
          const items = normalize(await fetcher(), provider, now());
          if (!items.length) throw Error('No recent news');
          value = { items, provider, updatedAt: now() }; failed = 0; lastError = ''; nextAttemptAt = now() + MINUTE;
          return;
        } catch { /* Try the fixed backup source; do not expose upstream bodies. */ }
      }
      failed++; nextAttemptAt = now() + Math.min(5 * MINUTE, MINUTE * 2 ** Math.min(failed - 1, 3));
      lastError = value ? '快讯源暂不可用，保留上次内容并标记数据时间。' : '快讯源暂不可用，稍后自动重试。';
    }).finally(() => { pending = null; });
    return pending;
  }
  async function get() {
    if (now() >= nextAttemptAt) {
      const task = refresh();
      if (!value) await task; // Only a cold read waits for bounded network I/O.
    }
    return snapshot();
  }
  return { get };
}
const service = createHotNewsService();
module.exports = { getHotNews: service.get, createHotNewsService, normalize, timestamp, articleUrl };
