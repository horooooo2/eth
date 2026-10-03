/**
 * 巨鲸快照 / 成交 / 异动事件 ↔ SQLite
 * 与磁盘 JSON 缓存并行写入；读取时可优先用库。
 */
const {
  getDb,
  setMeta,
  getMeta,
  purgeOlderThan,
  RETENTION_MS,
  FILL_RETENTION_MS,
  CLOSED_POSITION_RETENTION_MS,
  FILL_MAX_PER_WHALE,
  dbStatus,
  bumpDailyAdded,
  readDailyIoStats,
} = require('./db');
const {
  POSITION_EVENT_MERGE_MS,
  OPEN_KINDS,
  kindGroup,
  passesMinUsd,
  preferKind,
  alertDocFromEvent,
} = require('./positionEventPolicy');

const PAGED_ALERT_CACHE_TTL_MS = 10_000;
const pagedAlertCache = new Map();

function safeJson(value) {
  try {
    return JSON.stringify(value ?? null);
  } catch {
    return 'null';
  }
}

function parseJson(text, fallback = null) {
  try {
    return text ? JSON.parse(text) : fallback;
  } catch {
    return fallback;
  }
}

function coinOfTrade(trade) {
  return String(trade?.assetLabel || trade?.asset || '').trim();
}

/** 由成交派生开/补/减/平事件（结合 startPosition，避免买=多卖=空误判） */
function eventsFromTrade(trade) {
  if (!trade || trade.source === 'onchain') return [];
  const coin = coinOfTrade(trade);
  if (!coin) return [];
  const usd = Math.abs(Number(trade.amountUsd) || 0);
  const ts = Number(trade.time) || 0;
  const buy = trade.side === 'buy' || trade.side === 'B' || trade.side === 'in';
  const dir = String(trade.dir || '');
  const startValue = trade.startPosition;
  const start = startValue == null || startValue === '' ? NaN : Number(startValue);
  const sz = Math.abs(Number(trade.amount) || 0);
  const eps = 1e-8;

  let side = null;
  let isClose = false;
  let isOpen = false;

  if (Number.isFinite(start)) {
    if (Math.abs(start) < eps) {
      isOpen = true;
      side = buy ? 'long' : 'short';
    } else if (start > 0) {
      side = 'long';
      isClose = !buy;
    } else {
      side = 'short';
      isClose = buy;
    }
  } else if (/close|reduce/i.test(dir)) {
    isClose = true;
    side = /short/i.test(dir) ? 'short' : 'long';
  } else {
    // HL 的 Open Long/Short 也可能是补仓。缺少 startPosition 时不再把 dir
    // 当作新开仓证据，以免加仓误入开仓/共振记录。
    return [];
  }

  if (!side) return [];

  let openKind;
  if (isClose) {
    const remaining =
      Number.isFinite(start) && sz > 0 ? Math.abs(start) - sz : null;
    openKind =
      remaining != null && remaining <= Math.max(eps, Math.abs(start) * 1e-6)
        ? 'close'
        : 'decrease';
  } else if (isOpen || Number(trade._asOpen)) {
    openKind = 'open';
  } else {
    openKind = 'increase';
  }

  if (!passesMinUsd(usd, openKind)) return [];

  const title =
    openKind === 'close'
      ? side === 'long'
        ? `平多 ${coin}`
        : `平空 ${coin}`
      : openKind === 'decrease'
        ? side === 'long'
          ? `减多 ${coin}`
          : `减空 ${coin}`
        : openKind === 'open'
          ? side === 'long'
            ? `开多 ${coin}`
            : `开空 ${coin}`
          : side === 'long'
            ? `加多 ${coin}`
            : `加空 ${coin}`;

  return [
    {
      id: `evt-${openKind}-${trade.id || `${trade.whaleId}-${ts}-${coin}`}`,
      whaleId: trade.whaleId || null,
      time: ts,
      kind: openKind,
      coin,
      side,
      usd,
      title,
      payload: trade,
      mergedCount: 1,
    },
  ];
}

