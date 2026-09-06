const { readCache, writeCache } = require('./cache');
const {
  fetchAllNews,
  scrapeArticle,
  isAllowedNewsUrl,
  resolveScrapeUrl,
  splitFlash,
  stripTitlePrefix,
} = require('./news');
const { readConfig, DEFAULT_KEYWORD_GROUPS } = require('./config');

let newsInflight = null;

const KEYWORD_ALIASES = {
  比特币: ['BTC', 'Bitcoin'],
  以太坊: ['ETH', 'Ethereum'],
  加密货币: ['Crypto', 'cryptocurrency', '加密资产'],
  美联储: ['Fed', 'Federal Reserve'],
  杰克逊霍尔: ['Jackson Hole', 'JacksonHole'],
  稳定币: ['stablecoin'],
  区块链: ['blockchain'],
  通胀: ['inflation'],
  加息: ['rate hike', 'hike rates'],
  降息: ['rate cut', 'cut rates'],
  美股: ['US stocks', 'U.S. stocks', 'Wall Street'],
  纳斯达克: ['Nasdaq', 'NASDAQ'],
  纳指: ['Nasdaq'],
  标普: ['S&P', 'S&P 500', 'SPX'],
  道指: ['Dow', 'DJIA', 'Dow Jones'],
  英伟达: ['Nvidia', 'NVIDIA', 'NVDA'],
  特斯拉: ['Tesla', 'TSLA'],
  苹果: ['AAPL', 'Apple Inc'],
  微软: ['Microsoft', 'MSFT'],
  谷歌: ['Google', 'Alphabet', 'GOOGL'],
  亚马逊: ['Amazon', 'AMZN'],
  英特尔: ['Intel', 'INTC'],
  博通: ['Broadcom', 'AVGO'],
};

const CRYPTO_SIGNALS = [
  '比特币', '以太坊', '加密货币', '加密资产', '稳定币', '区块链',
  'BTC', 'ETH', 'USDT', 'USDC', 'SOL', 'Coinbase', '币安', 'Binance',
  'CLARITY', 'CFTC', 'SEC', '现货ETF', '比特币ETF', '以太坊ETF',
];

const US_STOCK_SIGNALS = [
  '美股', '纳斯达克', '纳指', '标普', '道指', '道琼斯', '纽交所', '纽约证券交易所',
  '华尔街', '美股盘前', '美股收盘', '美股期货',
  '英伟达', '特斯拉', '苹果', '微软', '谷歌', '亚马逊', '英特尔', '博通', '奈飞',
  'NVDA', 'TSLA', 'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'META', 'INTC', 'AVGO', 'AMD',
  'Nasdaq', 'NYSE', 'S&P',
];

const US_MACRO_ALWAYS = ['非农', 'FOMC', '美联储', '杰克逊霍尔', 'PCE', 'ISM'];

const MACRO_CONTEXT_OK =
  /美联储|华尔街|FOMC|非农|欧元区|欧洲央行|欧央行|日本央行|日央行|英国央行|英央行|杰克逊霍尔|美国(?:CPI|PPI|PCE|非农|GDP|通胀|就业|失业率|PMI|ISM|经济)|美国劳工|德国.{0,16}(?:CPI|通胀|调和)|欧元区.{0,12}(?:CPI|通胀)/;

const CHINA_EQUITY_RE =
  /(?:\d{6}\s*[.．]?\s*(?:SZ|SH|BJ)\b)|(?:股票代码\s*\d{6})|(?:[（(]\d{6}[）)])|(?:创业板|科创板|北交所|深交所|上交所|新三板)|(?:\bA股\b|A 股|沪深|港股通|陆股通|北向资金|南向资金)|(?:涨停|跌停|龙虎榜|涨跌幅偏离|股票交易异常波动)|(?:中国证监会|证监会广东|证监会上海|证监会深圳)|(?:人民币普通股)|(?:拟合计减持|增持公司股份|减持不超)|(?:异动公告)/;

const CHINA_DOMESTIC_RE =
  /商务部|国资委|进博会|国家统计局|中央企业|国有企业|国有控股|七部门|新华财经|中国建筑|上海普陀|消费贷款贴息/;

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function textHas(haystack, needle) {
  if (!needle) return false;
  if (/^[A-Za-z0-9&]+$/.test(needle) || /^(S&P|S&P 500)$/i.test(needle)) {
    return new RegExp(`(^|[^A-Za-z0-9])${escapeRegExp(needle)}([^A-Za-z0-9]|$)`, 'i').test(
      haystack,
    );
  }
  if (needle === '利率') {
    return /(?<![毛净])利率/.test(haystack);
  }
  if (needle === '苹果') {
    return /苹果(?:公司|股价|财报|盘前|盘后|概念)|AAPL/.test(haystack);
  }
  return haystack.includes(needle);
}

function articleText(article) {
  return `${article.title || ''} ${article.summary || ''}`;
}

function matchKeywords(article, keywords) {
  const text = articleText(article);
  return keywords.filter((word) => {
    if (textHas(text, word)) return true;
    const aliases = KEYWORD_ALIASES[word] || [];
    return aliases.some((alias) => textHas(text, alias));
  });
}

