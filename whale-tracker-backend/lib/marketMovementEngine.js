'use strict';
const MINUTE = 60000, DAY = 86400000;
function validBar(bar) {
  return bar && Number.isSafeInteger(bar.time) && bar.time >= 0 && bar.time % MINUTE === 0
    && ['open', 'close', 'high', 'low'].every(key => Number.isFinite(bar[key]) && bar[key] > 0)
    && bar.high >= Math.max(bar.open, bar.close) && bar.low <= Math.min(bar.open, bar.close);
}
function createEngine({ now = Date.now, maxEvents = 1000 } = {}) {
  const states = new Map(); let events = [];
  function configure(contracts) {
    const selected = new Set(contracts.slice(0, 100).map(row => row.symbol));
    for (const symbol of states.keys()) if (!selected.has(symbol)) states.delete(symbol);
    for (const row of contracts.slice(0, 100)) {
      if (!states.has(row.symbol)) states.set(row.symbol, { bars: [], day: null, cooldown: new Map() });
      states.get(row.symbol).contract = row;
    }
  }
  function emit(state, bar, kind, label, change, referencePrice) {
    if (bar.time + MINUTE < now() - 120000 || bar.time + MINUTE > now()) return;
    if (bar.time - (state.cooldown.get(kind) ?? -Infinity) < 5 * MINUTE) return;
    state.cooldown.set(kind, bar.time);
    events.push({ id: `${state.contract.symbol}:${bar.time}:${kind}`, symbol: state.contract.symbol,
      name: state.contract.name, kind, label, change, price: bar.close, referencePrice,
      time: bar.time + MINUTE, direction: kind === 'HIGH' ? 'UP' : kind === 'LOW' || change < 0 ? 'DOWN' : 'UP' });
    if (events.length > maxEvents) events.splice(0, events.length - maxEvents);
  }
  function append(state, bar, notify) {
    if (!validBar(bar) || bar.time + MINUTE > now()) return false;
    const previous = state.bars.at(-1);
    if (previous && bar.time <= previous.time) return false;
    const dayAt = Math.floor(bar.time / DAY) * DAY;
    if (!state.day || state.day.time !== dayAt) state.day = {
      time: dayAt, open: bar.open, high: bar.high, low: bar.low, complete: bar.time === dayAt,
    };
    else {
      if (!previous || bar.time !== previous.time + MINUTE) state.day.complete = false;
      if (notify && state.day.complete) {
        if (bar.high > state.day.high) emit(state, bar, 'HIGH', '今日新高', (bar.close / state.day.open - 1) * 100, state.day.open);
        if (bar.low < state.day.low) emit(state, bar, 'LOW', '今日新低', (bar.close / state.day.open - 1) * 100, state.day.open);
      }
      state.day.high = Math.max(state.day.high, bar.high); state.day.low = Math.min(state.day.low, bar.low);
    }
    state.bars.push(bar);
    if (state.bars.length > 121) state.bars.shift();
    if (notify) for (const [minutes, label] of [[5, '5分钟'], [120, '2小时']]) {
      const rows = state.bars, baseline = rows[rows.length - minutes - 1];
      if (!baseline || baseline.time !== bar.time - minutes * MINUTE) continue;
      // Exactly minutes+1 distinct minute bars imply no missing minute in this window.
      const change = (bar.close / baseline.close - 1) * 100, magnitude = Math.abs(change);
      if (magnitude + 1e-9 < 3) continue;
      const level = magnitude + 1e-9 >= 11 ? '大' : magnitude + 1e-9 >= 7 ? '中' : '小';
      const side = change > 0 ? '涨' : '跌';
      emit(state, bar, `${minutes}:${level}:${side}`, `${label}${level}${side}`, change, baseline.close);
    }
    return true;
  }
  function ingest(symbol, bar) { const state = states.get(symbol); return state ? append(state, bar, true) : false; }
  function seed(symbol, bars) {
    const state = states.get(symbol); if (!state || !Array.isArray(bars)) return;
    // REST may finish after live bars: merge by open time; live data wins and seed never alerts.
    const merged = new Map(bars.filter(validBar).map(bar => [bar.time, bar]));
    for (const bar of state.bars) merged.set(bar.time, bar);
    const ordered = [...merged.values()].sort((a, b) => a.time - b.time);
    state.bars = []; state.day = null;
    for (const bar of ordered) append(state, bar, false);
  }
  function snapshot() {
    const time = now(), today = Math.floor(time / DAY) * DAY;
    events = events.filter(row => row.time >= time - DAY);
    let ready5m = 0, ready2h = 0, readyDay = 0, latestAt = null;
    for (const state of states.values()) {
      const last = state.bars.at(-1); if (!last) continue;
      latestAt = Math.max(latestAt || 0, last.time + MINUTE);
      if (time - last.time - MINUTE > 120000) continue;
      const baseline5 = state.bars.at(-6), baseline120 = state.bars.at(-121);
      if (baseline5?.time === last.time - 5 * MINUTE) ready5m++;
      if (baseline120?.time === last.time - 120 * MINUTE) ready2h++;
      if (state.day?.time === today && state.day.complete) readyDay++;
    }
    return { events: [...events].sort((a, b) => b.time - a.time || a.id.localeCompare(b.id)),
      monitored: states.size, ready5m, ready2h, readyDay, latestAt };
  }
  return { configure, ingest, seed, snapshot, latest: symbol => states.get(symbol)?.bars.at(-1)?.time,
    buffered: () => [...states.values()].reduce((sum, state) => sum + state.bars.length, 0) };
}
module.exports = { createEngine, validBar, MINUTE, DAY };