function upsertAlertRows(database, alerts) {
  if (!alerts?.length) return { written: 0, added: 0 };
  const stmt = database.prepare(`
    INSERT INTO alerts (id, whale_id, time, kind, payload_json)
    VALUES (@id, @whale_id, @time, @kind, @payload_json)
    ON CONFLICT(id) DO UPDATE SET
      whale_id = excluded.whale_id,
      time = excluded.time,
      kind = excluded.kind,
      payload_json = excluded.payload_json
  `);
  const exists = database.prepare('SELECT 1 AS x FROM alerts WHERE id = ?');
  const sourceSeen = database.prepare('SELECT 1 AS x FROM alert_sources WHERE source_id = ?');
  const rememberSource = database.prepare('INSERT OR IGNORE INTO alert_sources(source_id, alert_id) VALUES (?, ?)');
  const moveSources = database.prepare('UPDATE alert_sources SET alert_id = ? WHERE alert_id = ?');
  const findMerge = database.prepare(`
    SELECT id, time, kind, payload_json FROM alerts
    WHERE whale_id = ?
      AND time >= ? AND time <= ?
      AND kind IN ('open', 'increase')
    ORDER BY time DESC LIMIT 40
  `);
  const delById = database.prepare('DELETE FROM alerts WHERE id = ?');
  const delItemsById = database.prepare('DELETE FROM alert_items WHERE alert_id = ?');
  const insertItem = database.prepare(`
    INSERT INTO alert_items (alert_id, item_index, kind, coin, side, usd, time)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  let written = 0;
  let added = 0;
  const retiredAlertIds = [];
  alertLoop: for (const alert of alerts) {
    if (!alert?.id) continue;
    const sourceId = String(alert.id);
    // HTTP retries and server-generated copies of the same event must never
    // add their notional a second time after a nearby event was merged.
    if (sourceSeen.get(sourceId)) continue;
    const kind = String(alert.kind || '');
    if (!OPEN_KINDS.has(kind)) continue;
    const time = Number(alert.at || alert.time) || 0;
    if (!time) continue;
    const usd = Math.abs(Number(alert.items?.[0]?.usd) || 0);
    if (!passesMinUsd(usd, kind)) continue;

    const whaleId = alert.whaleId ? String(alert.whaleId) : null;
    const coin = String(alert.items?.[0]?.coin || '').toUpperCase();
    const side = String(alert.items?.[0]?.side || '').toLowerCase();
    const group = kindGroup(kind);

    let target = alert;
    let mergedIntoExisting = false;

    if (whaleId && coin && side && group) {
      const windowStart = time - POSITION_EVENT_MERGE_MS;
      const windowEnd = time + POSITION_EVENT_MERGE_MS;
      const candidates = findMerge.all(whaleId, windowStart, windowEnd);
      for (const row of candidates) {
        if (String(row.id) === String(alert.id)) continue;
        if (kindGroup(row.kind) !== group) continue;
        const payload = parseJson(row.payload_json, null);
        const pCoin = String(payload?.items?.[0]?.coin || '').toUpperCase();
        const pSide = String(payload?.items?.[0]?.side || '').toLowerCase();
        if (pCoin !== coin || pSide !== side) continue;

        const previousSource = payload?.items?.[0]?.evidenceSource;
        const incomingSource = alert.items?.[0]?.evidenceSource;
        if (
          previousSource && incomingSource &&
          previousSource !== incomingSource &&
          (previousSource === 'fill' || incomingSource === 'fill')
        ) {
          // 成交流是具体成交金额，快照流是最终仓位变化。两者可能描述同一次
          // 操作：以 fill 为权威金额，避免交叉重复相加；同来源的拆单仍按下方合并。
          if (previousSource === 'fill') {
            if (incomingSource === 'snapshot') {
              rememberSource.run(sourceId, String(row.id));
              continue alertLoop;
            }
          } else if (incomingSource === 'fill') {
            delById.run(String(row.id));
            delItemsById.run(String(row.id));
            retiredAlertIds.push(String(row.id));
            continue;
          }
        }

        const prevUsd = Math.abs(Number(payload?.items?.[0]?.usd) || 0);
        const nextKind = preferKind(row.kind, kind);
        const mergedCount =
          Math.max(1, Number(payload?.mergedCount) || 1) +
          Math.max(1, Number(alert.mergedCount) || 1);
        const items = [
          ...(payload?.items || []),
          ...(alert.items || []),
        ].sort((a, b) => (Number(b.time) || 0) - (Number(a.time) || 0));
        const lead = items[0] || alert.items?.[0];
        target = {
          ...payload,
          ...alert,
          id: String(row.id),
          at: Math.max(Number(row.time) || 0, time),
          kind: nextKind,
          kindLabel:
            mergedCount > 1
              ? `${preferKind(row.kind, kind) === 'open' ? '开单' : preferKind(row.kind, kind) === 'close' ? '平仓' : preferKind(row.kind, kind) === 'increase' ? '加仓' : '减仓'}（多单）`
              : alert.kindLabel,
          headline:
            mergedCount > 1
              ? `${lead?.title || alert.headline || ''}（${mergedCount} 笔）`
              : alert.headline,
          items: items.map((it, idx) =>
            idx === 0
              ? { ...it, kind: nextKind, usd: prevUsd + usd }
              : it,
          ),
          mergedCount,
        };
        if (String(alert.id) !== String(row.id)) {
          // 新 id 不单独落库，并入已有行
          mergedIntoExisting = true;
        }
        break;
      }
    }

    const id = String(target.id);
    if (!exists.get(id)) added += 1;
    stmt.run({
      id,
      whale_id: target.whaleId ? String(target.whaleId) : whaleId,
      time: Number(target.at || target.time) || time,
      kind: String(target.kind || kind),
      payload_json: safeJson(target),
    });
    for (const retiredId of retiredAlertIds.splice(0)) moveSources.run(id, retiredId);
    delItemsById.run(id);
    for (const [itemIndex, item] of (Array.isArray(target.items) ? target.items : []).entries()) {
      insertItem.run(
        id,
        itemIndex,
        String(item?.kind || ''),
        String(item?.coin || '').trim().toUpperCase(),
        String(item?.side || '').trim().toLowerCase(),
        Number(item?.usd) || 0,
        Number(item?.time) || 0,
      );
    }
    if (mergedIntoExisting && String(alert.id) !== id) {
      try {
        delById.run(String(alert.id));
        delItemsById.run(String(alert.id));
      } catch {
        // ignore
      }
    }
    rememberSource.run(sourceId, id);
    written += 1;
  }
  if (written) pagedAlertCache.clear();
  return { written, added };
}

/** 前端同步异动历史 */
function persistAlerts(alerts = []) {
  const list = Array.isArray(alerts) ? alerts : [];
  const database = getDb();
  const tx = database.transaction(() => upsertAlertRows(database, list));
  const result = tx();
  if (result.added) bumpDailyAdded(result.added);
  const purged = purgeOlderThan(CLOSED_POSITION_RETENTION_MS);
  if (purged.alertsDeleted) pagedAlertCache.clear();
  return { saved: result.written, added: result.added, purged };
}

/** Full event window for resonance: pagination and display limits must not bias signals. */
function loadResonanceInputs(sinceMs, untilMs, minUsd) {
  const database = getDb();
  const alerts = database.prepare(`SELECT payload_json FROM alerts
    WHERE EXISTS (SELECT 1 FROM alert_items i WHERE i.alert_id = alerts.id
      AND i.kind IN ('open', 'increase') AND ABS(i.usd) >= ?
      AND COALESCE(NULLIF(i.time, 0), alerts.time) BETWEEN ? AND ?)
    ORDER BY time DESC`).all(minUsd, sinceMs, untilMs)
    .map(row => parseJson(row.payload_json, null)).filter(Boolean);
  const activity = database.prepare(`SELECT payload_json FROM fills
    WHERE time BETWEEN ? AND ? AND COALESCE(source, '') != 'onchain'
    AND ABS(COALESCE(amount_usd, 0)) >= ?
    ORDER BY time DESC`).all(sinceMs, untilMs, minUsd)
    .map(row => parseJson(row.payload_json, null)).filter(Boolean);
  return { alerts, activity };
}

function countStoredAlerts() {
  return Number(getDb().prepare('SELECT COUNT(*) AS total FROM alerts').get()?.total) || 0;
}

function loadRecentAlerts(limit = 500) {
  const database = getDb();
  // 持仓中事件不按固定天数砍；查询侧取较宽窗口 + 当前仓过滤由 purge 保证
  const cutoff = Date.now() - 180 * 24 * 60 * 60 * 1000;
  const rows = database
    .prepare(
      `SELECT payload_json FROM alerts
       WHERE time >= ? AND kind IN ('open', 'increase')
       ORDER BY time DESC LIMIT ?`,
    )
    .all(cutoff, Math.max(1, Math.min(2000, Number(limit) || 500)));
  return rows
    .map((row) => parseJson(row.payload_json, null))
    .filter((item) => item && item.id);
}

/** 服务器侧净流入横幅聚合；按异动发生时间过滤，不把客户端本地历史当作数据源。 */
function loadAlertFlowSummary({ sinceMs = 0, untilMs = Date.now(), coin = '' } = {}) {
  const from = Math.max(Number(sinceMs) || 0, Date.now() - CLOSED_POSITION_RETENTION_MS);
  const to = Math.max(from, Number(untilMs) || Date.now());
  const normalizedCoin = String(coin || '').trim().toUpperCase();
  const where = [
    `alerts.kind IN ('open', 'increase')`,
    `COALESCE(NULLIF(alert_item.time, 0), alerts.time) >= ?`,
    `COALESCE(NULLIF(alert_item.time, 0), alerts.time) <= ?`,
    `ABS(COALESCE(alert_item.usd, 0)) > 0`,
    `alert_item.side IN ('long', 'short')`,
  ];
  const params = [from, to];
  if (normalizedCoin && normalizedCoin !== 'ALL') {
    // Hyperliquid 的 K 前缀代表千倍币种；与前端 watched coin 归一逻辑保持一致。
    where.push(`UPPER(alert_item.coin) IN (?, ?, ?)`);
    params.push(normalizedCoin, `K${normalizedCoin}`, `U${normalizedCoin}`);
  }
  const db = getDb();
  const rows = db.prepare(
    `SELECT alert_item.side AS side,
            SUM(ABS(COALESCE(alert_item.usd, 0))) AS usd,
            COUNT(*) AS events
       FROM alerts
       JOIN alert_items AS alert_item ON alert_item.alert_id = alerts.id
      WHERE ${where.join(' AND ')}
      GROUP BY alert_item.side`,
  ).all(...params);
  const longUsd = Number(rows.find((row) => row.side === 'long')?.usd) || 0;
  const shortUsd = Number(rows.find((row) => row.side === 'short')?.usd) || 0;
  const events = rows.reduce((sum, row) => sum + (Number(row.events) || 0), 0);
  const whales = Number(db.prepare(
    `SELECT COUNT(DISTINCT alerts.whale_id) AS c
       FROM alerts
       JOIN alert_items AS alert_item ON alert_item.alert_id = alerts.id
      WHERE ${where.join(' AND ')}`,
  ).get(...params)?.c) || 0;
  return { longUsd, shortUsd, netUsd: longUsd - shortUsd, events, whales, sinceMs: from, untilMs: to };
}

/**
 * 异动分页查询（仅开仓 / 加仓）。
 */
function loadPagedAlerts(query = {}) {
  const page = Math.max(1, Number(query.page) || 1);
  const limit = Math.max(1, Math.min(100, Number(query.limit) || 50));
  const offset = (page - 1) * limit;
  const cutoff = Math.max(
    Date.now() - 180 * 24 * 60 * 60 * 1000,
    Number(query.sinceMs) || 0,
  );
  const whaleId = String(query.whaleId || '').trim();
  const kind = String(query.kind || 'all').trim().toLowerCase();
  const coinRaw = String(query.coins || query.coin || '').trim();
  const coins = [
    ...new Set(
      coinRaw
        .split(/[,\s]+/)
        .map((item) => String(item || '').trim().toUpperCase())
        .filter((item) => item && item !== 'ALL'),
    ),
  ];
  const side = String(query.side || 'all').trim().toLowerCase();
  const minUsd = Math.max(0, Number(query.minUsd) || 0);
  const excludeExotic = String(query.excludeExotic || '') === '1' || query.excludeExotic === true;
  const cacheKey = JSON.stringify({
    page, limit,
    // The default rolling 180d cutoff changes every millisecond and otherwise
    // makes the short cache unreachable. Writes/purges invalidate it, and the
    // 10s TTL bounds staleness at the retention boundary. Explicit sinceMs is exact.
    cutoff: Number(query.sinceMs) > 0 ? cutoff : 'rolling-180d',
    whaleId, kind, coins, side, minUsd, excludeExotic,
  });
  const cached = pagedAlertCache.get(cacheKey);
  if (cached && Date.now() - cached.createdAt < PAGED_ALERT_CACHE_TTL_MS) return cached.data;
  if (cached) pagedAlertCache.delete(cacheKey);

  // 一条仓位 diff 可以同时包含多个币种/方向；过滤必须检查整个 items 数组，
  // 而不能只看 items[0]。参数顺序与返回 SQL 片段保持一致。
  function itemExistsSql({ includeSide = true, includeCoins = true } = {}) {
    const itemWhere = [];
    const itemParams = [];
    if (includeCoins && coins.length) {
      itemWhere.push(`alert_item.coin IN (${coins.map(() => '?').join(', ')})`);
      itemParams.push(...coins);
    }
    if (includeSide && (side === 'long' || side === 'short')) {
      itemWhere.push('alert_item.side = ?');
      itemParams.push(side);
    }
    if (kind === 'open' || kind === 'increase') {
      itemWhere.push('alert_item.kind = ?');
      itemParams.push(kind);
    }
    if (minUsd > 0) {
      itemWhere.push('ABS(COALESCE(alert_item.usd, 0)) >= ?');
      itemParams.push(minUsd);
    }
    if (excludeExotic) itemWhere.push(`alert_item.coin NOT LIKE '@%' AND instr(alert_item.coin, ':') = 0`);
    return {
      sql: `EXISTS (SELECT 1 FROM alert_items AS alert_item WHERE alert_item.alert_id = alerts.id${itemWhere.length ? ` AND ${itemWhere.join(' AND ')}` : ''})`,
      params: itemParams,
    };
  }

  const where = [
    `time >= ?`,
    `kind IN ('open', 'increase')`,
  ];
  const params = [cutoff];

  if (whaleId) {
    where.push('whale_id = ?');
    params.push(whaleId);
  }
  if (kind === 'open' || kind === 'increase') {
    where.push('kind = ?');
    params.push(kind);
  }
  const rowItems = itemExistsSql();
  where.push(rowItems.sql);
  params.push(...rowItems.params);

  const whereSql = where.join(' AND ');
  const database = getDb();
  const total =
    Number(
      database.prepare(`SELECT COUNT(*) AS c FROM alerts WHERE ${whereSql}`).get(...params)
        ?.c,
    ) || 0;

  const rows = database
    .prepare(
      `SELECT payload_json FROM alerts
       WHERE ${whereSql}
       ORDER BY time DESC
       LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset);

  const alerts = rows
    .map((row) => parseJson(row.payload_json, null))
    .filter((item) => item && item.id);

  const facetWhere = [
    `alerts.time >= ?`,
    `alerts.kind IN ('open', 'increase')`,
  ];
  const facetParams = [cutoff];
  if (whaleId) {
    facetWhere.push('alerts.whale_id = ?');
    facetParams.push(whaleId);
  }
  if (kind === 'open' || kind === 'increase') {
    facetWhere.push('alerts.kind = ?');
    facetParams.push(kind);
  }
  // 多空计数需跟当前币种一致（否则选 BTC 仍显示全市场多空数）
  const facetItems = itemExistsSql({ includeSide: false });
  facetWhere.push(facetItems.sql);
  facetParams.push(...facetItems.params);
  const facetSql = facetWhere.join(' AND ');
  const allCount =
    Number(
      database.prepare(`SELECT COUNT(*) AS c FROM alerts WHERE ${facetSql}`).get(...facetParams)
        ?.c,
    ) || 0;
  const coinRows = database
    .prepare(
      `SELECT alert_item.coin AS coin,
              COUNT(DISTINCT alerts.id) AS c
       FROM alerts
       JOIN alert_items AS alert_item ON alert_item.alert_id = alerts.id
       WHERE ${facetSql}
         AND ABS(COALESCE(alert_item.usd, 0)) >= ?
         ${excludeExotic ? `AND alert_item.coin NOT LIKE '@%' AND instr(alert_item.coin, ':') = 0` : ''}
         ${coins.length ? `AND alert_item.coin IN (${coins.map(() => '?').join(', ')})` : ''}
       GROUP BY coin`,
    )
    .all(...facetParams, ...(minUsd > 0 ? [minUsd] : [0]), ...coins);
  const byCoin = {};
  for (const row of coinRows) {
    const key = String(row.coin || '').trim();
    if (!key) continue;
    byCoin[key] = Number(row.c) || 0;
  }
  const longCount =
    Number(
      database
        .prepare(
          `SELECT COUNT(*) AS c FROM alerts
           WHERE ${facetSql}
             AND EXISTS (SELECT 1 FROM alert_items AS alert_item
                         WHERE alert_item.alert_id = alerts.id
                           AND alert_item.side = 'long'
                           AND ABS(COALESCE(alert_item.usd, 0)) >= ?
                           ${excludeExotic ? `AND alert_item.coin NOT LIKE '@%' AND instr(alert_item.coin, ':') = 0` : ''}
                           ${coins.length ? `AND alert_item.coin IN (${coins.map(() => '?').join(', ')})` : ''})`,
        )
        .get(...facetParams, minUsd, ...coins)?.c,
    ) || 0;
  const shortCount =
    Number(
      database
        .prepare(
          `SELECT COUNT(*) AS c FROM alerts
           WHERE ${facetSql}
             AND EXISTS (SELECT 1 FROM alert_items AS alert_item
                         WHERE alert_item.alert_id = alerts.id
                           AND alert_item.side = 'short'
                           AND ABS(COALESCE(alert_item.usd, 0)) >= ?
                           ${excludeExotic ? `AND alert_item.coin NOT LIKE '@%' AND instr(alert_item.coin, ':') = 0` : ''}
                           ${coins.length ? `AND alert_item.coin IN (${coins.map(() => '?').join(', ')})` : ''})`,
        )
        .get(...facetParams, minUsd, ...coins)?.c,
    ) || 0;

  const result = {
    alerts,
    total,
    page,
    limit,
    retentionDays: Math.round(CLOSED_POSITION_RETENTION_MS / (24 * 60 * 60 * 1000)),
    retentionMode: 'open-positions+closed-1d',
    facets: {
      all: allCount,
      byCoin,
      long: longCount,
      short: shortCount,
    },
  };
  if (pagedAlertCache.size >= 100) pagedAlertCache.clear();
  pagedAlertCache.set(cacheKey, { createdAt: Date.now(), data: result });
  return result;
}

