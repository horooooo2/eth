const API_BASE = "";

async function fetchJson(path) {
  const resp = await fetch(`${API_BASE}${path}`);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}

function setStatus(key, ok, msg) {
  const el = document.querySelector(`[data-status="${key}"]`);
  if (!el) return;
  el.textContent = msg;
  el.classList.toggle("ok", !!ok);
  el.classList.toggle("err", !ok);
}

function fmt(n, digits = 2) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return "—";
  return Number(n).toFixed(digits);
}

function pnlClass(n) {
  if (n > 0) return "pos";
  if (n < 0) return "neg";
  return "";
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderAccount(data) {
  const el = document.getElementById("account-body");
  el.classList.remove("skeleton");
  const src = data.source === "okx" ? "OKX 实盘" : "纸面盘";
  el.innerHTML = `
    <div class="metrics">
      <div class="metric"><div class="label">净值 (${src})</div><div class="value">$${fmt(data.equity)}</div></div>
      <div class="metric"><div class="label">可用</div><div class="value">$${fmt(data.available)}</div></div>
      <div class="metric"><div class="label">今日盈亏</div><div class="value ${pnlClass(data.today_pnl)}">${fmt(data.today_pnl)} (${fmt(data.today_pnl_pct)}%)</div></div>
      <div class="metric"><div class="label">持仓数</div><div class="value">${data.position_count}</div></div>
      <div class="metric"><div class="label">风险敞口</div><div class="value">${fmt(data.risk_exposure_pct * 100)}%</div></div>
      <div class="metric"><div class="label">上次同步</div><div class="value" style="font-size:14px">${escapeHtml(data.last_sync || "—")}</div></div>
    </div>`;
}

function renderState(data) {
  const el = document.getElementById("state-body");
  el.classList.remove("skeleton");
  const rows = [
    ["压力", data.stress],
    ["风险偏好", data.risk_appetite],
    ["耐心", data.patience],
    ["专注", data.focus],
    ["自我怀疑", data.self_doubt],
    ["固执", data.stubbornness],
  ];
  const bars = rows
    .map(
      ([label, v]) => `
      <div class="bar-row">
        <span>${escapeHtml(label)}</span>
        <div class="bar-track"><div class="bar-fill" style="width:${Math.round(Number(v) * 100)}%"></div></div>
        <span>${fmt(v)}</span>
      </div>`
    )
    .join("");
  const mods = (data.modifiers || []).join(", ") || "无";
  el.innerHTML = `
    <div><strong>${escapeHtml(data.mood_label)}</strong> · 睡眠债 ${fmt(data.sleep_debt, 1)}h</div>
    <div class="mode-badge">${escapeHtml(data.mode_label)} (${escapeHtml(data.primary_mode)})</div>
    <div class="muted" style="margin-top:6px">修饰: ${escapeHtml(mods)}</div>
    <div class="bars">${bars}</div>
    <div class="muted" style="margin-top:8px">更新: ${escapeHtml(data.last_updated || "—")}</div>`;
}

function renderCharacter(data) {
  const el = document.getElementById("character-body");
  el.classList.remove("skeleton");
  const heroName = document.getElementById("hero-name");
  const heroSub = document.getElementById("hero-sub");
  if (!data || data.available === false || !data.name) {
    if (heroName) heroName.textContent = "--";
    if (heroSub) heroSub.textContent = "未导入角色";
    el.innerHTML = `
      <div class="muted">--</div>
      <div class="tags"><span class="tag">--</span></div>
      <p class="arc">--</p>
      <div class="bars">
        ${["风险偏好", "耐心", "固执", "自省", "纪律"]
          .map(
            (label) => `<div class="bar-row">
          <span>${label}</span>
          <div class="bar-track"></div>
          <span>--</span>
        </div>`
          )
          .join("")}
      </div>
      <ul class="event-list"><li><span></span><span></span><span class="muted">--</span></li></ul>`;
    return;
  }
  if (heroName) heroName.textContent = data.name;
  if (heroSub) {
    heroSub.textContent = [data.occupation, data.location].filter(Boolean).join(" · ") || "--";
  }
  const tags = (data.tags || []).map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join("");
  const traits = (data.traits || [])
    .map((t) => {
      const ch = Number(t.change_7d || 0);
      const sign = ch > 0 ? "+" : "";
      return `<div class="bar-row">
        <span>${escapeHtml(t.name)}</span>
        <div class="bar-track"><div class="bar-fill" style="width:${Math.round(Number(t.value) * 100)}%"></div></div>
        <span>${fmt(t.value)} <span class="muted">${sign}${fmt(ch)}</span></span>
      </div>`;
    })
    .join("");
  const events = (data.recent_events || [])
    .map(
      (e) => `<li><span class="t">${escapeHtml(e.time)}</span><span>${escapeHtml(e.icon)}</span><span>${escapeHtml(e.text)}</span></li>`
    )
    .join("");
  const dl = data.deadline;
  let deadlineHtml = "";
  if (dl && dl.enabled !== false) {
    const total = Math.max(1, Number(dl.total_days || 90));
    const cur = Math.max(0, Number(dl.current_day || 0));
    const left = Math.max(0, Number(dl.days_left != null ? dl.days_left : total - cur));
    const pct = Math.min(100, Math.round((cur / total) * 100));
    let cls = "deadline-block";
    if (left <= 7 && left > 0) cls += " warn";
    if (left <= 0 || (dl.last_evaluation && dl.last_evaluation.action)) cls += " done";
    const evalLine = dl.last_evaluation
      ? `评估：${escapeHtml(dl.last_evaluation.action || "")}${dl.last_evaluation.new_deadline_days ? " · +" + dl.last_evaluation.new_deadline_days + "天" : ""}`
      : `压力 ${fmt(dl.pressure || 0, 4)}`;
    deadlineHtml = `<div class="${cls}" id="deadline-progress">
      <div class="dl-title">三个月期限</div>
      <div class="dl-bar"><div class="dl-fill" style="width:${pct}%"></div></div>
      <div class="dl-meta"><span>第 ${cur} 天 / 共 ${total} 天</span><span>剩余 ${left} 天 · ${evalLine}</span></div>
    </div>`;
    if (dl.last_evaluation && !window.__deadlineModalShown) {
      showDeadlineModal(dl, data);
      window.__deadlineModalShown = true;
    }
  }
  el.innerHTML = `
    <div class="muted">${escapeHtml(data.occupation)} · ${escapeHtml(data.location)} · ${data.age}岁</div>
    <div class="tags">${tags || '<span class="tag">--</span>'}</div>
    <p class="arc">${escapeHtml(data.emotion_arc || "--")}</p>
    ${deadlineHtml}
    <div class="bars">${traits}</div>
    <ul class="event-list">${events || "<li><span></span><span></span><span class='muted'>暂无事件</span></li>"}</ul>`;
}

function showDeadlineModal(dl, data) {
  let modal = document.getElementById("deadline-modal");
  if (!modal) {
    modal = document.createElement("div");
    modal.id = "deadline-modal";
    document.body.appendChild(modal);
  }
  const ev = dl.last_evaluation || {};
  modal.className = "open";
  modal.innerHTML = `<div class="modal-card">
    <h3>【三个月评估】</h3>
    <div class="stats">
      第 ${escapeHtml(String(dl.current_day || 90))} 天 · 压力 ${fmt(dl.pressure || 0, 4)}
    </div>
    <div class="reason">"${escapeHtml(ev.reason || "—")}"</div>
    <div class="action">决定：${escapeHtml(ev.action || "CONTINUE")}${
      ev.new_deadline_days ? " · 延长 " + ev.new_deadline_days + " 天" : ""
    }</div>
    <button type="button" id="deadline-modal-ok">确认</button>
  </div>`;
  modal.querySelector("#deadline-modal-ok").onclick = () => {
    modal.classList.remove("open");
  };
}

function renderCurrentPositions(list, summary) {
  const el = document.getElementById("positions-current");
  const sum = document.getElementById("positions-summary");
  el.classList.remove("skeleton");
  if (summary) {
    sum.textContent = `保证金合计 $${fmt(summary.total_margin)} · 总盈亏 $${fmt(summary.total_pnl)} · 风险 ${fmt(summary.total_risk_pct * 100)}%`;
  }
  if (!list || !list.length) {
    el.innerHTML = `<div class="muted">当前无持仓</div>`;
    return;
  }
  el.innerHTML = list
    .map(
      (p) => `<div class="pos-card">
      <div class="row"><span class="title">${escapeHtml(p.symbol)} ${escapeHtml(p.side)} ×${fmt(p.leverage, 0)}</span>
      <span class="${pnlClass(p.pnl)}">${fmt(p.pnl)} (${fmt(p.pnl_pct)}%)</span></div>
      <div class="row muted"><span>入场 ${fmt(p.entry_price)}</span><span>现价 ${fmt(p.current_price)}</span><span>${p.holding_minutes} 分钟</span></div>
      <div class="hint">${escapeHtml(p.psychology_mood || "")}</div>
    </div>`
    )
    .join("");
}

function renderHistory(list) {
  const el = document.getElementById("positions-history");
  el.classList.remove("skeleton");
  if (!list || !list.length) {
    el.innerHTML = `<div class="muted">暂无历史仓位</div>`;
    return;
  }
  el.innerHTML = list
    .map(
      (p) => `<div class="pos-card">
      <div class="row"><span class="title">${escapeHtml(p.symbol)} ${escapeHtml(p.side)}</span>
      <span class="${pnlClass(p.realized_pnl)}">${fmt(p.realized_pnl)} (${fmt(p.pnl_pct)}%)</span></div>
      <div class="row muted"><span>${fmt(p.entry_price)} → ${fmt(p.exit_price)}</span><span>${escapeHtml(p.exit_reason || "")}</span></div>
      <div class="hint">${escapeHtml(p.narrative_reason || "")}</div>
    </div>`
    )
    .join("");
}

function renderTimeline(entries) {
  const el = document.getElementById("timeline-body");
  el.classList.remove("skeleton");
  if (!entries || !entries.length) {
    el.innerHTML = `<div class="muted">暂无时间线</div>`;
    return;
  }
  el.innerHTML = entries
    .map((e) => {
      const type = e.type || "psych";
      let body = "";
      if (type === "trade") {
        body = `<div class="tl-text"><strong>${escapeHtml(e.decision)}</strong> ${escapeHtml(e.symbol || "")}
          · score ${fmt(e.signal_score)} / thr ${fmt(e.threshold)}
          ${e.narrative_thought ? `<div class="hint" style="margin-top:4px">${escapeHtml(e.narrative_thought)}</div>` : ""}</div>`;
      } else if (type === "ambient") {
        body = `<div class="tl-text">🌫 背景<br/>${escapeHtml(e.text || e.name || "")}</div>`;
      } else {
        body = `<div class="tl-text">${escapeHtml(e.text || "")}</div>`;
      }
      const mood = type === "ambient" ? "背景" : (e.mood_label || e.mood || e.mode || type);
      return `<div class="tl-item ${type}">
        <div class="tl-meta">${escapeHtml(e.timestamp)} · ${escapeHtml(type === "ambient" ? "🌫 背景" : type)} · ${escapeHtml(mood)}</div>
        ${body}
      </div>`;
    })
    .join("");
}

async function loadAccount() {
  try {
    const data = await fetchJson("/api/account");
    renderAccount(data);
    setStatus("account", true, "已同步");
  } catch (e) {
    setStatus("account", false, "数据不可用");
  }
}

async function loadState() {
  try {
    const data = await fetchJson("/api/state");
    renderState(data);
    setStatus("state", true, "已同步");
  } catch (e) {
    setStatus("state", false, "数据不可用");
  }
}

async function loadCharacter() {
  try {
    const data = await fetchJson("/api/character");
    renderCharacter(data);
    setStatus("character", true, "已同步");
  } catch (e) {
    setStatus("character", false, "数据不可用");
  }
}

async function loadPositions() {
  try {
    const data = await fetchJson("/api/positions");
    renderCurrentPositions(data.current, data.summary);
    renderHistory(data.history);
    setStatus("positions", true, "已同步");
  } catch (e) {
    setStatus("positions", false, "数据不可用");
  }
}

let timelineType = "all";

async function loadTimeline() {
  try {
    const data = await fetchJson(`/api/timeline?limit=50&type=${encodeURIComponent(timelineType)}`);
    renderTimeline(data.entries);
    setStatus("timeline", true, `共 ${data.total} 条`);
  } catch (e) {
    setStatus("timeline", false, "数据不可用");
  }
}

async function refreshAll() {
  const stamp = new Date().toLocaleTimeString();
  const poll = document.getElementById("poll-status");
  if (poll) poll.textContent = `刷新中 · ${stamp}`;
  await Promise.all([loadAccount(), loadState(), loadCharacter(), loadPositions(), loadTimeline()]);
  if (poll) poll.textContent = `已刷新 · ${stamp}`;
}

function wireTabs() {
  document.querySelectorAll(".tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      const tab = btn.getAttribute("data-tab");
      const cur = document.getElementById("positions-current");
      const hist = document.getElementById("positions-history");
      if (tab === "history") {
        cur.hidden = true;
        cur.classList.remove("active");
        hist.hidden = false;
        hist.classList.add("active");
      } else {
        hist.hidden = true;
        hist.classList.remove("active");
        cur.hidden = false;
        cur.classList.add("active");
      }
    });
  });
  document.querySelectorAll(".chip").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".chip").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      timelineType = btn.getAttribute("data-type") || "all";
      loadTimeline();
    });
  });
}

