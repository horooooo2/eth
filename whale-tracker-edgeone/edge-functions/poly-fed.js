/**
 * EdgeOne Edge Function：在边缘节点拉取 Polymarket 9 月 FOMC 定价。
 * 云函数若在国内机房访问不了 gamma-api，浏览器可改打这个同域接口。
 */
const SLUGS = [
  'fed-decision-in-september-762',
  'fed-decision-in-september-2026',
  'fed-decision-in-september',
];

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function parsePrices(raw) {
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return num(Array.isArray(parsed) ? parsed[0] : 0);
  } catch {
    return 0;
  }
}

function unwrap(data) {
  if (!data) return null;
  if (Array.isArray(data)) return data[0] || null;
  if (Array.isArray(data.events)) return data.events[0] || null;
  return data;
}

function parseEvent(event) {
  let markets = event?.markets || [];
  if (typeof markets === 'string') {
    try {
      markets = JSON.parse(markets);
    } catch {
      markets = [];
    }
  }
  const items = (Array.isArray(markets) ? markets : []).map((market) => {
    const title = String(market.groupItemTitle || market.question || '');
    let label = title;
    if (/50\+ bps decrease/i.test(title)) label = '降息 50bp+';
    else if (/25 bps decrease/i.test(title)) label = '降息 25bp';
    else if (/No change/i.test(title)) label = '维持利率';
    else if (/50\+ bps increase/i.test(title)) label = '加息 50bp+';
    else if (/25 bps increase/i.test(title)) label = '加息 25bp';
    const pct = parsePrices(market.outcomePrices) * 100;
    return {
      label,
      pct,
      kind: label.includes('加息') ? 'hike' : label.includes('降息') ? 'cut' : 'hold',
    };
  });
  return {
    title: event?.title || '9 月 FOMC',
    items: items.sort((a, b) => b.pct - a.pct),
    hikePct: items.filter((item) => item.kind === 'hike').reduce((sum, item) => sum + item.pct, 0),
    cutPct: items.filter((item) => item.kind === 'cut').reduce((sum, item) => sum + item.pct, 0),
    holdPct: items.filter((item) => item.kind === 'hold').reduce((sum, item) => sum + item.pct, 0),
    source: 'Polymarket',
  };
}

async function loadEvent(slug) {
  const headers = {
    Accept: 'application/json',
    Origin: 'https://polymarket.com',
    Referer: `https://polymarket.com/event/${slug}`,
  };
  const urls = [
    `https://gamma-api.polymarket.com/events?slug=${encodeURIComponent(slug)}`,
    `https://gamma-api.polymarket.com/events/slug/${encodeURIComponent(slug)}`,
  ];
  for (const url of urls) {
    const res = await fetch(url, { headers });
    if (!res.ok) continue;
    const parsed = parseEvent(unwrap(await res.json()));
    if (parsed.items.length) return parsed;
  }
  return null;
}

async function handle() {
  try {
    for (const slug of SLUGS) {
      const parsed = await loadEvent(slug);
      if (parsed?.items?.length) {
        return new Response(JSON.stringify(parsed), {
          status: 200,
          headers: {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'public, max-age=60',
            'access-control-allow-origin': '*',
          },
        });
      }
    }
    return new Response(JSON.stringify({ title: '9 月 FOMC', items: [], hikePct: 0, cutPct: 0, holdPct: 0, source: 'Polymarket' }), {
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message || 'fed fetch failed', items: [] }), {
      status: 502,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  }
}

export async function onRequest() {
  return handle();
}

export async function onRequestGet() {
  return handle();
}
