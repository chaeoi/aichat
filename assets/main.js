(function (window) {
  const ChatApp = window.ChatApp || (window.ChatApp = {});

  ChatApp.AUTH_STORAGE_KEY = "chat-api-auth-state";
  ChatApp.LEGACY_STORAGE_KEY = "chat-api-ui-state";
  ChatApp.PREFERENCE_PREFIX = "chat-api-preferences";

  ChatApp.state = {
    backendUrl: "",
    accessKey: "",
    authToken: "",
    tokenExpiresAt: "",
    userId: "",
    providers: [],
    models: [],
    activeModel: "",
    sessions: [],
    activeSessionId: "",
    isSending: false,
    modelMenuOpen: false,
  };
})(window);

(function (window, document) {
  const ChatApp = window.ChatApp;

  ChatApp.elements = {
    loginOverlay: document.querySelector("#loginOverlay"),
    loginForm: document.querySelector("#loginForm"),
    backendUrlInput: document.querySelector("#backendUrlInput"),
    accessKeyInput: document.querySelector("#accessKeyInput"),
    loginError: document.querySelector("#loginError"),
    modelButton: document.querySelector("#modelButton"),
    modelButtonLabel: document.querySelector("#modelButtonLabel"),
    modelPopover: document.querySelector("#modelPopover"),
    composer: document.querySelector("#composer"),
    promptInput: document.querySelector("#promptInput"),
    sendButton: document.querySelector("#sendButton"),
    messages: document.querySelector("#messages"),
    sessionList: document.querySelector("#sessionList"),
    newChatButton: document.querySelector("#newChatButton"),
    logoutButton: document.querySelector("#logoutButton"),
    accountButton: document.querySelector("#accountButton"),
    connectionLabel: document.querySelector("#connectionLabel"),
    openSidebarButton: document.querySelector("#openSidebarButton"),
    closeSidebarButton: document.querySelector("#closeSidebarButton"),
    sidebar: document.querySelector(".sidebar"),
  };
})(window, document);

