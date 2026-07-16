// server.js — Super Tic-Tac-Toe WebSocket Game Server + Static File Server
const WebSocket = require("ws");
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const Rules = require("./game-rules");

// ============================================================
// Constants
// ============================================================
const BOARD_COUNT = Rules.BOARD_COUNT;
const CELL_COUNT = Rules.CELL_COUNT;
const SWAP_COOLDOWN_MS = 60 * 1000;
const ROOM_ID_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no confusing 0/O/1/I
const MAX_WS_PAYLOAD_BYTES = 1024 * 1024;
const MAX_CHAT_TEXT_LENGTH = 500;
const MAX_CHAT_IMAGE_BYTES = 512 * 1024;
const MAX_CHAT_MESSAGES = 100;
const MAX_CHAT_CACHE_BYTES = 10 * 1024 * 1024;
const MAX_CHAT_DEDUPE_IDS_PER_PLAYER = parseInt(process.env.CHAT_DEDUPE_MAX_IDS, 10) || 4096;
const MAX_MOVE_DEDUPE_IDS_PER_PLAYER = 256;
const CHAT_RATE_WINDOW_MS = parseInt(process.env.CHAT_RATE_WINDOW_MS, 10) || 10 * 1000;
const CHAT_TEXT_RATE_MAX = parseInt(process.env.CHAT_TEXT_RATE_MAX, 10) || 5;
const CHAT_IMAGE_RATE_MAX = parseInt(process.env.CHAT_IMAGE_RATE_MAX, 10) || 1;
const RECONNECT_GRACE_MS = parseInt(process.env.RECONNECT_GRACE_MS, 10) || 5 * 60 * 1000;

// ============================================================
// MIME types for static file serving
// ============================================================
const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

const PROJECT_ROOT = path.resolve(__dirname, "..");
const IS_PRODUCTION = process.env.NODE_ENV === "production" || Boolean(process.env.RENDER);

// ============================================================
// Rate limiting
// ============================================================
const rateLimitMap = new Map();
const RATE_LIMIT_MS = 1000;
const RATE_LIMIT_MAX = 20;

function checkRateLimit(ws) {
  const now = Date.now();
  let record = rateLimitMap.get(ws);
  if (!record || now - record.windowStart > RATE_LIMIT_MS) {
    rateLimitMap.set(ws, { count: 1, windowStart: now });
    return true;
  }
  record.count++;
  return record.count <= RATE_LIMIT_MAX;
}

function cleanupRateLimit(ws) {
  rateLimitMap.delete(ws);
}

function checkChatRateLimit(player, kind) {
  const now = Date.now();
  let record = player.chatRateLimit;
  if (!record || now - record.windowStart >= CHAT_RATE_WINDOW_MS) {
    record = { windowStart: now, text: 0, image: 0 };
    player.chatRateLimit = record;
  }
  const limit = kind === "image" ? CHAT_IMAGE_RATE_MAX : CHAT_TEXT_RATE_MAX;
  if (record[kind] >= limit) return false;
  record[kind]++;
  return true;
}

// ============================================================
// Server setup
// ============================================================
const server = http.createServer((req, res) => {
  // Parse URL and serve static files from project root
  let urlPath = req.url.split("?")[0];
  if (urlPath === "/") urlPath = "/index.html";

  const filePath = path.join(PROJECT_ROOT, urlPath);

  // Prevent directory traversal
  if (!filePath.startsWith(PROJECT_ROOT)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || "application/octet-stream";

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end("Not Found");
      return;
    }
    res.writeHead(200, { "Content-Type": contentType });
    res.end(data);
  });
});
const wss = new WebSocket.Server({
  server,
  maxPayload: MAX_WS_PAYLOAD_BYTES,
  // Accept connections from any origin during development
  verifyClient: () => true,
});

// Heartbeat — detect silent disconnects
const HEARTBEAT_MS = 30000;
const heartbeatTimer = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws._isAlive === false) {
      ws.terminate();
      return;
    }
    ws._isAlive = false;
    ws.ping();
  });
}, HEARTBEAT_MS);

wss.on("close", () => clearInterval(heartbeatTimer));

// ============================================================
// Room store
// ============================================================
const rooms = new Map();
const sessions = new Map();

function generateRoomId() {
  let id;
  do {
    id = "";
    for (let i = 0; i < 6; i++) {
      id += ROOM_ID_CHARS[Math.floor(Math.random() * ROOM_ID_CHARS.length)];
    }
  } while (rooms.has(id));
  return id;
}

