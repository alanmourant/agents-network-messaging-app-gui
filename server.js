const path = require("path");
const http = require("http");
const crypto = require("crypto");
const express = require("express");
const { WebSocketServer } = require("ws");

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 8080;
const HISTORY_LIMIT = 400;

const state = {
  seq: 0,
  clients: new Map(),
  recentClientMessageIds: new Set(),
  messageDelivery: new Map(),
  conversations: new Map()
};

function nowIso() {
  return new Date().toISOString();
}

function makeId() {
  return crypto.randomUUID();
}

function safePriority(priority) {
  if (priority === "critical" || priority === "high" || priority === "normal") {
    return priority;
  }
  return "normal";
}

function conversationKey(a, b) {
  return [a, b].sort().join("|");
}

function normalizeIp(rawIp) {
  if (typeof rawIp !== "string" || !rawIp.trim()) {
    return "unknown";
  }
  const ip = rawIp.trim();
  return ip.startsWith("::ffff:") ? ip.slice(7) : ip;
}

function publishIpHandleConflict(ipAddress) {
  const sessionsOnIp = [];
  for (const session of state.clients.values()) {
    if (!session.joined || session.ipAddress !== ipAddress) {
      continue;
    }
    sessionsOnIp.push(session);
  }

  if (sessionsOnIp.length < 2) {
    return;
  }

  const distinctHandles = new Map();
  for (const session of sessionsOnIp) {
    const name = typeof session.name === "string" ? session.name.trim() : "";
    if (!name) {
      continue;
    }
    const key = name.toLowerCase();
    if (!distinctHandles.has(key)) {
      distinctHandles.set(key, name);
    }
  }

  if (distinctHandles.size < 2) {
    return;
  }

  broadcast(
    {
      type: "ip_handle_conflict",
      ts: nowIso(),
      ipAddress,
      handles: Array.from(distinctHandles.values()).sort((a, b) => a.localeCompare(b)),
      sessionCount: sessionsOnIp.length
    },
    (session) => session.joined && session.ipAddress === ipAddress
  );
}

function persistDirectMessage(message) {
  const key = conversationKey(message.sender.id, message.recipient.id);
  const queue = state.conversations.get(key) || [];
  queue.push(message);
  while (queue.length > HISTORY_LIMIT) {
    queue.shift();
  }
  state.conversations.set(key, queue);
}

function sendJson(ws, payload) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function broadcast(payload, matcher = null) {
  const serialized = JSON.stringify(payload);
  for (const [client, session] of state.clients.entries()) {
    if (client.readyState !== client.OPEN) {
      continue;
    }
    if (matcher && !matcher(session)) {
      continue;
    }
    client.send(serialized);
  }
}

function publishPresence() {
  const users = [];
  for (const session of state.clients.values()) {
    if (!session.joined) {
      continue;
    }
    users.push({
      id: session.id,
      name: session.name,
      lastSeen: session.lastSeen,
      deviceLabel: session.deviceLabel,
      isDefaultName: !session.hasCustomName
    });
  }

  broadcast({
    type: "presence",
    ts: nowIso(),
    users
  });
}

function findOnlineSessionById(sessionId) {
  for (const [socket, session] of state.clients.entries()) {
    if (session.id === sessionId && session.joined && socket.readyState === socket.OPEN) {
      return { socket, session };
    }
  }
  return null;
}

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    ts: nowIso(),
    usersOnline: Array.from(state.clients.values()).filter((session) => session.joined).length
  });
});

