const crypto = require('crypto');
const axios = require('axios');

const REQUEST_TIMEOUT_MS = 10000;
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const client = axios.create({
  timeout: REQUEST_TIMEOUT_MS,
  headers: {
    Accept: 'application/json, text/plain, */*',
    'User-Agent': BROWSER_UA,
  },
  validateStatus: (code) => code < 500,
});

function stripHtml(value) {
  return String(value || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function toTimestamp(value) {
  if (!value && value !== 0) return Date.now();
  if (typeof value === 'number') return value < 1e12 ? value * 1000 : value;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && String(value).trim() !== '') {
    if (numeric > 1e12) return numeric;
    if (numeric > 1e9) return numeric * 1000;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? Date.now() : parsed;
}

/** 从【标题】正文 或整段快讯里拆出短标题 */
function extractHeadline(text) {
  const raw = String(text || '').trim();
  const bracket = raw.match(/^【([^】]{2,80})】([\s\S]*)$/);
  if (bracket) {
    return { title: bracket[1].trim(), body: String(bracket[2] || '').trim() };
  }
  return { title: '', body: raw };
}

function cleanTitle(value) {
  return String(value || '')
    .replace(/\s*[|_]\s*(东方财富网|手机新浪网|新浪网|华尔街见闻|财联社)\s*$/g, '')
    .trim();
}

function splitFlash(title, body) {
  const rawTitle = stripHtml(title);
  const rawBody = stripHtml(body || rawTitle);
  const fromTitle = extractHeadline(rawTitle);
  const fromBody = extractHeadline(rawBody);

  let headline = rawTitle;
  if (!headline || headline === rawBody || headline.length > 72) {
    headline = fromTitle.title || fromBody.title || rawTitle;
  }
  if (headline.length > 72 && (fromTitle.title || fromBody.title)) {
    headline = fromTitle.title || fromBody.title;
  }

  let content = rawBody || fromTitle.body || rawTitle;
  if (!content) content = headline;
  if (!headline) headline = fromBody.title || content.slice(0, 40) || '无标题';
  headline = cleanTitle(headline);

  return { title: headline, summary: content };
}

function article({ id, title, source, url, publishedAt, summary }) {
  const split = splitFlash(title, summary);
  return {
    id: String(id || `${source}-${publishedAt}-${split.title.slice(0, 24)}`),
    title: split.title || '无标题',
    source,
    url: url || '',
    publishedAt: toTimestamp(publishedAt),
    summary: split.summary,
  };
}

function looksLikePdf(url) {
  return /\.pdf($|\?)/i.test(String(url || ''));
}

function clsDetailUrl(id) {
  return `https://www.cls.cn/detail/${id}`;
}

function pickUsableUrl(candidates, fallback) {
  for (const raw of candidates) {
    const url = String(raw || '').trim();
    if (!url || looksLikePdf(url) || /cninfo\.com\.cn/i.test(url)) continue;
    if (!isAllowedNewsUrl(url) || isThinUrl(url)) continue;
    return url;
  }
  return fallback || '';
}

async function safeFetch(name, fn) {
  try {
    const list = await fn();
    return Array.isArray(list) ? list.filter((item) => item && item.title) : [];
  } catch (err) {
    console.warn(`[news] ${name} 失败:`, err.message);
    return [];
  }
}

/** 财联社电报：公开 cache 接口，无需 sign */
async function fetchClsNews() {
  const { data, status } = await client.get('https://www.cls.cn/api/cache', {
    params: { app: 'CailianpressWeb', name: 'telegraph', os: 'web', sv: '8.7.9' },
    headers: { Referer: 'https://www.cls.cn/telegraph', origin: 'https://www.cls.cn' },
  });
  if (status !== 200) return [];
  const list = data?.data?.roll_data || [];
  return list.map((item) => {
    const body = item.content || item.brief || '';
    return article({
      id: `cls-${item.id}`,
      title: item.title || extractHeadline(body).title || body,
      source: '财联社',
      url: pickUsableUrl(
        [item.assocArticleUrl, item.shareurl],
        clsDetailUrl(item.id),
      ),
      publishedAt: item.ctime,
      summary: body || item.title,
    });
  });
}

/** 华尔街见闻全球快讯 */
async function fetchWallstcnNews() {
  const { data, status } = await client.get('https://api-one.wallstcn.com/apiv1/content/lives', {
    params: { channel: 'global-channel', limit: 50 },
    headers: { Referer: 'https://wallstreetcn.com/live', origin: 'https://wallstreetcn.com' },
  });
  if (status !== 200) return [];
  const list = data?.data?.items || [];
  return list.map((item) => {
    const text = item.content_text || stripHtml(item.content) || '';
    return article({
      id: `wscn-${item.id}`,
      title: item.title || item.highlight_title || extractHeadline(text).title || text,
      source: '华尔街见闻',
      url: item.uri || `https://wallstreetcn.com/livenews/${item.id}`,
      publishedAt: item.display_time,
      summary: text,
    });
  });
}

/** 新浪财经 7×24 */
async function fetchSinaNews() {
  const { data, status } = await client.get('https://zhibo.sina.com.cn/api/zhibo/feed', {
    params: { page: 1, page_size: 50, zhibo_id: 152, tag_id: 0, type: 0 },
    headers: { Referer: 'https://finance.sina.com.cn/7x24/' },
  });
  if (status !== 200) return [];
  const list = data?.result?.data?.feed?.list || [];
  return list.map((item) => {
    const text = item.rich_text || item.content || '';
    return article({
      id: `sina-${item.id}`,
      title: extractHeadline(text).title || text,
      source: '新浪财经',
      url: item.docurl || 'https://finance.sina.com.cn/7x24/',
      publishedAt: item.create_time || item.update_time,
      summary: text,
    });
  });
}

/** 东方财富栏目快讯，每次带动态 UUID */
async function fetchEastmoneyNews() {
  const { data, status } = await client.get(
    'https://np-listapi.eastmoney.com/comm/web/getNewsByColumns',
    {
      params: {
        client: 'web',
        biz: 'web_home_channel',
        column: '350,35,466,467',
        order: 1,
        page_index: 1,
        page_size: 50,
        req_trace: crypto.randomUUID(),
      },
      headers: { Referer: 'https://www.eastmoney.com/' },
    },
  );
  if (status !== 200) return [];
  const list = data?.data?.list || [];
  return list.map((item) =>
    article({
      id: `em-${item.code || item.uniqueUrl}`,
      title: item.title || item.summary,
      source: item.mediaName || '东方财富',
      url: item.url || item.uniqueUrl,
      publishedAt: item.showTime,
      summary: item.summary || item.title,
    }),
  );
}

/** 金十快讯：公开页实际会带 x-app-id；没有有效头时自动跳过 */
async function fetchJin10News() {
  const { data, status } = await client.get('https://flash-api.jin10.com/get_flash_list', {
    params: { channel: '-8200', vip: '1' },
    headers: {
      'x-app-id': 'bVBF4FyRTn5NJF5n',
      'x-version': '1.0.0',
      origin: 'https://www.jin10.com',
      referer: 'https://www.jin10.com/',
    },
  });
  if (status !== 200) return [];
  const list = Array.isArray(data?.data) ? data.data : [];
  return list
    .map((item) => {
      const payload = item.data || {};
      const content = payload.content || payload.vip_title || payload.title || '';
      if (!content || payload.pic) return null;
      return article({
        id: `jin10-${item.id}`,
        title: payload.title || extractHeadline(content).title || content,
        source: '金十数据',
        url: payload.link || payload.source_link || 'https://www.jin10.com/',
        publishedAt: item.time,
        summary: content,
      });
    })
    .filter(Boolean);
}

function mergeArticles(...groups) {
  const seen = new Set();
  const merged = [];
  for (const item of groups.flat()) {
    const key = (item.summary || item.title || '').slice(0, 80);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    merged.push(item);
  }
  merged.sort((a, b) => b.publishedAt - a.publishedAt);
  return merged.slice(0, 200);
}

async function fetchAllNews() {
  const [cls, wscn, sina, eastmoney, jin10] = await Promise.all([
    safeFetch('财联社', fetchClsNews),
    safeFetch('华尔街见闻', fetchWallstcnNews),
    safeFetch('新浪财经', fetchSinaNews),
    safeFetch('东方财富', fetchEastmoneyNews),
    safeFetch('金十数据', fetchJin10News),
  ]);

  return {
    articles: mergeArticles(cls, wscn, sina, eastmoney, jin10),
    sources: {
      cls: cls.length,
      wallstcn: wscn.length,
      sina: sina.length,
      eastmoney: eastmoney.length,
      jin10: jin10.length,
    },
  };
}

const ALLOWED_NEWS_HOSTS = [
  'cls.cn',
  'eastmoney.com',
  'dfcfw.com',
  'wallstreetcn.com',
  'awtmt.com',
  'sina.com.cn',
  'sina.cn',
  'jin10.com',
];

function isAllowedNewsUrl(raw) {
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    const host = parsed.hostname.toLowerCase();
    return ALLOWED_NEWS_HOSTS.some((domain) => host === domain || host.endsWith(`.${domain}`));
  } catch (_err) {
    return false;
  }
}

function isThinUrl(raw) {
  try {
    const parsed = new URL(raw);
    const path = parsed.pathname.replace(/\/+$/, '') || '/';
    if (['/', '/telegraph', '/live', '/7x24'].includes(path)) return true;
    if (path === '/livenews') return true;
    return false;
  } catch (_err) {
    return true;
  }
}

function hostnameOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch (_err) {
    return '';
  }
}

