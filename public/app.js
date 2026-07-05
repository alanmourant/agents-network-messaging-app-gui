const OUTBOX_STORAGE_KEY = "stage-mesh-outbox-v2";
const HANDLE_STORAGE_KEY = "stage-mesh-handle-v1";
const RECIPIENT_ALIAS_STORAGE_KEY = "stage-mesh-recipient-alias-v1";
const TAB_REGISTRY_STORAGE_KEY = "stage-mesh-active-tabs-v1";
const TAB_HEARTBEAT_MS = 2000;
const TAB_STALE_MS = 7000;

const state = {
  ws: null,
  myId: null,
  myName: "",
  myDeviceLabel: "",
  users: [],
  activeRecipientId: null,
  recognitionActive: false,
  alwaysListening: false,
  lastSpeechConfidence: null,
  outbox: new Map(),
  messageIdToClientId: new Map(),
  sendTimeouts: new Map(),
  recipientAliases: {},
  lastIpHandleConflictSignature: "",
  recipientUnreadCounts: new Map(),
  recipientLastActivity: new Map(),
  tabId: null,
  tabHeartbeatTimer: null,
  lastKnownTabCount: 1
};

const refs = {
  recipientList: document.getElementById("recipientList"),
  onlineUserList: document.getElementById("onlineUserList"),
  handleInput: document.getElementById("handleInput"),
  saveHandleBtn: document.getElementById("saveHandleBtn"),
  resetHandleBtn: document.getElementById("resetHandleBtn"),
  myIdentity: document.getElementById("myIdentity"),
  activeRecipientTitle: document.getElementById("activeRecipientTitle"),
  connState: document.getElementById("connState"),
  onlineCount: document.getElementById("onlineCount"),
  tabStatus: document.getElementById("tabStatus"),
  messages: document.getElementById("messages"),
  receivedMessages: document.getElementById("receivedMessages"),
  messageForm: document.getElementById("messageForm"),
  composerPanel: document.getElementById("composerPanel"),
  messageInput: document.getElementById("messageInput"),
  prioritySelect: document.getElementById("prioritySelect"),
  quickActions: document.getElementById("quickActions"),
  sendBtn: document.getElementById("sendBtn"),
  recipientStatus: document.getElementById("recipientStatus"),
  queueStatus: document.getElementById("queueStatus"),
  outboxList: document.getElementById("outboxList"),
  alertBanner: document.getElementById("alertBanner"),
  pttBtn: document.getElementById("pttBtn"),
  speechStatus: document.getElementById("speechStatus"),
  alwaysListeningToggle: document.getElementById("alwaysListeningToggle")
};

function nowTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function makeClientId() {
  return self.crypto && self.crypto.randomUUID ? self.crypto.randomUUID() : `msg-${Date.now()}-${Math.random()}`;
}

function escapeHtml(text) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function setConnState(online) {
  refs.connState.textContent = online ? "online" : "offline";
  refs.connState.classList.toggle("online", online);
  refs.connState.classList.toggle("offline", !online);
}

function showAlert(text, level = "high") {
  refs.alertBanner.textContent = text;
  refs.alertBanner.classList.remove("hidden");
  refs.alertBanner.classList.toggle("critical", level === "critical");

  clearTimeout(showAlert._timer);
  showAlert._timer = setTimeout(() => {
    refs.alertBanner.classList.add("hidden");
  }, level === "critical" ? 9000 : 5500);
}

function inferDeviceLabel() {
  const ua = navigator.userAgent || "";
  const platform = navigator.platform || "Device";

  let browser = "Browser";
  if (/Edg\//i.test(ua)) {
    browser = "Edge";
  } else if (/Chrome\//i.test(ua)) {
    browser = "Chrome";
  } else if (/Safari\//i.test(ua) && !/Chrome\//i.test(ua)) {
    browser = "Safari";
  } else if (/Firefox\//i.test(ua)) {
    browser = "Firefox";
  }

  let device = "Device";
  if (/iPhone/i.test(ua)) {
    device = "iPhone";
  } else if (/iPad/i.test(ua)) {
    device = "iPad";
  } else if (/Android/i.test(ua)) {
    device = "Android";
  } else if (/Windows/i.test(platform)) {
    device = "Windows";
  } else if (/Mac/i.test(platform)) {
    device = "Mac";
  } else if (/Linux/i.test(platform)) {
    device = "Linux";
  }

  return `${device} ${browser}`;
}