wss.on("connection", (ws) => {
  const session = {
    id: makeId(),
    name: `User-${Math.floor(Math.random() * 900 + 100)}`,
    joinedAt: nowIso(),
    lastSeen: nowIso(),
    joined: true,
    hasCustomName: false,
    deviceLabel: "Browser",
    ipAddress: normalizeIp(ws?._socket?.remoteAddress),
    acknowledgedIds: new Set()
  };

  state.clients.set(ws, session);

  sendJson(ws, {
    type: "server_hello",
    sessionId: session.id,
    ts: nowIso()
  });

  sendJson(ws, {
    type: "joined",
    id: session.id,
    name: session.name,
    deviceLabel: session.deviceLabel,
    isDefaultName: !session.hasCustomName
  });

  publishPresence();
  publishIpHandleConflict(session.ipAddress);

  ws.on("message", (raw) => {
    session.lastSeen = nowIso();

    let payload;
    try {
      payload = JSON.parse(raw.toString("utf-8"));
    } catch (_err) {
      sendJson(ws, { type: "error", message: "Invalid JSON payload." });
      return;
    }

    if (!payload || typeof payload !== "object") {
      return;
    }

    if (payload.type === "join") {
      session.name = typeof payload.name === "string" && payload.name.trim() ? payload.name.trim().slice(0, 40) : session.name;
      session.hasCustomName = Boolean(payload.isCustomName);
      session.deviceLabel =
        typeof payload.deviceLabel === "string" && payload.deviceLabel.trim()
          ? payload.deviceLabel.trim().slice(0, 40)
          : session.deviceLabel;

      sendJson(ws, {
        type: "joined",
        id: session.id,
        name: session.name,
        deviceLabel: session.deviceLabel,
        isDefaultName: !session.hasCustomName
      });

      publishPresence();
      publishIpHandleConflict(session.ipAddress);
      return;
    }

    if (payload.type === "get_history") {
      const peerId = typeof payload.peerId === "string" ? payload.peerId : "";
      if (!peerId || !findOnlineSessionById(peerId)) {
        sendJson(ws, { type: "history", peerId, messages: [] });
        return;
      }
      const key = conversationKey(session.id, peerId);
      const history = state.conversations.get(key) || [];
      sendJson(ws, { type: "history", peerId, messages: history.slice(-150) });
      return;
    }

    if (payload.type === "ack") {
      const messageId = typeof payload.messageId === "string" ? payload.messageId : "";
      if (!messageId) {
        return;
      }
      session.acknowledgedIds.add(messageId);
      if (session.acknowledgedIds.size > 400) {
        const oldest = session.acknowledgedIds.values().next().value;
        session.acknowledgedIds.delete(oldest);
      }

      const delivery = state.messageDelivery.get(messageId);
      if (!delivery) {
        return;
      }

      if (!delivery.expectedRecipientIds.has(session.id) || delivery.ackedRecipientIds.has(session.id)) {
        return;
      }

      delivery.ackedRecipientIds.add(session.id);
      const senderRef = findOnlineSessionById(delivery.senderId);
      if (senderRef) {
        sendJson(senderRef.socket, {
          type: "message_delivery",
          messageId,
          deliveredCount: delivery.ackedRecipientIds.size,
          targetCount: delivery.expectedRecipientIds.size,
          ackBy: {
            id: session.id,
            name: session.name
          },
          ts: nowIso()
        });
      }

      return;
    }

    if (payload.type === "send_message") {
      const body = typeof payload.body === "string" ? payload.body.trim() : "";
      if (!body) {
        sendJson(ws, { type: "error", message: "Message body is required." });
        return;
      }

      const recipientId = typeof payload.toId === "string" ? payload.toId : "";
      if (!recipientId) {
        sendJson(ws, { type: "error", message: "Recipient is required." });
        return;
      }

      const recipientRef = findOnlineSessionById(recipientId);
      if (!recipientRef) {
        sendJson(ws, { type: "error", message: "Recipient is offline or unavailable." });
        return;
      }

      if (recipientRef.session.id === session.id) {
        sendJson(ws, { type: "error", message: "Cannot send message to self." });
        return;
      }

      const clientMessageId = typeof payload.clientMessageId === "string" ? payload.clientMessageId : "";
      if (clientMessageId) {
        if (state.recentClientMessageIds.has(clientMessageId)) {
          return;
        }
        state.recentClientMessageIds.add(clientMessageId);
        if (state.recentClientMessageIds.size > 2000) {
          const first = state.recentClientMessageIds.values().next().value;
          state.recentClientMessageIds.delete(first);
        }
      }

      const message = {
        id: makeId(),
        seq: ++state.seq,
        conversationKey: conversationKey(session.id, recipientRef.session.id),
        body: body.slice(0, 1200),
        priority: safePriority(payload.priority),
        ts: nowIso(),
        sender: {
          id: session.id,
          name: session.name,
          deviceLabel: session.deviceLabel
        },
        recipient: {
          id: recipientRef.session.id,
          name: recipientRef.session.name,
          deviceLabel: recipientRef.session.deviceLabel
        },
        source: payload.source === "speech" ? "speech" : "typed",
        speechConfidence:
          typeof payload.speechConfidence === "number" && Number.isFinite(payload.speechConfidence)
            ? Math.max(0, Math.min(1, payload.speechConfidence))
            : null
      };

      persistDirectMessage(message);

      const expectedRecipientIds = new Set();
      expectedRecipientIds.add(recipientRef.session.id);

      state.messageDelivery.set(message.id, {
        senderId: session.id,
        expectedRecipientIds,
        ackedRecipientIds: new Set(),
        createdAt: Date.now()
      });

      if (state.messageDelivery.size > 2000) {
        const oldestId = state.messageDelivery.keys().next().value;
        state.messageDelivery.delete(oldestId);
      }

      sendJson(ws, { type: "message", message });
      sendJson(recipientRef.socket, { type: "message", message });

      if (message.priority !== "normal") {
        sendJson(recipientRef.socket, {
          type: "alert",
          level: message.priority,
          messageId: message.id,
          sender: message.sender,
          body: message.body,
          ts: message.ts
        });
      }

      sendJson(ws, {
        type: "message_accepted",
        messageId: message.id,
        clientMessageId,
        targetCount: expectedRecipientIds.size,
        ts: nowIso()
      });

      return;
    }

    sendJson(ws, { type: "error", message: "Unknown event type." });
  });

  ws.on("close", () => {
    const sessionIp = session.ipAddress;
    state.clients.delete(ws);
    publishPresence();
    publishIpHandleConflict(sessionIp);
  });

  ws.on("error", () => {
    const sessionIp = session.ipAddress;
    state.clients.delete(ws);
    publishPresence();
    publishIpHandleConflict(sessionIp);
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`LAN messenger listening on http://0.0.0.0:${PORT}`);
});
