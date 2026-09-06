/**
 * Sorsa X/Twitter：只打 user-tweets（不打 info）+ 磁盘缓存
 */
const { getWatchAccounts } = require('./xWatchAccounts');
const axios = require('axios');
const { readCache, writeCache } = require('./cache');

const CACHE_PREFIX = 'x-user';
const FRESH_MS = Math.max(60_000, Number(process.env.SORSA_CACHE_MS) || 30 * 60_000);
const DEFAULT_USER = String(process.env.X_DEFAULT_USER || 'cz_binance').replace(/^@/, '');

function getApiKey() {
  return String(process.env.SORSA_API_KEY || '').trim();
}

function cacheName(username) {
  return `${CACHE_PREFIX}-${String(username || DEFAULT_USER).replace(/^@/, '').toLowerCase()}`;
}

function normalizeTweet(t, username, { nest = true } = {}) {
  const id = String(t.id || t.tweet_id || t.id_str || '').trim();
  const user = t.user || {};
  const handle = String(user.username || user.screen_name || username || '').replace(/^@/, '');
  const quotedRaw = nest ? t.quoted_status || null : null;
  const retweetedRaw = nest ? t.retweeted_status || null : null;
  const refRaw = quotedRaw || retweetedRaw || null;
  const refKind = quotedRaw ? 'quote' : retweetedRaw ? 'retweet' : '';
  return {
    id,
    text: String(t.full_text || t.text || t.fullText || '').trim(),
    textZh: t.textZh || '',
    createdAt: t.created_at || t.createdAt || t.date || null,
    likes: Number(t.likes_count ?? t.like_count ?? t.favorite_count ?? t.likes) || 0,
    retweets: Number(t.retweet_count ?? t.retweets) || 0,
    replies: Number(t.reply_count ?? t.replies) || 0,
    views: Number(t.view_count ?? t.views) || 0,
    quotes: Number(t.quote_count ?? t.quotes) || 0,
    isReply: Boolean(t.is_reply),
    isQuote: Boolean(t.is_quote_status || quotedRaw),
    isRetweet: Boolean(retweetedRaw && !quotedRaw),
    lang: t.lang || '',
    url: id && handle ? `https://x.com/${handle}/status/${id}` : null,
    user: {
      id: String(user.id || ''),
      username: handle,
      name: String(user.display_name || user.name || handle),
      avatar: String(user.profile_image_url || user.profile_image_url_https || '').replace(
        /_normal(\.|$)/,
        '_bigger$1',
      ),
      followers: Number(user.followers_count || user.followers) || 0,
    },
    refKind,
    refTweet: refRaw ? normalizeTweet(refRaw, refRaw.user?.username || '', { nest: false }) : null,
  };
}

function profileFromTweets(tweets, username, meta) {
  const first = (tweets || []).find((t) => t?.user?.username);
  const handle = String(first?.user?.username || username || '').replace(/^@/, '');
  return {
    id: String(first?.user?.id || ''),
    username: handle,
    name: String(first?.user?.name || meta?.name || handle),
    label: meta?.label || handle,
    avatar: String(first?.user?.avatar || ''),
    url: handle ? `https://x.com/${handle}` : null,
  };
}

