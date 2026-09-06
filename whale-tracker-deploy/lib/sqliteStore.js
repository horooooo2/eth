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
  dbStatus,
  bumpDailyAdded,
  readDailyIoStats,
} = require('./db');

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
  const start = Number(trade.startPosition);
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
  } else if (/short/i.test(dir)) {
    side = 'short';
    isOpen = /open/i.test(dir);
  } else if (/long/i.test(dir)) {
    side = 'long';
    isOpen = /open/i.test(dir);
  } else {
    // 无仓位上下文时退回 closedPnl；方向仍不可靠，仅用于减仓类
    isClose = Math.abs(Number(trade.closedPnl) || 0) > 1;
    side = buy ? 'long' : 'short';
    if (!isClose) {
      // 无法确认是加多还是平空时，不写开/加事件
      return [];
    }
  }

  if (!side) return [];

  const openKind = isClose
    ? 'decrease'
    : isOpen || Number(trade._asOpen)
      ? 'open'
      : 'increase';
  const title = isClose
    ? side === 'long'
      ? `减/平多 ${coin}`
      : `减/平空 ${coin}`
    : side === 'long'
      ? `开/加多 ${coin}`
      : `开/加空 ${coin}`;
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
    },
  ];
}

/** 开/补仓事件 → 前端 WhaleAlert 形状（供右侧异动持久化） */
function alertDocFromEvent(event) {
  if (!event || (event.kind !== 'open' && event.kind !== 'increase')) return null;
  const kindLabel = event.kind === 'open' ? '开单' : '加仓';
  const sideLabel = event.side === 'short' ? '空' : '多';
  return {
    id: String(event.id),
    at: Number(event.time) || Date.now(),
    whaleId: event.whaleId ? String(event.whaleId) : '',
    whaleName: event.payload?.whaleName || '',
    address: event.payload?.from || event.payload?.address || '',
    kind: event.kind,
    kindLabel,
    headline: event.title || `${kindLabel} ${event.coin || ''}`.trim(),
    items: [
      {
        kind: event.kind,
        title: event.title || `${kindLabel}${sideLabel} ${event.coin || ''}`.trim(),
        detail: '',
        coin: event.coin || undefined,
        side: event.side === 'short' ? 'short' : 'long',
        usd: Number(event.usd) || 0,
        time: Number(event.time) || 0,
        price: event.payload?.price ?? null,
      },
    ],
    layer: 'position',
  };
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
  let written = 0;
  let added = 0;
  for (const alert of alerts) {
    if (!alert?.id) continue;
    const kind = String(alert.kind || '');
    if (kind !== 'open' && kind !== 'increase') continue;
    const time = Number(alert.at || alert.time) || 0;
    if (!time) continue;
    const id = String(alert.id);
    if (!exists.get(id)) added += 1;
    stmt.run({
      id,
      whale_id: alert.whaleId ? String(alert.whaleId) : null,
      time,
      kind,
      payload_json: safeJson(alert),
    });
    written += 1;
  }
  return { written, added };
}

/** 前端同步异动历史（开仓/补仓） */
function persistAlerts(alerts = []) {
  const list = Array.isArray(alerts) ? alerts : [];
  const database = getDb();
  const tx = database.transaction(() => upsertAlertRows(database, list));
  const result = tx();
  if (result.added) bumpDailyAdded(result.added);
  const purged = purgeOlderThan(RETENTION_MS);
  return { saved: result.written, added: result.added, purged };
}