function inferDisplayName(deviceLabel) {
  const suffix = Math.floor(Math.random() * 900 + 100);
  return `${deviceLabel}-${suffix}`;
}

function getStoredHandle() {
  const raw = localStorage.getItem(HANDLE_STORAGE_KEY) || "";
  const handle = raw.trim().slice(0, 40);
  return handle || null;
}

function setStoredHandle(handle) {
  const value = (handle || "").trim().slice(0, 40);
  if (!value) {
    localStorage.removeItem(HANDLE_STORAGE_KEY);
    return;
  }
  localStorage.setItem(HANDLE_STORAGE_KEY, value);
}

function loadRecipientAliases() {
  try {
    const raw = localStorage.getItem(RECIPIENT_ALIAS_STORAGE_KEY);
    if (!raw) {
      state.recipientAliases = {};
      return;
    }
    const parsed = JSON.parse(raw);
    state.recipientAliases = parsed && typeof parsed === "object" ? parsed : {};
  } catch (_err) {
    state.recipientAliases = {};
  }
}

function persistRecipientAliases() {
  localStorage.setItem(RECIPIENT_ALIAS_STORAGE_KEY, JSON.stringify(state.recipientAliases));
}

function getRecipientAlias(userId) {
  const alias = state.recipientAliases[userId];
  return typeof alias === "string" && alias.trim() ? alias.trim().slice(0, 40) : null;
}

function displayNameForUser(user) {
  if (!user) {
    return "Unknown";
  }
  const alias = getRecipientAlias(user.id);
  if (alias && user.isDefaultName) {
    return alias;
  }
  return user.name;
}

function setRecipientAlias(user) {
  if (!user || !user.isDefaultName) {
    return;
  }
  const current = getRecipientAlias(user.id) || "";
  const value = prompt(`Set local alias for ${user.name}`, current);
  if (value === null) {
    return;
  }
  const next = value.trim().slice(0, 40);
  if (!next) {
    delete state.recipientAliases[user.id];
  } else {
    state.recipientAliases[user.id] = next;
  }
  persistRecipientAliases();
  renderRecipientList();
  renderOnlineUsers();
  updateRecipientUi();
}

function updateIdentityUi() {
  refs.myIdentity.textContent = state.myName
    ? `You are ${state.myName}${state.myDeviceLabel ? ` (${state.myDeviceLabel})` : ""}`
    : "Using automatic device name.";
}

function applyHandleChange(handleValue) {
  const handle = (handleValue || "").trim().slice(0, 40);
  if (handle) {
    setStoredHandle(handle);
    state.myName = handle;
  } else {
    setStoredHandle("");
    state.myName = inferDisplayName(state.myDeviceLabel || inferDeviceLabel());
  }

  refs.handleInput.value = getStoredHandle() || "";
  updateIdentityUi();

  wsSend({
    type: "join",
    name: state.myName,
    deviceLabel: state.myDeviceLabel,
    isCustomName: Boolean(getStoredHandle())
  });
}