async function postJson(path, body) {
  const resp = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  if (!resp.ok) {
    let detail = `HTTP ${resp.status}`;
    try {
      const j = await resp.json();
      detail = j.detail || detail;
    } catch (_) {}
    throw new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
  }
  return resp.json();
}

const AiTraderAPI = {
  get: fetchJson,
  post: postJson,
};

async function runKillSwitch() {
  if (!window.confirm("确认一键平仓？将市价平掉 OKX 全部持仓并暂停新开仓。")) return;
  const poll = document.getElementById("poll-status");
  if (poll) poll.textContent = "Kill Switch 执行中…";
  try {
    const r = await postJson("/api/safety/kill-switch", {});
    const msg = r.ok
      ? `平仓完成 ${ (r.closed || []).length } 笔`
      : `部分失败: ${(r.errors || []).join("; ")}`;
    alert(msg);
    await refreshAll();
  } catch (e) {
    alert("Kill Switch 失败: " + e.message);
  }
}

function wireHeaderActions() {
  const apiBtn = document.getElementById("btn-api-config");
  const charBtn = document.getElementById("btn-character");
  const chatBtn = document.getElementById("btn-chat");
  const killBtn = document.getElementById("btn-kill-switch");
  if (apiBtn) {
    apiBtn.addEventListener("click", () => {
      window.AiTraderModals.openApiConfig(AiTraderAPI);
    });
  }
  if (charBtn) {
    charBtn.addEventListener("click", () => {
      window.AiTraderModals.openCharacter(AiTraderAPI);
    });
  }
  if (chatBtn) {
    let chatModal = null;
    chatBtn.addEventListener("click", () => {
      if (!chatModal) {
        chatModal = new window.AiTraderModals.ChatModal(AiTraderAPI);
      }
      if (chatModal.isOpen) chatModal.close();
      else chatModal.open();
    });
  }
  if (killBtn) killBtn.addEventListener("click", () => void runKillSwitch());
}