function decodeEntities(value) {
  return String(value || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

function htmlToText(html) {
  return decodeEntities(
    String(html || '')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n\n')
      .replace(/<\/div>/gi, '\n')
      .replace(/<\/h[1-6]>/gi, '\n\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function parseClsNextData(html) {
  const match = String(html).match(
    /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/,
  );
  if (!match) return null;
  try {
    const articleDetail = JSON.parse(match[1])?.props?.pageProps?.articleDetail;
    if (!articleDetail) return null;
    return {
      title: stripHtml(articleDetail.title),
      content: htmlToText(articleDetail.content || articleDetail.brief || ''),
    };
  } catch (_err) {
    return null;
  }
}

function sliceAfterMatch(html, startRe, endRe) {
  const startMatch = String(html).match(startRe);
  if (!startMatch) return '';
  const start = html.indexOf(startMatch[0]) + startMatch[0].length;
  let chunk = html.slice(start, start + 80000);
  if (endRe) {
    const cut = chunk.search(endRe);
    if (cut > 40) chunk = chunk.slice(0, cut);
  }
  return htmlToText(chunk);
}

function parseContentBody(html) {
  const startMatch = String(html).match(/id=["']ContentBody["'][^>]*>/i);
  if (!startMatch) return '';
  const start = html.indexOf(startMatch[0]) + startMatch[0].length;
  let chunk = html.slice(start, start + 50000);
  const cut = chunk.search(/郑重声明|责任编辑：|分享到微信|class="appendix/i);
  if (cut > 80) chunk = chunk.slice(0, cut);
  return htmlToText(chunk);
}

function parseSinaArticle(html) {
  const title =
    stripHtml((html.match(/<h1[^>]*class=["'][^"']*art_tit_h1[^"']*["'][^>]*>([\s\S]*?)<\/h1>/i) || [])[1]) ||
    parseMeta(html, 'og:title');
  const content =
    sliceAfterMatch(
      html,
      /class=["'][^"']*art_content[^"']*["'][^>]*>/i,
      /<!--\s*content end\s*-->|相关新闻|推荐阅读|id=["']j_relevent/i,
    ) || sliceAfterMatch(html, /<p class=["']art_p["']>/i, /<\/p>/i);
  if (!title && !content) return null;
  return { title, content };
}

function parseLdJsonArticle(html) {
  const blocks = String(html).match(/<script[^>]+type=["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>/gi) || [];
  for (const block of blocks) {
    try {
      const json = JSON.parse(block.replace(/<script[^>]*>|<\/script>/gi, ''));
      const nodes = Array.isArray(json) ? json : json['@graph'] || [json];
      const articleNode = nodes.find((node) => /NewsArticle/i.test(String(node?.['@type'] || '')));
      if (!articleNode) continue;
      const content = htmlToText(articleNode.articleBody || '');
      if (articleNode.headline || content) {
        return { title: stripHtml(articleNode.headline), content };
      }
    } catch (_err) {
      /* ignore malformed ld+json */
    }
  }
  return null;
}

function parseMeta(html, name) {
  const pattern = new RegExp(
    `<meta[^>]+(?:name|property)=["']${name}["'][^>]+content=["']([^"']+)["']`,
    'i',
  );
  const match = String(html).match(pattern);
  return match ? decodeEntities(match[1]) : '';
}

function isUsefulTitle(value) {
  const title = String(value || '').trim();
  if (title.length < 4) return false;
  return !['华尔街见闻', '财联社', '新浪财经', '东方财富网', '金十数据', '手机新浪网'].includes(title);
}

function parseArticleHtml(html, url) {
  const host = hostnameOf(url);

  if (host.includes('cls.cn')) {
    const next = parseClsNextData(html);
    if (next?.content) return next;
  }

  if (host.includes('sina.cn') || host.includes('sina.com.cn')) {
    const sina = parseSinaArticle(html);
    if (sina?.content) return sina;
  }

  const body = parseContentBody(html);
  if (body) {
    return {
      title: parseMeta(html, 'og:title') || stripHtml((html.match(/<title>([\s\S]*?)<\/title>/i) || [])[1]),
      content: body,
    };
  }

  const ld = parseLdJsonArticle(html);
  if (ld?.content) return ld;

  const description = parseMeta(html, 'description') || parseMeta(html, 'og:description');
  return {
    title: parseMeta(html, 'og:title'),
    content: description,
  };
}

function resolveScrapeUrl(id, url) {
  const raw = String(url || '').trim();
  if (/^cls-\d+$/i.test(String(id || ''))) {
    if (!raw || looksLikePdf(raw) || /cninfo\.com\.cn/i.test(raw) || isThinUrl(raw) || !isAllowedNewsUrl(raw)) {
      return clsDetailUrl(String(id).slice(4));
    }
  }
  if (/^wscn-\d+$/i.test(String(id || '')) && (!raw || isThinUrl(raw))) {
    return `https://wallstreetcn.com/livenews/${String(id).slice(5)}`;
  }
  return raw;
}

function liveNewsId(url) {
  const match = String(url || '').match(/livenews\/(\d+)/i);
  return match ? match[1] : '';
}

const detailCache = new Map();

async function scrapeWallstcnLive(url) {
  const id = liveNewsId(url);
  if (!id) return null;
  const { data, status } = await client.get(`https://api-one.wallstcn.com/apiv1/content/lives/${id}`, {
    headers: {
      Accept: 'application/json',
      Referer: 'https://wallstreetcn.com/live',
      origin: 'https://wallstreetcn.com',
    },
    timeout: 10000,
    transformResponse: [(body) => body],
  });
  if (status !== 200) return null;
  const json = typeof data === 'string' ? JSON.parse(data) : data;
  const item = json?.data || {};
  const content = htmlToText(item.content || '') || String(item.content_text || '').trim();
  const title = item.title || item.highlight_title || extractHeadline(content).title;
  if (!content) return null;
  return { title, content };
}

async function scrapeArticle(url) {
  if (!isAllowedNewsUrl(url) || isThinUrl(url) || looksLikePdf(url)) {
    return null;
  }
  const hit = detailCache.get(url);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.value;

  let parsed = null;
  const host = hostnameOf(url);
  if (host.includes('wallstreetcn.com') && liveNewsId(url)) {
    parsed = await scrapeWallstcnLive(url);
  } else {
    const { data, status } = await client.get(url, {
      headers: {
        Referer: url,
        Accept: 'text/html,application/xhtml+xml',
      },
      timeout: 10000,
      maxRedirects: 3,
      responseType: 'text',
      transformResponse: [(body) => body],
    });
    if (status === 200 && typeof data === 'string') {
      parsed = parseArticleHtml(data, url);
    }
  }

  if (!parsed?.content) return null;
  parsed.title = cleanTitle(parsed.title || '');
  if (parsed.title && !isUsefulTitle(parsed.title)) parsed.title = '';
  detailCache.set(url, { at: Date.now(), value: parsed });
  return parsed;
}

function stripTitlePrefix(title, content) {
  const headline = String(title || '').trim();
  let body = String(content || '').trim();
  if (!headline || !body) return body;
  if (body === headline) return body;
  const prefixes = [`【${headline}】`, headline];
  for (const prefix of prefixes) {
    if (body.startsWith(prefix)) {
      const rest = body.slice(prefix.length).replace(/^[：:\s]+/, '').trim();
      if (rest.length > 8) return rest;
    }
  }
  return body;
}

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, '').toLowerCase();
}

module.exports = {
  fetchAllNews,
  scrapeArticle,
  isAllowedNewsUrl,
  isThinUrl,
  resolveScrapeUrl,
  splitFlash,
  stripTitlePrefix,
  normalizeText,
};