function readTabRegistry() {
  try {
    const raw = localStorage.getItem(TAB_REGISTRY_STORAGE_KEY);
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (_err) {
    return {};
  }
}

function pruneTabRegistry(registry, nowMs = Date.now()) {
  const next = {};
  for (const [id, ts] of Object.entries(registry || {})) {
    if (typeof ts !== "number" || !Number.isFinite(ts)) {
      continue;
    }
    if (nowMs - ts > TAB_STALE_MS) {
      continue;
    }
    next[id] = ts;
  }
  return next;
}

function updateTabHighlight(tabCount) {
  const safeCount = Math.max(1, tabCount || 1);
  const multiple = safeCount > 1;
  if (refs.tabStatus) {
    refs.tabStatus.textContent = `${safeCount} tabs`;
    refs.tabStatus.classList.toggle("hidden", !multiple);
  }
  document.body.classList.toggle("multi-tab-detected", multiple);

  if (multiple && state.lastKnownTabCount <= 1) {
    showAlert("Multiple browser tabs are using this app on this device.", "high");
  }
  state.lastKnownTabCount = safeCount;
}

function writeTabHeartbeat() {
  if (!state.tabId) {
    return;
  }
  const nowMs = Date.now();
  const registry = pruneTabRegistry(readTabRegistry(), nowMs);
  registry[state.tabId] = nowMs;
  localStorage.setItem(TAB_REGISTRY_STORAGE_KEY, JSON.stringify(registry));
  updateTabHighlight(Object.keys(registry).length);
}

function removeCurrentTabFromRegistry() {
  if (!state.tabId) {
    return;
  }
  const nowMs = Date.now();
  const registry = pruneTabRegistry(readTabRegistry(), nowMs);
  delete registry[state.tabId];
  localStorage.setItem(TAB_REGISTRY_STORAGE_KEY, JSON.stringify(registry));
}

function handleTabRegistryStorageUpdate(rawValue) {
  if (!state.tabId) {
    return;
  }
  let parsed = {};
  try {
    parsed = rawValue ? JSON.parse(rawValue) : {};
  } catch (_err) {
    parsed = {};
  }
  const registry = pruneTabRegistry(parsed, Date.now());
  if (!registry[state.tabId]) {
    registry[state.tabId] = Date.now();
  }
  updateTabHighlight(Object.keys(registry).length);
}

function initializeTabTracking() {
  state.tabId = makeClientId();
  writeTabHeartbeat();
  if (state.tabHeartbeatTimer) {
    clearInterval(state.tabHeartbeatTimer);
  }
  state.tabHeartbeatTimer = setInterval(() => {
    writeTabHeartbeat();
  }, TAB_HEARTBEAT_MS);

  window.addEventListener("storage", (evt) => {
    if (evt.key !== TAB_REGISTRY_STORAGE_KEY) {
      return;
    }
    handleTabRegistryStorageUpdate(evt.newValue);
  });

  window.addEventListener("beforeunload", () => {
    removeCurrentTabFromRegistry();
  });
}

function handleIpHandleConflict(payload) {
  const handles = Array.isArray(payload.handles)
    ? payload.handles.filter((name) => typeof name === "string" && name.trim())
    : [];

  if (handles.length < 2) {
    return;
  }

  const sorted = handles
    .map((name) => name.trim().slice(0, 40))
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  const ipAddress = typeof payload.ipAddress === "string" && payload.ipAddress.trim() ? payload.ipAddress.trim() : "unknown";
  const signature = `${ipAddress}|${sorted.join("|")}`;

  if (state.lastIpHandleConflictSignature === signature) {
    return;
  }
  state.lastIpHandleConflictSignature = signature;

  const keepCurrent = confirm(
    `More than one handle is being used on IP ${ipAddress}.\n\nHandles: ${sorted.join(", ")}\n\nKeep your current handle (${state.myName})?`
  );

  if (!keepCurrent) {
    applyHandleChange("");
    showAlert("Switched to default handle for this device.", "high");
    return;
  }

  showAlert("Multiple handles detected on this IP. Current handle confirmed.", "high");
}

function wsReady() {
  return Boolean(state.ws && state.ws.readyState === WebSocket.OPEN);
}

function touchRecipientActivity(recipientId, ts = Date.now()) {
  if (!recipientId || recipientId === state.myId) {
    return;
  }
  state.recipientLastActivity.set(recipientId, ts);
}

function getUnreadCount(recipientId) {
  return state.recipientUnreadCounts.get(recipientId) || 0;
}

function clearUnreadCount(recipientId) {
  if (!recipientId) {
    return;
  }
  state.recipientUnreadCounts.delete(recipientId);
}

function bumpUnreadCount(recipientId) {
  if (!recipientId) {
    return;
  }
  state.recipientUnreadCounts.set(recipientId, getUnreadCount(recipientId) + 1);
}

function pruneRecipientLiveState() {
  const onlineIds = new Set(state.users.filter((u) => u.id !== state.myId).map((u) => u.id));

  for (const id of state.recipientUnreadCounts.keys()) {
    if (!onlineIds.has(id)) {
      state.recipientUnreadCounts.delete(id);
    }
  }

  for (const id of state.recipientLastActivity.keys()) {
    if (!onlineIds.has(id)) {
      state.recipientLastActivity.delete(id);
    }
  }
}

function activeRecipient() {
  return state.users.find((user) => user.id === state.activeRecipientId) || null;
}

function persistOutbox() {
  const data = Array.from(state.outbox.values());
  localStorage.setItem(OUTBOX_STORAGE_KEY, JSON.stringify(data));
}

function loadOutbox() {
  try {
    const raw = localStorage.getItem(OUTBOX_STORAGE_KEY);
    if (!raw) {
      return;
    }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return;
    }
    for (const item of parsed) {
      if (item && typeof item.clientMessageId === "string") {
        state.outbox.set(item.clientMessageId, item);
      }
    }
  } catch (_err) {
    localStorage.removeItem(OUTBOX_STORAGE_KEY);
  }
}

