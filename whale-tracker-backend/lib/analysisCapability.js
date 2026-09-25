/**
 * analysisCapability：按能力维度评估，而非简单缺失比例
 */

function freshnessScore(fetchedAt, ttlMs) {
  if (!fetchedAt) return 0;
  const age = Date.now() - Number(fetchedAt);
  if (age < 0) return 1;
  if (age >= ttlMs) return 0.15;
  return Math.max(0.15, 1 - age / ttlMs);
}

function statusOk(mod) {
  return mod && (mod.status === 'ok' || mod.status === 'empty');
}

function statusAvailable(mod) {
  return mod && mod.status === 'ok';
}

/**
 * @param {object} ctx buildMarketBriefContext 结果
 */
function buildAnalysisCapability(ctx) {
  const st = ctx.statusMeta || {};
  const ttl = {
    price: 10_000,
    technical: 180_000,
    derivatives: 60_000,
    whales: 120_000,
    news: 900_000,
  };

  const price = {
    required: true,
    ok: ctx.market?.price != null,
    fresh: freshnessScore(
      st.price?.status === 'ok' ? st.price?.fetchedAt : st.technical?.fetchedAt,
      st.price?.status === 'ok' ? ttl.price : ttl.technical,
    ),
    status: ctx.market?.price != null ? 'ok' : 'unavailable',
  };
  const technical = {
    important: true,
    ok: Boolean(ctx.tech?.available),
    fresh: freshnessScore(st.technical?.fetchedAt, ttl.technical),
    status: st.technical?.status || (ctx.tech?.available ? 'ok' : 'unavailable'),
  };
  const derivatives = {
    important: true,
    ok: statusAvailable({ status: st.derivatives?.status }) || Boolean(ctx.sentiment?.liquidations || ctx.sentiment?.fundingPct != null),
    fresh: freshnessScore(st.derivatives?.fetchedAt, ttl.derivatives),
    status: st.derivatives?.status || 'unavailable',
  };
  const news = {
    required: true,
    ok: (ctx.news?.length || 0) + (ctx.webNews?.length || 0) > 0,
    fresh: freshnessScore(st.news?.fetchedAt, ttl.news),
    status: st.news?.status || 'unavailable',
  };
  const whalesExt = {
    required: true,
    ok:
      Boolean(ctx.sentiment?.external?.binanceTopAccount) ||
      Boolean(ctx.sentiment?.external?.bybitAccount) ||
      (ctx.sentiment?.external?.onchainWhales || []).length > 0 ||
      (ctx.whales?.longCount || 0) + (ctx.whales?.shortCount || 0) > 0,
    fresh: freshnessScore(st.whales?.fetchedAt, ttl.whales),
    status: st.whales?.status || 'unavailable',
  };

  function scoreParts(parts) {
    let w = 0;
    let s = 0;
    for (const p of parts) {
      const weight = p.required ? 2 : p.important ? 1.2 : 1;
      w += weight;
      const avail = p.ok ? 1 : p.status === 'empty' ? 0.35 : 0;
      s += weight * avail * (0.55 + 0.45 * (p.fresh || 0));
    }
    return w ? Number((s / w).toFixed(3)) : 0;
  }

  function capability(name, parts, requiredKeys) {
    const missingRequired = requiredKeys.filter((k) => {
      const p = parts.find((x) => x.key === k);
      return p && !p.ok && p.status !== 'empty';
    });
    const score = scoreParts(parts);
    const available = missingRequired.length === 0 && score >= 0.25;
    return {
      name,
      available,
      score,
      status: available ? 'ok' : 'unavailable',
      missingRequired: missingRequired.map((k) => k),
      parts: parts.map((p) => ({
        key: p.key,
        status: p.status,
        ok: p.ok,
        fresh: Number((p.fresh || 0).toFixed(3)),
      })),
    };
  }

  const shortTerm = capability(
    'shortTerm',
    [
      { key: 'price', ...price, required: true },
      { key: 'technical', ...technical, important: true },
      { key: 'derivatives', ...derivatives, important: true },
    ],
    ['price'],
  );

  const newsDriven = capability(
    'newsDriven',
    [{ key: 'news', ...news, required: true }],
    ['news'],
  );

  const whaleAnalysis = capability(
    'whaleAnalysis',
    [{ key: 'whales', ...whalesExt, required: true }],
    ['whales'],
  );

  return {
    shortTerm,
    newsDriven,
    whaleAnalysis,
    asOf: Date.now(),
  };
}

module.exports = {
  buildAnalysisCapability,
  freshnessScore,
};
