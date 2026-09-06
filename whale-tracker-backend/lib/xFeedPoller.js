/**
 * X ?????????? user-tweets ? MyMemory ???? ? ?? + WS ??
 * ???? 9:00??? 3:00 ???3:00?9:00 ?????? 30 ?????
 */
const { readCache, writeCache } = require('./cache');
const { broadcast } = require('./realtimeHub');
const { translateTweets } = require('./myMemoryTranslate');
const { getWatchAccounts, fetchFromSorsa, readCached } = require('./sorsaTwitter');

const FEED_CACHE = 'x-feed';
const POLL_MS = Math.max(
  5 * 60_000,
  Number(process.env.X_POLL_INTERVAL_MS) || 30 * 60_000,
);
const PER_USER_KEEP = Math.max(5, Number(process.env.X_PER_USER_KEEP) || 15);
const USER_GAP_MS = Math.max(0, Number(process.env.X_USER_GAP_MS) || 1500);

let pollTimer = null;
let busy = false;
let lastPollAt = 0;
let lastPollError = '';
let lastNewCount = 0;

function beijingParts(now = Date.now()) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    hour: 'numeric',
    minute: 'numeric',
    hourCycle: 'h23',
  });
  const parts = Object.fromEntries(
    fmt
      .formatToParts(new Date(now))
      .filter((p) => p.type !== 'literal')
      .map((p) => [p.type, p.value]),
  );
  return {
    hour: Number(parts.hour) || 0,
    minute: Number(parts.minute) || 0,
  };
}

/** ???? 09:00???? 03:00?????????? */
function isPollWindowOpen(now = Date.now()) {
  const { hour } = beijingParts(now);
  return hour >= 9 || hour < 3;
}

function tweetTime(t) {
  const n = Date.parse(t?.createdAt || '');
  return Number.isFinite(n) ? n : 0;
}

function accountMeta(username) {
  const u = String(username || '').replace(/^@/, '');
  return (
    getWatchAccounts().find((a) => a.username.toLowerCase() === u.toLowerCase()) || {
      username: u,
      label: u,
      name: u,
    }
  );
}

function readFeedCache() {
  const cached = readCache(FEED_CACHE);
  if (!cached?.data) {
    return {
      accounts: getWatchAccounts().map((a) => ({ ...a, avatar: '' })),
      tweets: [],
      refreshedAt: 0,
      updatedAt: 0,
      stale: true,
      source: 'empty',
    };
  }
  return {
    ...cached.data,
    updatedAt: Number(cached.updatedAt) || 0,
    stale: Date.now() - (Number(cached.updatedAt) || 0) > POLL_MS,
  };
}

function writeFeed(payload) {
  writeCache(FEED_CACHE, payload);
  return payload;
}

/** ????????????/?????? Sorsa */
async function backfillTranslations() {
  const feed = readFeedCache();
  const missing = (feed.tweets || []).filter(
    (t) => !t.textZh || (t.refTweet && !t.refTweet.textZh),
  );
  if (!missing.length) {
    return { ...feed, backfilled: 0 };
  }
  await translateTweets(missing, { gapMs: 800 });
  writeFeed({
    accounts: feed.accounts,
    tweets: feed.tweets,
    refreshedAt: feed.refreshedAt || Date.now(),
    source: feed.source || 'sorsa',
  });
  for (const acc of getWatchAccounts({ enabledOnly: true })) {
    const cached = readCached(acc.username);
    if (!cached?.tweets?.length) continue;
    const byId = new Map(feed.tweets.map((t) => [t.id, t]));
    let changed = false;
    for (const t of cached.tweets) {
      const fresh = byId.get(t.id);
      if (!fresh) continue;
      if (fresh.textZh && fresh.textZh !== t.textZh) {
        t.textZh = fresh.textZh;
        changed = true;
      }
      if (fresh.refTweet?.textZh && t.refTweet) {
        t.refTweet.textZh = fresh.refTweet.textZh;
        changed = true;
      }
    }
    if (changed) {
      writeCache(`x-user-${acc.username.toLowerCase()}`, {
        ...cached,
        tweets: cached.tweets,
        refreshedAt: Date.now(),
      });
    }
  }
  return { ...readFeedCache(), backfilled: missing.length };
}

function mergeFeed(perUserPayloads) {
  const byId = new Map();
  const accounts = [];
  for (const payload of perUserPayloads) {
    if (!payload) continue;
    const meta = accountMeta(payload.username);
    const profile = payload.profile || {};
    accounts.push({
      username: meta.username,
      label: meta.label,
      name: profile.name || meta.name,
      avatar: profile.avatar || '',
      url: profile.url || `https://x.com/${meta.username}`,
    });
    const list = (payload.tweets || []).slice(0, PER_USER_KEEP);
    for (const t of list) {
      const row = {
        ...t,
        username: meta.username,
        label: meta.label,
      };
      const prev = byId.get(row.id);
      if (!prev) {
        byId.set(row.id, row);
      } else {
        byId.set(row.id, {
          ...prev,
          ...row,
          textZh: row.textZh || prev.textZh || '',
          refTweet: row.refTweet || prev.refTweet || null,
        });
      }
    }
  }
  const tweets = [...byId.values()].sort((a, b) => tweetTime(b) - tweetTime(a));
  return {
    accounts,
    tweets,
    refreshedAt: Date.now(),
    source: 'sorsa',
  };
}