function renderOutbox() {
  const items = Array.from(state.outbox.values()).slice(-8).reverse();
  refs.outboxList.innerHTML = "";

  for (const entry of items) {
    const row = document.createElement("div");
    row.className = "outbox-item";

    const left = document.createElement("div");
    left.textContent = `${entry.recipientName || "recipient"} | ${entry.status}${
      Number.isFinite(entry.targetCount) ? ` ${entry.deliveredCount || 0}/${entry.targetCount}` : ""
    }`;

    const right = document.createElement("div");
    if (entry.status === "failed" || entry.status === "queued") {
      const retryBtn = document.createElement("button");
      retryBtn.type = "button";
      retryBtn.textContent = "Retry";
      retryBtn.addEventListener("click", () => {
        sendOutboxEntry(entry.clientMessageId, true);
      });
      right.appendChild(retryBtn);
    }

    row.appendChild(left);
    row.appendChild(right);
    refs.outboxList.appendChild(row);
  }
}

function updateQueueStatus() {
  let queued = 0;
  let sending = 0;
  let failed = 0;
  for (const entry of state.outbox.values()) {
    if (entry.status === "queued") {
      queued += 1;
    } else if (entry.status === "sending") {
      sending += 1;
    } else if (entry.status === "failed") {
      failed += 1;
    }
  }
  refs.queueStatus.textContent = `Outbox queued:${queued} sending:${sending} failed:${failed}`;
  renderOutbox();
}

function updateComposerPriorityUi() {
  const isCritical = refs.prioritySelect.value === "critical";
  refs.composerPanel.classList.toggle("critical-mode", isCritical);
}

function renderRecipientList() {
  refs.recipientList.innerHTML = "";
  const others = state.users
    .filter((u) => u.id !== state.myId)
    .sort((a, b) => {
      const aActivity = state.recipientLastActivity.get(a.id) || 0;
      const bActivity = state.recipientLastActivity.get(b.id) || 0;
      if (aActivity !== bActivity) {
        return bActivity - aActivity;
      }
      return displayNameForUser(a).localeCompare(displayNameForUser(b));
    });

  if (!others.length) {
    const empty = document.createElement("div");
    empty.className = "subtitle";
    empty.textContent = "No other devices online yet.";
    refs.recipientList.appendChild(empty);
    return;
  }

  for (const user of others) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "channel-btn";
    btn.dataset.userId = user.id;
    const unreadCount = getUnreadCount(user.id);
    btn.innerHTML = `
      <span class="channel-btn-label">${escapeHtml(displayNameForUser(user))}${
        user.deviceLabel ? ` (${escapeHtml(user.deviceLabel)})` : ""
      }</span>
      ${unreadCount > 0 ? `<span class="channel-unread">${unreadCount}</span>` : ""}
    `;
    btn.addEventListener("click", () => {
      state.activeRecipientId = user.id;
      clearUnreadCount(user.id);
      syncRecipientUi();
      renderRecipientList();
      updateRecipientUi();
      wsSend({ type: "get_history", peerId: user.id });
    });
    refs.recipientList.appendChild(btn);
  }
  syncRecipientUi();
}