function loadFillsByWhale(whaleId, options = {}) {
  const id = String(whaleId || '');
  if (!id) return [];
  const cap = FILL_MAX_PER_WHALE;
  const limit = Math.max(1, Math.min(Number(options.limit) || cap, cap));
  const since = Number(options.sinceMs) || Date.now() - FILL_RETENTION_MS;
  const rows = getDb()
    .prepare(
      `SELECT payload_json FROM fills
       WHERE whale_id = ? AND time >= ? AND COALESCE(source, '') != 'onchain'
       ORDER BY time DESC LIMIT ?`,
    )
    .all(id, since, limit);
  return rows.map((row) => parseJson(row.payload_json, null)).filter(Boolean);
}

/** 最近成交（全地址），供资金动态总览 */
function loadRecentFills(options = {}) {
  const limit = Math.max(1, Math.min(8000, Number(options.limit) || 5000));
  const since = Number(options.sinceMs) || Date.now() - FILL_RETENTION_MS;
  const rows = getDb()
    .prepare(
      `SELECT payload_json FROM fills
       WHERE time >= ? AND COALESCE(source, '') != 'onchain'
       ORDER BY time DESC LIMIT ?`,
    )
    .all(since, limit);
  return rows.map((row) => parseJson(row.payload_json, null)).filter(Boolean);
}