function loadRecentAlerts(limit = 500) {
  const cutoff = Date.now() - RETENTION_MS;
  const rows = getDb()
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

/**
 * 异动分页查询（开/补仓）。
 * query: page, limit, whaleId, kind(open|increase|all), coin, side(long|short|all),
 *        minUsd, sinceMs
 */
function loadPagedAlerts(query = {}) {
  const page = Math.max(1, Number(query.page) || 1);
  const limit = Math.max(1, Math.min(100, Number(query.limit) || 50));
  const offset = (page - 1) * limit;
  const cutoff = Math.max(
    Date.now() - RETENTION_MS,
    Number(query.sinceMs) || 0,
  );
  const whaleId = String(query.whaleId || '').trim();
  const kind = String(query.kind || 'all').trim().toLowerCase();
  const coin = String(query.coin || '').trim().toUpperCase();
  const side = String(query.side || 'all').trim().toLowerCase();
  const minUsd = Math.max(0, Number(query.minUsd) || 0);

  const where = [`time >= ?`, `kind IN ('open', 'increase')`];
  const params = [cutoff];

  if (whaleId) {
    where.push('whale_id = ?');
    params.push(whaleId);
  }
  if (kind === 'open' || kind === 'increase') {
    where.push('kind = ?');
    params.push(kind);
  }
  if (coin && coin !== 'ALL') {
    where.push(
      `UPPER(COALESCE(json_extract(payload_json, '$.items[0].coin'), '')) = ?`,
    );
    params.push(coin);
  }
  if (side === 'long' || side === 'short') {
    where.push(
      `LOWER(COALESCE(json_extract(payload_json, '$.items[0].side'), '')) = ?`,
    );
    params.push(side);
  }
  if (minUsd > 0) {
    where.push(
      `COALESCE(json_extract(payload_json, '$.items[0].usd'), 0) >= ?`,
    );
    params.push(minUsd);
  }

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

  // 分面：在 whale/since/kind/minUsd 基础上统计（不含 coin/side，便于筛选项数字）
  const facetWhere = [`time >= ?`, `kind IN ('open', 'increase')`];
  const facetParams = [cutoff];
  if (whaleId) {
    facetWhere.push('whale_id = ?');
    facetParams.push(whaleId);
  }
  if (kind === 'open' || kind === 'increase') {
    facetWhere.push('kind = ?');
    facetParams.push(kind);
  }
  if (minUsd > 0) {
    facetWhere.push(
      `COALESCE(json_extract(payload_json, '$.items[0].usd'), 0) >= ?`,
    );
    facetParams.push(minUsd);
  }
  const facetSql = facetWhere.join(' AND ');
  const allCount =
    Number(
      database.prepare(`SELECT COUNT(*) AS c FROM alerts WHERE ${facetSql}`).get(...facetParams)
        ?.c,
    ) || 0;
  const coinRows = database
    .prepare(
      `SELECT UPPER(COALESCE(json_extract(payload_json, '$.items[0].coin'), '')) AS coin, COUNT(*) AS c
       FROM alerts WHERE ${facetSql}
       GROUP BY coin`,
    )
    .all(...facetParams);
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
          `SELECT COUNT(*) AS c FROM alerts WHERE ${facetSql}
           AND LOWER(COALESCE(json_extract(payload_json, '$.items[0].side'), '')) = 'long'`,
        )
        .get(...facetParams)?.c,
    ) || 0;
  const shortCount =
    Number(
      database
        .prepare(
          `SELECT COUNT(*) AS c FROM alerts WHERE ${facetSql}
           AND LOWER(COALESCE(json_extract(payload_json, '$.items[0].side'), '')) = 'short'`,
        )
        .get(...facetParams)?.c,
    ) || 0;

  return {
    alerts,
    total,
    page,
    limit,
    retentionDays: 7,
    facets: {
      all: allCount,
      byCoin,
      long: longCount,
      short: shortCount,
    },
  };
}

function loadFillsByWhale(whaleId, options = {}) {
  const id = String(whaleId || '');
  if (!id) return [];
  const limit = Math.max(
    1,
    Math.min(
      Number(options.limit) || Number(process.env.FILL_MAX_PER_WHALE) || 10000,
      Number(process.env.FILL_MAX_PER_WHALE) || 10000,
    ),
  );
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
  const alertCutoff = Date.now() - RETENTION_MS;
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
    alertRetentionDays: Math.round(RETENTION_MS / (24 * 60 * 60 * 1000)),
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
  persistModePayload,
  persistTradesIncremental,
  loadModePayload,
  loadRecentEvents,
  loadRecentAlerts,
  loadPagedAlerts,
  loadDbBrowse,
  loadFillsByWhale,
  loadRecentFills,
  countFillsByWhale,
  persistAlerts,
  hasWhaleData,
  eventsFromTrade,
};