function validateRuleConfig(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const keys = Object.keys(value).sort();
  if (keys.length !== 2 || keys[0] !== "boardVariant" || keys[1] !== "swapEvery") return null;
  if (!["normal", "cycle", "chaos"].includes(value.boardVariant)) return null;
  if (!Number.isInteger(value.swapEvery) || value.swapEvery < 1 || value.swapEvery > 20) return null;
  return { boardVariant: value.boardVariant, swapEvery: value.swapEvery };
}

function createPlayer(ws, symbol, roomId) {
  const player = {
    ws,
    symbol,
    sessionId: crypto.randomUUID(),
    resumeToken: crypto.randomBytes(32).toString("hex"),
    previousResumeToken: null,
    previousResumeTokenExpiresAt: 0,
    reconnectTimer: null,
    reconnectDeadline: 0,
    chatRateLimit: null,
    chatDedupe: new Map(),
    moveDedupe: new Map(),
  };
  sessions.set(player.sessionId, { roomId, player });
  return player;
}

function sessionCredentials(player) {
  return {
    session_id: player.sessionId,
    resume_token: player.resumeToken,
  };
}

function isConnectionBound(ws) {
  return Boolean(ws._sessionId);
}

function bindConnection(ws, roomId, player) {
  if (isConnectionBound(ws)) return false;
  ws._roomId = roomId;
  ws._sessionId = player.sessionId;
  player.ws = ws;
  return true;
}

function unbindConnection(ws, player) {
  if (!ws || (player && ws._sessionId !== player.sessionId)) return;
  ws._roomId = null;
  ws._sessionId = null;
}

function rejectBoundConnection(ws, type = "error") {
  sendJson(ws, {
    type,
    code: type === "session_error" ? "SESSION_CONNECTION_IN_USE" : "CONNECTION_ALREADY_BOUND",
    message: "当前连接已绑定玩家会话",
  });
}

function sendJson(ws, message) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
}

function isOnline(player) {
  return Boolean(player.ws && player.ws.readyState === WebSocket.OPEN);
}

function clearReconnectTimer(player) {
  if (player.reconnectTimer) clearTimeout(player.reconnectTimer);
  player.reconnectTimer = null;
  player.reconnectDeadline = 0;
}

function destroyRoom(room, exceptWs) {
  if (!room || rooms.get(room.id) !== room) return;
  rooms.delete(room.id);
  room.players.forEach((player) => {
    clearReconnectTimer(player);
    sessions.delete(player.sessionId);
    const playerWs = player.ws;
    if (playerWs !== exceptWs) {
      sendJson(playerWs, { type: "player_disconnected", room_id: room.id });
    }
    unbindConnection(playerWs, player);
    player.ws = null;
  });
}

function tokensMatch(expected, received) {
  if (typeof received !== "string" || received.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(received, "hex"));
  } catch (error) {
    return false;
  }
}

function sendChatError(ws, code, message, clientMessageId) {
  const response = { type: "chat_error", code, message };
  if (typeof clientMessageId === "string") response.client_message_id = clientMessageId;
  sendJson(ws, response);
}