(function (window) {
  const ChatApp = window.ChatApp;
  const {
    AUTH_STORAGE_KEY,
    LEGACY_STORAGE_KEY,
    PREFERENCE_PREFIX,
    state,
  } = ChatApp;

  function loadAuthState() {
    const raw = localStorage.getItem(AUTH_STORAGE_KEY);
    if (!raw) return;

    try {
      const saved = JSON.parse(raw);
      state.backendUrl = saved.backendUrl || "";
      state.authToken = saved.authToken || "";
      state.tokenExpiresAt = saved.tokenExpiresAt || "";
      state.userId = saved.userId || "";
    } catch {
      localStorage.removeItem(AUTH_STORAGE_KEY);
    }
  }

  function saveAuthState() {
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

  function clearAuthState() {
    localStorage.removeItem(AUTH_STORAGE_KEY);
  }

  function userStorageKey() {
    if (!state.backendUrl || !state.userId) return "";
    return `${PREFERENCE_PREFIX}:${state.backendUrl}:${state.userId}`;
  }

  function loadPreferences() {
    const key = userStorageKey();
    if (!key) return;

    const raw = localStorage.getItem(key);
    if (!raw) return;

    try {
      const saved = JSON.parse(raw);
      state.activeModel = saved.activeModel || "";
      state.activeSessionId = saved.activeSessionId || "";
    } catch {
      localStorage.removeItem(key);
    }
  }

  function migrateLegacyState() {
    const raw = localStorage.getItem(LEGACY_STORAGE_KEY);
    const key = userStorageKey();
    if (!raw || !key) return;

    try {
      const saved = JSON.parse(raw);
      localStorage.setItem(
        key,
        JSON.stringify({
          activeModel: saved.activeModel || "",
          activeSessionId: saved.activeSessionId || "",
        }),
      );
      localStorage.removeItem(LEGACY_STORAGE_KEY);
      loadPreferences();
    } catch {
      localStorage.removeItem(LEGACY_STORAGE_KEY);
    }
  }

  function savePreferences() {
    const key = userStorageKey();
    if (!key) return;

    localStorage.setItem(
      key,
      JSON.stringify({
        activeModel: state.activeModel,
        activeSessionId: state.activeSessionId,
      }),
    );
  }

  function resetUserState() {
    state.providers = [];
    state.models = [];
    state.activeModel = "";
    state.sessions = [];
    state.activeSessionId = "";
    state.modelMenuOpen = false;
  }

  function normalizeBackendUrl(url) {
    return url.trim().replace(/\/+$/, "");
  }

  function createId() {
    if (window.crypto?.randomUUID) {
      return window.crypto.randomUUID();
    }
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function modelsFromProviders(providers) {
    const models = [];
    for (const provider of providers) {
      for (const model of provider.models || []) {
        if (!models.includes(model)) models.push(model);
      }
    }
    return models;
  }

  function activeSession() {
    return state.sessions.find((session) => session.id === state.activeSessionId);
  }

  async function readableError(response) {
    try {
      const data = await response.json();
      return data.detail || response.statusText;
    } catch {
      return response.statusText || "请求失败";
    }
  }

  Object.assign(ChatApp, {
    activeSession,
    clearAuthState,
    createId,
    loadAuthState,
    loadPreferences,
    migrateLegacyState,
    modelsFromProviders,
    normalizeBackendUrl,
    readableError,
    resetUserState,
    saveAuthState,
    savePreferences,
  });
})(window);

(function (window) {
  const ChatApp = window.ChatApp;
  const {
    activeSession,
    clearAuthState,
    createId,
    modelsFromProviders,
    readableError,
    saveAuthState,
    state,
  } = ChatApp;

  function authHeaders(extra = {}) {
    return {
      ...extra,
      Authorization: `Bearer ${state.authToken}`,
    };
  }

  async function loginWithAccessKey(accessKey) {
    const response = await fetch(`${state.backendUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ access_key: accessKey }),
    });

    if (!response.ok) {
      throw new Error(await readableError(response));
    }

    const data = await response.json();
    state.authToken = data.token || "";
    state.tokenExpiresAt = data.expires_at || "";
    state.userId = data.user_id || "";
    if (!state.authToken || !state.userId) {
      throw new Error("后端没有返回有效 JWT");
    }
    saveAuthState();
  }

  async function validateSavedLogin() {
    if (!state.backendUrl || !state.authToken || !state.userId) return false;
    if (state.tokenExpiresAt && Date.parse(state.tokenExpiresAt) <= Date.now()) {
      clearAuthState();
      return false;
    }

    const response = await fetch(`${state.backendUrl}/api/auth/me`, {
      headers: authHeaders(),
    });
    if (!response.ok) {
      clearAuthState();
      return false;
    }

    const data = await response.json();
    state.userId = data.user_id || state.userId;
    saveAuthState();
    return true;
  }

  async function fetchProviders() {
    const response = await fetch(`${state.backendUrl}/api/providers`, {
      headers: authHeaders(),
    });
    if (!response.ok) {
      throw new Error(await readableError(response));
    }

    const data = await response.json();
    state.providers = data.providers || [];
    state.models = Array.isArray(data.models) ? data.models : modelsFromProviders(state.providers);
    if (!state.models.length) {
      throw new Error("后端没有配置可用模型");
    }

    if (!state.models.includes(state.activeModel)) {
      const defaultModel = state.providers.find((provider) => provider.default_model)?.default_model;
      state.activeModel = defaultModel && state.models.includes(defaultModel) ? defaultModel : state.models[0];
    }
  }

  async function fetchSessions() {
    const response = await fetch(`${state.backendUrl}/api/sessions`, {
      headers: authHeaders(),
    });
    if (!response.ok) {
      throw new Error(await readableError(response));
    }

    const data = await response.json();
    state.sessions = (data.sessions || []).map((session) => ({ ...session, messages: [] }));
    if (!state.sessions.some((session) => session.id === state.activeSessionId)) {
      state.activeSessionId = state.sessions[0]?.id || "";
    }
  }

  async function fetchSessionMessages(sessionId) {
    if (!sessionId) return;

    const response = await fetch(`${state.backendUrl}/api/sessions/${encodeURIComponent(sessionId)}`, {
      headers: authHeaders(),
    });
    if (!response.ok) {
      throw new Error(await readableError(response));
    }

    const data = await response.json();
    const session = state.sessions.find((item) => item.id === sessionId);
    if (!session) return;
    session.title = data.session.title;
    session.createdAt = data.session.createdAt;
    session.updatedAt = data.session.updatedAt;
    session.messages = data.messages || [];
  }

  async function createRemoteSession() {
    const id = createId();
    const response = await fetch(`${state.backendUrl}/api/sessions`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ id, title: "新对话" }),
    });
    if (!response.ok) {
      throw new Error(await readableError(response));
    }

    const data = await response.json();
    const session = { ...data.session, messages: [] };
    state.sessions.unshift(session);
    state.activeSessionId = session.id;
    return session;
  }

  async function ensureSession() {
    if (!state.sessions.length || !activeSession()) {
      await createRemoteSession();
    }
  }

  Object.assign(ChatApp, {
    authHeaders,
    createRemoteSession,
    ensureSession,
    fetchProviders,
    fetchSessionMessages,
    fetchSessions,
    loginWithAccessKey,
    validateSavedLogin,
  });
})(window);

(function (window, document) {
  const ChatApp = window.ChatApp;
  const { activeSession, elements, savePreferences, state } = ChatApp;

  function renderModelMenu() {
    elements.modelButtonLabel.textContent = state.activeModel || "选择模型";
    elements.modelButton.disabled = !state.models.length;
    elements.modelButton.setAttribute("aria-expanded", String(state.modelMenuOpen));
    elements.modelPopover.classList.toggle("open", state.modelMenuOpen);
    elements.modelPopover.innerHTML = "";

    for (const model of state.models) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `model-option${model === state.activeModel ? " active" : ""}`;
      button.dataset.model = model;
      button.setAttribute("role", "option");
      button.setAttribute("aria-selected", String(model === state.activeModel));

      const name = document.createElement("span");
      name.textContent = model;

      const detail = document.createElement("small");
      detail.textContent = providerNamesForModel(model).join(" / ");

      button.append(name, detail);
      elements.modelPopover.append(button);
    }
  }

  function providerNamesForModel(model) {
    return state.providers
      .filter((provider) => (provider.models || []).includes(model))
      .map((provider) => provider.name || provider.id);
  }

  function renderSessions() {
    elements.sessionList.innerHTML = "";

    for (const session of state.sessions) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `session-item${session.id === state.activeSessionId ? " active" : ""}`;
      button.dataset.sessionId = session.id;

      const title = document.createElement("span");
      title.textContent = session.title;
      button.append(title);
      elements.sessionList.append(button);
    }
  }

  function renderMessages() {
    const session = activeSession();
    elements.messages.innerHTML = "";

    if (!session || session.messages.length === 0) {
      const empty = document.createElement("div");
      empty.className = "empty-state";
      empty.innerHTML = "<h2>有什么可以帮忙的？</h2>";
      elements.messages.append(empty);
      return;
    }

    for (const message of session.messages) {
      elements.messages.append(createMessageNode(message));
    }
    elements.messages.scrollTop = elements.messages.scrollHeight;
  }

  function createMessageNode(message) {
    const row = document.createElement("div");
    row.className = "message-row";

    const item = document.createElement("article");
    item.className = `message ${message.role}`;

    const avatar = document.createElement("div");
    avatar.className = "message-avatar";
    avatar.textContent = message.role === "user" ? "U" : "AI";

    const content = document.createElement("div");
    content.className = "message-content";
    if (message.pending) content.classList.add("typing");
    content.textContent = message.content;

    item.append(avatar, content);
    row.append(item);
    return row;
  }

  function renderConnection() {
    try {
      const host = state.backendUrl ? new URL(state.backendUrl).host : "未连接";
      elements.connectionLabel.textContent = state.userId ? `${host} · ${state.userId}` : host;
    } catch {
      elements.connectionLabel.textContent = "未连接";
    }
  }

  function render() {
    renderModelMenu();
    renderSessions();
    renderMessages();
    renderConnection();
    elements.sendButton.disabled = state.isSending || !state.authToken;
  }

  function resizeTextarea() {
    elements.promptInput.style.height = "auto";
    elements.promptInput.style.height = `${Math.min(elements.promptInput.scrollHeight, 180)}px`;
  }

  function updateLastAssistantNode(assistantMessage) {
    const nodes = elements.messages.querySelectorAll(".message.assistant .message-content");
    const node = nodes[nodes.length - 1];
    if (!node) return;
    node.textContent = assistantMessage.content;
    elements.messages.scrollTop = elements.messages.scrollHeight;
  }

  function selectModel(model) {
    state.activeModel = model;
    state.modelMenuOpen = false;
    savePreferences();
    renderModelMenu();
  }

  Object.assign(ChatApp, {
    render,
    renderConnection,
    renderModelMenu,
    resizeTextarea,
    selectModel,
    updateLastAssistantNode,
  });
})(window, document);

(function (window) {
  const ChatApp = window.ChatApp;
  const {
    authHeaders,
    readableError,
    state,
    updateLastAssistantNode,
  } = ChatApp;

  async function streamAssistantReply(session, assistantMessage) {
    const requestMessages = session.messages
      .filter((message) => !message.pending)
      .map(({ role, content }) => ({ role, content }));

    const response = await fetch(`${state.backendUrl}/api/chat/stream`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        session_id: session.id,
        model: state.activeModel,
        messages: requestMessages,
      }),
    });

    if (!response.ok || !response.body) {
      throw new Error(await readableError(response));
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      buffer = consumeSseBuffer(buffer, assistantMessage);
      updateLastAssistantNode(assistantMessage);
    }

    buffer += decoder.decode();
    consumeSseBuffer(buffer, assistantMessage);
  }

  function consumeSseBuffer(buffer, assistantMessage) {
    const events = buffer.split(/\r?\n\r?\n/);
    const remainder = events.pop() || "";

    for (const eventText of events) {
      const dataLines = eventText
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart());

      for (const data of dataLines) {
        if (!data || data === "[DONE]") continue;
        appendDelta(data, assistantMessage);
      }
    }

    return remainder;
  }

  function appendDelta(data, assistantMessage) {
    try {
      const parsed = JSON.parse(data);
      if (parsed.error) {
        assistantMessage.content += `请求失败：${parsed.error.message || JSON.stringify(parsed.error)}`;
        return;
      }
      if (parsed.detail) {
        assistantMessage.content += `请求失败：${parsed.detail}`;
        return;
      }
      const delta = parsed.choices?.[0]?.delta?.content || "";
      const fallback = parsed.choices?.[0]?.message?.content || "";
      assistantMessage.content += delta || fallback;
    } catch {
      if (data.startsWith("Upstream request failed") || data.startsWith("请求失败")) {
        assistantMessage.content += data;
      }
    }
  }

  Object.assign(ChatApp, {
    streamAssistantReply,
  });
})(window);

(function (window) {
  const ChatApp = window.ChatApp;
  const {
    activeSession,
    clearAuthState,
    createRemoteSession,
    elements,
    ensureSession,
    fetchProviders,
    fetchSessionMessages,
    fetchSessions,
    loadPreferences,
    loginWithAccessKey,
    migrateLegacyState,
    normalizeBackendUrl,
    render,
    resetUserState,
    resizeTextarea,
    savePreferences,
    state,
    streamAssistantReply,
  } = ChatApp;

  async function hydrateUserData() {
    migrateLegacyState();
    loadPreferences();
    await fetchProviders();
    await fetchSessions();
    await ensureSession();
    await fetchSessionMessages(state.activeSessionId);
    savePreferences();
  }

  async function handleLogin(event) {
    event.preventDefault();
    elements.loginError.textContent = "";
    state.backendUrl = normalizeBackendUrl(elements.backendUrlInput.value);
    state.accessKey = elements.accessKeyInput.value.trim();

    try {
      await loginWithAccessKey(state.accessKey);
      resetUserState();
      await hydrateUserData();
      elements.loginOverlay.classList.add("hidden");
      elements.accessKeyInput.value = "";
      state.accessKey = "";
      render();
    } catch (error) {
      elements.loginError.textContent = error.message || "连接失败";
    }
  }

  function logout() {
    state.backendUrl = "";
    state.accessKey = "";
    state.authToken = "";
    state.tokenExpiresAt = "";
    state.userId = "";
    resetUserState();
    clearAuthState();
    elements.backendUrlInput.value = "http://localhost:8000";
    elements.accessKeyInput.value = "";
    elements.loginOverlay.classList.remove("hidden");
    elements.connectionLabel.textContent = "未连接";
    render();
  }

  async function sendMessage(event) {
    event.preventDefault();
    const text = elements.promptInput.value.trim();
    if (!text || state.isSending) return;

    await ensureSession();
    const session = activeSession();
    if (!session) {
      throw new Error("无法创建会话");
    }

    if (session.title === "新对话") {
      session.title = text.slice(0, 28);
    }

    session.messages.push({ role: "user", content: text });
    session.updatedAt = Date.now();
    const assistantMessage = { role: "assistant", content: "", pending: true };
    session.messages.push(assistantMessage);
    elements.promptInput.value = "";
    resizeTextarea();
    state.isSending = true;
    savePreferences();
    render();

    try {
      await streamAssistantReply(session, assistantMessage);
      await fetchSessions();
      state.activeSessionId = session.id;
      await fetchSessionMessages(session.id);
    } catch (error) {
      assistantMessage.content = error.message || "请求失败";
    } finally {
      assistantMessage.pending = false;
      session.updatedAt = Date.now();
      state.isSending = false;
      savePreferences();
      render();
    }
  }

  async function selectSession(sessionId) {
    state.activeSessionId = sessionId;
    elements.sidebar.classList.remove("open");
    savePreferences();
    try {
      await fetchSessionMessages(state.activeSessionId);
    } catch (error) {
      console.error(error);
    }
    render();
  }

  async function startNewChat() {
    try {
      await createRemoteSession();
      savePreferences();
      elements.sidebar.classList.remove("open");
      render();
    } catch (error) {
      console.error(error);
    }
  }

  Object.assign(ChatApp, {
    handleLogin,
    hydrateUserData,
    logout,
    selectSession,
    sendMessage,
    startNewChat,
  });
})(window);

(function (window, document) {
  const ChatApp = window.ChatApp;
  const {
    clearAuthState,
    elements,
    handleLogin,
    hydrateUserData,
    loadAuthState,
    logout,
    render,
    renderConnection,
    renderModelMenu,
    resetUserState,
    resizeTextarea,
    selectModel,
    selectSession,
    sendMessage,
    startNewChat,
    state,
    validateSavedLogin,
  } = ChatApp;

  function bindEvents() {
    elements.loginForm.addEventListener("submit", handleLogin);
    elements.composer.addEventListener("submit", sendMessage);

    elements.promptInput.addEventListener("input", resizeTextarea);
    elements.promptInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        elements.composer.requestSubmit();
      }
    });

    elements.modelButton.addEventListener("click", () => {
      state.modelMenuOpen = !state.modelMenuOpen;
      renderModelMenu();
    });

    elements.modelPopover.addEventListener("click", (event) => {
      const button = event.target.closest(".model-option");
      if (!button) return;
      selectModel(button.dataset.model);
    });

    document.addEventListener("click", (event) => {
      if (event.target.closest(".model-menu")) return;
      if (!state.modelMenuOpen) return;
      state.modelMenuOpen = false;
      renderModelMenu();
    });

    elements.sessionList.addEventListener("click", (event) => {
      const button = event.target.closest(".session-item");
      if (!button) return;
      selectSession(button.dataset.sessionId);
    });

    elements.newChatButton.addEventListener("click", startNewChat);
    elements.logoutButton.addEventListener("click", logout);
    elements.accountButton.addEventListener("click", () => {
      elements.loginOverlay.classList.remove("hidden");
    });
    elements.openSidebarButton.addEventListener("click", () => elements.sidebar.classList.add("open"));
    elements.closeSidebarButton.addEventListener("click", () => elements.sidebar.classList.remove("open"));
  }

  async function init() {
    bindEvents();
    loadAuthState();
    elements.backendUrlInput.value = state.backendUrl || "http://localhost:8000";
    elements.accessKeyInput.value = "";
    renderConnection();

    if (!state.backendUrl || !state.authToken) {
      render();
      return;
    }

    try {
      const isValid = await validateSavedLogin();
      if (!isValid) {
        elements.loginOverlay.classList.remove("hidden");
        render();
        return;
      }
      await hydrateUserData();
      elements.loginOverlay.classList.add("hidden");
      render();
    } catch {
      clearAuthState();
      resetUserState();
      elements.loginOverlay.classList.remove("hidden");
      render();
    }
  }

  init();
})(window, document);
