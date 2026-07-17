(function () {
  "use strict";

  const AUTH_STORAGE_KEY = "aichat-auth";
  const PREFERENCE_PREFIX = "aichat-prefs";
  const DRAFT_TITLE = "新对话";

  /* ========== 状态 ========== */

  const state = {
    backendUrl: "",
    authToken: "",
    tokenExpiresAt: "",
    userId: "",
    providers: [],
    models: [],
    activeModel: "",
    sessions: [],
    activeSessionId: "", // 空字符串表示"新对话"草稿，尚未在服务端建立会话
    messages: [],
    messageCache: new Map(),
    isStreaming: false,
    abortController: null,
    modelMenuOpen: false,
    menuSessionId: "",
  };

  const el = {};
  for (const id of [
    "sidebar",
    "sidebarBackdrop",
    "sidebarCloseButton",
    "sessionList",
    "sessionMenu",
    "newChatButton",
    "topbarNewChatButton",
    "menuButton",
    "modelButton",
    "modelButtonLabel",
    "modelPopover",
    "chatScroll",
    "chatThread",
    "composer",
    "promptInput",
    "sendButton",
    "connectionLabel",
    "accountAvatar",
    "logoutButton",
    "loginOverlay",
    "loginForm",
    "backendUrlInput",
    "accessKeyInput",
    "loginSubmitButton",
    "loginError",
    "toast",
  ]) {
    el[id] = document.getElementById(id);
  }

  /* ========== 本地存储 ========== */

  function loadAuth() {
    try {
      const saved = JSON.parse(localStorage.getItem(AUTH_STORAGE_KEY) || "null");
      if (!saved) return;
      state.backendUrl = saved.backendUrl || "";
      state.authToken = saved.authToken || "";
      state.tokenExpiresAt = saved.tokenExpiresAt || "";
      state.userId = saved.userId || "";
    } catch {
      localStorage.removeItem(AUTH_STORAGE_KEY);
    }
  }

  function saveAuth() {
    localStorage.setItem(
      AUTH_STORAGE_KEY,
      JSON.stringify({
        backendUrl: state.backendUrl,
        authToken: state.authToken,
        tokenExpiresAt: state.tokenExpiresAt,
        userId: state.userId,
      }),
    );
  }

  function clearAuth() {
    state.authToken = "";
    state.tokenExpiresAt = "";
    state.userId = "";
    localStorage.removeItem(AUTH_STORAGE_KEY);
  }

  function prefKey() {
    return state.backendUrl && state.userId
      ? `${PREFERENCE_PREFIX}:${state.backendUrl}:${state.userId}`
      : "";
  }

  function loadPrefs() {
    const key = prefKey();
    if (!key) return;
    try {
      const saved = JSON.parse(localStorage.getItem(key) || "null");
      if (!saved) return;
      state.activeModel = saved.activeModel || "";
    } catch {
      localStorage.removeItem(key);
    }
  }

  function savePrefs() {
    const key = prefKey();
    if (!key) return;
    localStorage.setItem(key, JSON.stringify({ activeModel: state.activeModel }));
  }

  /* ========== API ========== */

  class ApiError extends Error {
    constructor(message, status) {
      super(message);
      this.status = status;
    }
  }

  async function readableError(response) {
    try {
      const data = await response.json();
      if (typeof data.detail === "string") return data.detail;
      if (data.detail) return JSON.stringify(data.detail);
    } catch {
      /* 非 JSON 响应 */
    }
    return response.statusText || `HTTP ${response.status}`;
  }

  async function api(path, options = {}) {
    let response;
    try {
      response = await fetch(state.backendUrl + path, {
        ...options,
        headers: {
          "Content-Type": "application/json",
          ...(state.authToken ? { Authorization: `Bearer ${state.authToken}` } : {}),
          ...options.headers,
        },
      });
    } catch {
      throw new ApiError("无法连接到后端服务", 0);
    }

    if (response.status === 401 || response.status === 403) {
      const message = await readableError(response);
      if (!options.skipAuthRedirect) forceRelogin();
      throw new ApiError(message, response.status);
    }
    if (!response.ok) {
      throw new ApiError(await readableError(response), response.status);
    }
    return response;
  }

  async function apiJson(path, options) {
    return (await api(path, options)).json();
  }

  async function login(backendUrl, accessKey) {
    state.backendUrl = backendUrl;
    const data = await apiJson("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ access_key: accessKey }),
      skipAuthRedirect: true,
    });
    if (!data.token || !data.user_id) throw new ApiError("后端没有返回有效凭证", 0);
    state.authToken = data.token;
    state.tokenExpiresAt = data.expires_at || "";
    state.userId = data.user_id;
    saveAuth();
  }

  async function validateSavedLogin() {
    if (!state.backendUrl || !state.authToken) return false;
    if (state.tokenExpiresAt && Date.parse(state.tokenExpiresAt) <= Date.now()) return false;
    try {
      await apiJson("/api/auth/me", { skipAuthRedirect: true });
      return true;
    } catch {
      return false;
    }
  }

  async function fetchProviders() {
    const data = await apiJson("/api/providers");
    state.providers = data.providers || [];
    state.models = data.models || [];
    if (!state.models.length) throw new ApiError("后端没有配置可用模型", 0);
    if (!state.models.includes(state.activeModel)) {
      const preferred = state.providers.find((p) => p.default_model)?.default_model;
      state.activeModel = state.models.includes(preferred) ? preferred : state.models[0];
      savePrefs();
    }
  }

  async function fetchSessions() {
    const data = await apiJson("/api/sessions");
    state.sessions = data.sessions || [];
  }

  async function fetchMessages(sessionId) {
    const data = await apiJson(`/api/sessions/${encodeURIComponent(sessionId)}`);
    state.messageCache.set(sessionId, data.messages || []);
    return data;
  }

  /* ========== Markdown 渲染（先转义再解析，输出安全 HTML） ========== */

  function escapeHtml(text) {
    return text
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  function renderInline(text) {
    let html = escapeHtml(text);
    html = html.replace(/`([^`]+)`/g, (_, code) => `<code>${code}</code>`);
    html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    html = html.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>");
    html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_, label, url) => {
      return `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`;
    });
    return html;
  }

  function renderMarkdown(text) {
    const lines = text.split("\n");
    const out = [];
    let paragraph = [];
    let list = null; // { type: "ul" | "ol", items: [] }

    const flushParagraph = () => {
      if (!paragraph.length) return;
      out.push(`<p>${paragraph.map(renderInline).join("<br>")}</p>`);
      paragraph = [];
    };
    const flushList = () => {
      if (!list) return;
      out.push(`<${list.type}>${list.items.map((item) => `<li>${item}</li>`).join("")}</${list.type}>`);
      list = null;
    };
    const flushAll = () => {
      flushParagraph();
      flushList();
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      const fence = line.match(/^\s*```(\S*)\s*$/);
      if (fence) {
        flushAll();
        const language = fence[1];
        const codeLines = [];
        i++;
        while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
          codeLines.push(lines[i]);
          i++;
        }
        out.push(
          `<div class="code-block">` +
            `<div class="code-block-header"><span>${escapeHtml(language || "代码")}</span>` +
            `<button type="button" class="code-copy-button">复制</button></div>` +
            `<pre><code>${escapeHtml(codeLines.join("\n"))}</code></pre></div>`,
        );
        continue;
      }

      const heading = line.match(/^(#{1,4})\s+(.*)$/);
      if (heading) {
        flushAll();
        const level = heading[1].length;
        out.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
        continue;
      }

      if (/^\s*(---+|\*\*\*+)\s*$/.test(line)) {
        flushAll();
        out.push("<hr>");
        continue;
      }

      const quote = line.match(/^>\s?(.*)$/);
      if (quote) {
        flushAll();
        const quoteLines = [quote[1]];
        while (i + 1 < lines.length) {
          const next = lines[i + 1].match(/^>\s?(.*)$/);
          if (!next) break;
          quoteLines.push(next[1]);
          i++;
        }
        out.push(`<blockquote>${quoteLines.map(renderInline).join("<br>")}</blockquote>`);
        continue;
      }

      const unordered = line.match(/^\s*[-*+]\s+(.*)$/);
      const ordered = line.match(/^\s*\d+[.)]\s+(.*)$/);
      if (unordered || ordered) {
        flushParagraph();
        const type = unordered ? "ul" : "ol";
        if (!list || list.type !== type) {
          flushList();
          list = { type, items: [] };
        }
        list.items.push(renderInline((unordered || ordered)[1]));
        continue;
      }

      if (!line.trim()) {
        flushAll();
        continue;
      }

      flushList();
      paragraph.push(line);
    }

    flushAll();
    return out.join("");
  }

  /* ========== 渲染 ========== */

  function render() {
    renderSessions();
    renderModelMenu();
    renderConnection();
    renderComposer();
  }

  function sessionGroupLabel(timestamp) {
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    if (timestamp >= startOfDay) return "今天";
    if (timestamp >= startOfDay - 86400000) return "昨天";
    if (timestamp >= startOfDay - 7 * 86400000) return "近 7 天";
    if (timestamp >= startOfDay - 30 * 86400000) return "近 30 天";
    return "更早";
  }

  function renderSessions() {
    el.sessionList.innerHTML = "";

    if (!state.sessions.length) {
      const empty = document.createElement("div");
      empty.className = "session-empty";
      empty.textContent = "还没有历史对话";
      el.sessionList.append(empty);
      return;
    }

    let lastGroup = "";
    for (const session of state.sessions) {
      const group = sessionGroupLabel(session.updatedAt || 0);
      if (group !== lastGroup) {
        const label = document.createElement("div");
        label.className = "session-group-label";
        label.textContent = group;
        el.sessionList.append(label);
        lastGroup = group;
      }

      const item = document.createElement("div");
      item.className = "session-item";
      if (session.id === state.activeSessionId) item.classList.add("active");
      if (session.id === state.menuSessionId) item.classList.add("menu-open");
      item.dataset.sessionId = session.id;

      const titleButton = document.createElement("button");
      titleButton.type = "button";
      titleButton.className = "session-title-button";
      titleButton.dataset.action = "open";
      const title = document.createElement("span");
      title.textContent = session.title || DRAFT_TITLE;
      titleButton.append(title);

      const moreButton = document.createElement("button");
      moreButton.type = "button";
      moreButton.className = "session-more-button";
      moreButton.dataset.action = "menu";
      moreButton.setAttribute("aria-label", "会话操作");
      moreButton.textContent = "⋯";

      item.append(titleButton, moreButton);
      el.sessionList.append(item);
    }
  }

  function renderModelMenu() {
    el.modelButtonLabel.textContent = state.activeModel || "选择模型";
    el.modelButton.disabled = !state.models.length;
    el.modelButton.setAttribute("aria-expanded", String(state.modelMenuOpen));
    el.modelPopover.classList.toggle("open", state.modelMenuOpen);
    el.modelPopover.innerHTML = "";

    for (const model of state.models) {
      const active = model === state.activeModel;
      const button = document.createElement("button");
      button.type = "button";
      button.className = `model-option${active ? " active" : ""}`;
      button.dataset.model = model;
      button.setAttribute("role", "option");
      button.setAttribute("aria-selected", String(active));

      const text = document.createElement("span");
      text.className = "option-text";
      const name = document.createElement("span");
      name.textContent = model;
      const detail = document.createElement("small");
      detail.textContent = state.providers
        .filter((p) => (p.models || []).includes(model))
        .map((p) => p.name || p.id)
        .join(" / ");
      text.append(name, detail);

      const check = document.createElement("span");
      check.className = "check";
      check.textContent = "✓";

      button.append(text, check);
      el.modelPopover.append(button);
    }
  }

  function renderConnection() {
    try {
      const host = state.backendUrl ? new URL(state.backendUrl).host : "未连接";
      el.connectionLabel.textContent = state.userId ? `${host}` : "未连接";
      el.accountAvatar.textContent = (state.userId || "U").slice(0, 1).toUpperCase();
    } catch {
      el.connectionLabel.textContent = "未连接";
    }
  }

  function renderComposer() {
    const hasText = Boolean(el.promptInput.value.trim());
    el.sendButton.disabled = state.isStreaming ? false : !hasText || !state.authToken;
    el.sendButton.classList.toggle("streaming", state.isStreaming);
    el.sendButton.setAttribute("aria-label", state.isStreaming ? "停止生成" : "发送");
  }

  function renderMessages() {
    el.chatThread.innerHTML = "";

    if (!state.messages.length) {
      const empty = document.createElement("div");
      empty.className = "empty-state";
      const h2 = document.createElement("h2");
      h2.textContent = "有什么可以帮忙的？";
      empty.append(h2);
      el.chatThread.append(empty);
      return;
    }

    for (const message of state.messages) {
      el.chatThread.append(createMessageNode(message));
    }
    scrollToBottom(true);
  }

  function createMessageNode(message) {
    const wrap = document.createElement("div");
    wrap.className = `message ${message.role}`;
    if (message.streaming) wrap.classList.add("streaming");

    const body = document.createElement("div");
    body.className = "message-body";
    if (message.role === "assistant") {
      body.innerHTML = renderMarkdown(message.content);
    } else {
      body.textContent = message.content;
    }
    wrap.append(body);

    if (message.error) {
      const error = document.createElement("div");
      error.className = "message-error";
      error.textContent = message.error;
      wrap.append(error);
    }

    if (message.role === "assistant" && !message.streaming && message.content) {
      const actions = document.createElement("div");
      actions.className = "message-actions";
      const copy = document.createElement("button");
      copy.type = "button";
      copy.dataset.action = "copy";
      copy.title = "复制";
      copy.setAttribute("aria-label", "复制");
      copy.innerHTML =
        '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
      actions.append(copy);
      wrap.append(actions);
    }

    return wrap;
  }

  function isNearBottom() {
    const node = el.chatScroll;
    return node.scrollHeight - node.scrollTop - node.clientHeight < 120;
  }

  function scrollToBottom(force) {
    if (force || isNearBottom()) {
      el.chatScroll.scrollTop = el.chatScroll.scrollHeight;
    }
  }

  let streamRenderQueued = false;

  function renderStreamingMessage() {
    if (streamRenderQueued) return;
    streamRenderQueued = true;
    requestAnimationFrame(() => {
      streamRenderQueued = false;
      const last = state.messages[state.messages.length - 1];
      const node = el.chatThread.lastElementChild?.querySelector(".message-body");
      if (!last || !node) return;
      const stick = isNearBottom();
      node.innerHTML = renderMarkdown(last.content);
      scrollToBottom(stick);
    });
  }

  function showToast(message) {
    el.toast.textContent = message;
    el.toast.classList.add("show");
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => el.toast.classList.remove("show"), 2600);
  }

  /* ========== 动作 ========== */

  function forceRelogin() {
    stopStreaming();
    clearAuth();
    el.loginOverlay.classList.remove("hidden");
    el.loginError.textContent = "登录已过期，请重新连接";
  }

  function createSessionId() {
    if (window.crypto?.randomUUID) return crypto.randomUUID();
    return `s-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function startNewChat() {
    if (state.isStreaming) stopStreaming();
    state.activeSessionId = "";
    state.messages = [];
    closeSidebar();
    renderSessions();
    renderMessages();
    el.promptInput.focus();
  }

  async function openSession(sessionId) {
    if (state.isStreaming) stopStreaming();
    state.activeSessionId = sessionId;
    state.messages = state.messageCache.get(sessionId) || [];
    closeSidebar();
    renderSessions();
    renderMessages();
    try {
      await fetchMessages(sessionId);
      if (state.activeSessionId !== sessionId) return;
      state.messages = state.messageCache.get(sessionId);
      renderMessages();
    } catch (error) {
      showToast(error.message || "加载会话失败");
    }
  }

  async function sendMessage() {
    const text = el.promptInput.value.trim();
    if (!text || state.isStreaming || !state.authToken) return;

    let sessionId = state.activeSessionId;
    if (!sessionId) {
      sessionId = createSessionId();
      state.activeSessionId = sessionId;
      state.sessions.unshift({
        id: sessionId,
        title: text.split("\n")[0].slice(0, 30) || DRAFT_TITLE,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    }

    el.promptInput.value = "";
    resizeTextarea();

    const userMessage = { role: "user", content: text };
    const assistantMessage = { role: "assistant", content: "", streaming: true };
    state.messages = [...state.messages, userMessage, assistantMessage];
    state.messageCache.set(sessionId, state.messages);

    state.isStreaming = true;
    state.abortController = new AbortController();
    renderSessions();
    renderMessages();
    renderComposer();

    try {
      const response = await api("/api/chat/stream", {
        method: "POST",
        body: JSON.stringify({
          session_id: sessionId,
          content: text,
          model: state.activeModel,
        }),
        signal: state.abortController.signal,
      });
      await consumeStream(response, assistantMessage);
    } catch (error) {
      if (error.name === "AbortError") {
        assistantMessage.error = assistantMessage.content ? "" : "已停止生成";
      } else {
        assistantMessage.error = error.message || "请求失败";
      }
    } finally {
      assistantMessage.streaming = false;
      state.isStreaming = false;
      state.abortController = null;
      renderMessages();
      renderComposer();
      syncSessions();
    }
  }

  async function consumeStream(response, assistantMessage) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    const consume = (chunkText, isFinal) => {
      buffer += chunkText;
      const events = buffer.replace(/\r\n/g, "\n").split("\n\n");
      buffer = isFinal ? "" : events.pop() || "";

      for (const eventText of events) {
        for (const line of eventText.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (!data || data === "[DONE]") continue;
          applyStreamData(data, assistantMessage);
        }
      }
    };

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      consume(decoder.decode(value, { stream: true }), false);
      renderStreamingMessage();
    }
    consume(decoder.decode() + "\n\n", true);
  }

  function applyStreamData(data, assistantMessage) {
    let parsed;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    if (parsed.error) {
      assistantMessage.error = parsed.error.message || "生成出错";
      return;
    }
    const choice = (parsed.choices || [])[0] || {};
    assistantMessage.content += choice.delta?.content || choice.message?.content || "";
  }

  function stopStreaming() {
    if (state.abortController) state.abortController.abort();
  }

  async function syncSessions() {
    try {
      await fetchSessions();
      renderSessions();
    } catch {
      /* 列表同步失败不打断聊天 */
    }
  }

  async function renameSession(sessionId) {
    const session = state.sessions.find((item) => item.id === sessionId);
    const title = prompt("重命名对话", session?.title || "");
    if (title === null) return;
    const trimmed = title.trim().slice(0, 100);
    if (!trimmed) return;
    try {
      await apiJson(`/api/sessions/${encodeURIComponent(sessionId)}`, {
        method: "PATCH",
        body: JSON.stringify({ title: trimmed }),
      });
      if (session) session.title = trimmed;
      renderSessions();
    } catch (error) {
      showToast(error.message || "重命名失败");
    }
  }

  async function deleteSession(sessionId) {
    const session = state.sessions.find((item) => item.id === sessionId);
    if (!confirm(`删除对话「${session?.title || ""}」？此操作不可恢复。`)) return;
    try {
      await api(`/api/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
      state.sessions = state.sessions.filter((item) => item.id !== sessionId);
      state.messageCache.delete(sessionId);
      if (state.activeSessionId === sessionId) startNewChat();
      renderSessions();
    } catch (error) {
      showToast(error.message || "删除失败");
    }
  }

  function openSessionMenu(sessionId, anchor) {
    state.menuSessionId = sessionId;
    el.sessionMenu.hidden = false;
    const rect = anchor.getBoundingClientRect();
    const menuRect = el.sessionMenu.getBoundingClientRect();
    let left = rect.left;
    let top = rect.bottom + 4;
    if (left + menuRect.width > window.innerWidth - 8) left = window.innerWidth - menuRect.width - 8;
    if (top + menuRect.height > window.innerHeight - 8) top = rect.top - menuRect.height - 4;
    el.sessionMenu.style.left = `${left}px`;
    el.sessionMenu.style.top = `${top}px`;
    renderSessions();
  }

  function closeSessionMenu() {
    if (el.sessionMenu.hidden) return;
    el.sessionMenu.hidden = true;
    state.menuSessionId = "";
    renderSessions();
  }

  function openSidebar() {
    document.querySelector(".app").classList.add("sidebar-open");
  }

  function closeSidebar() {
    document.querySelector(".app").classList.remove("sidebar-open");
  }

  function resizeTextarea() {
    el.promptInput.style.height = "auto";
    el.promptInput.style.height = `${Math.min(el.promptInput.scrollHeight, 200)}px`;
  }

  async function hydrate() {
    loadPrefs();
    await fetchProviders();
    await fetchSessions();
    startNewChat();
    render();
  }

  async function handleLogin(event) {
    event.preventDefault();
    el.loginError.textContent = "";
    el.loginSubmitButton.disabled = true;

    const backendUrl = el.backendUrlInput.value.trim().replace(/\/+$/, "");
    const accessKey = el.accessKeyInput.value.trim();

    try {
      await login(backendUrl, accessKey);
      state.messageCache.clear();
      await hydrate();
      el.loginOverlay.classList.add("hidden");
      el.accessKeyInput.value = "";
    } catch (error) {
      el.loginError.textContent = error.message || "连接失败";
    } finally {
      el.loginSubmitButton.disabled = false;
    }
  }

  function logout() {
    if (!confirm("退出登录？")) return;
    stopStreaming();
    clearAuth();
    state.backendUrl = "";
    state.providers = [];
    state.models = [];
    state.activeModel = "";
    state.sessions = [];
    state.messages = [];
    state.messageCache.clear();
    state.activeSessionId = "";
    el.backendUrlInput.value = "http://localhost:8000";
    el.loginError.textContent = "";
    el.loginOverlay.classList.remove("hidden");
    render();
    renderMessages();
  }

  /* ========== 事件绑定 ========== */

  function bindEvents() {
    el.loginForm.addEventListener("submit", handleLogin);
    el.logoutButton.addEventListener("click", logout);

    el.composer.addEventListener("submit", (event) => {
      event.preventDefault();
      if (state.isStreaming) {
        stopStreaming();
      } else {
        sendMessage();
      }
    });

    const coarsePointer = window.matchMedia("(pointer: coarse)").matches;
    el.promptInput.addEventListener("input", () => {
      resizeTextarea();
      renderComposer();
    });
    el.promptInput.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      if (event.isComposing || event.keyCode === 229) return; // 中文输入法候选确认
      if (event.shiftKey || coarsePointer) return; // 移动端 Enter 换行，用按钮发送
      event.preventDefault();
      if (!state.isStreaming) sendMessage();
    });

    el.newChatButton.addEventListener("click", startNewChat);
    el.topbarNewChatButton.addEventListener("click", startNewChat);

    el.menuButton.addEventListener("click", openSidebar);
    el.sidebarCloseButton.addEventListener("click", closeSidebar);
    el.sidebarBackdrop.addEventListener("click", closeSidebar);

    el.modelButton.addEventListener("click", () => {
      state.modelMenuOpen = !state.modelMenuOpen;
      renderModelMenu();
    });
    el.modelPopover.addEventListener("click", (event) => {
      const option = event.target.closest(".model-option");
      if (!option) return;
      state.activeModel = option.dataset.model;
      state.modelMenuOpen = false;
      savePrefs();
      renderModelMenu();
    });

    el.sessionList.addEventListener("click", (event) => {
      const item = event.target.closest(".session-item");
      if (!item) return;
      const action = event.target.closest("button")?.dataset.action;
      if (action === "menu") {
        event.stopPropagation();
        openSessionMenu(item.dataset.sessionId, event.target.closest("button"));
      } else if (action === "open") {
        openSession(item.dataset.sessionId);
      }
    });

    el.sessionMenu.addEventListener("click", (event) => {
      const action = event.target.closest("button")?.dataset.action;
      const sessionId = state.menuSessionId;
      closeSessionMenu();
      if (!sessionId) return;
      if (action === "rename") renameSession(sessionId);
      if (action === "delete") deleteSession(sessionId);
    });

    el.chatThread.addEventListener("click", async (event) => {
      const copyCode = event.target.closest(".code-copy-button");
      if (copyCode) {
        const code = copyCode.closest(".code-block")?.querySelector("code")?.textContent || "";
        await copyText(code, copyCode);
        return;
      }
      const copyMessage = event.target.closest('[data-action="copy"]');
      if (copyMessage) {
        const index = [...el.chatThread.querySelectorAll(".message")].indexOf(
          copyMessage.closest(".message"),
        );
        const message = state.messages[index];
        if (message) {
          await copyText(message.content);
          showToast("已复制");
        }
      }
    });

    document.addEventListener("click", (event) => {
      if (state.modelMenuOpen && !event.target.closest(".model-menu")) {
        state.modelMenuOpen = false;
        renderModelMenu();
      }
      if (!event.target.closest(".session-menu") && !event.target.closest(".session-more-button")) {
        closeSessionMenu();
      }
    });

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        closeSessionMenu();
        closeSidebar();
        if (state.modelMenuOpen) {
          state.modelMenuOpen = false;
          renderModelMenu();
        }
      }
    });

    window.addEventListener("resize", closeSessionMenu);
  }

  async function copyText(text, button) {
    try {
      await navigator.clipboard.writeText(text);
      if (button) {
        const original = button.textContent;
        button.textContent = "已复制";
        setTimeout(() => (button.textContent = original), 1500);
      }
    } catch {
      showToast("复制失败");
    }
  }

  /* ========== 启动 ========== */

  async function init() {
    bindEvents();
    loadAuth();
    el.backendUrlInput.value = state.backendUrl || "http://localhost:8000";
    render();
    renderMessages();

    if (await validateSavedLogin()) {
      try {
        await hydrate();
        el.loginOverlay.classList.add("hidden");
        return;
      } catch (error) {
        showToast(error.message || "初始化失败");
      }
    }
    clearAuth();
    el.loginOverlay.classList.remove("hidden");
  }

  init();
})();
