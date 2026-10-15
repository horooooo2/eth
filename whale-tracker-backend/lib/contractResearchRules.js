'use strict';
const VERSION = 'contract-research-v4';
const { extractFacts, quoteEvidence, dateOnly, dateSupported } = require('./contractResearchWeb');
const DAY = 86400000;
const DIMENSIONS = [
  ['technical', '技术面', 25, 'RSI、均线、趋势与支撑阻力是否形成一致证据？'],
  ['institutional', '机构共识', 25, '公开评级、目标价与机构分歧支持哪一侧？持仓不等于观点。'],
  ['fundamental', '基本面', 20, '财务、指引、产品价格与行业供需如何变化？'],
  ['event', '事件催化', 20, '财报、宏观及行业事件有哪些已知影响与待验证条件？'],
  ['flows', '资金／空头', 10, '合约主动成交、持仓及可核对的股票空头资料如何相互印证？'],
].map(([id, label, weight, question]) => ({ id, label, weight, question }));
function number(value) {
  if (value == null || value === '' || typeof value === 'boolean') return null;
  const n = Number(value); return Number.isFinite(n) ? n : null;
}
function safeUrl(value) {
  try { const u = new URL(value); return ['https:', 'http:'].includes(u.protocol) && !u.username && !u.password ? u.href : null; } catch { return null; }
}
function mean(values) { return values.reduce((sum, n) => sum + n, 0) / values.length; }
function technicalFrame(input, interval, now = Date.now()) {
  const ms = { '1h': 3600000, '4h': 14400000, '1d': DAY }[interval];
  const unavailable = (reason) => ({ interval, available: false, reason, bull: null, bear: null });
  if (!ms || input?.stale || !input?.available) return unavailable('K 线缺失或已过期');
  const bars = (input.bars || []).filter(b => number(b.closeTime) != null && b.closeTime < now);
  if (bars.length < 55) return unavailable('已收盘 K 线不足 55 根');
  const window = bars.slice(-55);
  if (window.some((b, i) => ![b.open, b.high, b.low, b.close, b.volume, b.openTime, b.closeTime].every(v => number(v) != null)
    || Math.min(b.open, b.high, b.low, b.close) <= 0 || b.volume < 0
    || b.high < Math.max(b.open, b.close) || b.low > Math.min(b.open, b.close) || b.high < b.low
    || b.closeTime !== b.openTime + ms - 1 || (i > 0 && b.openTime !== window[i - 1].openTime + ms))) return unavailable('K 线不连续或价格字段异常');
  const last = window.at(-1);
  if (now - last.closeTime > ms * 1.25) return unavailable('最近已收盘 K 线不够新鲜');
  const closes = window.map(b => b.close), ma20 = mean(closes.slice(-20)), ma50 = mean(closes.slice(-50));
  const momentum = (last.close / window.at(-6).close - 1) * 100;
  const previous20 = window.slice(-21, -1), high20 = Math.max(...previous20.map(b => b.high)), low20 = Math.min(...previous20.map(b => b.low));
  const changes = closes.slice(-15).slice(1).map((v, i) => v - closes.slice(-15)[i]);
  const gain = mean(changes.map(v => Math.max(v, 0))), loss = mean(changes.map(v => Math.max(-v, 0)));
  const rsi = gain === 0 && loss === 0 ? 50 : loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  const tr = window.slice(-14).map((b, i) => Math.max(b.high - b.low, Math.abs(b.high - window[window.length - 15 + i].close), Math.abs(b.low - window[window.length - 15 + i].close)));
  const bull = (last.close > ma20 ? 3 : 0) + (ma20 > ma50 ? 3 : 0) + (momentum > 0.2 ? 2 : 0) + (last.close > high20 ? 2 : 0);
  const bear = (last.close < ma20 ? 3 : 0) + (ma20 < ma50 ? 3 : 0) + (momentum < -0.2 ? 2 : 0) + (last.close < low20 ? 2 : 0);
  return { interval, available: true, bull, bear, close: last.close, ma20, ma50, momentum, rsi, atr: mean(tr), high20, low20, asOf: last.closeTime };
}
function technicalSummary(klines, horizon, now = Date.now()) {
  const frames = ['1h', '4h', '1d'].map(interval => technicalFrame(klines?.[interval], interval, now));
  const weights = horizon === 30 ? [0.1, 0.3, 0.6] : horizon === 7 ? [0.2, 0.5, 0.3] : [0.4, 0.4, 0.2];
  const complete = frames.every(f => f.available);
  return { frames, available: complete, bull: complete ? Number(frames.reduce((s, f, i) => s + f.bull * weights[i], 0).toFixed(1)) : null,
    bear: complete ? Number(frames.reduce((s, f, i) => s + f.bear * weights[i], 0).toFixed(1)) : null,
    reason: complete ? '基于已收盘的 1h / 4h / 日线；RSI 仅作背景，不把超卖直接计为看多。' : '三个周期尚未完整，仅展示可用周期，不补算总分。' };
}
function aggregate(dimensions) {
  const known = dimensions.filter(d => number(d.bull) != null && number(d.bear) != null);
  const coverage = known.reduce((s, d) => s + d.weight, 0);
  const bounds = (side) => {
    const lower = known.reduce((s, d) => s + d[side] * d.weight / 100, 0);
    return { low: Number(lower.toFixed(2)), high: Number((lower + (100 - coverage) / 10).toFixed(2)) };
  };
  return { coverage, available: coverage >= 65, bull: coverage >= 65 ? bounds('bull') : null, bear: coverage >= 65 ? bounds('bear') : null,
    label: coverage < 65 ? '证据不足，暂不汇总' : coverage < 100 ? '部分覆盖 · 显示可能区间' : '证据支持度 · 非胜率',
    missing: dimensions.filter(d => !known.includes(d)).map(d => d.label) };
}
function eventTime(event) {
  if (event.at && Number.isFinite(Date.parse(event.at))) return Date.parse(event.at);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(event.date || '')) return null;
  const time = /^\d{2}:\d{2}$/.test(event.time || '') ? event.time : '00:00';
  const stamp = Date.parse(`${event.date}T${time}:00+08:00`); return Number.isFinite(stamp) ? stamp : null;
}
function eventRange(event) {
  const start = eventTime(event);
  return { start, end: start != null && !event.at && !/^\d{2}:\d{2}$/.test(event.time || '') ? start + DAY - 1 : start };
}
function eventWindows(events, now = Date.now()) {
  return [3, 7, 30].map(days => ({ days, events: events.filter(e => { const { start, end } = eventRange(e); return start != null && end >= now && start <= now + days * DAY; }).map(e => e.id) }));
}
function calculateStress({ notional, margin, side, days, fundingRate, intervalHours }) {
  const amount = number(notional), cash = number(margin), rate = number(fundingRate), interval = number(intervalHours);
  if (!(amount > 0) || amount > 1e12 || !['long', 'short'].includes(side) || ![3, 7, 30].includes(days)) throw Object.assign(new Error('请填写有效名义金额、方向和持有周期'), { status: 400 });
  const sign = side === 'long' ? 1 : -1;
  return { notional: amount, margin: cash > 0 ? cash : null, side, days,
    moves: [-20, -10, -5, 5, 10, 20].map(move => { const pnl = amount * move / 100 * sign; return { move, pnl, marginRatio: cash > 0 ? pnl / cash * 100 : null }; }),
    funding: rate != null && interval > 0 && interval <= 24 ? [0.5, 1, 2].map(multiplier => ({ multiplier, cost: amount * rate * sign * days * 24 / interval * multiplier })) : [],
    note: '固定初始名义金额的情景测算，未计手续费、滑点及资金费计费名义金额变化；资金费假设不代表预测，不计算强平价。' };
}
function parseAnalysis(raw, snapshot, research) {
  let parsed;
  try { parsed = JSON.parse(String(raw).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')); } catch { throw new Error('AI 返回格式不正确，请重试'); }
  if (!parsed || typeof parsed.summary !== 'string' || !parsed.summary.trim()) throw new Error('AI 未返回有效研判摘要');
  const materials = [...snapshot.sources, ...(research?.sources || [])];
  const facts = extractFacts(parsed, research, snapshot.generatedAt);
  const usable = s => !s.stale && safeUrl(s.url) && (['financial', 'computed', 'macro', 'event'].includes(s.kind)
    || (s.kind === 'web' && ['read', 'indexed'].includes(s.verification) && s.text));
  const validIds = new Set(materials.filter(usable).map(s => s.id));
  const refs = value => Array.isArray(value) ? [...new Set(value.filter(id => typeof id === 'string' && validIds.has(id)))].slice(0, 5) : [];
  const cleanItems = value => (Array.isArray(value) ? value : []).slice(0, 6).flatMap(item => {
    const sourceIds = refs(item?.sourceIds); return typeof item?.text === 'string' && item.text.trim() && sourceIds.length ? [{ text: item.text.trim().slice(0, 650), sourceIds }] : [];
  });
  const dimensions = snapshot.dimensions.map(d => {
    if (['technical', 'flows'].includes(d.id)) return d;
    const input = (Array.isArray(parsed.dimensions) ? parsed.dimensions : []).find(item => item?.id === d.id);
    const bull = number(input?.bull), bear = number(input?.bear), sourceIds = refs(input?.sourceIds);
    if (bull == null || bear == null || bull < 0 || bull > 10 || bear < 0 || bear > 10 || !sourceIds.length || typeof input.reason !== 'string' || !input.reason.trim()) return d;
    // A profile/source directory and an unannounced future event are not factual outcomes.
    const cited = materials.filter(s => sourceIds.includes(s.id));
    const excerpt = quoteEvidence({ sourceId: input.sourceId, quote: input.quote }, research?.sources || []);
    const datedWeb = excerpt && sourceIds.includes(excerpt.source.id) && dateOnly(input.asOf, snapshot.generatedAt) && dateSupported(input.asOf, excerpt.source, excerpt.source.text)
      && snapshot.generatedAt - Date.parse(input.asOf + 'T00:00:00+08:00') <= (d.id === 'institutional' ? 120 : 180) * DAY;
    const official = cited.some(s => ['financial', 'macro'].includes(s.kind) && usable(s));
    if (d.id === 'institutional') {
      if (!datedWeb || !facts.institutions.some(i => !i.stale && i.rating && i.sourceIds.some(id => sourceIds.includes(id)))) return d;
    } else if (!datedWeb && !official) return d;
    return { ...d, bull, bear, reason: input.reason.slice(0, 900), sourceIds, method: cited.some(s => s.verification === 'indexed') ? 'AI 分析 · 搜索摘录待核原文' : 'AI 证据分析 · 主观支持度' };
  });
  const strings = value => (Array.isArray(value) ? value : []).filter(v => typeof v === 'string' && v.trim()).slice(0, 6).map(v => v.slice(0, 650));
  return { summary: parsed.summary.trim().slice(0, 2500), bullEvidence: cleanItems(parsed.bullEvidence), bearEvidence: cleanItems(parsed.bearEvidence),
    conditions: strings(parsed.conditions), invalidations: strings(parsed.invalidations), risks: strings(parsed.risks), limitations: strings(parsed.limitations),
    ...facts, dimensions, scores: aggregate(dimensions) };
}
function buildAlerts(snapshot, analysis = null, now = Date.now()) {
  const alerts = [], thresholds = [];
  const push = (id, level, title, detail, at) => alerts.push({ id: `${snapshot.symbol}:${id}`, level, title, detail, at });
  const frame = snapshot.technical?.frames.find(f => f.interval === '1d' && f.available);
  const rsi = number(frame?.rsi), rsiFresh = rsi != null && frame && now - frame.asOf >= 0 && now - frame.asOf < DAY * 1.25;
  thresholds.push({ id: 'rsi', label: '日线 RSI14', rule: '< 30 或 > 70', value: rsiFresh ? rsi : null, unit: '', triggered: Boolean(rsiFresh && (rsi < 30 || rsi > 70)), near: Boolean(rsiFresh && ((rsi >= 30 && rsi < 35) || (rsi > 65 && rsi <= 70))) });
  if (rsiFresh && (rsi < 30 || rsi > 70)) push('rsi', 'warning', rsi < 30 ? '日线进入超卖区间' : '日线进入超买区间', `RSI14 ${rsi.toFixed(1)}，不单独代表反转或开仓信号。`, frame.asOf);
  else if (rsiFresh && ((rsi >= 30 && rsi < 35) || (rsi > 65 && rsi <= 70))) push('rsi-near', 'warning', `日线 RSI ${rsi.toFixed(1)} 接近${rsi < 35 ? '超卖' : '超买'}区间`, '当前尚未触发正式阈值，接近区间不构成开仓信号。', frame.asOf);
  const quote = snapshot.quote, change = number(quote?.priceChangePercent), quoteFresh = quote && !quote.stale && now - quote.closeTime < 180000;
  thresholds.push({ id: 'price', label: '合约 24h 涨跌幅', rule: '绝对涨跌幅 ≥ 10%', value: quoteFresh ? change : null, unit: '%', triggered: quoteFresh && change != null && Math.abs(change) >= 10 });
  if (quoteFresh && change != null && Math.abs(change) >= 10) push('price', 'danger', '合约价格大幅波动', `24h 涨跌 ${change.toFixed(2)}%，留意流动性和跳空风险。`, quote.closeTime);
  const events = [...(snapshot.events || []), ...(analysis?.events || [])], eventKeys = new Set();
  for (const e of events) {
    const { start: at, end } = eventRange(e), days = at == null ? null : Math.ceil((at - now) / DAY);
    const key = `${e.title}:${at}`;
    if (eventKeys.has(key) || e.stale || end == null || end < now || days == null || days > 7 || !/财报|earnings|CPI|PCE|非农|FOMC|利率/i.test(e.title)) continue;
    eventKeys.add(key); push(`event-${e.id}`, 'warning', `${e.title}临近`, `${days === 0 ? '今天' : `${days} 天内`}公布／举行；结果和市场反应尚未确定。`, at);
  }
  for (const e of (analysis?.events || [])) {
    const at = e.publishedAt ? Date.parse(e.publishedAt + 'T00:00:00+08:00') : eventTime(e);
    if (e.importance !== 'high' || !e.sourceIds?.length || at == null || now - at > 7 * DAY || now < at || /财报|CPI|PCE|非农|FOMC|利率/i.test(e.title)) continue;
    push(`risk-${e.id}`, 'danger', `事件观察：${e.title}`, `AI 基于公开资料整理：${e.note || '需继续核对对该标的的影响。'}`, at);
  }
  const squeeze = analysis?.metrics?.find(m => m.id === 'squeezeRisk' && !m.stale && now - Date.parse(m.asOf + 'T00:00:00+08:00') <= 2 * DAY);
  thresholds.push({ id: 'squeeze', label: 'S3 轧空评分', rule: '≥ 80（本页观察阈值）', value: squeeze?.value ?? null, unit: '', triggered: squeeze?.value >= 80 });
  if (squeeze?.value >= 80) push('squeeze', 'danger', '公开资料提示较高轧空风险', '来自带原文摘录的 S3 数据，请结合其数据日期；不是币安空头账户比。', Date.parse(squeeze.asOf + 'T00:00:00+08:00'));
  thresholds.push({ id: 'foreign', label: '韩股外资连续净卖出', rule: '连续 5 个交易日', value: null, unit: '', triggered: false });
  if (snapshot.market?.baseAsset === 'KORU') push('koru-reset', 'warning', 'KORU 每日重置杠杆', '底层为 MSCI Korea 25/50 指数；多日收益存在路径依赖，不能按固定每周损耗或指数累计涨跌 × 3 计算。', null);
  const bond = snapshot.context?.rows.find(row => row.id === 'DGS10' && !row.stale && row.value != null && now - Date.parse(row.asOf) < 7 * DAY);
  thresholds.push({ id: 'treasury', label: '10Y 美债', rule: '> 5.2% 或 < 4.8%（日频）', value: bond?.value ?? null, unit: '%', triggered: Boolean(bond && (bond.value > 5.2 || bond.value < 4.8)), near: Boolean(bond && ((bond.value >= 4.8 && bond.value <= 4.9) || (bond.value >= 5.1 && bond.value <= 5.2))) });
  if (bond && (bond.value > 5.2 || bond.value < 4.8)) push('treasury', 'warning', '美债收益率进入观察区间', `${bond.asOf} 日频值 ${bond.value}%，不代表当前盘中报价；对标的影响还需结合其他证据。`, Date.parse(bond.asOf + 'T00:00:00+08:00'));
  return { alerts, thresholds, evaluatedAt: now };
}
module.exports = { VERSION, DIMENSIONS, number, safeUrl, technicalFrame, technicalSummary, aggregate, eventTime, eventRange, eventWindows, calculateStress, parseAnalysis, buildAlerts };
