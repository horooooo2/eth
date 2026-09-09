'use strict';
/**
 * Stage 2B production SHADOW accept — browser session control plane only.
 * Does not print tokens, keys, or passphrases.
 */
const fs = require('fs');
const http = require('http');
const path = require('path');
const WebSocket = require('ws');

const OUT_DIR = path.join(__dirname, 'tmp_stage2b_out');
const RUN_MS = 7 * 60 * 1000;
const POLL_MS = 45 * 1000;
const PROD = 'http://43.160.208.168';

fs.mkdirSync(OUT_DIR, { recursive: true });

function getJson(p) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port: 9222, path: p }, (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(d));
          } catch (err) {
            reject(err);
          }
        });
      })
      .on('error', reject);
  });
}

function cdp(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let id = 0;
    const pending = new Map();
    ws.on('open', () => {
      resolve({
        send(method, params = {}) {
          const msgId = ++id;
          return new Promise((res, rej) => {
            pending.set(msgId, { res, rej });
            ws.send(JSON.stringify({ id: msgId, method, params }));
          });
        },
        close() {
          ws.close();
        },
      });
    });
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) rej(new Error(msg.error.message || JSON.stringify(msg.error)));
        else res(msg.result);
      }
    });
    ws.on('error', reject);
  });
}

async function evaluate(client, expression) {
  const out = await client.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (out.exceptionDetails) {
    const d = out.exceptionDetails;
    throw new Error(d.exception && d.exception.description ? d.exception.description : d.text || 'eval failed');
  }
  return out.result && out.result.value;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function screenshot(client, name) {
  const shot = await client.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
  const file = path.join(OUT_DIR, `${name}.png`);
  fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
  return file;
}

const PAGE_HELPERS = String.raw`
(() => {
  const TOKEN_KEY = 'whale-tracker-auth-token';
  function token() { return localStorage.getItem(TOKEN_KEY) || ''; }
  function authUser() {
    try { return JSON.parse(localStorage.getItem('whale-tracker-auth-user') || 'null'); }
    catch { return null; }
  }
  async function api(method, url, body) {
    const headers = { Accept: 'application/json' };
    const t = token();
    if (t) headers.Authorization = 'Bearer ' + t;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text.slice(0, 300) }; }
    return { status: res.status, json };
  }
  function clickExact(tag, text) {
    const els = Array.from(document.querySelectorAll(tag));
    const el = els.find((e) => (e.textContent || '').trim() === text);
    if (!el) return false;
    el.click();
    return true;
  }
  function uiFacts() {
    const text = document.body ? document.body.innerText : '';
    return {
      href: location.href,
      title: document.title,
      hasCabin: text.includes('个人交易舱'),
      hasLoginGate: text.includes('鲸鱼AI 需要登录'),
      hasDeepSeekGate: text.includes('配置鲸鱼AI') && text.includes('DeepSeek'),
      hasOkxGate: text.includes('绑定 OKX') || text.includes('校验并保存'),
      hasSimulatedCang: /模拟仓/.test(text),
      hasPaperCang: /Paper仓/.test(text),
      hasOkxDemo: text.includes('OKX 模拟盘'),
      hasOkxLive: text.includes('OKX 实盘'),
      hasAlphaShadow: text.includes('Alpha执行：SHADOW') || text.includes('Alpha执行： SHADOW') || /Alpha执行[：:]\s*SHADOW/.test(text),
      hasTrendS1: text.includes('趋势跟踪'),
      hasMockMd: /\bmock\b/i.test(text) || text.includes('假K线') || text.includes('fake candle'),
      snippet: text.slice(0, 2500),
      footer: (text.match(/bridge[^\n]{0,200}/) || [''])[0],
      startVisible: Array.from(document.querySelectorAll('button')).some((b) => /启动交易系统|^启动$/.test((b.textContent || '').trim())),
      stopVisible: Array.from(document.querySelectorAll('button')).some((b) => (b.textContent || '').trim() === '停止'),
      applyVisible: Array.from(document.querySelectorAll('button')).some((b) => (b.textContent || '').trim() === '应用'),
      confirmSwitchVisible: Array.from(document.querySelectorAll('button')).some((b) => (b.textContent || '').trim() === '确认切换'),
      selectedOption: (() => {
        const sel = document.querySelector('.strategy-select-row select');
        if (!sel) return null;
        const opt = sel.options[sel.selectedIndex];
        return { value: sel.value, label: opt ? opt.textContent : '' };
      })(),
      systemLogs: Array.from(document.querySelectorAll('.log-entry')).slice(0, 20).map((el) => (el.innerText || '').trim()).filter(Boolean).slice(0, 12),
    };
  }
  window.__s2b = { tokenReady: Boolean(token()), authUser: authUser(), api, clickExact, uiFacts };
  return { tokenReady: Boolean(token()), user: authUser() };
})()
`;

function pickFacts(dash, extras = {}) {
  const snap = (dash && dash.json && dash.json.snapshot) || {};
  const view = (dash && dash.json && dash.json.view) || snap.view || {};
  const engine = view.engine || snap.engine || {};
  const bridge = (dash && dash.json && dash.json.bridge) || {};
  const diag = snap.strategy_diagnostics || extras.diag || {};
  const md = (diag && diag.market_data) || snap.market_data || {};
  const s7 = Array.isArray(snap.s7) ? snap.s7 : [];
  const s7s1 = s7.find((x) => String(x.strategy_id) === 'S1') || s7[0] || {};
  const edge = snap.edge || {};
  const tis = Array.isArray(snap.trade_intents) ? snap.trade_intents : [];
  const ois = Array.isArray(snap.order_intents) ? snap.order_intents : [];
  const pos = Array.isArray(snap.open_positions) ? snap.open_positions : [];
  const recentOi = Array.isArray(view.recent_order_intents) ? view.recent_order_intents : [];
  const statuses = ois.map((o) => String(o.status || o.execution_status || '').toUpperCase());
  return {
    http: dash && dash.status,
    user_id_ready: snap.user_id_ready === true || view.user_id_ready === true || engine.user_id_ready === true,
    account_environment: snap.account_environment || view.account_environment || null,
    alpha_execution: snap.alpha_execution || engine.alpha_execution || null,
    live_permission: snap.live_permission === true || view.live_permission === true || engine.live_permission === true,
    engine_state: engine.state || null,
    active_strategy_id: engine.active_strategy || (view.active_strategy && view.active_strategy.id) || snap.strategy && snap.strategy.id || null,
    alpha_opening_enabled: engine.alpha_opening_enabled,
    evaluation_count: Number(engine.evaluation_count || 0),
    last_tick_at: engine.last_tick_at || null,
    last_evaluated_at: engine.last_evaluated_at || null,
    transport_status: bridge.transport_status || null,
    engine_runtime_status: bridge.engine_runtime_status || bridge.freshness || null,
    strategy_runtime_status: bridge.strategy_runtime_status || null,
    freshness: bridge.freshness || null,
    lastError: bridge.lastError || null,
    market_source: md.source || md.market_source || null,
    instrument: md.instrument || md.symbol || null,
    timeframe: md.timeframe || md.interval || null,
    bars_loaded: md.bars_loaded != null ? Number(md.bars_loaded) : null,
    market_state: md.state || md.market_state || null,
    decision: diag.last_decision || diag.decision || null,
    reason_codes: diag.last_reason_codes || diag.reason_codes || [],
    trade_intent_count: tis.length,
    order_intent_count: ois.length,
    trade_intent_ids: tis.map((t) => t.intent_id || t.id).filter(Boolean),
    order_intent_ids: ois.map((o) => o.order_intent_id || o.id).filter(Boolean),
    would_submit: statuses.filter((s) => s === 'WOULD_SUBMIT').length,
    filled: statuses.filter((s) => s === 'FILLED' || s === 'SIM_FILLED').length,
    order_statuses: statuses,
    open_positions: pos.length,
    position_origins: pos.map((p) => ({
      id: p.position_id || p.id || null,
      origin_strategy_id: p.origin_strategy_id || null,
      origin_trade_intent_id: p.origin_trade_intent_id || null,
      source: (p.metadata && p.metadata.source) || p.source || null,
      paper: Boolean(p.paper || (p.metadata && p.metadata.paper) || String((p.metadata && p.metadata.source) || p.source || '').includes('paper')),
    })),
    s7_sample_count: s7s1.sample_count != null ? Number(s7s1.sample_count) : null,
    edge_sample_count: edge.sample_count != null ? Number(edge.sample_count) : null,
    edge_available: edge.available,
    recent_order_intents: recentOi.map((o) => ({
      id: o.order_intent_id || o.id || null,
      status: o.status || null,
      shadow: o.shadow || null,
    })),
  };
}

function writeReport(obj) {
  const file = path.join(OUT_DIR, 'report.json');
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
  return file;
}

(async () => {
  const report = {
    started_at: new Date().toISOString(),
    anomalies: [],
    polls: [],
    p0_trade_order: false,
  };

  const targets = await getJson('/json/list');
  const page =
    targets.find((t) => t.type === 'page' && String(t.url || '').includes('43.160.208.168')) ||
    targets.find((t) => t.type === 'page');
  if (!page) throw new Error('no CDP page');
  const client = await cdp(page.webSocketDebuggerUrl);
  await client.send('Runtime.enable');
  await client.send('Page.enable');

  await client.send('Page.navigate', { url: PROD + '/#/' });
  await sleep(2500);
  await evaluate(client, PAGE_HELPERS);

  const login = await evaluate(
    client,
    `(() => {
      const u = window.__s2b.authUser;
      return {
        tokenReady: window.__s2b.tokenReady,
        user_id: u && u.id,
        username: u && u.username,
        href: location.href,
      };
    })()`,
  );
  report.login = login;
  console.log('LOGIN', JSON.stringify(login));
  if (!login.tokenReady || !login.user_id) {
    report.anomalies.push('NO_AUTH_SESSION');
    writeReport(report);
    console.log('STAGE2B_FAIL no session');
    client.close();
    process.exit(2);
  }

  const clickedAi = await evaluate(client, `window.__s2b.clickExact('button', '鲸鱼AI') || window.__s2b.clickExact('span', '鲸鱼AI')`);
  console.log('CLICK_WHALE_AI', clickedAi);
  await sleep(3500);
  await evaluate(client, PAGE_HELPERS);
  let ui0 = await evaluate(client, `window.__s2b.uiFacts()`);
  report.ui_after_nav = {
    hasCabin: ui0.hasCabin,
    hasLoginGate: ui0.hasLoginGate,
    hasDeepSeekGate: ui0.hasDeepSeekGate,
    hasOkxGate: ui0.hasOkxGate,
    href: ui0.href,
    selectedOption: ui0.selectedOption,
  };
  console.log('UI_NAV', JSON.stringify(report.ui_after_nav));
  await screenshot(client, '01_cabin_before_start');

  async function api(method, url, body) {
    const expr =
      body === undefined
        ? `window.__s2b.api(${JSON.stringify(method)}, ${JSON.stringify(url)})`
        : `window.__s2b.api(${JSON.stringify(method)}, ${JSON.stringify(url)}, ${JSON.stringify(body)})`;
    return evaluate(client, expr);
  }

  const [dash0, trade0, keys0, selections0, diag0, pos0] = await Promise.all([
    api('GET', '/api/whale-ai/engine/dashboard'),
    api('GET', '/api/whale-ai/trade/status'),
    api('GET', '/api/whale-ai/trade/keys'),
    api('GET', '/api/whale-ai/engine/execution/selections'),
    api('GET', '/api/whale-ai/engine/strategy/S1/diagnostics'),
    api('GET', '/api/whale-ai/trade/positions'),
  ]);

  report.pre_http = {
    dashboard: dash0.status,
    trade_status: trade0.status,
    keys: keys0.status,
    selections: selections0.status,
    diagnostics: diag0.status,
    positions: pos0.status,
  };
  console.log('PRE_HTTP', JSON.stringify(report.pre_http));

  if (dash0.status === 401 || trade0.status === 401) {
    report.anomalies.push('SESSION_REJECTED_401');
    writeReport(report);
    console.log('STAGE2B_FAIL 401');
    client.close();
    process.exit(2);
  }

  const tradeJson = trade0.json || {};
  const keysJson = keys0.json || {};
  report.account_truth = {
    session_user_id: login.user_id,
    trade_status_simulated: tradeJson.simulated,
    trade_status_ready: tradeJson.ready,
    trade_status_configured: tradeJson.configured,
    keys_okx_simulated: keysJson.okx && keysJson.okx.simulated,
    keys_okx_configured: keysJson.okx && keysJson.okx.configured,
    keys_okx_ready: keysJson.okx && keysJson.okx.ready,
    keys_okx_hint_present: Boolean(keysJson.okx && keysJson.okx.apiKeyHint),
  };
  const expectedEnv =
    report.account_truth.keys_okx_simulated === false || report.account_truth.trade_status_simulated === false
      ? 'OKX_LIVE'
      : 'OKX_DEMO';
  report.account_truth.expected_account_environment = expectedEnv;

  const baseline = pickFacts(dash0, { diag: diag0.json });
  report.baseline = baseline;
  report.exchange_positions_pre = {
    http: pos0.status,
    count: Array.isArray(pos0.json && pos0.json.positions) ? pos0.json.positions.length : Array.isArray(pos0.json) ? pos0.json.length : null,
    error: pos0.json && (pos0.json.error || pos0.json.code) || null,
  };
  console.log('BASELINE', JSON.stringify(baseline, null, 2));
  console.log('ACCOUNT_TRUTH', JSON.stringify(report.account_truth));

  if (baseline.account_environment !== expectedEnv) {
    report.anomalies.push(
      `ACCOUNT_ENV_MISMATCH dashboard=${baseline.account_environment} keys.simulated→${expectedEnv}`,
    );
  }
  if (baseline.alpha_execution !== 'SHADOW') {
    report.anomalies.push(`ALPHA_NOT_SHADOW ${baseline.alpha_execution}`);
  }
  if (baseline.live_permission === true) {
    report.anomalies.push('LIVE_PERMISSION_TRUE');
  }

  const selJson = selections0.json || {};
  report.selections_pre = {
    http: selections0.status,
    active: selJson.active_id || selJson.selected_id || selJson.active || null,
    console_mode: selJson.console_mode || null,
  };

  // Select S1 via UI if needed, then start via UI.
  const needSelect = await evaluate(
    client,
    `(() => {
      const sel = document.querySelector('.strategy-select-row select');
      if (!sel) return { ok: false, reason: 'no_select' };
      if (sel.value !== 'S1') {
        sel.value = 'S1';
        sel.dispatchEvent(new Event('input', { bubbles: true }));
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      }
      return { ok: true, value: sel.value };
    })()`,
  );
  console.log('SELECT_S1_VALUE', JSON.stringify(needSelect));
  await sleep(400);
  const applied = await evaluate(client, `window.__s2b.clickExact('button', '应用')`);
  console.log('CLICK_APPLY', applied);
  await sleep(800);
  const confirmed = await evaluate(client, `window.__s2b.clickExact('button', '确认切换')`);
  console.log('CLICK_CONFIRM', confirmed);
  await sleep(2500);

  const started = await evaluate(
    client,
    `window.__s2b.clickExact('button', '启动交易系统') || window.__s2b.clickExact('button', '启动')`,
  );
  console.log('CLICK_START', started);
  report.ui_clicks = { whaleAi: clickedAi, apply: applied, confirm: confirmed, start: started, select: needSelect };
  await sleep(4000);

  const dash1 = await api('GET', '/api/whale-ai/engine/dashboard');
  const afterStart = pickFacts(dash1);
  report.after_start = afterStart;
  console.log('AFTER_START', JSON.stringify(afterStart, null, 2));
  await screenshot(client, '02_after_start');
  const uiStart = await evaluate(client, `window.__s2b.uiFacts()`);
  report.ui_after_start = {
    hasCabin: uiStart.hasCabin,
    hasOkxDemo: uiStart.hasOkxDemo,
    hasOkxLive: uiStart.hasOkxLive,
    hasAlphaShadow: uiStart.hasAlphaShadow,
    hasTrendS1: uiStart.hasTrendS1,
    hasSimulatedCang: uiStart.hasSimulatedCang,
    hasPaperCang: uiStart.hasPaperCang,
    footer: uiStart.footer,
    startVisible: uiStart.startVisible,
    stopVisible: uiStart.stopVisible,
    selectedOption: uiStart.selectedOption,
    snippetHead: (uiStart.snippet || '').slice(0, 800),
  };

  if (afterStart.engine_runtime_status === 'STALE' && afterStart.evaluation_count > 0) {
    report.anomalies.push('STALE_AFTER_START_WHILE_EVALUATING');
  }
  if (String(afterStart.alpha_execution) !== 'SHADOW') {
    report.anomalies.push('ALPHA_CHANGED_AFTER_START');
  }

  const t0 = Date.now();
  let last = afterStart;
  let p0 = false;
  while (Date.now() - t0 < RUN_MS) {
    await sleep(POLL_MS);
    const [d, dS1, oi] = await Promise.all([
      api('GET', '/api/whale-ai/engine/dashboard'),
      api('GET', '/api/whale-ai/engine/strategy/S1/diagnostics'),
      api('GET', '/api/whale-ai/engine/order-intents'),
    ]);
    const facts = pickFacts(d, { diag: dS1.json });
    const oiList = Array.isArray(oi.json) ? oi.json : (oi.json && oi.json.order_intents) || [];
    const filledNow = oiList.filter((x) => {
      const s = String(x.status || x.execution_status || '').toUpperCase();
      return s === 'FILLED' || s === 'SIM_FILLED' || s === 'SUBMITTED' || s === 'PARTIAL';
    });
    const row = {
      at: new Date().toISOString(),
      elapsed_s: Math.round((Date.now() - t0) / 1000),
      ...facts,
    };
    report.polls.push(row);
    console.log(
      'POLL',
      JSON.stringify({
        elapsed_s: row.elapsed_s,
        eval: facts.evaluation_count,
        tick: facts.last_tick_at,
        evat: facts.last_evaluated_at,
        transport: facts.transport_status,
        engine: facts.engine_runtime_status,
        strategy: facts.strategy_runtime_status,
        decision: facts.decision,
        reasons: facts.reason_codes,
        ti: facts.trade_intent_count,
        oi: facts.order_intent_count,
        would: facts.would_submit,
        filled: facts.filled,
        pos: facts.open_positions,
      }),
    );

    if (facts.engine_runtime_status === 'STALE') {
      report.anomalies.push(`STALE_AT_${row.elapsed_s}s`);
    }
    if (facts.transport_status && facts.transport_status !== 'CONNECTED') {
      report.anomalies.push(`TRANSPORT_${facts.transport_status}_AT_${row.elapsed_s}s`);
    }
    if (facts.open_positions !== baseline.open_positions) {
      report.anomalies.push(`OPEN_POSITIONS_CHANGED ${baseline.open_positions}→${facts.open_positions}`);
    }
    if (facts.position_origins.some((p) => p.paper || String(p.source || '').includes('paper') || String(p.source || '').includes('shadow'))) {
      report.anomalies.push('PAPER_OR_SHADOW_POSITION');
    }
    if (filledNow.length || facts.filled > 0) {
      p0 = true;
      report.p0_trade_order = true;
      report.anomalies.push('P0_FILLED_OR_SUBMITTED');
      console.log('P0_STOP filled/submitted');
      last = facts;
      break;
    }
    last = facts;
  }

  report.mid_ui = await evaluate(client, `window.__s2b.uiFacts()`);
  await screenshot(client, '03_running');

  const stopped = await evaluate(client, `window.__s2b.clickExact('button', '停止')`);
  console.log('CLICK_STOP', stopped);
  report.ui_clicks.stop = stopped;
  await sleep(4000);

  const [dashEnd, diagEnd, posEnd, tradeEnd] = await Promise.all([
    api('GET', '/api/whale-ai/engine/dashboard'),
    api('GET', '/api/whale-ai/engine/strategy/S1/diagnostics'),
    api('GET', '/api/whale-ai/trade/positions'),
    api('GET', '/api/whale-ai/trade/status'),
  ]);
  const ended = pickFacts(dashEnd, { diag: diagEnd.json });
  report.after_stop = ended;
  report.exchange_positions_post = {
    http: posEnd.status,
    count: Array.isArray(posEnd.json && posEnd.json.positions)
      ? posEnd.json.positions.length
      : Array.isArray(posEnd.json)
        ? posEnd.json.length
        : null,
    error: posEnd.json && (posEnd.json.error || posEnd.json.code) || null,
  };
  report.trade_status_post_simulated = tradeEnd.json && tradeEnd.json.simulated;
  const uiEnd = await evaluate(client, `window.__s2b.uiFacts()`);
  report.ui_after_stop = {
    hasCabin: uiEnd.hasCabin,
    hasOkxDemo: uiEnd.hasOkxDemo,
    hasOkxLive: uiEnd.hasOkxLive,
    hasAlphaShadow: uiEnd.hasAlphaShadow,
    hasTrendS1: uiEnd.hasTrendS1,
    hasSimulatedCang: uiEnd.hasSimulatedCang,
    hasPaperCang: uiEnd.hasPaperCang,
    footer: uiEnd.footer,
    startVisible: uiEnd.startVisible,
    stopVisible: uiEnd.stopVisible,
    systemLogs: uiEnd.systemLogs,
    snippetHead: (uiEnd.snippet || '').slice(0, 900),
  };
  await screenshot(client, '04_after_stop');

  const firstPoll = report.polls[0] || afterStart;
  const lastPoll = report.polls[report.polls.length - 1] || last;
  report.delta = {
    evaluation_count: `${baseline.evaluation_count} → ${lastPoll.evaluation_count}`,
    last_tick_at: `${baseline.last_tick_at} → ${lastPoll.last_tick_at}`,
    last_evaluated_at: `${baseline.last_evaluated_at} → ${lastPoll.last_evaluated_at}`,
    open_positions: `${baseline.open_positions} → ${ended.open_positions}`,
    s7: `${baseline.s7_sample_count} → ${ended.s7_sample_count}`,
    edge: `${baseline.edge_sample_count} → ${ended.edge_sample_count}`,
    new_trade_intents: (ended.trade_intent_count || 0) - (baseline.trade_intent_count || 0),
    new_order_intents: (ended.order_intent_count || 0) - (baseline.order_intent_count || 0),
    polls: report.polls.length,
    first_poll_eval: firstPoll.evaluation_count,
  };

  if (ended.alpha_execution !== 'SHADOW') report.anomalies.push('ALPHA_CHANGED_AFTER_STOP');
  if (ended.alpha_opening_enabled === true) report.anomalies.push('ALPHA_OPENING_STILL_ENABLED_AFTER_STOP');
  if (ended.open_positions !== baseline.open_positions) {
    report.anomalies.push(`OPEN_POSITIONS_END ${baseline.open_positions}→${ended.open_positions}`);
  }

  report.finished_at = new Date().toISOString();
  writeReport(report);
  console.log('DELTA', JSON.stringify(report.delta));
  console.log('ANOMALIES', JSON.stringify(report.anomalies));
  console.log(p0 ? 'STAGE2B_P0_DONE' : 'STAGE2B_DONE');
  client.close();
})().catch((err) => {
  console.error(String(err && err.stack ? err.stack : err));
  process.exit(1);
});