function countFillsByWhale(whaleId) {
  const id = String(whaleId || '');
  if (!id) return 0;
  const cutoff = Date.now() - FILL_RETENTION_MS;
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS c FROM fills
       WHERE whale_id = ? AND time >= ? AND COALESCE(source, '') != 'onchain'`,
    )
    .get(id, cutoff);
  return Number(row?.c) || 0;
}

function loadDbBrowse(options = {}) {
  const limit = Math.max(1, Math.min(1000, Number(options.limit) || 50));
  const database = getDb();
  const fillCutoff = Date.now() - FILL_RETENTION_MS;
  const alertCutoff = Date.now() - Math.max(CLOSED_POSITION_RETENTION_MS, 7 * 24 * 60 * 60 * 1000);
  const status = dbStatus();

  const whales = database
    .prepare(
      `SELECT id, name, address, direction, long_usd, short_usd, net_usd, priority, closed_trades, updated_at, payload_json
       FROM whales ORDER BY priority DESC, closed_trades DESC LIMIT ?`,
    )
    .all(limit)
    .map((row) => {
      const payload = parseJson(row.payload_json, {}) || {};
      return {
        id: row.id,
        name: row.name,
        address: row.address,
        direction: row.direction,
        longUsd: row.long_usd,
        shortUsd: row.short_usd,
        netUsd: row.net_usd,
        priority: row.priority,
        closedTrades: row.closed_trades,
        updatedAt: row.updated_at,
        manual: Boolean(payload.manual),
        customName: Boolean(payload.customName),
      };
    });

  const fills = database
    .prepare(
      `SELECT id, whale_id, time, asset, side, amount, amount_usd, price, closed_pnl, source
       FROM fills WHERE time >= ? ORDER BY time DESC LIMIT ?`,
    )
    .all(fillCutoff, limit)
    .map((row) => ({
      id: row.id,
      whaleId: row.whale_id,
      time: row.time,
      asset: row.asset,
      side: row.side,
      amount: row.amount,
      amountUsd: row.amount_usd,
      price: row.price,
      closedPnl: row.closed_pnl,
      source: row.source,
    }));

  const events = database
    .prepare(
      `SELECT id, whale_id, time, kind, coin, side, usd, title
       FROM events WHERE time >= ? ORDER BY time DESC LIMIT ?`,
    )
    .all(alertCutoff, limit)
    .map((row) => ({
      id: row.id,
      whaleId: row.whale_id,
      time: row.time,
      kind: row.kind,
      coin: row.coin,
      side: row.side,
      usd: row.usd,
      title: row.title,
    }));

  const alerts = database
    .prepare(
      `SELECT id, whale_id, time, kind, payload_json
       FROM alerts WHERE time >= ? ORDER BY time DESC LIMIT ?`,
    )
    .all(alertCutoff, limit)
    .map((row) => {
      const payload = parseJson(row.payload_json, {}) || {};
      return {
        id: row.id,
        whaleId: row.whale_id,
        time: row.time,
        kind: row.kind,
        headline: payload.headline || '',
        whaleName: payload.whaleName || '',
        coin: payload.items?.[0]?.coin || '',
        usd: payload.items?.[0]?.usd ?? null,
      };
    });

  const fillBySource = database
    .prepare(
      `SELECT COALESCE(source, 'unknown') AS source, COUNT(*) AS c
       FROM fills WHERE time >= ? GROUP BY source`,
    )
    .all(fillCutoff);

  let backfill = null;
  try {
    backfill = parseJson(getMeta('fills_backfill_cursor')?.value, null);
  } catch {
    backfill = null;
  }

  return {
    at: Date.now(),
    retentionDays: Math.round(FILL_RETENTION_MS / (24 * 60 * 60 * 1000)),
    alertRetentionDays: Math.round(CLOSED_POSITION_RETENTION_MS / (24 * 60 * 60 * 1000)),
    fillMaxPerWhale: FILL_MAX_PER_WHALE,
    retentionMode: 'open-positions+closed-1d',
    status,
    dailyIo: readDailyIoStats(),
    fillBySource,
    backfill,
    whales,
    fills,
    events,
    alerts,
  };
}

/** 增量写入成交（实时 WS），并派生 events/alerts */
function persistTradesIncremental(trades = []) {
  const list = Array.isArray(trades) ? trades : [];
  if (!list.length) return { fills: 0, events: 0, alerts: 0 };
  const database = getDb();
  const upsertFill = database.prepare(`
    INSERT INTO fills (
      id, whale_id, time, asset, side, amount, amount_usd, price, closed_pnl, hash, source, payload_json
    ) VALUES (
      @id, @whale_id, @time, @asset, @side, @amount, @amount_usd, @price, @closed_pnl, @hash, @source, @payload_json
    )
    ON CONFLICT(id) DO UPDATE SET
      whale_id = excluded.whale_id,
      time = excluded.time,
      asset = excluded.asset,
      side = excluded.side,
      amount = excluded.amount,
      amount_usd = excluded.amount_usd,
      price = excluded.price,
      closed_pnl = excluded.closed_pnl,
      hash = excluded.hash,
      source = excluded.source,
      payload_json = excluded.payload_json
  `);
  const upsertEvent = database.prepare(`
    INSERT INTO events (
      id, whale_id, time, kind, coin, side, usd, title, payload_json
    ) VALUES (
      @id, @whale_id, @time, @kind, @coin, @side, @usd, @title, @payload_json
    )
    ON CONFLICT(id) DO UPDATE SET
      whale_id = excluded.whale_id,
      time = excluded.time,
      kind = excluded.kind,
      coin = excluded.coin,
      side = excluded.side,
      usd = excluded.usd,
      title = excluded.title,
      payload_json = excluded.payload_json
  `);

  let fills = 0;
  let events = 0;
  let added = 0;
  const derivedAlerts = [];
  const existsFill = database.prepare('SELECT 1 AS x FROM fills WHERE id = ?');
  const existsEvent = database.prepare('SELECT 1 AS x FROM events WHERE id = ?');
  const tx = database.transaction(() => {
    for (const trade of list) {
      const id = String(trade?.id || trade?.hash || '');
      if (!id) continue;
      if (!existsFill.get(id)) added += 1;
      upsertFill.run({
        id,
        whale_id: trade.whaleId ? String(trade.whaleId) : null,
        time: Number(trade.time) || 0,
        asset: coinOfTrade(trade),
        side: String(trade.side || ''),
        amount: Number(trade.amount) || 0,
        amount_usd: Number(trade.amountUsd) || 0,
        price: Number(trade.price) || 0,
        closed_pnl: Number(trade.closedPnl) || 0,
        hash: trade.hash ? String(trade.hash) : null,
        source: trade.source ? String(trade.source) : 'hyperliquid',
        payload_json: safeJson(trade),
      });
      fills += 1;
      for (const event of eventsFromTrade(trade)) {
        if (!existsEvent.get(event.id)) added += 1;
        upsertEvent.run({
          id: event.id,
          whale_id: event.whaleId,
          time: event.time,
          kind: event.kind,
          coin: event.coin,
          side: event.side,
          usd: event.usd,
          title: event.title,
          payload_json: safeJson(event.payload),
        });
        events += 1;
        const alertDoc = alertDocFromEvent(event);
        if (alertDoc) derivedAlerts.push(alertDoc);
      }
    }
    const alertResult = upsertAlertRows(database, derivedAlerts);
    added += alertResult.added || 0;
  });
  tx();
  if (added) bumpDailyAdded(added);
  return { fills, events, alerts: derivedAlerts.length, added };
}

function persistModePayload(data = {}, updatedAt = Date.now()) {
  const whales = Array.isArray(data.whales) ? data.whales : [];
  const trades = Array.isArray(data.trades) ? data.trades : [];
  const database = getDb();
  const now = Number(updatedAt) || Date.now();

  const upsertWhale = database.prepare(`
    INSERT INTO whales (
      id, name, address, enabled, direction, long_usd, short_usd, net_usd,
      priority, closed_trades, error, payload_json, updated_at
    ) VALUES (
      @id, @name, @address, @enabled, @direction, @long_usd, @short_usd, @net_usd,
      @priority, @closed_trades, @error, @payload_json, @updated_at
    )
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      address = excluded.address,
      enabled = excluded.enabled,
      direction = excluded.direction,
      long_usd = excluded.long_usd,
      short_usd = excluded.short_usd,
      net_usd = excluded.net_usd,
      priority = excluded.priority,
      closed_trades = excluded.closed_trades,
      error = excluded.error,
      payload_json = excluded.payload_json,
      updated_at = excluded.updated_at
  `);

  const deletePositions = database.prepare('DELETE FROM positions WHERE whale_id = ?');
  const insertPosition = database.prepare(`
    INSERT INTO positions (
      whale_id, coin, side, size, entry_px, position_value, unrealized_pnl,
      leverage, open_time, payload_json, updated_at
    ) VALUES (
      @whale_id, @coin, @side, @size, @entry_px, @position_value, @unrealized_pnl,
      @leverage, @open_time, @payload_json, @updated_at
    )
  `);

  const upsertFill = database.prepare(`
    INSERT INTO fills (
      id, whale_id, time, asset, side, amount, amount_usd, price, closed_pnl, hash, source, payload_json
    ) VALUES (
      @id, @whale_id, @time, @asset, @side, @amount, @amount_usd, @price, @closed_pnl, @hash, @source, @payload_json
    )
    ON CONFLICT(id) DO UPDATE SET
      whale_id = excluded.whale_id,
      time = excluded.time,
      asset = excluded.asset,
      side = excluded.side,
      amount = excluded.amount,
      amount_usd = excluded.amount_usd,
      price = excluded.price,
      closed_pnl = excluded.closed_pnl,
      hash = excluded.hash,
      source = excluded.source,
      payload_json = excluded.payload_json
  `);

  const upsertEvent = database.prepare(`
    INSERT INTO events (
      id, whale_id, time, kind, coin, side, usd, title, payload_json
    ) VALUES (
      @id, @whale_id, @time, @kind, @coin, @side, @usd, @title, @payload_json
    )
    ON CONFLICT(id) DO UPDATE SET
      whale_id = excluded.whale_id,
      time = excluded.time,
      kind = excluded.kind,
      coin = excluded.coin,
      side = excluded.side,
      usd = excluded.usd,
      title = excluded.title,
      payload_json = excluded.payload_json
  `);

  const existsFill = database.prepare('SELECT 1 AS x FROM fills WHERE id = ?');
  const existsEvent = database.prepare('SELECT 1 AS x FROM events WHERE id = ?');
  let added = 0;

  const tx = database.transaction(() => {
    for (const whale of whales) {
      if (!whale?.id) continue;
      upsertWhale.run({
        id: String(whale.id),
        name: String(whale.name || ''),
        address: String(whale.address || ''),
        enabled: whale.enabled === false ? 0 : 1,
        direction: whale.direction || 'neutral',
        long_usd: Number(whale.longUsd) || 0,
        short_usd: Number(whale.shortUsd) || 0,
        net_usd: Number(whale.netUsd) || 0,
        priority: Number(whale.priority) || 0,
        closed_trades: Number(whale.closedTrades) || 0,
        error: whale.error ? String(whale.error) : null,
        payload_json: safeJson(whale),
        updated_at: now,
      });

      deletePositions.run(String(whale.id));
      for (const pos of whale.positions || []) {
        if (!pos?.coin || !pos?.side) continue;
        insertPosition.run({
          whale_id: String(whale.id),
          coin: String(pos.coin),
          side: String(pos.side),
          size: Number(pos.size) || 0,
          entry_px: Number(pos.entryPx) || 0,
          position_value: Number(pos.positionValue) || 0,
          unrealized_pnl: Number(pos.unrealizedPnl) || 0,
          leverage: pos.leverage == null ? null : Number(pos.leverage),
          open_time: pos.openTime == null ? null : Number(pos.openTime) || null,
          payload_json: safeJson(pos),
          updated_at: now,
        });
      }
    }

    const derivedAlerts = [];
    for (const trade of trades) {
      const id = String(trade?.id || trade?.hash || '');
      if (!id) continue;
      if (!existsFill.get(id)) added += 1;
      upsertFill.run({
        id,
        whale_id: trade.whaleId ? String(trade.whaleId) : null,
        time: Number(trade.time) || 0,
        asset: coinOfTrade(trade),
        side: String(trade.side || ''),
        amount: Number(trade.amount) || 0,
        amount_usd: Number(trade.amountUsd) || 0,
        price: Number(trade.price) || 0,
        closed_pnl: Number(trade.closedPnl) || 0,
        hash: trade.hash ? String(trade.hash) : null,
        source: trade.source ? String(trade.source) : 'hyperliquid',
        payload_json: safeJson(trade),
      });
      for (const event of eventsFromTrade(trade)) {
        if (!existsEvent.get(event.id)) added += 1;
        upsertEvent.run({
          id: event.id,
          whale_id: event.whaleId,
          time: event.time,
          kind: event.kind,
          coin: event.coin,
          side: event.side,
          usd: event.usd,
          title: event.title,
          payload_json: safeJson(event.payload),
        });
        const alertDoc = alertDocFromEvent(event);
        if (alertDoc) derivedAlerts.push(alertDoc);
      }
    }
    const alertResult = upsertAlertRows(database, derivedAlerts);
    added += alertResult.added || 0;
  });

  tx();
  if (added) bumpDailyAdded(added);
  setMeta('whales_updated_at', String(now));
  setMeta('warnings', safeJson(data.warnings || []));
  setMeta('min_usd', String(data.minUsd ?? 1000));
  const purged = purgeOlderThan(RETENTION_MS);
  return { whales: whales.length, trades: trades.length, added, purged };
}

function hasWhaleData() {
  try {
    const row = getDb().prepare('SELECT COUNT(*) AS c FROM whales').get();
    return Number(row?.c) > 0;
  } catch {
    return false;
  }
}

function loadModePayload() {
  if (!hasWhaleData()) return null;
  const database = getDb();
  const meta = getMeta('whales_updated_at');
  const updatedAt = meta ? Number(meta.value) || meta.updatedAt : Date.now();
  const cutoff = Date.now() - FILL_RETENTION_MS;

  const whaleRows = database
    .prepare('SELECT payload_json FROM whales WHERE enabled = 1 ORDER BY priority DESC, closed_trades DESC')
    .all();
  const whales = whaleRows
    .map((row) => parseJson(row.payload_json, null))
    .filter(Boolean);

  const fillRows = database
    .prepare('SELECT payload_json FROM fills WHERE time >= ? ORDER BY time DESC LIMIT 5000')
    .all(cutoff);
  const trades = fillRows
    .map((row) => parseJson(row.payload_json, null))
    .filter(Boolean);

  const warnings = parseJson(getMeta('warnings')?.value, []) || [];
  const minUsd = Number(getMeta('min_usd')?.value) || 1000;

  return {
    data: {
      whales,
      trades,
      warnings: Array.isArray(warnings) ? warnings : [],
      minUsd,
    },
    updatedAt,
    source: 'sqlite',
  };
}

function loadRecentEvents(limit = 200) {
  const cutoff = Date.now() - RETENTION_MS;
  const rows = getDb()
    .prepare(
      `SELECT id, whale_id, time, kind, coin, side, usd, title, payload_json
       FROM events WHERE time >= ? ORDER BY time DESC LIMIT ?`,
    )
    .all(cutoff, Math.max(1, Math.min(2000, Number(limit) || 200)));
  return rows.map((row) => ({
    id: row.id,
    whaleId: row.whale_id,
    time: row.time,
    kind: row.kind,
    coin: row.coin,
    side: row.side,
    usd: row.usd,
    title: row.title,
    trade: parseJson(row.payload_json, null),
  }));
}

module.exports = {
  loadResonanceInputs,
  countStoredAlerts,
  persistModePayload,
  persistTradesIncremental,
  loadModePayload,
  loadRecentEvents,
  loadRecentAlerts,
  loadAlertFlowSummary,
  loadPagedAlerts,
  loadDbBrowse,
  loadFillsByWhale,
  loadRecentFills,
  countFillsByWhale,
  persistAlerts,
  hasWhaleData,
  eventsFromTrade,
};
