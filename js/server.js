// server.js — Super Tic-Tac-Toe WebSocket Game Server + Static File Server
const WebSocket = require("ws");
const http = require("http");
const fs = require("fs");
const path = require("path");

// ============================================================
// Constants
// ============================================================
const BOARD_COUNT = 9;
const CELL_COUNT = 9;
const CENTER_BOARD = 4;
const BONUS_POINTS = 2;
const WINNING_PATTERNS = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8],
  [0, 3, 6], [1, 4, 7], [2, 5, 8],
  [0, 4, 8], [2, 4, 6],
];
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
            gameState: createInitialGameState(),
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

          board.cells[move.cell_index] = symbol;

          // Check mini-board win/draw and update currentBoard
          if (checkMiniBoardWin(gameState, move.board_index)) {
            board.winner = symbol;
            gameState.scores[symbol]++;
            const nextBoard = findNextBoardAfterWin(
              gameState, move.board_index, move.cell_index
            );
            if (nextBoard !== null) {
              gameState.currentBoard = nextBoard;
              // Track fromBoard after win/draw jump (fix #7)
              gameState.boards[nextBoard].fromBoard = move.board_index;
            }
          } else if (checkMiniBoardDraw(gameState, move.board_index)) {
            board.winner = "draw";
            const nextBoard = findNextBoardAfterWin(
              gameState, move.board_index, move.cell_index
            );
            if (nextBoard !== null) {
              gameState.currentBoard = nextBoard;
              gameState.boards[nextBoard].fromBoard = move.board_index;
            }
          } else {
            // Normal jump to the cell's target board
            const nextBoard = move.cell_index;
            if (!gameState.boards[nextBoard].winner) {
              gameState.currentBoard = nextBoard;
              gameState.boards[nextBoard].fromBoard = move.board_index;
            } else {
              gameState.currentBoard = move.board_index;
            }
          }

          // Switch turn
          gameState.currentPlayer = gameState.currentPlayer === "X" ? "O" : "X";

          // Check overall bonus and game end
          checkOverallWin(gameState);
          const gameOver = checkGameEnd(gameState);

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
          if (gameOver) {
            const totalX = gameState.scores.X + (gameState.bonusScores.X || 0);
            const totalO = gameState.scores.O + (gameState.bonusScores.O || 0);
            moveRoom.players.forEach((player) => {
              player.ws.send(JSON.stringify({
                type: "game_over",
                winner: gameState.overallWinner,
                scores: { X: totalX, O: totalO },
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

          resetRoom.gameState = createInitialGameState();

          resetRoom.players.forEach((player) => {
            player.ws.send(JSON.stringify({ type: "game_reset" }));
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
// Game logic (authoritative copy)
// ============================================================

function createInitialGameState() {
  return {
    boards: Array.from({ length: BOARD_COUNT }, () => ({
      cells: Array(CELL_COUNT).fill(null),
      winner: null,
      fromBoard: null,
    })),
    currentBoard: CENTER_BOARD,
    currentPlayer: "X",
    scores: { X: 0, O: 0 },
    bonusScores: { X: 0, O: 0 },
    isGameOver: false,
    overallWinner: null,
  };
}

function checkMiniBoardWin(gameState, boardIndex) {
  const cells = gameState.boards[boardIndex].cells;
  for (const [a, b, c] of WINNING_PATTERNS) {
    if (cells[a] && cells[a] === cells[b] && cells[a] === cells[c]) {
      return true;
    }
  }
  return false;
}

function checkMiniBoardDraw(gameState, boardIndex) {
  const board = gameState.boards[boardIndex];
  return board.cells.every((cell) => cell !== null) && !board.winner;
}

function findNextBoardAfterWin(gameState, wonBoardIndex, moveCellIndex) {
  const targetBoard = moveCellIndex;
  if (!gameState.boards[targetBoard].winner) {
    return targetBoard;
  }

  const fromBoard = gameState.boards[wonBoardIndex].fromBoard;
  if (fromBoard !== null && !gameState.boards[fromBoard].winner) {
    return fromBoard;
  }

  if (fromBoard !== null) {
    const recursiveBoard = findRecursiveAvailableBoard(gameState, fromBoard);
    if (recursiveBoard !== null) return recursiveBoard;
  }

  for (let i = 0; i < BOARD_COUNT; i++) {
    if (!gameState.boards[i].winner) return i;
  }
  return null;
}

function findRecursiveAvailableBoard(gameState, boardIndex) {
  const visited = new Set();
  const stack = [boardIndex];

  while (stack.length > 0) {
    const current = stack.pop();
    if (visited.has(current)) continue;
    visited.add(current);

    const fromBoard = gameState.boards[current].fromBoard;
    if (fromBoard === null) break;
    if (!gameState.boards[fromBoard].winner) return fromBoard;
    stack.push(fromBoard);
  }

  return null;
}

function checkOverallWin(gameState) {
  const overallBoard = gameState.boards.map((b) => b.winner);
  gameState.bonusScores = { X: 0, O: 0 };

  for (const [a, b, c] of WINNING_PATTERNS) {
    if (
      overallBoard[a] &&
      overallBoard[a] === overallBoard[b] &&
      overallBoard[a] === overallBoard[c] &&
      overallBoard[a] !== "draw"
    ) {
      // Cumulative bonus — multiple lines all count (fix #4)
      gameState.bonusScores[overallBoard[a]] += BONUS_POINTS;
    }
  }
}

function checkGameEnd(gameState) {
  const allBoardsEnded = gameState.boards.every((b) => b.winner !== null);
  if (allBoardsEnded) {
    gameState.isGameOver = true;
    const totalX = gameState.scores.X + (gameState.bonusScores.X || 0);
    const totalO = gameState.scores.O + (gameState.bonusScores.O || 0);
    if (totalX > totalO) {
      gameState.overallWinner = "X";
    } else if (totalO > totalX) {
      gameState.overallWinner = "O";
    } else {
      gameState.overallWinner = "draw";
    }
    return true;
  }
  return false;
}

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