function renderOnlineUsers() {
  refs.onlineUserList.innerHTML = "";

  if (!state.users.length) {
    const empty = document.createElement("div");
    empty.className = "subtitle";
    empty.textContent = "No users detected.";
    refs.onlineUserList.appendChild(empty);
    return;
  }

  for (const user of state.users) {
    const row = document.createElement("div");
    row.className = "online-user-item";

    const left = document.createElement("div");
    left.className = "online-user-name";
    left.innerHTML = `<span class="online-dot"></span><span>${escapeHtml(displayNameForUser(user))}</span>`;

    const right = document.createElement("div");
    if (user.id === state.myId) {
      const you = document.createElement("span");
      you.className = "online-you";
      you.textContent = "you";
      right.appendChild(you);
    } else if (user.isDefaultName) {
      const aliasBtn = document.createElement("button");
      aliasBtn.type = "button";
      aliasBtn.className = "alias-btn";
      aliasBtn.textContent = "Alias";
      aliasBtn.addEventListener("click", () => {
        setRecipientAlias(user);
      });
      right.appendChild(aliasBtn);
    }

    row.appendChild(left);
    row.appendChild(right);
    refs.onlineUserList.appendChild(row);
  }
}

function syncRecipientUi() {
  refs.recipientList.querySelectorAll(".channel-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.userId === state.activeRecipientId);
  });
}

function updateRecipientUi() {
  const recipient = activeRecipient();
  const hasRecipient = Boolean(recipient);
  refs.sendBtn.disabled = !hasRecipient;

  if (!hasRecipient) {
    refs.activeRecipientTitle.textContent = "Select a recipient";
    refs.recipientStatus.textContent = "Choose a recipient to begin messaging.";
    refs.messages.innerHTML = "";
    return;
  }

  refs.activeRecipientTitle.textContent = displayNameForUser(recipient);
  refs.recipientStatus.textContent = `Direct messages with ${displayNameForUser(recipient)}.`;
}

function messageCard(message) {
  const item = document.createElement("article");
  item.className = "message-item";

  const priorityBadge =
    message.priority === "normal"
      ? ""
      : `<span class="priority-badge ${message.priority}">${message.priority}</span>`;
  const sourceSuffix = message.source === "speech" ? "speech" : "typed";
  const senderUser = state.users.find((u) => u.id === message.sender.id);
  const senderName = message.sender.id === state.myId ? state.myName : displayNameForUser(senderUser || message.sender);

  item.innerHTML = `
    <div class="message-meta">
      <strong>${escapeHtml(senderName)}</strong>
      <span>${message.sender.id === state.myId ? "sent" : "received"}</span>
      <span>${nowTime(message.ts)}</span>
      ${priorityBadge}
      <span>${sourceSuffix}</span>
    </div>
    <div class="message-body">${escapeHtml(message.body)}</div>
  `;

  return item;
}

function renderMessages(messages, replace = false) {
  if (replace) {
    refs.messages.innerHTML = "";
  }
  for (const m of messages) {
    refs.messages.appendChild(messageCard(m));
  }
  refs.messages.scrollTop = refs.messages.scrollHeight;
}

function renderReceivedWindow(messages, replace = false) {
  if (replace) {
    refs.receivedMessages.innerHTML = "";
  }

  const incoming = messages.filter((m) => m.sender.id !== state.myId);
  if (replace && incoming.length === 0) {
    const empty = document.createElement("div");
    empty.className = "received-item";
    empty.textContent = "No received messages yet.";
    refs.receivedMessages.appendChild(empty);
    return;
  }

  for (const m of incoming) {
    const senderUser = state.users.find((u) => u.id === m.sender.id);
    const senderName = displayNameForUser(senderUser || m.sender);
    const item = document.createElement("div");
    item.className = "received-item";
    item.innerHTML = `
      <div><strong>From:</strong> ${escapeHtml(senderName)}</div>
      <div><strong>Message:</strong> ${escapeHtml(m.body)}</div>
    `;
    refs.receivedMessages.appendChild(item);
  }

  refs.receivedMessages.scrollTop = refs.receivedMessages.scrollHeight;
}