function hasAnySignal(text, signals) {
  return signals.some((word) => textHas(text, word) || (KEYWORD_ALIASES[word] || []).some((alias) => textHas(text, alias)));
}

function isChinaEquityNews(article) {
  const text = articleText(article);
  if (CHINA_EQUITY_RE.test(text)) return true;
  if (/公告称|发布公告|临时公告/.test(text) && !hasAnySignal(text, US_STOCK_SIGNALS) && !hasAnySignal(text, CRYPTO_SIGNALS)) {
    return true;
  }
  return false;
}

function isUsStocksOrCryptoNews(article, matchedKeywords) {
  const text = articleText(article);
  if (hasAnySignal(text, CRYPTO_SIGNALS)) return true;
  if (hasAnySignal(text, US_STOCK_SIGNALS)) return true;
  if (US_MACRO_ALWAYS.some((word) => matchedKeywords.includes(word) || textHas(text, word))) {
    return true;
  }
  const macroHits = matchedKeywords.filter((word) =>
    ['CPI', 'PPI', 'PMI', '加息', '降息', '利率', '通胀', '就业', '失业率', 'GDP'].includes(word),
  );
  if (macroHits.length && MACRO_CONTEXT_OK.test(text) && !CHINA_DOMESTIC_RE.test(text)) {
    return true;
  }
  if (['众议院', '参议院', 'CLARITY', 'SEC', 'CFTC'].some((word) => matchedKeywords.includes(word))) {
    return !CHINA_DOMESTIC_RE.test(text);
  }
  return false;
}

function keepArticle(article) {
  if (isChinaEquityNews(article)) return false;
  if (CHINA_DOMESTIC_RE.test(articleText(article)) && !hasAnySignal(articleText(article), CRYPTO_SIGNALS) && !hasAnySignal(articleText(article), US_STOCK_SIGNALS)) {
    return false;
  }
  return isUsStocksOrCryptoNews(article, article.matchedKeywords || []);
}

async function refreshNews(force = false) {
  const cached = readCache('news');
  if (!force && cached && !cached.stale) {
    return { ...cached.data, stale: false, updatedAt: cached.updatedAt };
  }
  if (newsInflight) {
    if (!force && cached) {
      return { ...cached.data, stale: true, updatedAt: cached.updatedAt };
    }
    return newsInflight;
  }

  newsInflight = (async () => {
    const { keywords, keywordGroups } = readConfig();
    const groups = keywordGroups || DEFAULT_KEYWORD_GROUPS;
    const fetched = await fetchAllNews();
    const articles = fetched.articles
      .map((item) => ({
        ...item,
        matchedKeywords: matchKeywords(item, keywords),
      }))
      .filter((item) => item.matchedKeywords.length > 0)
      .filter(keepArticle)
      .slice(0, 80);

    const payload = {
      articles,
      keywords,
      keywordGroups: groups,
      sources: fetched.sources,
    };
    const saved = writeCache('news', payload);
    return { ...payload, stale: false, updatedAt: saved.updatedAt };
  })().finally(() => {
    newsInflight = null;
  });

  return newsInflight;
}

async function getNews(force = false) {
  try {
    return await refreshNews(force);
  } catch (err) {
    const cached = readCache('news');
    if (cached) {
      return {
        ...cached.data,
        stale: true,
        updatedAt: cached.updatedAt,
        warning: `新闻刷新失败：${err.message}`,
      };
    }
    throw err;
  }
}

function findCachedArticle(id) {
  const cached = readCache('news');
  return (cached?.data?.articles || []).find((item) => item.id === id) || null;
}

async function getNewsDetail(id, url) {
  const cached = id ? findCachedArticle(id) : null;
  const target = resolveScrapeUrl(id, url || cached?.url || '');
  let title = cached?.title || '';
  let content = cached?.summary || '';
  let fetched = false;
  let warning = '';

  if (target && isAllowedNewsUrl(target)) {
    try {
      const scraped = await scrapeArticle(target);
      if (scraped?.content) {
        if (scraped.content.length > content.length) {
          content = scraped.content;
          fetched = true;
        }
        if (scraped.title && scraped.title.length <= 80) {
          title = scraped.title;
          fetched = true;
        }
      } else if (!content) {
        warning = '未抓取到正文，已展示快讯原文';
      }
    } catch (err) {
      warning = `正文抓取失败，已展示快讯原文：${err.message}`;
    }
  }

  const split = splitFlash(title, content);
  title = split.title;
  content = stripTitlePrefix(title, split.summary);

  if (!title && !content) {
    const error = new Error('未找到该快讯');
    error.status = 404;
    throw error;
  }

  return {
    id: id || cached?.id || '',
    title,
    source: cached?.source || '',
    url: target || cached?.url || '',
    publishedAt: cached?.publishedAt || 0,
    summary: cached?.summary || '',
    content,
    matchedKeywords: cached?.matchedKeywords || [],
    fetched,
    warning,
  };
}

module.exports = {
  getNews,
  refreshNews,
  getNewsDetail,
};
