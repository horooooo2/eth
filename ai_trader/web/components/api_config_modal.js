/**
 * API Key / DeepSeek config modal.
 * Expects window.AiTraderAPI helpers: get/post JSON.
 */
(function (global) {
  function el(html) {
    const t = document.createElement("template");
    t.innerHTML = html.trim();
    return t.content.firstElementChild;
  }

  function openApiConfigModal(api) {
    const existing = document.getElementById("modal-api-config");
    if (existing) existing.remove();

    const modal = el(`
      <div id="modal-api-config" class="modal-backdrop">
        <div class="modal">
          <header>
            <h3>API 配置</h3>
            <button type="button" class="modal-close" data-close>&times;</button>
          </header>
          <p class="muted">密钥只写入后端 .env，前端仅显示脱敏值。保存后建议重启服务。</p>
          <label>OKX API Key<input id="cfg-api-key" type="password" autocomplete="off" placeholder="留空则不修改" /></label>
          <label>OKX Secret Key<input id="cfg-secret" type="password" autocomplete="off" placeholder="留空则不修改" /></label>
          <label>OKX Passphrase<input id="cfg-pass" type="password" autocomplete="off" placeholder="留空则不修改" /></label>
          <label>DeepSeek API Key<input id="cfg-deepseek" type="password" autocomplete="off" placeholder="留空则不修改" /></label>
          <label class="row-check"><input id="cfg-demo" type="checkbox" /> Demo 模拟盘</label>
          <div id="cfg-status" class="cfg-status muted"></div>
          <footer class="modal-actions">
            <button type="button" id="cfg-test">测试连接</button>
            <button type="button" id="cfg-save" class="primary">保存</button>
          </footer>
        </div>
      </div>`);
    document.body.appendChild(modal);

    const status = modal.querySelector("#cfg-status");
    const close = () => modal.remove();
    modal.querySelector("[data-close]").addEventListener("click", close);
    modal.addEventListener("click", (e) => {
      if (e.target === modal) close();
    });

    api.get("/api/exchange/config").then((cfg) => {
      modal.querySelector("#cfg-api-key").placeholder = cfg.okx_api_key || "未配置";
      modal.querySelector("#cfg-secret").placeholder = cfg.okx_secret_key || "未配置";
      modal.querySelector("#cfg-pass").placeholder = cfg.okx_passphrase || "未配置";
      modal.querySelector("#cfg-deepseek").placeholder = cfg.deepseek_api_key || "未配置";
      modal.querySelector("#cfg-demo").checked = !!cfg.okx_demo;
      status.textContent = cfg.note || "";
    }).catch((e) => {
      status.textContent = "加载失败: " + e.message;
      status.classList.add("err");
    });

    modal.querySelector("#cfg-test").addEventListener("click", async () => {
      status.textContent = "测试中…";
      status.classList.remove("ok", "err");
      try {
        const r = await api.post("/api/exchange/test", {});
        status.textContent = r.ok ? "连接成功" : ("失败: " + (r.message || ""));
        status.classList.toggle("ok", !!r.ok);
        status.classList.toggle("err", !r.ok);
      } catch (e) {
        status.textContent = "失败: " + e.message;
        status.classList.add("err");
      }
    });

    modal.querySelector("#cfg-save").addEventListener("click", async () => {
      const body = {
        okx_demo: modal.querySelector("#cfg-demo").checked,
      };
      const apiKey = modal.querySelector("#cfg-api-key").value.trim();
      const secret = modal.querySelector("#cfg-secret").value.trim();
      const pass = modal.querySelector("#cfg-pass").value.trim();
      const deep = modal.querySelector("#cfg-deepseek").value.trim();
      if (apiKey) body.okx_api_key = apiKey;
      if (secret) body.okx_secret_key = secret;
      if (pass) body.okx_passphrase = pass;
      if (deep) body.deepseek_api_key = deep;
      status.textContent = "保存中…";
      try {
        const cfg = await api.post("/api/exchange/config", body);
        status.textContent = "已保存。请重启服务使配置完全生效。脱敏: " + (cfg.okx_api_key || "");
        status.classList.add("ok");
        status.classList.remove("err");
      } catch (e) {
        status.textContent = "保存失败: " + e.message;
        status.classList.add("err");
      }
    });
  }

  global.AiTraderModals = global.AiTraderModals || {};
  global.AiTraderModals.openApiConfig = openApiConfigModal;
})(window);