async function loadChannelHistory(channel) {
  wsSend({ type: "get_history", peerId: channel });
}

function wsSend(payload) {
  if (!wsReady()) {
    return false;
  }
  state.ws.send(JSON.stringify(payload));
  return true;
}

function markOutboxFailed(clientMessageId) {
  const entry = state.outbox.get(clientMessageId);
  if (!entry || entry.status === "delivered") {
    return;
  }
  entry.status = "failed";
  state.outbox.set(clientMessageId, entry);
  persistOutbox();
  updateQueueStatus();
}

function sendOutboxEntry(clientMessageId, force = false) {
  const entry = state.outbox.get(clientMessageId);
  if (!entry) {
    return;
  }

  if (!force && entry.status === "delivered") {
    return;
  }

  if (!entry.toId) {
    entry.status = "failed";
    state.outbox.set(entry.clientMessageId, entry);
    persistOutbox();
    updateQueueStatus();
    return;
  }

  if (!wsReady()) {
    entry.status = "queued";
    state.outbox.set(entry.clientMessageId, entry);
    persistOutbox();
    updateQueueStatus();
    return;
  }

  entry.status = "sending";
  state.outbox.set(entry.clientMessageId, entry);
  wsSend({
    type: "send_message",
    clientMessageId: entry.clientMessageId,
    toId: entry.toId,
    body: entry.body,
    priority: entry.priority,
    source: entry.source,
    speechConfidence: entry.speechConfidence
  });

  clearTimeout(state.sendTimeouts.get(entry.clientMessageId));
  state.sendTimeouts.set(
    entry.clientMessageId,
    setTimeout(() => {
      markOutboxFailed(entry.clientMessageId);
    }, 6500)
  );

  persistOutbox();
  updateQueueStatus();
}

function flushOutbox() {
  for (const entry of state.outbox.values()) {
    if (entry.status === "queued" || entry.status === "failed") {
      sendOutboxEntry(entry.clientMessageId, true);
    }
  }
}

function queueNewMessage(body, source = "typed") {
  const recipient = activeRecipient();
  if (!recipient) {
    showAlert("Select a recipient first.");
    return;
  }

  touchRecipientActivity(recipient.id);

  const entry = {
    clientMessageId: makeClientId(),
    toId: recipient.id,
    recipientName: displayNameForUser(recipient),
    body,
    priority: refs.prioritySelect.value,
    source,
    speechConfidence: state.lastSpeechConfidence,
    status: "queued",
    targetCount: null,
    deliveredCount: 0,
    queuedAt: Date.now(),
    messageId: null
  };

  state.outbox.set(entry.clientMessageId, entry);
  persistOutbox();
  updateQueueStatus();
  renderRecipientList();
  sendOutboxEntry(entry.clientMessageId, true);
}

