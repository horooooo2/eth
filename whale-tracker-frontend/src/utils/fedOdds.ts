export type FedOdds = {
  title: string;
  items: { label: string; pct: number; kind: string }[];
  hikePct: number;
  cutPct: number;
  holdPct: number;
  source: string;
};

function num(value: unknown) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function parsePrices(raw: unknown) {
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return num(Array.isArray(parsed) ? parsed[0] : 0);
  } catch {
    return 0;
  }
}

function unwrap(data: any) {
  if (!data) return null;
  if (Array.isArray(data)) return data[0] || null;
  if (Array.isArray(data.events)) return data.events[0] || null;
  return data;
}

export function parseFedEvent(event: any): FedOdds {
  let markets = event?.markets || [];
  if (typeof markets === 'string') {
    try {
      markets = JSON.parse(markets);
    } catch {
      markets = [];
    }
  }
  const items = (Array.isArray(markets) ? markets : []).map((market: any) => {
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
    items: [...items].sort((a, b) => b.pct - a.pct),
    hikePct: items.filter((item) => item.kind === 'hike').reduce((sum, item) => sum + item.pct, 0),
    cutPct: items.filter((item) => item.kind === 'cut').reduce((sum, item) => sum + item.pct, 0),
    holdPct: items.filter((item) => item.kind === 'hold').reduce((sum, item) => sum + item.pct, 0),
    source: 'Polymarket',
  };
}

function usable(odds: FedOdds | null | undefined): odds is FedOdds {
  return Boolean(odds?.items?.some((item) => Number(item.pct) > 0));
}

async function readJson(url: string, ms: number, signal?: AbortSignal) {
  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: signal || AbortSignal.timeout(ms),
  });
  if (!res.ok) return null;
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function firstHit<T>(tasks: Promise<T | null>[]): Promise<T | null> {
  return new Promise((resolve) => {
    let left = tasks.length;
    if (!left) {
      resolve(null);
      return;
    }
    let settled = false;
    for (const task of tasks) {
      task
        .then((value) => {
          if (!settled && value) {
            settled = true;
            resolve(value);
            return;
          }
          if (--left === 0 && !settled) resolve(null);
        })
        .catch(() => {
          if (--left === 0 && !settled) resolve(null);
        });
    }
  });
}

export async function fetchFedOddsClient(): Promise<FedOdds | null> {
  const fromEvent = async (url: string, ms: number) => {
    const parsed = parseFedEvent(unwrap(await readJson(url, ms)));
    return usable(parsed) ? parsed : null;
  };
  const fromLocal = async (url: string, ms: number) => {
    const data = await readJson(url, ms);
    return usable(data) ? (data as FedOdds) : null;
  };

  const hit = await firstHit([
    fromEvent('https://gamma-api.polymarket.com/events?slug=fed-decision-in-september-762', 8000),
    fromLocal('/poly-fed', 4000),
  ]);
  if (hit) return hit;

  return firstHit([
    fromEvent('https://gamma-api.polymarket.com/events/slug/fed-decision-in-september-762', 6000),
    fromLocal('/api/poly-fed', 4000),
  ]);
}
