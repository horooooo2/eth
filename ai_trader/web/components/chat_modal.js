/**
 * Chat modal with Zhang Ming (passive conversation).
 */
(function (global) {
  function el(html) {
    const t = document.createElement("template");
    t.innerHTML = html.trim();
    return t.content.firstElementChild;
  }

  function escapeHtml(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  class ChatModal {
    constructor(api) {
      this.api = api || { get: (u) => fetch(u).then((r) => r.json()), post: null };
      this.messages = [];
      this.isOpen = false;
      this.container = null;
      this._typing = false;
      this.init();
    }

    init() {
      if (document.getElementById("chat-modal")) return;
      this.container = el(`
        <div class="chat-modal" id="chat-modal" hidden>
          <div class="chat-header">
            <div class="chat-title">
              <span class="chat-avatar">张</span>
              <div>
                <div class="chat-name">张明</div>
                <div class="chat-status" id="chat-status-line">在线</div>
              </div>
            </div>
            <button type="button" class="chat-close" data-close>&times;</button>
          </div>
          <div class="chat-messages" id="chat-messages"></div>
          <div class="chat-input-area">
            <input type="text" id="chat-input" placeholder="说点什么..." autocomplete="off" />
            <button type="button" id="chat-send">发送</button>
          </div>
        </div>`);
      document.body.appendChild(this.container);
      this.container.querySelector("[data-close]").addEventListener("click", () => this.close());
      this.container.querySelector("#chat-send").addEventListener("click", () => void this._onSend());
      this.container.querySelector("#chat-input").addEventListener("keydown", (e) => {
        if (e.key === "Enter") void this._onSend();
      });
    }

    open() {
      this.isOpen = true;
      this.container.hidden = false;
      this.container.classList.add("open");
      const dot = document.getElementById("chat-unread-dot");
      if (dot) dot.style.display = "none";
      void this.loadHistory();
      this.container.querySelector("#chat-input").focus();
    }

    close() {
      this.isOpen = false;
      this.container.classList.remove("open");
      this.container.hidden = true;
    }

    async loadHistory() {
      try {
        const data = await this.api.get("/api/conversation/history?limit=40");
        this.messages = data.messages || [];
        this.render();
      } catch (e) {
        this.messages = [];
        this.render();
      }
    }

    async sendMessage(text) {
      const content = String(text || "").trim();
      if (!content || this._typing) return;
      this.messages.push({ role: "user", content, timestamp: new Date().toISOString() });
      this.render();
      this._typing = true;
      this._showTyping(true);
      try {
        const post = this.api.post || (async (path, body) => {
          const r = await fetch(path, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          });
          if (!r.ok) {
            let detail = "HTTP " + r.status;
            try {
              const j = await r.json();
              detail = j.detail || detail;
            } catch (_) {}
            throw new Error(detail);
          }
          return r.json();
        });
        const resp = await post("/api/conversation/send", { message: content });
        this._showTyping(false);
        if (resp.silence) {
          this.messages.push({
            role: "system",
            content: "张明没有回复",
            timestamp: resp.timestamp,
          });
        } else {
          this.messages.push({
            role: "zhangming",
            content: resp.reply || "",
            timestamp: resp.timestamp,
            impact_applied: resp.impact_applied,
          });
        }
        const status = document.getElementById("chat-status-line");
        if (status && resp.mood_label) status.textContent = resp.mood_label;
      } catch (e) {
        this._showTyping(false);
        this.messages.push({
          role: "system",
          content: "发送失败: " + (e.message || e),
        });
      } finally {
        this._typing = false;
        this.render();
      }
    }

    async _onSend() {
      const input = this.container.querySelector("#chat-input");
      const text = input.value;
      input.value = "";
      await this.sendMessage(text);
    }

    _showTyping(on) {
      const box = this.container.querySelector("#chat-messages");
      let tip = box.querySelector(".chat-typing");
      if (!on) {
        if (tip) tip.remove();
        return;
      }
      if (!tip) {
        tip = document.createElement("div");
        tip.className = "chat-bubble zhangming chat-typing";
        tip.textContent = "对方正在输入…";
        box.appendChild(tip);
        box.scrollTop = box.scrollHeight;
      }
    }

    render() {
      const box = this.container.querySelector("#chat-messages");
      box.innerHTML = this.messages
        .map((m) => {
          if (m.role === "system") {
            return `<div class="chat-system">${escapeHtml(m.content)}</div>`;
          }
          const side = m.role === "user" ? "user" : "zhangming";
          const impact =
            m.impact_applied && Object.keys(m.impact_applied).length
              ? `<div class="chat-impact">（张明的状态发生了细微变化）</div>`
              : "";
          return `<div class="chat-bubble ${side}"><div>${escapeHtml(m.content)}</div>${impact}</div>`;
        })
        .join("");
      box.scrollTop = box.scrollHeight;
    }

    showUnreadDot() {
      const dot = document.getElementById("chat-unread-dot");
      if (dot && !this.isOpen) dot.style.display = "inline-block";
    }
  }

  global.AiTraderModals = global.AiTraderModals || {};
  global.AiTraderModals.ChatModal = ChatModal;
})(window);