document.addEventListener("DOMContentLoaded", () => {
  wireTabs();
  wireHeaderActions();
  refreshAll();
  setInterval(refreshAll, 5000);
  setInterval(pollTrauma, 5000);
  fetchJson("/api/health")
    .then((h) => {
      const el = document.getElementById("db-hint");
      if (el && h.db) el.textContent = h.db.split(/[/\\\\]/).pop();
    })
    .catch(() => {});
});

let _traumaSince = new Date(Date.now() - 86400000).toISOString();

async function pollTrauma() {
  try {
    const data = await fetchJson(
      `/api/character/trauma-events?since=${encodeURIComponent(_traumaSince)}`
    );
    const events = data.events || [];
    if (!events.length) return;
    _traumaSince = events[events.length - 1].timestamp || _traumaSince;
    const latest = events[events.length - 1];
    showTraumaBanner(latest);
  } catch (_) {}
}

function showTraumaBanner(evt) {
  let bar = document.getElementById("trauma-banner");
  if (!bar) {
    bar = document.createElement("div");
    bar.id = "trauma-banner";
    bar.className = "trauma-banner";
    document.body.prepend(bar);
  }
  const impacts = (evt.baseline_impact && evt.baseline_impact.impacts) || {};
  const impactText = Object.entries(impacts)
    .map(([k, v]) => `${k} ${Number(v) >= 0 ? "+" : ""}${v}`)
    .join("，");
  bar.innerHTML = `⚠️ 创伤事件：${escapeHtml(evt.description || evt.event_type)}<br/>基线变化：${escapeHtml(impactText || "—")}`;
  bar.hidden = false;
  clearTimeout(bar._timer);
  bar._timer = setTimeout(() => {
    bar.hidden = true;
  }, 5000);
}