function hasImageSignature(mime, bytes) {
  if (mime === "image/jpeg") {
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  if (mime === "image/png") {
    return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"));
  }
  if (mime === "image/webp") {
    return bytes.length >= 12 &&
      bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
      bytes.subarray(8, 12).toString("ascii") === "WEBP";
  }
  return false;
}

function validateChatContent(content) {
  if (!content || typeof content !== "object") {
    return { error: ["INVALID_CONTENT", "无效的聊天内容"] };
  }
  if (content.kind === "text") {
    if (typeof content.text !== "string") {
      return { error: ["INVALID_TEXT", "消息文本必须为字符串"] };
    }
    const text = content.text.trim();
    const length = Array.from(text).length;
    if (length < 1 || length > MAX_CHAT_TEXT_LENGTH) {
      return { error: ["INVALID_TEXT", "消息文本长度必须为 1-500 个字符"] };
    }
    return { content: { kind: "text", text }, bytes: Buffer.byteLength(text, "utf8") };
  }
  if (content.kind === "image") {
    const allowedMimes = new Set(["image/jpeg", "image/png", "image/webp"]);
    if (!allowedMimes.has(content.mime) || typeof content.data !== "string") {
      return { error: ["INVALID_IMAGE", "仅支持 JPEG、PNG 或 WebP 图片"] };
    }
    if (content.data.length > Math.ceil(MAX_CHAT_IMAGE_BYTES / 3) * 4) {
      return { error: ["IMAGE_TOO_LARGE", "图片不能超过 512 KiB"] };
    }
    const isBase64 = content.data.length > 0 &&
      /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(content.data);
    if (!isBase64) {
      return { error: ["INVALID_IMAGE", "图片数据不是有效的 Base64"] };
    }
    const bytes = Buffer.from(content.data, "base64");
    if (bytes.length > MAX_CHAT_IMAGE_BYTES) {
      return { error: ["IMAGE_TOO_LARGE", "图片不能超过 512 KiB"] };
    }
    if (bytes.toString("base64") !== content.data || !hasImageSignature(content.mime, bytes)) {
      return { error: ["INVALID_IMAGE", "图片格式与内容不匹配"] };
    }
    return {
      content: { kind: "image", mime: content.mime, data: content.data },
      bytes: bytes.length,
    };
  }
  return { error: ["INVALID_CONTENT", "未知的聊天内容类型"] };
}

function appendChatMessage(room, message, payloadBytes, player) {
  const storedMessage = {
    ...message,
    _payload_bytes: payloadBytes,
    _sender_session_id: player.sessionId,
  };
  room.chatMessages.push(storedMessage);
  room.chatBytes += payloadBytes;
  if (message.client_message_id !== undefined) {
    player.chatDedupe.set(message.client_message_id, storedMessage);
    while (player.chatDedupe.size > MAX_CHAT_DEDUPE_IDS_PER_PLAYER) {
      player.chatDedupe.delete(player.chatDedupe.keys().next().value);
    }
  }
  while (room.chatMessages.length > MAX_CHAT_MESSAGES || room.chatBytes > MAX_CHAT_CACHE_BYTES) {
    const removed = room.chatMessages.shift();
    room.chatBytes -= removed._payload_bytes;
    if (removed.client_message_id !== undefined) {
      const sender = room.players.find((candidate) => candidate.sessionId === removed._sender_session_id);
      if (sender && sender.chatDedupe.get(removed.client_message_id) === removed) {
        sender.chatDedupe.set(removed.client_message_id, null);
      }
    }
  }
}

function publicChatMessage(message) {
  const { _payload_bytes, _sender_session_id, ...publicMessage } = message;
  return publicMessage;
}

// ============================================================
// Connection handler
// ============================================================
wss.on("connection", (ws) => {
  ws._roomId = null;
  ws._sessionId = null;

  // Heartbeat
  ws._isAlive = true;
  ws.on("pong", () => { ws._isAlive = true; });

  ws.on("message", (message) => {
    // ---- Rate limit ----
    if (!checkRateLimit(ws)) return;

    // ---- Parse ----
    let data;
    try {
      data = JSON.parse(message);
    } catch (e) {
      sendJson(ws, { type: "error", code: "INVALID_JSON", message: "无效的 JSON 格式" });
      return;
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      sendJson(ws, { type: "error", code: "INVALID_MESSAGE", message: "消息必须为 JSON 对象" });
      return;
    }

    switch (data.type) {

      // ========================================================
      case "create_room":
        {
          if (isConnectionBound(ws)) {
            rejectBoundConnection(ws);
            return;
          }
          const ruleConfig = validateRuleConfig(data.rule_config);
          if (!ruleConfig) {
            sendJson(ws, {
              type: "error",
              code: "INVALID_RULE_CONFIG",
              message: "rule_config 必须包含有效的 boardVariant 与 swapEvery",
            });
            return;
          }
          const roomId = generateRoomId();
          const creator = createPlayer(ws, "X", roomId);
          bindConnection(ws, roomId, creator);

          rooms.set(roomId, {
            id: roomId,
            players: [creator],
            ruleConfig,
            stateVersion: 0,
            gameState: Rules.createInitialGameState(ruleConfig),
            pendingSwap: null,
            nextSwapRequestAt: 0,
            chatMessages: [],
            chatBytes: 0,
          });

          ws.send(JSON.stringify({
            type: "room_created",
            room_id: roomId,
            player_symbol: "X",
            is_your_turn: true,
            rule_config: ruleConfig,
            state_version: 0,
            game_state: rooms.get(roomId).gameState,
            ...sessionCredentials(creator),
          }));
        }
        break;

      // ========================================================
      case "join_room":
        {
          if (isConnectionBound(ws)) {
            rejectBoundConnection(ws);
            return;
          }
          const roomId = data.room_id;
          if (typeof roomId !== "string" || roomId.length !== 6) {
            ws.send(JSON.stringify({ type: "error", message: "无效的房间ID格式" }));
            return;
          }

          const room = rooms.get(roomId);
          if (!room) {
            ws.send(JSON.stringify({ type: "error", message: "房间不存在" }));
            return;
          }
          if (room.players.length >= 2) {
            ws.send(JSON.stringify({ type: "error", message: "房间已满" }));
            return;
          }

          const joiner = createPlayer(ws, "O", roomId);
          bindConnection(ws, roomId, joiner);
          room.players.push(joiner);

          room.players.forEach((player) => {
            sendJson(player.ws, {
              type: "game_start",
              room_id: room.id,
              player_symbol: player.symbol,
              is_your_turn: player.symbol === "X",
              rule_config: room.ruleConfig,
              state_version: room.stateVersion,
              game_state: room.gameState,
              ...sessionCredentials(player),
            });
          });
        }
        break;

      // ========================================================
      case "resume_session":
        {
          if (isConnectionBound(ws)) {
            rejectBoundConnection(ws, "session_error");
            return;
          }
          const session = typeof data.session_id === "string" && sessions.get(data.session_id);
          if (!session) {
            sendJson(ws, { type: "session_error", code: "SESSION_NOT_FOUND", message: "会话不存在或已过期" });
            return;
          }
          const room = rooms.get(session.roomId);
          const player = session.player;
          if (!room || !room.players.includes(player)) {
            sessions.delete(data.session_id);
            sendJson(ws, { type: "session_error", code: "SESSION_NOT_FOUND", message: "会话不存在或已过期" });
            return;
          }
          if (
            player.previousResumeToken &&
            Date.now() > player.previousResumeTokenExpiresAt
          ) {
            player.previousResumeToken = null;
            player.previousResumeTokenExpiresAt = 0;
          }
          const playerIsOnline = isOnline(player);
          const matchesCurrentToken = tokensMatch(player.resumeToken, data.resume_token);
          const matchesPreviousToken = !playerIsOnline &&
            player.previousResumeToken && tokensMatch(player.previousResumeToken, data.resume_token);
          if (!matchesCurrentToken && !matchesPreviousToken) {
            sendJson(ws, { type: "session_error", code: "INVALID_RESUME_TOKEN", message: "恢复令牌无效" });
            return;
          }
          if (playerIsOnline) {
            sendJson(ws, { type: "session_error", code: "SESSION_ACTIVE", message: "会话仍在线" });
            return;
          }

          const reconnectDeadline = player.reconnectDeadline;
          clearReconnectTimer(player);
          bindConnection(ws, room.id, player);
          if (matchesCurrentToken) {
            player.previousResumeToken = player.resumeToken;
            player.previousResumeTokenExpiresAt = reconnectDeadline;
          }
          player.resumeToken = crypto.randomBytes(32).toString("hex");

          sendJson(ws, {
            type: "session_resumed",
            room_id: room.id,
            player_symbol: player.symbol,
            is_your_turn: !room.gameState.isGameOver && room.gameState.currentPlayer === player.symbol,
            rule_config: room.ruleConfig,
            state_version: room.stateVersion,
            game_state: room.gameState,
            chat_history: room.chatMessages.map(publicChatMessage),
            ...sessionCredentials(player),
          });
          room.players.forEach((other) => {
            if (other !== player) {
              sendJson(other.ws, {
                type: "player_reconnected",
                room_id: room.id,
                player_symbol: player.symbol,
              });
            }
          });
        }
        break;

      // ========================================================
      case "confirm_resume":
        {
          const session = typeof data.session_id === "string" && sessions.get(data.session_id);
          const player = session && session.player;
          if (
            !session || !player || player.ws !== ws ||
            ws._sessionId !== player.sessionId ||
            !tokensMatch(player.resumeToken, data.resume_token)
          ) {
            sendJson(ws, {
              type: "session_error",
              code: "INVALID_RESUME_CONFIRMATION",
              message: "恢复确认无效",
            });
            return;
          }
          player.previousResumeToken = null;
          player.previousResumeTokenExpiresAt = 0;
          sendJson(ws, { type: "resume_confirmed", session_id: player.sessionId });
        }
        break;

      // ========================================================
      case "request_swap":
        {
          const swapRoom = rooms.get(data.room_id);
          const requester = swapRoom && swapRoom.players.find((player) => player.ws === ws);
          const opponent = swapRoom && requester &&
            swapRoom.players.find((player) => player !== requester && isOnline(player));
          if (
            !swapRoom || !requester || swapRoom.players.length !== 2 ||
            !swapRoom.players.every(isOnline) || !opponent
          ) {
            sendJson(ws, {
              type: "swap_unavailable",
              room_id: data.room_id,
              message: "需要双方都在房间内才能交换先后手",
            });
            return;
          }
          if (Rules.hasAnyMove(swapRoom.gameState)) {
            sendJson(ws, { type: "swap_unavailable", room_id: swapRoom.id, message: "已有玩家落子，不能再交换先后手" });
            return;
          }

          const now = Date.now();
          if (swapRoom.pendingSwap) {
            sendJson(ws, { type: "swap_unavailable", room_id: swapRoom.id, message: "已有交换请求等待确认" });
            return;
          }
          if (now < swapRoom.nextSwapRequestAt) {
            ws.send(JSON.stringify({
              type: "swap_unavailable",
              room_id: swapRoom.id,
              message: "交换请求冷却中",
              cooldown_until: swapRoom.nextSwapRequestAt,
            }));
            return;
          }

          swapRoom.nextSwapRequestAt = now + SWAP_COOLDOWN_MS;
          swapRoom.pendingSwap = { requesterWs: ws };

          ws.send(JSON.stringify({
            type: "swap_request_sent",
            room_id: swapRoom.id,
            cooldown_until: swapRoom.nextSwapRequestAt,
          }));
          sendJson(opponent.ws, {
            type: "swap_request",
            room_id: swapRoom.id,
            requester_symbol: requester.symbol,
            cooldown_until: swapRoom.nextSwapRequestAt,
          });
        }
        break;

      // ========================================================
      case "respond_swap":
        {
          const swapRoom = rooms.get(data.room_id);
          const responder = swapRoom && swapRoom.players.find((player) => player.ws === ws);
          const pending = swapRoom && swapRoom.pendingSwap;
          if (!swapRoom || !responder || !pending || pending.requesterWs === ws) {
            sendJson(ws, { type: "swap_unavailable", room_id: data.room_id, message: "交换请求已失效" });
            return;
          }

          const accepted = data.accepted === true && !Rules.hasAnyMove(swapRoom.gameState);
          if (accepted) {
            swapRoom.players.forEach((player) => {
              player.symbol = player.symbol === "X" ? "O" : "X";
            });
          }
          swapRoom.pendingSwap = null;

          swapRoom.players.forEach((player) => {
            sendJson(player.ws, {
              type: "swap_result",
              room_id: swapRoom.id,
              accepted: accepted,
              player_symbol: player.symbol,
              is_your_turn: player.symbol === swapRoom.gameState.currentPlayer,
              responded_by_me: player.ws === ws,
              cooldown_until: swapRoom.nextSwapRequestAt,
            });
          });
        }
        break;

      // ========================================================
      case "make_move":
        {
          const moveRoom = rooms.get(data.room_id);
          const currentPlayer = moveRoom && moveRoom.players.find((player) => player.ws === ws);
          if (!moveRoom || !currentPlayer) {
            sendJson(ws, { type: "error", code: "NOT_ROOM_MEMBER", message: "你不是该房间成员" });
            return;
          }
          if (
            typeof data.client_move_id !== "string" ||
            data.client_move_id.length < 1 || data.client_move_id.length > 100
          ) {
            sendJson(ws, { type: "error", code: "INVALID_CLIENT_MOVE_ID", message: "无效的 client_move_id" });
            return;
          }
          if (currentPlayer.moveDedupe.has(data.client_move_id)) {
            const previous = currentPlayer.moveDedupe.get(data.client_move_id);
            currentPlayer.moveDedupe.delete(data.client_move_id);
            currentPlayer.moveDedupe.set(data.client_move_id, previous);
            sendJson(ws, previous);
            return;
          }
          if (moveRoom.players.length !== 2 || !moveRoom.players.every(isOnline)) {
            sendJson(ws, { type: "error", code: "PLAYERS_OFFLINE", message: "需要双方在线才能落子" });
            return;
          }
          if (!Number.isInteger(data.state_version) || data.state_version !== moveRoom.stateVersion) {
            sendJson(ws, {
              type: "error",
              code: "STATE_VERSION_MISMATCH",
              message: "客户端状态版本已过期",
              state_version: moveRoom.stateVersion,
            });
            return;
          }
          if (moveRoom.gameState.currentPlayer !== currentPlayer.symbol) {
            sendJson(ws, { type: "error", code: "NOT_YOUR_TURN", message: "尚未轮到你落子" });
            return;
          }
          const move = data.move;
          if (
            !move || typeof move !== "object" || Array.isArray(move) ||
            !Number.isInteger(move.position) ||
            move.position < 0 || move.position >= BOARD_COUNT ||
            !Number.isInteger(move.cell_index) ||
            move.cell_index < 0 || move.cell_index >= CELL_COUNT
          ) {
            sendJson(ws, { type: "error", code: "INVALID_MOVE", message: "无效的落子坐标" });
            return;
          }

          const turn = {
            position: move.position,
            cellIndex: move.cell_index,
            symbol: currentPlayer.symbol,
            exchangePair: null,
          };
          if (
            moveRoom.gameState.boardVariant === "chaos" &&
            Rules.requiresExchangeOnNextTurn(moveRoom.gameState)
          ) {
            const firstPosition = crypto.randomInt(BOARD_COUNT);
            let secondPosition = crypto.randomInt(BOARD_COUNT - 1);
            if (secondPosition >= firstPosition) secondPosition++;
            turn.exchangePair = [firstPosition, secondPosition];
          }
          let turnResult;
          try {
            turnResult = Rules.applyTurn(moveRoom.gameState, turn);
          } catch (error) {
            sendJson(ws, { type: "error", code: "ILLEGAL_MOVE", message: error.message });
            return;
          }
          turn.exchangePair = turnResult.exchange;
          moveRoom.stateVersion++;
          const applied = {
            type: "turn_applied",
            room_id: moveRoom.id,
            client_move_id: data.client_move_id,
            state_version: moveRoom.stateVersion,
            turn,
            result: {
              exchange: turnResult.exchange,
              gameOver: turnResult.gameOver,
            },
          };
          currentPlayer.moveDedupe.set(data.client_move_id, applied);
          while (currentPlayer.moveDedupe.size > MAX_MOVE_DEDUPE_IDS_PER_PLAYER) {
            currentPlayer.moveDedupe.delete(currentPlayer.moveDedupe.keys().next().value);
          }
          moveRoom.players.forEach((player) => {
            sendJson(player.ws, applied);
          });
        }
        break;

      // ========================================================
      case "reset_game":
        {
          const resetRoom = rooms.get(data.room_id);
          const resetter = resetRoom && resetRoom.players.find((player) => player.ws === ws);
          if (!resetRoom || !resetter) {
            sendJson(ws, { type: "error", code: "NOT_ROOM_MEMBER", message: "你不是该房间成员" });
            return;
          }
          if (resetRoom.players.length !== 2 || !resetRoom.players.every(isOnline)) {
            sendJson(ws, { type: "error", code: "PLAYERS_OFFLINE", message: "需要双方在线才能重新开始" });
            return;
          }

          resetRoom.gameState = Rules.createInitialGameState(resetRoom.ruleConfig);
          resetRoom.stateVersion = 0;
          resetRoom.pendingSwap = null;
          resetRoom.players.forEach((player) => player.moveDedupe.clear());

          resetRoom.players.forEach((player) => {
            sendJson(player.ws, {
              type: "game_reset",
              room_id: resetRoom.id,
              player_symbol: player.symbol,
              is_your_turn: player.symbol === "X",
              rule_config: resetRoom.ruleConfig,
              state_version: resetRoom.stateVersion,
              game_state: resetRoom.gameState,
            });
          });
        }
        break;

      // ========================================================
      case "chat_send":
        {
          const chatRoom = rooms.get(data.room_id);
          const sender = chatRoom && chatRoom.players.find((player) => player.ws === ws);
          if (!chatRoom || !sender) {
            sendChatError(ws, "NOT_ROOM_MEMBER", "你不是该房间成员", data.client_message_id);
            return;
          }
          if (chatRoom.players.length < 2) {
            sendChatError(ws, "CHAT_UNAVAILABLE", "需要双方加入后才能聊天", data.client_message_id);
            return;
          }
          if (
            data.client_message_id !== undefined &&
            (typeof data.client_message_id !== "string" || data.client_message_id.length < 1 || data.client_message_id.length > 100)
          ) {
            sendChatError(ws, "INVALID_CLIENT_MESSAGE_ID", "无效的客户端消息 ID");
            return;
          }
          if (data.client_message_id !== undefined) {
            if (sender.chatDedupe.has(data.client_message_id)) {
              const existing = sender.chatDedupe.get(data.client_message_id);
              sender.chatDedupe.delete(data.client_message_id);
              sender.chatDedupe.set(data.client_message_id, existing);
              if (existing) {
                sendJson(ws, publicChatMessage(existing));
              } else {
                sendChatError(
                  ws,
                  "DUPLICATE_MESSAGE_EVICTED",
                  "该消息已处理，但确认正文已从历史缓存淘汰",
                  data.client_message_id
                );
              }
              return;
            }
          }
          const validation = validateChatContent(data.content);
          if (validation.error) {
            sendChatError(ws, validation.error[0], validation.error[1], data.client_message_id);
            return;
          }
          if (!checkChatRateLimit(sender, validation.content.kind)) {
            sendChatError(ws, "CHAT_RATE_LIMITED", "聊天消息发送过于频繁", data.client_message_id);
            return;
          }

          const storedMessage = {
            type: "chat_message",
            room_id: chatRoom.id,
            id: crypto.randomUUID(),
            sender_symbol: sender.symbol,
            sent_at: Date.now(),
            content: validation.content,
          };
          if (data.client_message_id !== undefined) {
            storedMessage.client_message_id = data.client_message_id;
          }
          appendChatMessage(chatRoom, storedMessage, validation.bytes, sender);
          chatRoom.players.forEach((player) => sendJson(player.ws, storedMessage));
        }
        break;

      // ========================================================
      case "leave_room":
        {
          if (ws._roomId) {
            const leaveRoom = rooms.get(ws._roomId);
            if (leaveRoom) destroyRoom(leaveRoom, ws);
            unbindConnection(ws);
          }
        }
        break;

      // ========================================================
      default:
        ws.send(JSON.stringify({ type: "error", message: `未知消息类型: ${data.type}` }));
    }
  });

  // ---- Disconnect ----
  ws.on("close", () => {
    cleanupRateLimit(ws);
    if (ws._roomId) {
      const room = rooms.get(ws._roomId);
      if (room) {
        const disconnectedPlayer = room.players.find(
          (player) => player.sessionId === ws._sessionId && player.ws === ws
        );
        if (!disconnectedPlayer) return;
        unbindConnection(ws, disconnectedPlayer);
        disconnectedPlayer.ws = null;
        room.pendingSwap = null;
        disconnectedPlayer.reconnectDeadline = Date.now() + RECONNECT_GRACE_MS;
        room.players.forEach((player) => {
          if (player !== disconnectedPlayer) {
            sendJson(player.ws, {
              type: "player_temporarily_disconnected",
              room_id: room.id,
              player_symbol: disconnectedPlayer.symbol,
              reconnect_deadline: disconnectedPlayer.reconnectDeadline,
            });
          }
        });
        disconnectedPlayer.reconnectTimer = setTimeout(() => {
          if (rooms.get(room.id) !== room || disconnectedPlayer.ws) return;
          destroyRoom(room);
        }, RECONNECT_GRACE_MS);
      }
    }
  });
});

// ============================================================
// Start
// ============================================================
const PORT = parseInt(process.env.PORT, 10) || 8080;
const HOST = "0.0.0.0";

server.listen(PORT, HOST, () => {
  const url = `http://localhost:${PORT}`;
  console.log(`🎮 超级井字棋已启动 → ${IS_PRODUCTION ? "public service" : url}`);

  if (IS_PRODUCTION) return;

  console.log("   按 Ctrl+C 停止服务器");

  // Auto-open browser locally (cross-platform)
  const { exec } = require("child_process");
  const platform = process.platform;
  const openCmd =
    platform === "win32" ? `start "" "${url}"` :
    platform === "darwin" ? `open "${url}"` :
    `xdg-open "${url}"`;

  exec(openCmd, (err) => {
    if (err) console.log("⚠ 无法自动打开浏览器，请手动访问 " + url);
  });
});
