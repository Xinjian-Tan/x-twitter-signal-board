(function () {
  "use strict";

  const $ = (sel) => document.querySelector(sel);
  let server = false;
  let serverStatus = null;
  let busy = false;

  const SOURCE_NAMES = {
    "manual": "真实推文 · 手动采样",
    "x-api": "X API",
    "mock": "模拟数据",
    "demo": "样本数据"
  };

  function showResult(text, ok) {
    const box = $("#apiResult");
    if (!box) return;
    if (!text) {
      box.hidden = true;
      box.textContent = "";
      box.classList.remove("ok", "bad");
      return;
    }
    box.hidden = false;
    box.textContent = text;
    box.classList.toggle("ok", !!ok);
    box.classList.toggle("bad", !ok);
  }

  function renderStatus(data) {
    const el = $("#apiServerStatus");
    if (!el) return;
    el.classList.remove("ok", "bad");
    if (data) {
      el.classList.add("ok");
      el.textContent =
        "本地服务已连接 · token " +
        (data.tokenConfigured ? "已配置（仅内存）" : "未配置") +
        " · 数据源 " +
        (SOURCE_NAMES[data.source] || data.source || "未知");
    } else {
      el.classList.add("bad");
      el.textContent =
        "未连接本地服务：当前是静态模式。运行 python3 server/app.py --open 后，用 http://127.0.0.1:8787 打开本页。";
    }
    const disabled = !data || busy;
    const token = $("#tokenInput");
    if (token) token.disabled = disabled;
    ["#testTokenBtn", "#saveSyncBtn"].forEach((sel) => {
      const btn = $(sel);
      if (btn) btn.disabled = disabled;
    });
    const clear = $("#clearTokenBtn");
    if (clear) clear.disabled = !data || !data.tokenConfigured || busy;
  }

  function setBusy(value) {
    busy = value;
    renderStatus(server ? serverStatus : null);
    const label = value ? "处理中…" : null;
    if (value) showResult(label || "处理中…", true);
  }

  function isStaticPage() {
    const host = location.hostname || "";
    return !(host === "127.0.0.1" || host === "localhost" || host === "::1");
  }

  async function probe() {
    if (isStaticPage()) {
      server = false;
      serverStatus = null;
      renderStatus(null);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    try {
      const res = await fetch("/api/status", { cache: "no-store", signal: controller.signal });
      if (!res.ok) throw new Error("no local server");
      const data = await res.json();
      if (!data.server) throw new Error("not a sync server");
      server = true;
      serverStatus = data;
      renderStatus(data);
    } catch (e) {
      server = false;
      serverStatus = null;
      renderStatus(null);
    } finally {
      clearTimeout(timer);
    }
  }

  async function postJSON(url, body) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {})
    });
    let data = {};
    try { data = await res.json(); } catch (e) { /* ignore */ }
    if (!res.ok) {
      const err = new Error((data && data.error) || ("HTTP " + res.status));
      err.data = data;
      throw err;
    }
    return data;
  }

  function openModal() {
    const modal = $("#settingsModal");
    if (!modal) return;
    modal.classList.remove("hidden");
    modal.setAttribute("aria-hidden", "false");
    document.body.classList.add("modal-open");
    probe();
    const token = $("#tokenInput");
    if (token && !token.disabled) token.focus();
  }

  function closeModal() {
    const modal = $("#settingsModal");
    if (!modal) return;
    modal.classList.add("hidden");
    modal.setAttribute("aria-hidden", "true");
    document.body.classList.remove("modal-open");
  }

  function readToken() {
    const input = $("#tokenInput");
    return input ? input.value.trim() : "";
  }

  async function testToken() {
    if (!server) { showResult("请先启动本地服务：python3 server/app.py --open", false); return; }
    const token = readToken();
    const configured = !!(serverStatus && serverStatus.tokenConfigured);
    if (!token && !configured) { showResult("请先粘贴 X API token。", false); return; }
    setBusy(true);
    showResult("测试中…", true);
    try {
      const data = await postJSON("/api/check", token ? { token: token } : {});
      showResult(data.output || (data.ok ? "连接成功。" : "连接失败。"), !!data.ok);
    } catch (e) {
      const output = (e.data && e.data.output) || e.message;
      showResult(output, false);
    } finally {
      busy = false;
      renderStatus(server ? serverStatus : null);
    }
  }

  async function saveAndSync() {
    if (!server) { showResult("请先启动本地服务：python3 server/app.py --open", false); return; }
    const token = readToken();
    const configured = !!(serverStatus && serverStatus.tokenConfigured);
    if (!token && !configured) { showResult("请先粘贴 X API token。", false); return; }
    setBusy(true);
    showResult("同步中，可能需要 10–40 秒；请勿关闭页面…", true);
    try {
      if (token) await postJSON("/api/token", { token: token });
      const data = await postJSON("/api/sync", {});
      showResult((data.output || "同步完成。") + "\n\n即将刷新页面…", true);
      setTimeout(() => window.location.reload(), 900);
    } catch (e) {
      const output = (e.data && e.data.output) || e.message;
      showResult(output, false);
      busy = false;
      renderStatus(server ? serverStatus : null);
    }
  }

  async function clearToken() {
    if (!server) return;
    setBusy(true);
    try {
      const res = await fetch("/api/token", { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      showResult(data.message || "已清除本机内存中的 token。", true);
      await probe();
    } catch (e) {
      showResult("清除失败：" + e.message, false);
    } finally {
      busy = false;
      renderStatus(server ? serverStatus : null);
    }
  }

  function bind() {
    const settings = $("#settingsBtn");
    if (settings) settings.addEventListener("click", openModal);
    const close = $("#closeSettings");
    if (close) close.addEventListener("click", closeModal);
    const modal = $("#settingsModal");
    if (modal) {
      modal.addEventListener("click", (event) => {
        if (event.target === modal) closeModal();
      });
    }
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") closeModal();
      if (event.key === "Enter" && document.activeElement === $("#tokenInput")) {
        event.preventDefault();
        testToken();
      }
    });
    const test = $("#testTokenBtn");
    if (test) test.addEventListener("click", testToken);
    const save = $("#saveSyncBtn");
    if (save) save.addEventListener("click", saveAndSync);
    const clear = $("#clearTokenBtn");
    if (clear) clear.addEventListener("click", clearToken);
  }

  bind();
  probe();
})();