async function pollOnce({ force = false } = {}) {
  if (busy) return readFeedCache();
  if (!force && !isPollWindowOpen()) {
    return { ...readFeedCache(), skipped: 'off_hours' };
  }
  busy = true;
  lastPollError = '';
  try {
    const prevFeed = readFeedCache();
    const prevIds = new Set((prevFeed.tweets || []).map((t) => t.id));
    const payloads = [];
    const watchList = getWatchAccounts({ enabledOnly: true });

    for (let i = 0; i < watchList.length; i += 1) {
      const acc = watchList[i];
      try {
        const fresh = await fetchFromSorsa(acc.username);
        const needZh = (fresh.tweets || []).filter(
          (t) => t.id && (!t.textZh || (t.refTweet && !t.refTweet.textZh)),
        );
        if (needZh.length) {
          await translateTweets(needZh);
          writeCache(`x-user-${acc.username.toLowerCase()}`, {
            ...fresh,
            tweets: fresh.tweets,
            refreshedAt: Date.now(),
          });
        }
        payloads.push(fresh);
      } catch (err) {
        console.warn(`[x-poll] ${acc.username}:`, err.message);
        lastPollError = err.message;
        const cached = readCached(acc.username);
        if (cached) payloads.push(cached);
      }
      if (USER_GAP_MS > 0 && i < watchList.length - 1) {
        await new Promise((r) => setTimeout(r, USER_GAP_MS));
      }
    }

    const oldZh = new Map();
    for (const t of prevFeed.tweets || []) {
      if (t?.textZh) oldZh.set(t.id, t.textZh);
      if (t?.refTweet?.id && t.refTweet.textZh) {
        oldZh.set(`ref:${t.refTweet.id}`, t.refTweet.textZh);
      }
    }
    const feed = mergeFeed(payloads);
    for (const t of feed.tweets) {
      if (!t.textZh && oldZh.has(t.id)) t.textZh = oldZh.get(t.id);
      if (t.refTweet && !t.refTweet.textZh && oldZh.has(`ref:${t.refTweet.id}`)) {
        t.refTweet.textZh = oldZh.get(`ref:${t.refTweet.id}`);
      }
    }

    const missing = feed.tweets.filter(
      (t) => !t.textZh || (t.refTweet && !t.refTweet.textZh),
    );
    if (missing.length) {
      await translateTweets(missing, { gapMs: 800 });
    }

    writeFeed(feed);
    lastPollAt = Date.now();

    const newcomers = feed.tweets.filter((t) => t.id && !prevIds.has(t.id));
    lastNewCount = newcomers.length;
    if (newcomers.length) {
      try {
        broadcast({
          type: 'xTweet',
          at: Date.now(),
          tweets: newcomers.slice(0, 20),
          accounts: feed.accounts,
        });
      } catch (err) {
        console.warn('[x-poll] broadcast failed:', err.message);
      }
    }
    console.log(
      `[x-poll] ok users=${payloads.length} tweets=${feed.tweets.length} new=${newcomers.length}`,
    );
    return { ...feed, updatedAt: lastPollAt, stale: false, newCount: newcomers.length };
  } catch (err) {
    lastPollError = err.message || String(err);
    console.warn('[x-poll] failed:', lastPollError);
    return { ...readFeedCache(), error: lastPollError };
  } finally {
    busy = false;
  }
}

function getFeed({ user = '', limit = 40 } = {}) {
  const feed = readFeedCache();
  const u = String(user || '')
    .replace(/^@/, '')
    .trim()
    .toLowerCase();
  const watch = getWatchAccounts({ enabledOnly: true });
  const enabledSet = new Set(watch.map((a) => a.username.toLowerCase()));
  let tweets = (feed.tweets || []).filter((t) =>
    enabledSet.has(String(t.username || '').toLowerCase()),
  );
  if (u && u !== 'all') {
    tweets = tweets.filter((t) => String(t.username || '').toLowerCase() === u);
  }
  const lim = Math.max(1, Math.min(100, Number(limit) || 40));
  const avatarByUser = new Map(
    (feed.accounts || []).map((a) => [String(a.username || '').toLowerCase(), a]),
  );
  const accounts = watch.map((a) => {
    const prev = avatarByUser.get(a.username.toLowerCase()) || {};
    return {
      username: a.username,
      label: a.label,
      name: prev.name || a.name,
      avatar: prev.avatar || '',
      url: prev.url || `https://x.com/${a.username}`,
      enabled: true,
    };
  });
  return {
    accounts,
    tweets: tweets.slice(0, lim),
    refreshedAt: feed.refreshedAt || 0,
    updatedAt: feed.updatedAt || feed.refreshedAt || 0,
    stale: feed.stale,
    source: feed.source || 'sorsa',
    poll: getStatus(),
  };
}

function getStatus() {
  return {
    enabled: String(process.env.X_POLL || '1') !== '0',
    pollMs: POLL_MS,
    windowOpen: isPollWindowOpen(),
    busy,
    lastPollAt,
    lastPollError,
    lastNewCount,
    accounts: getWatchAccounts({ enabledOnly: true }).map((a) => a.username),
    accountsAll: getWatchAccounts().map((a) => ({
      username: a.username,
      enabled: a.enabled !== false,
    })),
  };
}

function startXFeedPolling() {
  if (pollTimer) return;
  const enabled = String(process.env.X_POLL || '1') !== '0';
  if (!enabled) {
    console.log('[x-poll] disabled (X_POLL=0)');
    return;
  }
  console.log(
    `[x-poll] every ${Math.round(POLL_MS / 60000)}m accounts=${getWatchAccounts({ enabledOnly: true })
      .map((a) => a.username)
      .join(',')}`,
  );
  setTimeout(() => {
    void pollOnce({ force: false });
  }, 8_000);
  pollTimer = setInterval(() => {
    void pollOnce({ force: false });
  }, POLL_MS);
}

module.exports = {
  getWatchAccounts,
  isPollWindowOpen,
  pollOnce,
  getFeed,
  getStatus,
  readFeedCache,
  backfillTranslations,
  startXFeedPolling,
};