function connect() {
  const wsProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const wsUrl = `${wsProtocol}//${window.location.host}`;
  const ws = new WebSocket(wsUrl);
  state.ws = ws;

  ws.addEventListener("open", () => {
    setConnState(true);
    state.myDeviceLabel = inferDeviceLabel();
    state.myName = getStoredHandle() || inferDisplayName(state.myDeviceLabel);
    updateIdentityUi();
  });

  ws.addEventListener("close", () => {
    setConnState(false);
    for (const entry of state.outbox.values()) {
      if (entry.status === "sending") {
        entry.status = "queued";
      }
    }
    persistOutbox();
    updateQueueStatus();
    setTimeout(connect, 1200);
  });

  ws.addEventListener("message", (evt) => {
    let payload;
    try {
      payload = JSON.parse(evt.data);
    } catch (_err) {
      return;
    }

    if (payload.type === "server_hello") {
      wsSend({
        type: "join",
        name: state.myName,
        deviceLabel: state.myDeviceLabel,
        isCustomName: Boolean(getStoredHandle())
      });
      return;
    }

    if (payload.type === "joined") {
      state.myId = payload.id;
      state.myName = payload.name || state.myName;
      state.myDeviceLabel = payload.deviceLabel || state.myDeviceLabel;
      refs.handleInput.value = getStoredHandle() || "";
      updateRecipientUi();
      renderOnlineUsers();
      updateIdentityUi();
      flushOutbox();
      return;
    }

    if (payload.type === "history") {
      if (payload.peerId === state.activeRecipientId) {
        clearUnreadCount(payload.peerId);
        renderMessages(payload.messages || [], true);
        renderReceivedWindow(payload.messages || [], true);
        renderRecipientList();
      }
      return;
    }

    if (payload.type === "message") {
      const m = payload.message;
      const counterpartId = m.sender.id === state.myId ? m.recipient.id : m.sender.id;
      touchRecipientActivity(counterpartId, Date.parse(m.ts) || Date.now());
      if (m.sender.id !== state.myId) {
        wsSend({ type: "ack", messageId: m.id });
        renderReceivedWindow([m], false);
      }
      const inActiveConversation =
        state.activeRecipientId &&
        ((m.sender.id === state.activeRecipientId && m.recipient.id === state.myId) ||
          (m.sender.id === state.myId && m.recipient.id === state.activeRecipientId));

      if (inActiveConversation) {
        clearUnreadCount(counterpartId);
        renderMessages([m], false);
      } else if (m.sender.id !== state.myId) {
        bumpUnreadCount(counterpartId);
      }
      renderRecipientList();
      return;
    }

    if (payload.type === "message_accepted") {
      const entry = state.outbox.get(payload.clientMessageId);
      if (!entry) {
        return;
      }
      clearTimeout(state.sendTimeouts.get(payload.clientMessageId));
      state.sendTimeouts.delete(payload.clientMessageId);
      entry.messageId = payload.messageId;
      entry.status = payload.targetCount > 0 ? "sent" : "delivered";
      entry.targetCount = payload.targetCount;
      entry.deliveredCount = payload.targetCount > 0 ? 0 : 0;
      state.messageIdToClientId.set(payload.messageId, payload.clientMessageId);
      state.outbox.set(payload.clientMessageId, entry);
      persistOutbox();
      updateQueueStatus();
      return;
    }

    if (payload.type === "message_delivery") {
      const clientId = state.messageIdToClientId.get(payload.messageId);
      if (!clientId) {
        return;
      }
      const entry = state.outbox.get(clientId);
      if (!entry) {
        return;
      }
      entry.targetCount = payload.targetCount;
      entry.deliveredCount = payload.deliveredCount;
      entry.status = payload.deliveredCount >= payload.targetCount ? "delivered" : "sent";
      state.outbox.set(clientId, entry);
      persistOutbox();
      updateQueueStatus();
      return;
    }

    if (payload.type === "alert") {
      const alertText = `${payload.level.toUpperCase()} | ${payload.sender.name} | ${payload.body}`;
      showAlert(alertText, payload.level);
      if (payload.level === "critical" && "vibrate" in navigator) {
        navigator.vibrate([140, 60, 180]);
      }
      return;
    }

    if (payload.type === "presence") {
      state.users = Array.isArray(payload.users) ? payload.users : [];
      pruneRecipientLiveState();
      refs.onlineCount.textContent = `${state.users.length} online`;
      renderRecipientList();
      renderOnlineUsers();
      if (state.activeRecipientId && !state.users.some((u) => u.id === state.activeRecipientId)) {
        state.activeRecipientId = null;
        updateRecipientUi();
      }
      return;
    }

    if (payload.type === "ip_handle_conflict") {
      handleIpHandleConflict(payload);
      return;
    }

    if (payload.type === "error") {
      showAlert(payload.message || "Server error");
    }
  });
}

function sendCurrentMessage(source = "typed") {
  const body = refs.messageInput.value.trim();
  if (!body) {
    return;
  }
  queueNewMessage(body, source);
  refs.messageInput.value = "";
  state.lastSpeechConfidence = null;
}

