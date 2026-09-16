/**
 * Character card management modal (list / export / import).
 */
(function (global) {
  function el(html) {
    const t = document.createElement("template");
    t.innerHTML = html.trim();
    return t.content.firstElementChild;
  }

  function openCharacterModal(api) {
    const existing = document.getElementById("modal-character");
    if (existing) existing.remove();

    const modal = el(`
      <div id="modal-character" class="modal-backdrop">
        <div class="modal wide">
          <header>
            <h3>角色管理</h3>
            <button type="button" class="modal-close" data-close>&times;</button>
          </header>
          <div id="char-active" class="char-card" hidden></div>
          <div id="char-empty" class="muted" style="padding:8px 0 12px">暂无角色，请先导入角色卡</div>
          <h4 id="char-list-title" hidden>可用角色</h4>
          <ul id="char-list" class="char-list"></ul>
          <div id="char-status" class="cfg-status muted"></div>
          <footer class="modal-actions">
            <button type="button" id="char-export" class="modal-btn">导出当前角色</button>
            <label class="modal-btn file-btn">导入角色文件
              <input id="char-import" type="file" accept="application/json,.json" hidden />
            </label>
          </footer>
        </div>
      </div>`);
    document.body.appendChild(modal);
    const status = modal.querySelector("#char-status");
    const close = () => modal.remove();
    modal.querySelector("[data-close]").addEventListener("click", close);
    modal.addEventListener("click", (e) => {
      if (e.target === modal) close();
    });

    async function refresh() {
      const list = await api.get("/api/character/list");
      const chars = list.characters || [];
      const active = modal.querySelector("#char-active");
      const empty = modal.querySelector("#char-empty");
      const listTitle = modal.querySelector("#char-list-title");
      const ul = modal.querySelector("#char-list");
      active.classList.remove("skeleton");

      if (!chars.length) {
        active.hidden = true;
        active.innerHTML = "";
        empty.hidden = false;
        listTitle.hidden = true;
        ul.innerHTML = "";
        return;
      }

      empty.hidden = true;
      listTitle.hidden = false;
      active.hidden = false;
      const profile = await api.get("/api/character");
      if (!profile.available) {
        active.hidden = true;
        empty.hidden = false;
      } else {
        const tags = (profile.tags || []).map((t) => `<span class="tag">${t}</span>`).join("");
        active.innerHTML = `
          <div class="row"><strong>${profile.name}</strong> <span class="muted">#${list.active}</span></div>
          <div class="muted">${profile.occupation || "--"} · ${profile.location || "--"} · ${profile.age != null ? profile.age + "岁" : "--"}</div>
          <div class="tags">${tags || '<span class="tag">--</span>'}</div>`;
      }
      ul.innerHTML = chars
        .map(
          (c) => `<li class="${c.id === list.active ? "active" : ""}">
            <span>${c.name} <span class="muted">(${c.id})</span></span>
            <span class="muted">${(c.tags || []).join(" · ")}</span>
          </li>`
        )
        .join("");
    }

    refresh().catch((e) => {
      status.textContent = "加载失败: " + e.message;
      status.classList.add("err");
    });

    modal.querySelector("#char-export").addEventListener("click", async () => {
      try {
        const list = await api.get("/api/character/list");
        if (!(list.characters || []).length || !list.active) {
          status.textContent = "暂无角色可导出，请先导入";
          status.classList.add("err");
          return;
        }
        const cid = list.active;
        const resp = await fetch(`/api/character/export?character_id=${encodeURIComponent(cid)}`);
        if (!resp.ok) throw new Error("HTTP " + resp.status);
        const blob = await resp.blob();
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = cid + ".json";
        a.click();
        URL.revokeObjectURL(a.href);
        status.textContent = "已导出 " + cid + ".json";
        status.classList.add("ok");
        status.classList.remove("err");
      } catch (e) {
        status.textContent = "导出失败: " + e.message;
        status.classList.add("err");
      }
    });

    modal.querySelector("#char-import").addEventListener("change", async (ev) => {
      const file = ev.target.files && ev.target.files[0];
      if (!file) return;
      try {
        const text = await file.text();
        const card = JSON.parse(text);
        const r = await api.post("/api/character/import", { card, force: true });
        status.textContent = "导入成功（已替换为当前唯一角色）";
        status.classList.add("ok");
        status.classList.remove("err");
        await refresh();
      } catch (e) {
        status.textContent = "导入失败: " + e.message;
        status.classList.add("err");
      }
      ev.target.value = "";
    });
  }

  global.AiTraderModals = global.AiTraderModals || {};
  global.AiTraderModals.openCharacter = openCharacterModal;
})(window);