/** 仅 user-tweets，不请求 /v3/info */
async function fetchFromSorsa(username) {
  const key = getApiKey();
  if (!key) {
    const err = new Error('未配置 SORSA_API_KEY');
    err.code = 'NO_KEY';
    throw err;
  }
  const user = String(username || '').replace(/^@/, '').trim();
  const headers = {
    ApiKey: key,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
  const twResp = await axios.post(
    'https://api.sorsa.io/v3/user-tweets',
    { username: user },
    { headers, timeout: 90_000 },
  );
  const rawList = Array.isArray(twResp.data?.tweets) ? twResp.data.tweets : [];
  const tweets = rawList.map((t) => normalizeTweet(t, user)).filter((t) => t.id && t.text);
  const meta = getWatchAccounts().find((a) => a.username.toLowerCase() === user.toLowerCase());
  const prev = readCached(user);
  // 保留旧译文（含引用推文）
  if (prev?.tweets?.length) {
    const zhMap = new Map();
    for (const t of prev.tweets) {
      if (t.textZh) zhMap.set(t.id, t.textZh);
      if (t.refTweet?.textZh) zhMap.set(`ref:${t.refTweet.id}`, t.refTweet.textZh);
    }
    for (const t of tweets) {
      if (zhMap.has(t.id)) t.textZh = zhMap.get(t.id);
      if (t.refTweet?.id && zhMap.has(`ref:${t.refTweet.id}`)) {
        t.refTweet.textZh = zhMap.get(`ref:${t.refTweet.id}`);
      }
    }
  }
  const profile = profileFromTweets(tweets, user, meta) || prev?.profile || null;
  const payload = {
    username: user,
    profile,
    tweets,
    nextCursor: twResp.data?.next_cursor || null,
    source: 'sorsa',
    refreshedAt: Date.now(),
  };
  writeCache(cacheName(user), payload);
  return payload;
}

function readCached(username) {
  const cached = readCache(cacheName(username));
  if (!cached?.data) return null;
  const updatedAt = Number(cached.updatedAt) || 0;
  return {
    ...cached.data,
    updatedAt,
    stale: Date.now() - updatedAt > FRESH_MS,
  };
}

/** 兼容此前手工落盘的 x-cz_binance.json */
function readLegacyFile(username) {
  try {
    const fs = require('fs');
    const path = require('path');
    const file = path.join(__dirname, '..', 'cache', `x-${username}.json`);
    if (!fs.existsSync(file)) return null;
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const list = Array.isArray(raw.tweets?.tweets)
      ? raw.tweets.tweets
      : Array.isArray(raw.tweets)
        ? raw.tweets
        : [];
    const tweets = list.map((t) => normalizeTweet(t, username)).filter((t) => t.id && t.text);
    if (!tweets.length) return null;
    const meta = getWatchAccounts().find((a) => a.username.toLowerCase() === username.toLowerCase());
    const updatedAt = Number(raw.fetchedAt) || Date.now();
    const payload = {
      username,
      profile: profileFromTweets(tweets, username, meta),
      tweets,
      nextCursor: raw.tweets?.next_cursor || null,
      source: raw.source || 'legacy',
      refreshedAt: updatedAt,
    };
    writeCache(cacheName(username), payload);
    return { ...payload, updatedAt, stale: Date.now() - updatedAt > FRESH_MS };
  } catch {
    return null;
  }
}

async function getUserTweets(username = DEFAULT_USER, { force = false, limit = 20 } = {}) {
  const user = String(username || DEFAULT_USER).replace(/^@/, '').trim() || DEFAULT_USER;
  const lim = Math.max(1, Math.min(50, Number(limit) || 20));
  let cached = readCached(user) || readLegacyFile(user);

  if (cached && !force && !cached.stale) {
    return {
      ...cached,
      tweets: (cached.tweets || []).slice(0, lim),
    };
  }
  if (cached && !force) {
    void fetchFromSorsa(user).catch((err) =>
      console.warn(`[x] background refresh ${user}:`, err.message),
    );
    return {
      ...cached,
      tweets: (cached.tweets || []).slice(0, lim),
    };
  }
  try {
    const fresh = await fetchFromSorsa(user);
    return {
      ...fresh,
      updatedAt: Date.now(),
      stale: false,
      tweets: (fresh.tweets || []).slice(0, lim),
    };
  } catch (err) {
    if (cached) {
      return {
        ...cached,
        tweets: (cached.tweets || []).slice(0, lim),
        error: err.message,
      };
    }
    throw err;
  }
}

module.exports = {
  DEFAULT_USER,
  getWatchAccounts,
  /** 兼容旧代码：每次访问都是当前列表 */
  get WATCH_ACCOUNTS() {
    return getWatchAccounts();
  },
  FRESH_MS,
  getUserTweets,
  fetchFromSorsa,
  readCached,
  normalizeTweet,
};