function setupSpeech() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    refs.speechStatus.textContent = "Speech unsupported on this browser.";
    refs.pttBtn.disabled = true;
    refs.alwaysListeningToggle.disabled = true;
    return;
  }

  const recognition = new SpeechRecognition();
  recognition.lang = "en-GB";
  recognition.interimResults = true;
  recognition.maxAlternatives = 1;

  let composing = "";

  recognition.onstart = () => {
    state.recognitionActive = true;
    refs.pttBtn.classList.add("listening");
    refs.speechStatus.textContent = state.alwaysListening ? "Always listening active." : "Listening...";
  };

  recognition.onend = () => {
    state.recognitionActive = false;
    refs.pttBtn.classList.remove("listening");

    if (composing.trim()) {
      refs.messageInput.value = `${refs.messageInput.value} ${composing}`.trim();
      composing = "";
    }

    refs.speechStatus.textContent = state.alwaysListening ? "Always listening active." : "Speech idle.";

    if (state.alwaysListening) {
      recognition.start();
    }
  };

  recognition.onerror = (evt) => {
    refs.speechStatus.textContent = `Speech error: ${evt.error}`;
    if (state.alwaysListening) {
      setTimeout(() => recognition.start(), 500);
    }
  };

  recognition.onresult = (evt) => {
    let transcript = "";
    for (let i = evt.resultIndex; i < evt.results.length; i += 1) {
      transcript += evt.results[i][0].transcript;
      state.lastSpeechConfidence = evt.results[i][0].confidence || null;
    }

    composing = transcript.trim();
    if (state.alwaysListening) {
      if (/\bmessage\b/i.test(composing) || /\bstage\b/i.test(composing)) {
        refs.messageInput.value = `${refs.messageInput.value} ${composing}`.trim();
        composing = "";
      }
      return;
    }
    refs.messageInput.value = `${refs.messageInput.value} ${composing}`.trim();
  };

  state.recognition = recognition;

  refs.pttBtn.addEventListener("pointerdown", () => {
    if (!state.recognitionActive) {
      state.alwaysListening = false;
      refs.alwaysListeningToggle.checked = false;
      recognition.start();
    }
  });

  refs.pttBtn.addEventListener("pointerup", () => {
    if (state.recognitionActive && !state.alwaysListening) {
      recognition.stop();
    }
  });

  refs.pttBtn.addEventListener("pointerleave", () => {
    if (state.recognitionActive && !state.alwaysListening) {
      recognition.stop();
    }
  });

  refs.alwaysListeningToggle.addEventListener("change", () => {
    state.alwaysListening = refs.alwaysListeningToggle.checked;
    if (state.alwaysListening && !state.recognitionActive) {
      recognition.start();
      return;
    }
    if (!state.alwaysListening && state.recognitionActive) {
      recognition.stop();
    }
  });
}

function wireUi() {
  renderRecipientList();
  renderOnlineUsers();
  updateRecipientUi();
  updateQueueStatus();
  updateComposerPriorityUi();
  refs.handleInput.value = getStoredHandle() || "";
  updateIdentityUi();

  refs.messageForm.addEventListener("submit", (evt) => {
    evt.preventDefault();
    sendCurrentMessage("typed");
  });

  refs.quickActions.addEventListener("click", (evt) => {
    const button = evt.target.closest("button[data-cue]");
    if (!button) {
      return;
    }
    refs.messageInput.value = button.dataset.cue;
    refs.prioritySelect.value = button.dataset.cue === "Hold" ? "high" : "normal";
    updateComposerPriorityUi();
    sendCurrentMessage("typed");
  });

  refs.prioritySelect.addEventListener("change", () => {
    updateComposerPriorityUi();
  });

  refs.messageInput.addEventListener("keydown", (evt) => {
    if ((evt.ctrlKey || evt.metaKey) && evt.key === "Enter") {
      sendCurrentMessage("typed");
    }
  });

  refs.saveHandleBtn.addEventListener("click", () => {
    applyHandleChange(refs.handleInput.value);
  });

  refs.resetHandleBtn.addEventListener("click", () => {
    applyHandleChange("");
  });

}

loadRecipientAliases();
loadOutbox();
wireUi();
initializeTabTracking();
setupSpeech();
connect();
