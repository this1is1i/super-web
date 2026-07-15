// server.js — Super Tic-Tac-Toe WebSocket Game Server + Static File Server
const WebSocket = require("ws");
const http = require("http");
const fs = require("fs");
const path = require("path");
const Rules = require("./game-rules");

// ============================================================
// Constants
// ============================================================
const BOARD_COUNT = Rules.BOARD_COUNT;
const CELL_COUNT = Rules.CELL_COUNT;
const SWAP_COOLDOWN_MS = 60 * 1000;
const ROOM_ID_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no confusing 0/O/1/I

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

// ============================================================
// Connection handler
// ============================================================
wss.on("connection", (ws) => {
  let currentRoom = null;
  let playerSymbol = null;

  // Heartbeat
  ws._isAlive = true;
  ws.on("pong", () => { ws._isAlive = true; });

  ws.on("message", (message) => {
    // ---- Rate limit ----
    if (!checkRateLimit(ws)) {
      ws.send(JSON.stringify({ type: "error", message: "消息过于频繁，请稍后再试" }));
      return;
    }

    // ---- Parse ----
    let data;
    try {
      data = JSON.parse(message);
    } catch (e) {
      console.error("Invalid JSON:", message.toString().slice(0, 200));
      ws.send(JSON.stringify({ type: "error", message: "无效的消息格式" }));
      return;
    }

    switch (data.type) {

      // ========================================================
      case "create_room":
        {
          const roomId = generateRoomId();
          currentRoom = roomId;
          playerSymbol = "X";

          rooms.set(roomId, {
            id: roomId,
            players: [{ ws, symbol: "X" }],
            gameState: Rules.createInitialGameState(),
            pendingSwap: null,
            nextSwapRequestAt: 0,
          });

          ws.send(JSON.stringify({
            type: "room_created",
            room_id: roomId,
            player_symbol: "X",
            is_your_turn: true,
          }));
        }
        break;

      // ========================================================
      case "join_room":
        {
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

          currentRoom = roomId;
          playerSymbol = "O";
          room.players.push({ ws, symbol: "O" });

          room.players.forEach((player) => {
            player.ws.send(JSON.stringify({
              type: "game_start",
              room_id: room.id,
              player_symbol: player.symbol,
              is_your_turn: player.symbol === "X",
            }));
          });
        }
        break;

      // ========================================================
      case "request_swap":
        {
          const swapRoom = rooms.get(data.room_id);
          const requester = swapRoom && swapRoom.players.find((player) => player.ws === ws);
          if (!swapRoom || !requester || swapRoom.players.length !== 2) {
            ws.send(JSON.stringify({ type: "swap_unavailable", message: "需要双方都在房间内才能交换先后手" }));
            return;
          }
          if (Rules.hasAnyMove(swapRoom.gameState)) {
            ws.send(JSON.stringify({ type: "swap_unavailable", message: "已有玩家落子，不能再交换先后手" }));
            return;
          }

          const now = Date.now();
          if (swapRoom.pendingSwap) {
            ws.send(JSON.stringify({ type: "swap_unavailable", message: "已有交换请求等待确认" }));
            return;
          }
          if (now < swapRoom.nextSwapRequestAt) {
            ws.send(JSON.stringify({
              type: "swap_unavailable",
              message: "交换请求冷却中",
              cooldown_until: swapRoom.nextSwapRequestAt,
            }));
            return;
          }

          swapRoom.nextSwapRequestAt = now + SWAP_COOLDOWN_MS;
          swapRoom.pendingSwap = { requesterWs: ws };
          const opponent = swapRoom.players.find((player) => player.ws !== ws);

          ws.send(JSON.stringify({
            type: "swap_request_sent",
            cooldown_until: swapRoom.nextSwapRequestAt,
          }));
          opponent.ws.send(JSON.stringify({
            type: "swap_request",
            requester_symbol: requester.symbol,
            cooldown_until: swapRoom.nextSwapRequestAt,
          }));
        }
        break;

      // ========================================================
      case "respond_swap":
        {
          const swapRoom = rooms.get(data.room_id);
          const responder = swapRoom && swapRoom.players.find((player) => player.ws === ws);
          const pending = swapRoom && swapRoom.pendingSwap;
          if (!swapRoom || !responder || !pending || pending.requesterWs === ws) {
            ws.send(JSON.stringify({ type: "swap_unavailable", message: "交换请求已失效" }));
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
            player.ws.send(JSON.stringify({
              type: "swap_result",
              accepted: accepted,
              player_symbol: player.symbol,
              is_your_turn: player.symbol === swapRoom.gameState.currentPlayer,
              responded_by_me: player.ws === ws,
              cooldown_until: swapRoom.nextSwapRequestAt,
            }));
          });
        }
        break;

      // ========================================================
      case "make_move":
        {
          const moveRoom = rooms.get(data.room_id);
          if (!moveRoom) return;

          // Require both players present (fix #3)
          if (moveRoom.players.length < 2) return;

          const currentPlayer = moveRoom.players.find((p) => p.ws === ws);
          if (!currentPlayer) return;

          const gameState = moveRoom.gameState;
          if (gameState.currentPlayer !== currentPlayer.symbol) return;
          if (gameState.isGameOver) return;

          // Validate move payload (fix #5)
          const move = data.move;
          if (!move || typeof move !== "object") {
            ws.send(JSON.stringify({ type: "error", message: "无效的移动数据" }));
            return;
          }
          if (
            typeof move.board_index !== "number" ||
            move.board_index < 0 || move.board_index >= BOARD_COUNT ||
            typeof move.cell_index !== "number" ||
            move.cell_index < 0 || move.cell_index >= CELL_COUNT
          ) {
            ws.send(JSON.stringify({ type: "error", message: "坐标越界" }));
            return;
          }

          const board = gameState.boards[move.board_index];
          if (!board) {
            ws.send(JSON.stringify({ type: "error", message: "棋盘不存在" }));
            return;
          }

          if (
            board.cells[move.cell_index] ||
            board.winner ||
            move.board_index !== gameState.currentBoard
          ) {
            ws.send(JSON.stringify({ type: "error", message: "非法移动" }));
            return;
          }

          // Use authoritative symbol, NOT the client-supplied move.player (fix #2)
          const symbol = currentPlayer.symbol;

          const moveResult = Rules.applyMove(
            gameState, move.board_index, move.cell_index, symbol
          );

          // Broadcast move
          moveRoom.players.forEach((player) => {
            player.ws.send(JSON.stringify({
              type: "move_made",
              move: {
                board_index: move.board_index,
                cell_index: move.cell_index,
                player: symbol,
              },
            }));
          });

          // Send explicit game_over if applicable
          if (moveResult.gameOver) {
            const totals = Rules.getTotalScores(gameState);
            moveRoom.players.forEach((player) => {
              player.ws.send(JSON.stringify({
                type: "game_over",
                winner: gameState.overallWinner,
                scores: totals,
              }));
            });
          }
        }
        break;

      // ========================================================
      case "reset_game":
        {
          const resetRoom = rooms.get(data.room_id);
          if (!resetRoom) return;

          resetRoom.gameState = Rules.createInitialGameState();
          resetRoom.pendingSwap = null;

          resetRoom.players.forEach((player) => {
            player.ws.send(JSON.stringify({
              type: "game_reset",
              player_symbol: player.symbol,
              is_your_turn: player.symbol === "X",
            }));
          });
        }
        break;

      // ========================================================
      case "leave_room":
        {
          if (currentRoom) {
            const leaveRoom = rooms.get(currentRoom);
            if (leaveRoom) {
              leaveRoom.players = leaveRoom.players.filter((p) => p.ws !== ws);
              if (leaveRoom.players.length === 0) {
                rooms.delete(currentRoom);
              } else {
                leaveRoom.players.forEach((player) => {
                  player.ws.send(JSON.stringify({ type: "player_disconnected" }));
                });
              }
            }
            currentRoom = null;
            playerSymbol = null;
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
    if (currentRoom) {
      const room = rooms.get(currentRoom);
      if (room) {
        room.players = room.players.filter((p) => p.ws !== ws);
        if (room.players.length === 0) {
          rooms.delete(currentRoom);
        } else {
          room.players.forEach((player) => {
            player.ws.send(JSON.stringify({ type: "player_disconnected" }));
          });
        }
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
