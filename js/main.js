// main.js — Super Tic-Tac-Toe Browser Client
(function () {
  "use strict";

  // ============================================================
  // Constants
  // ============================================================
  var Rules = window.SuperTicTacToeRules;
  var BOARD_COUNT = Rules.BOARD_COUNT;
  var CELL_COUNT = Rules.CELL_COUNT;

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
  var swapCooldownUntil = 0;
  var swapPending = false;

  var gameState = Rules.createInitialGameState();

  // ============================================================
  // Helpers: DOM shortcuts
  // ============================================================
  function $(id) { return document.getElementById(id); }

  // ============================================================
  // Local reset (without sending to server)
  // ============================================================
  function resetGameLocal() {
    clearJumpLog();
    gameState = Rules.createInitialGameState();
    pendingMoveSnapshot = null;
    swapPending = false;
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
        closeSettings();
        initGame();
        break;

      case "move_made":
        handleOpponentMove(message.move);
        break;

      case "game_reset":
        playerSymbol = message.player_symbol || playerSymbol;
        isMyTurn = message.is_your_turn;
        resetGameLocal();
        updatePlayerInfo();
        updateJumpLog("游戏已重置");
        break;

      case "swap_request_sent":
        swapPending = true;
        swapCooldownUntil = message.cooldown_until;
        updateSwapButton();
        updateJumpLog("已发送交换先后手请求，等待对方确认");
        break;

      case "swap_request":
        swapPending = true;
        swapCooldownUntil = message.cooldown_until;
        updateSwapButton();
        var accepted = window.confirm("对方请求交换先后手，是否同意？");
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: "respond_swap",
            room_id: currentRoom,
            accepted: accepted,
          }));
        }
        break;

      case "swap_result":
        swapPending = false;
        swapCooldownUntil = message.cooldown_until || swapCooldownUntil;
        if (message.accepted) {
          playerSymbol = message.player_symbol;
          isMyTurn = message.is_your_turn;
          updatePlayerInfo();
          updateJumpLog("双方已交换先后手，你现在是 " + playerSymbol);
        } else {
          updateJumpLog(message.responded_by_me ? "你拒绝了交换先后手" : "对方拒绝了交换先后手");
        }
        updateUI();
        renderBoard();
        break;

      case "swap_unavailable":
        swapPending = false;
        if (message.cooldown_until) swapCooldownUntil = message.cooldown_until;
        updateSwapButton();
        alert(message.message);
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
    gameState = snap.gameState;
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

    var moveResult = Rules.applyMove(gameState, boardIndex, cellIndex, player);
    isMyTurn = !moveResult.gameOver && gameState.currentPlayer === playerSymbol;

    updateUI();
    renderBoard();

    if (moveResult.gameOver) {
      showGameResult();
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
      gameState: JSON.parse(JSON.stringify(gameState)),
      isMyTurn: isMyTurn,
    };

    sendMove(boardIndex, cellIndex);

    // Optimistic local update through the same rules used by the server.
    var moveResult = Rules.applyMove(gameState, boardIndex, cellIndex, playerSymbol);
    isMyTurn = false;

    updateUI();
    renderBoard();
    if (moveResult.gameOver) showGameResult();

    updateJumpLog("你在棋盘" + (boardIndex + 1) + " 位置" + (cellIndex + 1) + " 落子");
  }

  function showGameResult() {
    var totals = Rules.getTotalScores(gameState);
    var totalX = totals.X;
    var totalO = totals.O;

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
    while (jumpLog.children.length > 3) {
      jumpLog.removeChild(jumpLog.firstElementChild);
    }
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
    $("yourPlayer").className = playerSymbol === "X" ? "player-x" : "player-o";
    $("opponentPlayer").className = playerSymbol === "X" ? "player-o" : "player-x";
    $("currentRoomId").textContent = currentRoom || roomId;
    updateSwapButton();
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

    var totals = Rules.getTotalScores(gameState);
    $("scoreX").textContent = totals.X;
    $("scoreO").textContent = totals.O;

    var bonusX = gameState.bonusScores.X || 0;
    var bonusO = gameState.bonusScores.O || 0;
    $("bonusInfo").textContent = "X: " + bonusX + " | O: " + bonusO;

    gameState.boards.forEach(function (board, index) {
      board.isActive = index === gameState.currentBoard && !gameState.isGameOver;
    });
    updateSwapButton();
  }

  function isTouchLayout() {
    return window.matchMedia && window.matchMedia("(max-width: 768px)").matches;
  }

  function clearPredictedBoard() {
    var highlighted = document.querySelectorAll(".mini-board.predicted-next");
    for (var index = 0; index < highlighted.length; index++) {
      highlighted[index].classList.remove("predicted-next");
    }
  }

  function predictWinningDestination(boardIndex, cellIndex) {
    var board = gameState.boards[boardIndex];
    var simulatedCells = board.cells.slice();
    simulatedCells[cellIndex] = playerSymbol;
    if (Rules.getWinningPatternIndexes(gameState, boardIndex, simulatedCells).length === 0) return null;

    var previousWinner = board.winner;
    board.winner = playerSymbol;
    var destination = Rules.findNextBoardAfterWin(gameState, boardIndex, cellIndex);
    board.winner = previousWinner;
    return destination;
  }

  function showPredictedBoard(boardIndex) {
    clearPredictedBoard();
    if (boardIndex === null) return;
    var target = $("board-" + boardIndex);
    if (target) target.classList.add("predicted-next");
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
        if (isMyTurn) miniBoard.classList.add("playable");
      }
      if (boardData.winner) {
        miniBoard.classList.add("won-" + boardData.winner.toLowerCase());
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
          if (!isTouchLayout()) {
            (function (activeBoardIndex, activeCellIndex, activeCell) {
              activeCell.addEventListener("mouseenter", function () {
                showPredictedBoard(predictWinningDestination(activeBoardIndex, activeCellIndex));
              });
              activeCell.addEventListener("mouseleave", clearPredictedBoard);
            })(boardIndex, cellIndex, cell);
          }
        }

        miniBoard.appendChild(cell);
      }

      overallBoard.appendChild(miniBoard);
    }

    // Touch devices cannot hover, so show the current board's fallback destination.
    var current = gameState.boards[gameState.currentBoard];
    if (
      isTouchLayout() && isMyTurn && !gameState.isGameOver &&
      current && current.fromBoard !== null
    ) {
      showPredictedBoard(Rules.findFallbackBoardAfterWin(gameState, gameState.currentBoard));
    }
  }

  function updateSwapButton() {
    var button = $("swapButton");
    if (!button) return;
    var remainingSeconds = Math.max(0, Math.ceil((swapCooldownUntil - Date.now()) / 1000));
    var canRequest = Boolean(currentRoom) && !Rules.hasAnyMove(gameState) && !swapPending && remainingSeconds === 0;
    button.style.display = currentRoom ? "inline-block" : "none";
    button.disabled = !canRequest;
    if (swapPending) {
      button.textContent = "等待交换确认…";
    } else if (Rules.hasAnyMove(gameState)) {
      button.textContent = "已落子，无法交换";
    } else if (remainingSeconds > 0) {
      button.textContent = "交换先后手 (" + remainingSeconds + "s)";
    } else {
      button.textContent = "⇄ 交换先后手";
    }
  }

  window.requestSwap = function () {
    if (!ws || ws.readyState !== WebSocket.OPEN || !currentRoom) return;
    if (Rules.hasAnyMove(gameState)) {
      alert("已有玩家落子，不能再交换先后手");
      return;
    }
    swapPending = true;
    updateSwapButton();
    ws.send(JSON.stringify({ type: "request_swap", room_id: currentRoom }));
  };

  // ============================================================
  // Overlay navigation
  // ============================================================
  window.openSettings = function () {
    $("settingsDrawer").classList.add("is-open");
    $("settingsBackdrop").classList.add("is-open");
    $("settingsDrawer").setAttribute("aria-hidden", "false");
    $("settingsButton").setAttribute("aria-expanded", "true");
  };

  window.closeSettings = function () {
    $("settingsDrawer").classList.remove("is-open");
    $("settingsBackdrop").classList.remove("is-open");
    $("settingsDrawer").setAttribute("aria-hidden", "true");
    $("settingsButton").setAttribute("aria-expanded", "false");
  };

  window.openRulesModal = function () {
    var modal = $("rulesModal");
    modal.classList.add("is-open");
    modal.setAttribute("aria-hidden", "false");
  };

  window.closeRulesModal = function () {
    var modal = $("rulesModal");
    modal.classList.remove("is-open");
    modal.setAttribute("aria-hidden", "true");
  };

  window.closeRulesOnBackdrop = function (event) {
    if (event.target === event.currentTarget) closeRulesModal();
  };

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
    updateUI();
    renderBoard();
    if (isMyTurn) {
      updateJumpLog("你的回合！当前棋盘: " + (gameState.currentBoard + 1));
    } else {
      updateJumpLog("等待对手行动...");
    }
  }

  window.onload = function () {
    updateConnectionStatus("disconnected", "未连接");
    window.setInterval(updateSwapButton, 1000);
    $("settingsButton").setAttribute("aria-expanded", "false");
    updateUI();
    renderBoard();
    openRulesModal();

    document.addEventListener("keydown", function (event) {
      if (event.key !== "Escape") return;
      if ($("rulesModal").classList.contains("is-open")) {
        closeRulesModal();
      } else {
        closeSettings();
      }
    });

    window.addEventListener("resize", function () {
      renderBoard();
    });

    // Auto-connect to the same host that serves the page.
    var wsProtocol = location.protocol === "https:" ? "wss://" : "ws://";
    var autoUrl = wsProtocol + location.host;
    $("serverUrl").value = autoUrl;
    window.connectToServer();
  };

})();
