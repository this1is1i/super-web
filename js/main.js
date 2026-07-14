// main.js — Super Tic-Tac-Toe Browser Client
(function () {
  "use strict";

  // ============================================================
  // Constants
  // ============================================================
  var BOARD_COUNT = 9;
  var CELL_COUNT = 9;
  var CENTER_BOARD = 4;
  var BONUS_POINTS = 2;
  var WINNING_PATTERNS = [
    [0, 1, 2], [3, 4, 5], [6, 7, 8],
    [0, 3, 6], [1, 4, 7], [2, 5, 8],
    [0, 4, 8], [2, 4, 6],
  ];

  // ============================================================
  // State
  // ============================================================
  var ws = null;
  var isConnected = false;
  var currentRoom = null;
  var playerSymbol = null;
  var isMyTurn = false;
  var roomId = null;
  var pendingMoveSnapshot = null;

  var gameState = {
    boards: Array.from({ length: BOARD_COUNT }, function (_, i) {
      return {
        cells: Array(CELL_COUNT).fill(null),
        winner: null,
        isActive: i === CENTER_BOARD,
        fromBoard: null,
      };
    }),
    currentBoard: CENTER_BOARD,
    currentPlayer: "X",
    scores: { X: 0, O: 0 },
    bonusScores: { X: 0, O: 0 },
    isGameOver: false,
    overallWinner: null,
  };

  // ============================================================
  // Helpers: DOM shortcuts
  // ============================================================
  function $(id) { return document.getElementById(id); }

  // ============================================================
  // Local reset (without sending to server)
  // ============================================================
  function resetGameLocal() {
    clearJumpLog();
    gameState = {
      boards: Array.from({ length: BOARD_COUNT }, function (_, i) {
        return {
          cells: Array(CELL_COUNT).fill(null),
          winner: null,
          isActive: i === CENTER_BOARD,
          fromBoard: null,
        };
      }),
      currentBoard: CENTER_BOARD,
      currentPlayer: "X",
      scores: { X: 0, O: 0 },
      bonusScores: { X: 0, O: 0 },
      isGameOver: false,
      overallWinner: null,
    };
    $("gameStatus").style.display = "none";
    updateUI();
    renderBoard();
  }

  // ============================================================
  // Connection
  // ============================================================
  window.connectToServer = function () {
    var serverUrl = $("serverUrl").value;

    if (!/^wss?:\/\/.+/.test(serverUrl)) {
      alert("请输入有效的 WebSocket 地址 (ws:// 或 wss://)");
      return;
    }

    updateConnectionStatus("connecting", "正在连接...");

    try {
      ws = new WebSocket(serverUrl);

      ws.onopen = function () {
        isConnected = true;
        updateConnectionStatus("connected", "已连接");
        $("roomControls").style.display = "block";
        $("connectionInfo").style.display = "block";
        updateConnectionInfo("连接成功！可以创建或加入房间");
      };

      ws.onmessage = function (event) {
        var message;
        try {
          message = JSON.parse(event.data);
        } catch (e) {
          console.error("Invalid message from server:", event.data);
          return;
        }
        handleServerMessage(message);
      };

      ws.onclose = function () {
        isConnected = false;
        updateConnectionStatus("disconnected", "已断开");
        $("roomControls").style.display = "none";
        $("connectionInfo").style.display = "none";
        $("playerInfo").style.display = "none";
        alert("连接已断开");
      };

      ws.onerror = function () {
        updateConnectionStatus("disconnected", "连接错误");
        alert("连接服务器失败，请检查地址是否正确");
      };
    } catch (error) {
      console.error("连接错误:", error);
      updateConnectionStatus("disconnected", "连接失败");
      alert("连接失败: " + error.message);
    }
  };

  window.disconnectFromServer = function () {
    if (ws) {
      ws.close();
      ws = null;
    }
    isConnected = false;
    currentRoom = null;
    roomId = null;
    playerSymbol = null;
    isMyTurn = false;
    resetGameLocal();
    updateConnectionStatus("disconnected", "未连接");
  };

  function handleServerMessage(message) {
    console.log("收到消息:", message);

    switch (message.type) {
      case "room_created":
        roomId = message.room_id;
        playerSymbol = message.player_symbol;
        isMyTurn = message.is_your_turn;
        updatePlayerInfo();
        hideWaiting();
        updateConnectionInfo("房间创建成功！房间ID: " + roomId);
        updateJumpLog("你是玩家 " + playerSymbol + "，等待对手加入...");
        break;

      case "game_start":
        currentRoom = message.room_id;
        playerSymbol = message.player_symbol;
        isMyTurn = message.is_your_turn;
        updatePlayerInfo();
        hideWaiting();
        updateJumpLog("游戏开始！");
        if (isMyTurn) {
          updateJumpLog("你的回合，开始下棋！");
        }
        initGame();
        break;

      case "move_made":
        handleOpponentMove(message.move);
        break;

      case "game_reset":
        resetGameLocal();
        updateJumpLog("游戏已重置");
        break;

      case "game_over":
        // Server confirms game end — sync local state if needed
        updateJumpLog(
          "游戏结束！" +
          (message.winner === "draw" ? "平局" : message.winner + " 获胜") +
          " | X: " + message.scores.X + " - O: " + message.scores.O
        );
        break;

      case "error":
        hideWaiting();
        if (pendingMoveSnapshot) {
          rollbackPendingMove();
        }
        alert("错误: " + message.message);
        break;

      case "player_disconnected":
        alert("对手已断开连接");
        currentRoom = null;
        roomId = null;
        playerSymbol = null;
        isMyTurn = false;
        resetGameLocal();
        updateConnectionInfo("对手已断开，请创建或加入新房间");
        break;

      default:
        console.warn("未知消息类型:", message.type, message);
    }
  }

  function rollbackPendingMove() {
    var snap = pendingMoveSnapshot;
    if (!snap) return;
    gameState.boards[snap.boardIndex].cells = snap.boardCells;
    gameState.boards[snap.boardIndex].winner = snap.boardWinner;
    snap.boardsMeta.forEach(function (meta, i) {
      gameState.boards[i].winner = meta.winner;
      gameState.boards[i].fromBoard = meta.fromBoard;
    });
    gameState.currentBoard = snap.currentBoard;
    gameState.currentPlayer = snap.currentPlayer;
    gameState.scores = snap.scores;
    gameState.bonusScores = snap.bonusScores;
    gameState.isGameOver = snap.isGameOver;
    gameState.overallWinner = snap.overallWinner;
    isMyTurn = snap.isMyTurn;
    pendingMoveSnapshot = null;
    updateUI();
    renderBoard();
  }

  // ============================================================
  // Room actions
  // ============================================================
  window.createRoom = function () {
    if (!isConnected) {
      alert("请先连接服务器");
      return;
    }
    showWaiting("正在创建房间...");
    ws.send(JSON.stringify({ type: "create_room" }));
  };

  window.joinRoom = function () {
    if (!isConnected) {
      alert("请先连接服务器");
      return;
    }
    var id = $("roomId").value.trim();
    if (!id) {
      alert("请输入房间ID");
      return;
    }
    showWaiting("正在加入房间...");
    ws.send(JSON.stringify({ type: "join_room", room_id: id }));
  };

  window.cancelWaiting = function () {
    hideWaiting();
    // Notify server to clean up the room (fix #8)
    var leaveId = roomId || currentRoom;
    if (ws && ws.readyState === WebSocket.OPEN && leaveId) {
      ws.send(JSON.stringify({ type: "leave_room", room_id: leaveId }));
    }
    currentRoom = null;
    roomId = null;
    playerSymbol = null;
    isMyTurn = false;
    updateConnectionInfo("已取消等待");
  };

  // ============================================================
  // Move handling
  // ============================================================
  function sendMove(boardIndex, cellIndex) {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      alert("未连接到服务器");
      return;
    }
    ws.send(JSON.stringify({
      type: "make_move",
      room_id: currentRoom,
      move: {
        board_index: boardIndex,
        cell_index: cellIndex,
        player: playerSymbol,
      },
    }));
  }

  function handleOpponentMove(moveData) {
    pendingMoveSnapshot = null;

    // Ignore own moves echoed back
    if (moveData.player === playerSymbol) return;

    var boardIndex = moveData.board_index;
    var cellIndex = moveData.cell_index;
    var player = moveData.player;

    gameState.boards[boardIndex].cells[cellIndex] = player;

    if (checkMiniBoardWin(boardIndex)) {
      gameState.boards[boardIndex].winner = player;
      gameState.scores[player]++;
      var nextBoard = findNextBoardAfterWin(boardIndex, cellIndex);
      if (nextBoard !== null) {
        gameState.currentBoard = nextBoard;
        gameState.boards[nextBoard].fromBoard = boardIndex; // fix #7
      }
    } else if (checkMiniBoardDraw(boardIndex)) {
      gameState.boards[boardIndex].winner = "draw";
      var nextBoard2 = findNextBoardAfterWin(boardIndex, cellIndex);
      if (nextBoard2 !== null) {
        gameState.currentBoard = nextBoard2;
        gameState.boards[nextBoard2].fromBoard = boardIndex; // fix #7
      }
    } else {
      var nextBoard3 = cellIndex;
      if (!gameState.boards[nextBoard3].winner) {
        gameState.currentBoard = nextBoard3;
        gameState.boards[nextBoard3].fromBoard = boardIndex;
      } else {
        gameState.currentBoard = boardIndex;
      }
    }

    checkOverallWin();

    isMyTurn = true;
    gameState.currentPlayer = playerSymbol;

    updateUI();
    renderBoard();

    // checkGameEnd now returns boolean (fix #6)
    if (checkGameEnd()) {
      updateJumpLog("对手在棋盘" + (boardIndex + 1) + " 位置" + (cellIndex + 1) + " 落子，游戏结束！");
    } else {
      updateJumpLog("对手在棋盘" + (boardIndex + 1) + " 位置" + (cellIndex + 1) + " 落子，轮到你了！");
    }
  }

  // ============================================================
  // Cell click handler
  // ============================================================
  function handleCellClick(event) {
    if (!isMyTurn || gameState.isGameOver) return;

    var boardIndex = parseInt(event.target.dataset.boardIndex);
    var cellIndex = parseInt(event.target.dataset.cellIndex);

    if (boardIndex !== gameState.currentBoard) return;

    // Save snapshot for rollback
    pendingMoveSnapshot = {
      boardIndex: boardIndex,
      cellIndex: cellIndex,
      currentBoard: gameState.currentBoard,
      isMyTurn: isMyTurn,
      currentPlayer: gameState.currentPlayer,
      scores: Object.assign({}, gameState.scores),
      bonusScores: Object.assign({}, gameState.bonusScores),
      isGameOver: gameState.isGameOver,
      overallWinner: gameState.overallWinner,
      boardCells: gameState.boards[boardIndex].cells.slice(),
      boardWinner: gameState.boards[boardIndex].winner,
      boardsMeta: gameState.boards.map(function (b) {
        return { winner: b.winner, fromBoard: b.fromBoard };
      }),
    };

    sendMove(boardIndex, cellIndex);

    // Optimistic local update
    gameState.boards[boardIndex].cells[cellIndex] = playerSymbol;

    if (checkMiniBoardWin(boardIndex)) {
      gameState.boards[boardIndex].winner = playerSymbol;
      gameState.scores[playerSymbol]++;
      var nextBoard = findNextBoardAfterWin(boardIndex, cellIndex);
      if (nextBoard !== null) {
        gameState.currentBoard = nextBoard;
        gameState.boards[nextBoard].fromBoard = boardIndex; // fix #7
      }
    } else if (checkMiniBoardDraw(boardIndex)) {
      gameState.boards[boardIndex].winner = "draw";
      var nextBoard2 = findNextBoardAfterWin(boardIndex, cellIndex);
      if (nextBoard2 !== null) {
        gameState.currentBoard = nextBoard2;
        gameState.boards[nextBoard2].fromBoard = boardIndex; // fix #7
      }
    } else {
      var nextBoard3 = cellIndex;
      if (!gameState.boards[nextBoard3].winner) {
        gameState.currentBoard = nextBoard3;
        gameState.boards[nextBoard3].fromBoard = boardIndex;
      } else {
        gameState.currentBoard = boardIndex;
      }
    }

    checkOverallWin();

    isMyTurn = false;
    gameState.currentPlayer = gameState.currentPlayer === "X" ? "O" : "X";

    updateUI();
    renderBoard();
    checkGameEnd();

    updateJumpLog("你在棋盘" + (boardIndex + 1) + " 位置" + (cellIndex + 1) + " 落子");
  }

  // ============================================================
  // Game logic (client copy — must mirror server.js)
  // ============================================================
  function findNextBoardAfterWin(wonBoardIndex, moveCellIndex) {
    var targetBoard = moveCellIndex;
    if (!gameState.boards[targetBoard].winner) return targetBoard;

    var fromBoard = gameState.boards[wonBoardIndex].fromBoard;
    if (fromBoard !== null && !gameState.boards[fromBoard].winner) return fromBoard;

    if (fromBoard !== null) {
      var recursiveBoard = findRecursiveAvailableBoard(fromBoard);
      if (recursiveBoard !== null) return recursiveBoard;
    }

    for (var i = 0; i < BOARD_COUNT; i++) {
      if (!gameState.boards[i].winner) return i;
    }
    return null;
  }

  function findRecursiveAvailableBoard(boardIndex) {
    var visited = new Set();
    var stack = [boardIndex];
    while (stack.length > 0) {
      var current = stack.pop();
      if (visited.has(current)) continue;
      visited.add(current);
      var fromBoard = gameState.boards[current].fromBoard;
      if (fromBoard === null) break;
      if (!gameState.boards[fromBoard].winner) return fromBoard;
      stack.push(fromBoard);
    }
    return null;
  }

  function checkMiniBoardWin(boardIndex) {
    var cells = gameState.boards[boardIndex].cells;
    for (var p = 0; p < WINNING_PATTERNS.length; p++) {
      var pat = WINNING_PATTERNS[p];
      var a = pat[0], b = pat[1], c = pat[2];
      if (cells[a] && cells[a] === cells[b] && cells[a] === cells[c]) return true;
    }
    return false;
  }

  function checkMiniBoardDraw(boardIndex) {
    var board = gameState.boards[boardIndex];
    return board.cells.every(function (cell) { return cell !== null; }) && !board.winner;
  }

  function checkOverallWin() {
    var overallBoard = gameState.boards.map(function (b) { return b.winner; });
    gameState.bonusScores = { X: 0, O: 0 };

    WINNING_PATTERNS.forEach(function (pat) {
      var a = pat[0], b = pat[1], c = pat[2];
      if (
        overallBoard[a] &&
        overallBoard[a] === overallBoard[b] &&
        overallBoard[a] === overallBoard[c] &&
        overallBoard[a] !== "draw"
      ) {
        // Cumulative (fix #4)
        gameState.bonusScores[overallBoard[a]] += BONUS_POINTS;
      }
    });
  }

  function checkGameEnd() {
    var allBoardsEnded = gameState.boards.every(function (b) { return b.winner !== null; });
    if (allBoardsEnded) {
      gameState.isGameOver = true;

      var totalX = gameState.scores.X + (gameState.bonusScores.X || 0);
      var totalO = gameState.scores.O + (gameState.bonusScores.O || 0);

      if (totalX > totalO) {
        gameState.overallWinner = "X";
      } else if (totalO > totalX) {
        gameState.overallWinner = "O";
      } else {
        gameState.overallWinner = "draw";
      }

      showGameResult();
      return true; // fix #6
    }
    return false; // fix #6
  }

  function showGameResult() {
    var totalX = gameState.scores.X + (gameState.bonusScores.X || 0);
    var totalO = gameState.scores.O + (gameState.bonusScores.O || 0);

    $("gameStatus").style.display = "block";

    if (gameState.overallWinner === "draw") {
      $("winnerInfo").innerHTML = "🤝 平局！最终得分：X: " + totalX + " - O: " + totalO;
    } else {
      var emoji = gameState.overallWinner === "X" ? "🏆" : "🎉";
      var winnerTotal = gameState.overallWinner === "X" ? totalX : totalO;
      var loserTotal = gameState.overallWinner === "X" ? totalO : totalX;
      $("winnerInfo").innerHTML =
        emoji + " 玩家 " + gameState.overallWinner + " 获胜！" +
        "<br>最终得分：" + gameState.overallWinner + ": " + winnerTotal +
        " - " + (gameState.overallWinner === "O" ? "X" : "O") + ": " + loserTotal;
    }

    updateJumpLog(
      "游戏结束！" + (gameState.overallWinner === "draw" ? "平局" : gameState.overallWinner + "获胜")
    );
  }

  // ============================================================
  // UI
  // ============================================================
  function clearJumpLog() {
    $("jumpLog").innerHTML = "";
  }

  function updateJumpLog(message) {
    var jumpLog = $("jumpLog");
    var entry = document.createElement("div");
    var time = new Date().toLocaleTimeString();
    entry.textContent = "[" + time + "] " + message;
    jumpLog.appendChild(entry);
    jumpLog.scrollTop = jumpLog.scrollHeight;
  }

  function updateConnectionStatus(status, text) {
    var el = $("connectionStatus");
    el.className = "connection-status status-" + status;
    el.innerHTML = '<span class="status-' + status + '">● ' + text + '</span>';
  }

  function updateConnectionInfo(text) {
    $("connectionInfo").textContent = text;
  }

  function updatePlayerInfo() {
    $("playerInfo").style.display = "block";
    $("yourPlayer").textContent = playerSymbol;
    $("opponentPlayer").textContent = playerSymbol === "X" ? "O" : "X";
    $("currentRoomId").textContent = currentRoom || roomId;
  }

  function showWaiting(message) {
    $("waitingMessage").textContent = message;
    $("waitingOverlay").style.display = "flex";
  }

  function hideWaiting() {
    $("waitingOverlay").style.display = "none";
  }

  function updateUI() {
    $("currentPlayer").innerHTML =
      '<span class="' + (gameState.currentPlayer === "X" ? "player-x" : "player-o") + '">' +
      gameState.currentPlayer + '</span>';

    var boardNames = ["左上", "中上", "右上", "左中", "中心", "右中", "左下", "中下", "右下"];
    $("activeBoard").textContent = boardNames[gameState.currentBoard] +
      " (" + (gameState.currentBoard + 1) + ")";

    $("scoreX").textContent = gameState.scores.X;
    $("scoreO").textContent = gameState.scores.O;

    var bonusX = gameState.bonusScores.X || 0;
    var bonusO = gameState.bonusScores.O || 0;
    $("bonusInfo").textContent = "X: " + bonusX + " | O: " + bonusO;

    gameState.boards.forEach(function (board, index) {
      board.isActive = index === gameState.currentBoard && !gameState.isGameOver && isMyTurn;
    });
  }

  function renderBoard() {
    var overallBoard = $("overallBoard");
    overallBoard.innerHTML = "";

    for (var boardIndex = 0; boardIndex < BOARD_COUNT; boardIndex++) {
      var miniBoard = document.createElement("div");
      miniBoard.className = "mini-board";
      miniBoard.id = "board-" + boardIndex;

      var boardData = gameState.boards[boardIndex];

      if (boardData.isActive) {
        miniBoard.classList.add("active");
      }
      if (boardData.winner) {
        miniBoard.classList.add("won-" + boardData.winner);
      }

      var label = document.createElement("div");
      label.className = "board-label";
      label.textContent = boardIndex + 1;
      miniBoard.appendChild(label);

      if (boardData.fromBoard !== null && !boardData.winner) {
        var sourceIndicator = document.createElement("div");
        sourceIndicator.className = "source-indicator";
        sourceIndicator.textContent = "S";
        sourceIndicator.title = "来源棋盘: " + (boardData.fromBoard + 1);
        miniBoard.appendChild(sourceIndicator);
      }

      for (var cellIndex = 0; cellIndex < CELL_COUNT; cellIndex++) {
        var cell = document.createElement("div");
        cell.className = "cell";
        cell.dataset.boardIndex = boardIndex;
        cell.dataset.cellIndex = cellIndex;

        var cellValue = boardData.cells[cellIndex];
        if (cellValue) {
          cell.classList.add(cellValue.toLowerCase());
          cell.textContent = cellValue;
        }

        if (
          boardIndex === gameState.currentBoard &&
          !gameState.isGameOver &&
          !cellValue &&
          !boardData.winner &&
          isMyTurn
        ) {
          cell.addEventListener("click", handleCellClick);
        }

        miniBoard.appendChild(cell);
      }

      overallBoard.appendChild(miniBoard);
    }
  }

  // ============================================================
  // Reset (user-initiated — sends to server if online)
  // ============================================================
  window.resetGame = function () {
    if (!isConnected || !currentRoom) {
      resetGameLocal();
      updateJumpLog("游戏重新开始");
    } else {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "reset_game", room_id: currentRoom }));
      }
    }
  };

  // ============================================================
  // Init
  // ============================================================
  function initGame() {
    clearJumpLog();
    renderBoard();
    updateUI();
    if (isMyTurn) {
      updateJumpLog("你的回合！当前棋盘: " + (gameState.currentBoard + 1));
    } else {
      updateJumpLog("等待对手行动...");
    }
  }

  window.onload = function () {
    updateConnectionStatus("disconnected", "未连接");

    // Auto-connect to the same host that serves the page.
    var wsProtocol = location.protocol === "https:" ? "wss://" : "ws://";
    var autoUrl = wsProtocol + location.host;
    $("serverUrl").value = autoUrl;
    window.connectToServer();
  };

})();
