// main.js — Super Tic-Tac-Toe Browser Client
(function () {
  "use strict";

  var Rules = window.SuperTicTacToeRules;
  var AI = window.SuperTicTacToeAI && window.SuperTicTacToeAI.createAI(Rules);
  var BOARD_COUNT = Rules.BOARD_COUNT;
  var CELL_COUNT = Rules.CELL_COUNT;
  var RECONNECT_GRACE_MS = 5 * 60 * 1000;
  var CONNECT_TIMEOUT_MS = 10 * 1000;
  var MAX_CHAT_IMAGE_BYTES = 512 * 1024;
  var MAX_IMAGE_EDGE = 1600;
  var RESUME_STORAGE_KEY = "super-tic-tac-toe-resume";

  var ws = null;
  var isConnected = false;
  var intentionalDisconnect = false;
  var reconnectStartedAt = 0;
  var reconnectAttempt = 0;
  var reconnectTimer = null;
  var connectionTimer = null;
  var connectionGeneration = 0;
  var lastServerUrl = "";
  var currentRoom = null;
  var roomId = null;
  var roomReady = false;
  var playerSymbol = null;
  var isMyTurn = false;
  var opponentOffline = false;
  var pendingOnlineMove = null;
  var stateVersion = 0;
  var sessionId = null;
  var resumeToken = null;
  var swapCooldownUntil = 0;
  var swapPending = false;
  var aiAbortController = null;
  var chatMessages = [];
  var chatImagePayload = null;
  var chatImageRequestId = 0;
  var unreadMessages = 0;
  var showingChatPreview = false;

  var gameConfig = {
    boardVariant: "normal",
    opponentMode: "pvp",
    swapEvery: 1,
  };
  var gameState = createGameState();

  function $(id) {
    return document.getElementById(id);
  }

  function createGameState() {
    return Rules.createInitialGameState({
      boardVariant: gameConfig.boardVariant,
      swapEvery: gameConfig.swapEvery,
    });
  }

  function rehydrateGameState(state) {
    if (typeof Rules.rehydrateGameState === "function") {
      return Rules.rehydrateGameState(state);
    }
    if (state && state.tiles && state.positionToTile) {
      state.boards = state.positionToTile.map(function (tileId) {
        return state.tiles[tileId];
      });
      state.currentBoard = state.currentPosition;
    }
    return state;
  }

  function getTileAtPosition(state, position) {
    if (typeof Rules.getTileAtPosition === "function") {
      return Rules.getTileAtPosition(state, position);
    }
    return state.tiles[state.positionToTile[position]];
  }

  function findTilePosition(state, tileId) {
    if (typeof Rules.findTilePosition === "function") {
      return Rules.findTilePosition(state, tileId);
    }
    return state.positionToTile.indexOf(tileId);
  }

  function randomId() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") {
      return window.crypto.randomUUID();
    }
    return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);
  }

  function sendJson(message) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(message));
    return true;
  }

  function saveResumeCredentials() {
    if (!sessionId || !resumeToken || !currentRoom) return;
    sessionStorage.setItem(RESUME_STORAGE_KEY, JSON.stringify({
      sessionId: sessionId,
      resumeToken: resumeToken,
      roomId: currentRoom,
      serverUrl: lastServerUrl,
    }));
  }

  function loadResumeCredentials() {
    try {
      var stored = JSON.parse(sessionStorage.getItem(RESUME_STORAGE_KEY) || "null");
      if (!stored || !stored.sessionId || !stored.resumeToken || !stored.roomId) return;
      sessionId = stored.sessionId;
      resumeToken = stored.resumeToken;
      currentRoom = stored.roomId;
      roomId = stored.roomId;
      if (stored.serverUrl) lastServerUrl = stored.serverUrl;
    } catch (error) {
      sessionStorage.removeItem(RESUME_STORAGE_KEY);
    }
  }

  function clearResumeCredentials() {
    sessionId = null;
    resumeToken = null;
    sessionStorage.removeItem(RESUME_STORAGE_KEY);
  }

  function adoptCredentials(message) {
    if (message.session_id) sessionId = message.session_id;
    if (message.resume_token) resumeToken = message.resume_token;
    saveResumeCredentials();
  }

  function cancelReconnect() {
    if (reconnectTimer) window.clearTimeout(reconnectTimer);
    reconnectTimer = null;
    reconnectStartedAt = 0;
    reconnectAttempt = 0;
  }

  function clearConnectionTimer() {
    if (connectionTimer) window.clearTimeout(connectionTimer);
    connectionTimer = null;
  }

  function startResumeTimeout(socket, generation) {
    clearConnectionTimer();
    connectionTimer = window.setTimeout(function () {
      if (ws !== socket || generation !== connectionGeneration) return;
      ws = null;
      connectionGeneration++;
      clearConnectionTimer();
      socket.close();
      isConnected = false;
      roomReady = false;
      isMyTurn = false;
      updateChatAvailability();
      renderBoard();
      updateConnectionStatus("connecting", "房间恢复超时，正在重试…");
      scheduleReconnect();
    }, CONNECT_TIMEOUT_MS);
  }

  function scheduleReconnect() {
    if (
      intentionalDisconnect || gameConfig.opponentMode !== "pvp" ||
      !sessionId || !resumeToken || !currentRoom || reconnectTimer
    ) return;
    var now = Date.now();
    if (!reconnectStartedAt) reconnectStartedAt = now;
    if (now - reconnectStartedAt >= RECONNECT_GRACE_MS) {
      clearOnlineRoom("连接恢复超时，请重新创建或加入房间");
      return;
    }
    var delay = Math.min(10000, Math.pow(2, reconnectAttempt) * 1000);
    reconnectAttempt++;
    updateConnectionStatus("connecting", "正在恢复连接…");
    reconnectTimer = window.setTimeout(function () {
      reconnectTimer = null;
      openSocket(true);
    }, delay);
  }

  function openSocket(isResume) {
    if (gameConfig.opponentMode !== "pvp") return;
    if (!lastServerUrl || ws && (
      ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN
    )) return;
    try {
      var socket = new WebSocket(lastServerUrl);
      var generation = ++connectionGeneration;
      ws = socket;
      clearConnectionTimer();
      connectionTimer = window.setTimeout(function () {
        if (
          ws !== socket || generation !== connectionGeneration ||
          socket.readyState !== WebSocket.CONNECTING
        ) return;
        ws = null;
        connectionGeneration++;
        clearConnectionTimer();
        socket.close();
        isConnected = false;
        if (isResume) {
          updateConnectionStatus("connecting", "连接超时，正在重试…");
          scheduleReconnect();
        } else {
          updateConnectionStatus("disconnected", "连接超时，请重试");
        }
      }, CONNECT_TIMEOUT_MS);
      socket.onopen = function () {
        if (ws !== socket || generation !== connectionGeneration) return;
        clearConnectionTimer();
        isConnected = true;
        if (!isResume) cancelReconnect();
        updateConnectionStatus("connected", isResume ? "正在恢复…" : "已连接");
        updateModeControls();
        if (isResume && sessionId && resumeToken) {
          sendJson({
            type: "resume_session",
            session_id: sessionId,
            resume_token: resumeToken,
          });
          startResumeTimeout(socket, generation);
        } else {
          $("connectionInfo").style.display = "block";
          updateConnectionInfo("连接成功，可以创建或加入房间");
        }
      };
      socket.onmessage = function (event) {
        if (ws !== socket || generation !== connectionGeneration) return;
        try {
          handleServerMessage(JSON.parse(event.data));
        } catch (error) {
          console.error("Invalid message from server:", event.data, error);
        }
      };
      socket.onclose = function () {
        if (ws !== socket || generation !== connectionGeneration) return;
        clearConnectionTimer();
        ws = null;
        isConnected = false;
        roomReady = false;
        isMyTurn = false;
        updateChatAvailability();
        renderBoard();
        if (intentionalDisconnect) {
          updateConnectionStatus("disconnected", "未连接");
          return;
        }
        if (sessionId && resumeToken && currentRoom) {
          updateConnectionStatus("connecting", "连接中断，等待恢复…");
          scheduleReconnect();
        } else {
          updateConnectionStatus("disconnected", "连接已断开");
          updateModeControls();
        }
      };
      socket.onerror = function () {
        if (ws !== socket || generation !== connectionGeneration) return;
        if (!isResume) updateConnectionStatus("disconnected", "连接错误");
      };
    } catch (error) {
      isConnected = false;
      if (isResume) scheduleReconnect();
      else alert("连接失败: " + error.message);
    }
  }

  function enterLocalMode() {
    intentionalDisconnect = true;
    cancelReconnect();
    clearConnectionTimer();
    connectionGeneration++;
    var socket = ws;
    ws = null;
    isConnected = false;
    roomReady = false;
    if (socket && socket.readyState < WebSocket.CLOSING) socket.close();
    updateConnectionStatus("local", "本地模式");
    updateModeControls();
    updateChatAvailability();
  }

  function ensurePvpConnection() {
    intentionalDisconnect = false;
    if (ws && ws.readyState === WebSocket.OPEN) {
      isConnected = true;
      updateConnectionStatus("connected", "已连接");
      updateModeControls();
      return;
    }
    updateConnectionStatus("connecting", "正在连接…");
    openSocket(Boolean(sessionId && currentRoom));
  }

  window.connectToServer = function () {
    var serverUrl = $("serverUrl").value.trim();
    if (!/^wss?:\/\/.+/.test(serverUrl)) {
      alert("请输入有效的 WebSocket 地址 (ws:// 或 wss://)");
      return;
    }
    intentionalDisconnect = false;
    lastServerUrl = serverUrl;
    updateConnectionStatus("connecting", "正在连接…");
    openSocket(Boolean(sessionId && currentRoom));
  };

  window.disconnectFromServer = function () {
    intentionalDisconnect = true;
    cancelReconnect();
    if (currentRoom) sendJson({ type: "leave_room", room_id: currentRoom });
    clearConnectionTimer();
    connectionGeneration++;
    var socket = ws;
    ws = null;
    if (socket && socket.readyState < WebSocket.CLOSING) socket.close();
    isConnected = false;
    clearOnlineRoom("已断开");
    updateConnectionStatus("disconnected", "未连接");
  };

  function clearOnlineRoom(message) {
    currentRoom = null;
    roomId = null;
    roomReady = false;
    playerSymbol = null;
    isMyTurn = false;
    opponentOffline = false;
    pendingOnlineMove = null;
    stateVersion = 0;
    swapPending = false;
    clearResumeCredentials();
    resetRoomChat();
    hideGameResult();
    $("playerInfo").style.display = "none";
    updateChatAvailability();
    if (message) updateConnectionInfo(message);
  }

  function applyRoomConfig(config) {
    if (!config) return;
    gameConfig.boardVariant = config.boardVariant || config.board_variant || "normal";
    gameConfig.swapEvery = Number(config.swapEvery || config.swap_every || 1);
    gameConfig.opponentMode = "pvp";
    syncConfigControls();
  }

  function handleServerMessage(message) {
    switch (message.type) {
      case "room_created":
        hideGameResult();
        currentRoom = message.room_id;
        roomId = message.room_id;
        roomReady = false;
        playerSymbol = message.player_symbol;
        isMyTurn = false;
        applyRoomConfig(message.rule_config);
        adoptCredentials(message);
        updatePlayerInfo();
        hideWaiting();
        updateConnectionInfo("房间创建成功，房间 ID: " + roomId);
        updateJumpLog("等待对手加入…");
        break;

      case "game_start":
        currentRoom = message.room_id;
        roomId = message.room_id;
        roomReady = true;
        playerSymbol = message.player_symbol;
        opponentOffline = false;
        applyRoomConfig(message.rule_config);
        adoptCredentials(message);
        gameState = message.game_state
          ? rehydrateGameState(message.game_state)
          : createGameState();
        stateVersion = message.state_version || 0;
        isMyTurn = message.is_your_turn;
        chatMessages = [];
        renderChat();
        updatePlayerInfo();
        hideWaiting();
        closeSettings();
        initGame();
        updateJumpLog("游戏开始！");
        break;

      case "turn_applied":
        if (!isCurrentRoomMessage(message)) break;
        applyAuthoritativeTurn(message);
        break;

      case "game_reset":
        if (!isCurrentRoomMessage(message)) break;
        applyRoomConfig(message.rule_config);
        gameState = message.game_state
          ? rehydrateGameState(message.game_state)
          : createGameState();
        stateVersion = message.state_version || 0;
        pendingOnlineMove = null;
        playerSymbol = message.player_symbol || playerSymbol;
        isMyTurn = message.is_your_turn;
        initGame();
        updateJumpLog("游戏已重置");
        break;

      case "session_resumed":
        clearConnectionTimer();
        cancelReconnect();
        currentRoom = message.room_id;
        roomId = message.room_id;
        roomReady = true;
        playerSymbol = message.player_symbol;
        opponentOffline = false;
        applyRoomConfig(message.rule_config);
        gameState = rehydrateGameState(message.game_state);
        stateVersion = message.state_version || gameState.stateVersion || 0;
        pendingOnlineMove = null;
        isMyTurn = message.is_your_turn;
        chatMessages = Array.isArray(message.chat_history) ? message.chat_history : [];
        adoptCredentials(message);
        sendJson({
          type: "confirm_resume",
          session_id: sessionId,
          resume_token: resumeToken,
        });
        updateConnectionStatus("connected", "已恢复");
        updatePlayerInfo();
        renderChat();
        renderChatPreview();
        updateUnreadBadge();
        updateUI();
        renderBoard();
        hideGameResult();
        updateJumpLog("已恢复原房间");
        if (gameState.isGameOver) showGameResult();
        break;

      case "resume_confirmed":
        break;

      case "session_error":
        clearConnectionTimer();
        if (message.code === "SESSION_ACTIVE") {
          if (ws) ws.close();
          else scheduleReconnect();
          break;
        }
        cancelReconnect();
        clearOnlineRoom(message.message || "会话已失效");
        updateConnectionStatus("connected", "已连接");
        break;

      case "chat_message":
        if (!isCurrentRoomMessage(message)) break;
        receiveChatMessage(message);
        break;

      case "chat_error":
        alert("消息发送失败: " + message.message);
        break;

      case "player_temporarily_disconnected":
        if (!isCurrentRoomMessage(message)) break;
        opponentOffline = true;
        isMyTurn = false;
        updateChatAvailability();
        renderBoard();
        updateJumpLog("对手暂时断线，最多保留 5 分钟");
        break;

      case "player_reconnected":
        if (!isCurrentRoomMessage(message)) break;
        opponentOffline = false;
        isMyTurn = gameState.currentPlayer === playerSymbol && !gameState.isGameOver;
        updateChatAvailability();
        renderBoard();
        updateJumpLog("对手已重新连接");
        break;

      case "player_disconnected":
        if (!isCurrentRoomMessage(message)) break;
        alert("对手已离开或恢复超时");
        clearOnlineRoom("对手已离开，请创建或加入新房间");
        resetGameLocal();
        break;

      case "swap_request_sent":
        if (!isCurrentRoomMessage(message)) break;
        swapPending = true;
        swapCooldownUntil = message.cooldown_until;
        updateSwapButton();
        updateJumpLog("已发送交换先后手请求");
        break;

      case "swap_request":
        if (!isCurrentRoomMessage(message)) break;
        swapPending = true;
        swapCooldownUntil = message.cooldown_until;
        updateSwapButton();
        sendJson({
          type: "respond_swap",
          room_id: currentRoom,
          accepted: window.confirm("对方请求交换先后手，是否同意？"),
        });
        break;

      case "swap_result":
        if (!isCurrentRoomMessage(message)) break;
        swapPending = false;
        swapCooldownUntil = message.cooldown_until || swapCooldownUntil;
        if (message.accepted) {
          playerSymbol = message.player_symbol;
          isMyTurn = message.is_your_turn;
          updatePlayerInfo();
          updateJumpLog("双方已交换先后手，你现在是 " + playerSymbol);
        } else {
          updateJumpLog(message.responded_by_me ? "你拒绝了交换" : "对方拒绝了交换");
        }
        updateUI();
        renderBoard();
        break;

      case "swap_unavailable":
        if (!isCurrentRoomMessage(message)) break;
        swapPending = false;
        if (message.cooldown_until) swapCooldownUntil = message.cooldown_until;
        updateSwapButton();
        alert(message.message);
        break;

      case "error":
        pendingOnlineMove = null;
        hideWaiting();
        renderBoard();
        alert("错误: " + message.message);
        break;

      default:
        console.warn("未知消息类型:", message.type, message);
    }
  }

  function isCurrentRoomMessage(message) {
    return Boolean(
      message && message.room_id && currentRoom &&
      gameConfig.opponentMode === "pvp" && message.room_id === currentRoom
    );
  }

  function normalizeTurn(turn) {
    return {
      position: turn.position,
      cellIndex: turn.cellIndex === undefined ? turn.cell_index : turn.cellIndex,
      symbol: turn.symbol,
      exchangePair: turn.exchangePair === undefined
        ? turn.exchange_pair || null
        : turn.exchangePair,
    };
  }

  function applyAuthoritativeTurn(message) {
    if (typeof message.state_version === "number" && message.state_version <= stateVersion) return;
    if (
      typeof message.state_version === "number" &&
      message.state_version > stateVersion + 1 &&
      message.game_state
    ) {
      gameState = rehydrateGameState(message.game_state);
    } else {
      var turn = normalizeTurn(message.turn);
      Rules.applyTurn(gameState, turn);
    }
    stateVersion = typeof message.state_version === "number"
      ? message.state_version
      : stateVersion + 1;
    pendingOnlineMove = null;
    isMyTurn = !gameState.isGameOver && gameState.currentPlayer === playerSymbol && !opponentOffline;
    updateUI();
    renderBoard();
    var appliedTurn = normalizeTurn(message.turn);
    updateJumpLog(
      (appliedTurn.symbol === playerSymbol ? "你" : "对手") +
      "在棋盘 " + (appliedTurn.position + 1) +
      " 的位置 " + (appliedTurn.cellIndex + 1) + " 落子" +
      (message.result && message.result.exchange
        ? "，交换棋盘 " + (message.result.exchange[0] + 1) + " 与 " +
          (message.result.exchange[1] + 1)
        : "")
    );
    if (gameState.isGameOver) showGameResult();
  }

  window.createRoom = function () {
    if (!isConnected) {
      alert("请先连接服务器");
      return;
    }
    showWaiting("正在创建房间…");
    sendJson({
      type: "create_room",
      rule_config: {
        boardVariant: gameConfig.boardVariant,
        swapEvery: gameConfig.swapEvery,
      },
    });
  };

  window.joinRoom = function () {
    if (!isConnected) {
      alert("请先连接服务器");
      return;
    }
    var id = $("roomId").value.trim().toUpperCase();
    if (!id) {
      alert("请输入房间 ID");
      return;
    }
    showWaiting("正在加入房间…");
    sendJson({ type: "join_room", room_id: id });
  };

  window.cancelWaiting = function () {
    hideWaiting();
    if (currentRoom) sendJson({ type: "leave_room", room_id: currentRoom });
    clearOnlineRoom("已取消等待");
  };

  function resetGameLocal() {
    cancelAI();
    gameState = createGameState();
    pendingOnlineMove = null;
    stateVersion = 0;
    swapPending = false;
    hideGameResult();
    initGame();
  }

  function currentRuleConfig() {
    return {
      boardVariant: gameConfig.boardVariant,
      swapEvery: gameConfig.swapEvery,
    };
  }

  function readConfigControls() {
    var swapEvery = Math.floor(Number($("swapEvery").value));
    if (!Number.isFinite(swapEvery) || swapEvery < 1 || swapEvery > 20) {
      throw new Error("交换频次必须是 1–20 的整数");
    }
    return {
      boardVariant: $("boardVariant").value,
      opponentMode: $("opponentMode").value,
      swapEvery: swapEvery,
    };
  }

  function syncConfigControls() {
    $("boardVariant").value = gameConfig.boardVariant;
    $("opponentMode").value = gameConfig.opponentMode;
    $("swapEvery").value = gameConfig.swapEvery;
    updateModeControls();
  }

  window.updateModeControls = function () {
    var opponentMode = $("opponentMode").value;
    var boardVariant = $("boardVariant").value;
    $("swapFrequencyField").hidden = boardVariant === "normal";
    $("connectionPanel").style.display = opponentMode === "pvp" ? "block" : "none";
    $("roomSettingsSection").style.display = opponentMode === "pvp" ? "block" : "none";
    $("roomControls").style.display =
      opponentMode === "pvp" && isConnected ? "block" : "none";
  };

  window.applyGameConfig = function () {
    var nextConfig;
    try {
      nextConfig = readConfigControls();
    } catch (error) {
      alert(error.message);
      return;
    }
    if (
      (currentRoom || Rules.hasAnyMove(gameState)) &&
      !window.confirm("应用新模式会结束当前对局，是否继续？")
    ) {
      syncConfigControls();
      return;
    }
    cancelAI();
    if (currentRoom) sendJson({ type: "leave_room", room_id: currentRoom });
    clearOnlineRoom();
    gameConfig = nextConfig;
    gameState = createGameState();
    stateVersion = 0;
    playerSymbol = nextConfig.opponentMode === "pvp" ? null : "X";
    isMyTurn = nextConfig.opponentMode !== "pvp";
    initGame();
    if (nextConfig.opponentMode === "pvp") {
      ensurePvpConnection();
    } else {
      enterLocalMode();
    }
    closeSettings();
    updateJumpLog(
      "已切换为" + modeLabel(nextConfig.boardVariant) + " · " +
      opponentLabel(nextConfig.opponentMode)
    );
  };

  function modeLabel(mode) {
    return mode === "cycle" ? "循环模式" : mode === "chaos" ? "混沌模式" : "普通模式";
  }

  function opponentLabel(mode) {
    return mode === "ai_normal" ? "普通人机" : mode === "ai_hard" ? "困难人机" : "对战";
  }

  function requiresExchange(state) {
    return typeof Rules.requiresExchangeOnNextTurn === "function" &&
      Rules.requiresExchangeOnNextTurn(state);
  }

  function randomExchangePair() {
    var first = Math.floor(Math.random() * BOARD_COUNT);
    var second = Math.floor(Math.random() * (BOARD_COUNT - 1));
    if (second >= first) second++;
    return [first, second];
  }

  function exchangePairForLocalTurn(state) {
    if (state.boardVariant !== "chaos" || !requiresExchange(state)) return null;
    return randomExchangePair();
  }

  function exchangePairForSearch(state, ply) {
    if (state.boardVariant !== "chaos" || !requiresExchange(state)) return null;
    var first = (state.moveCount + ply * 3) % BOARD_COUNT;
    var offset = 1 + ((state.moveCount + ply * 5) % (BOARD_COUNT - 1));
    return [first, (first + offset) % BOARD_COUNT];
  }

  function sendOnlineMove(position, cellIndex) {
    var clientMoveId = randomId();
    var message = {
      type: "make_move",
      room_id: currentRoom,
      client_move_id: clientMoveId,
      state_version: stateVersion,
      move: { position: position, cell_index: cellIndex },
    };
    if (!sendJson(message)) return;
    pendingOnlineMove = {
      position: position,
      cellIndex: cellIndex,
      symbol: playerSymbol,
      clientMoveId: clientMoveId,
    };
    isMyTurn = false;
    renderBoard();
  }

  function handleCellClick(event) {
    if (!isMyTurn || gameState.isGameOver || opponentOffline) return;
    var position = Number(event.currentTarget.dataset.position);
    var cellIndex = Number(event.currentTarget.dataset.cellIndex);
    if (position !== gameState.currentPosition) return;

    if (gameConfig.opponentMode === "pvp") {
      if (!isConnected || !roomReady || !currentRoom || pendingOnlineMove) return;
      sendOnlineMove(position, cellIndex);
      return;
    }

    var turn = {
      position: position,
      cellIndex: cellIndex,
      symbol: "X",
      exchangePair: exchangePairForLocalTurn(gameState),
    };
    Rules.applyTurn(gameState, turn);
    isMyTurn = false;
    updateUI();
    renderBoard();
    updateJumpLog("你在棋盘 " + (position + 1) + " 的位置 " + (cellIndex + 1) + " 落子");
    if (gameState.isGameOver) {
      showGameResult();
      return;
    }
    scheduleAITurn();
  }

  function cancelAI() {
    if (aiAbortController) aiAbortController.abort();
    aiAbortController = null;
  }

  function scheduleAITurn() {
    if (!AI || gameConfig.opponentMode === "pvp" || gameState.currentPlayer !== "O") return;
    cancelAI();
    aiAbortController = new AbortController();
    var controller = aiAbortController;
    var rootExchange = exchangePairForLocalTurn(gameState);
    updateJumpLog("AI 正在思考…");
    AI.chooseTurn(gameState, {
      difficulty: gameConfig.opponentMode === "ai_hard" ? "hard" : "normal",
      symbol: "O",
      exchangePair: rootExchange,
      resolveExchangePair: exchangePairForSearch,
      maxDepth: gameConfig.opponentMode === "ai_hard" ? 4 : 1,
      timeLimitMs: gameConfig.opponentMode === "ai_hard" ? 1200 : 350,
      signal: controller.signal,
    }).then(function (turn) {
      if (controller.signal.aborted || gameState.currentPlayer !== "O") return;
      Rules.applyTurn(gameState, turn);
      aiAbortController = null;
      isMyTurn = !gameState.isGameOver;
      updateUI();
      renderBoard();
      updateJumpLog(
        "AI 在棋盘 " + (turn.position + 1) + " 的位置 " + (turn.cellIndex + 1) + " 落子"
      );
      if (gameState.isGameOver) showGameResult();
    }).catch(function (error) {
      if (error && error.name === "AbortError") return;
      aiAbortController = null;
      isMyTurn = true;
      console.error("AI move failed:", error);
      alert("AI 无法完成回合，请重新开始");
      renderBoard();
    });
  }

  function showGameResult() {
    var totals = Rules.getTotalScores(gameState);
    $("gameStatus").style.display = "block";
    if (gameState.overallWinner === "draw") {
      $("winnerInfo").textContent = "平局！最终得分 X: " + totals.X + " - O: " + totals.O;
    } else {
      $("winnerInfo").textContent =
        "玩家 " + gameState.overallWinner + " 获胜！最终得分 X: " +
        totals.X + " - O: " + totals.O;
    }
    updateJumpLog("游戏结束");
  }

  function hideGameResult() {
    $("gameStatus").style.display = "none";
    $("winnerInfo").textContent = "";
  }

  function clearJumpLog() {
    $("jumpLog").innerHTML = "";
  }

  function updateJumpLog(message) {
    var jumpLog = $("jumpLog");
    var entry = document.createElement("div");
    entry.textContent = "[" + new Date().toLocaleTimeString() + "] " + message;
    jumpLog.appendChild(entry);
    while (jumpLog.children.length > 3) {
      jumpLog.removeChild(jumpLog.firstElementChild);
    }
  }

  window.toggleActivityView = function () {
    showingChatPreview = !showingChatPreview;
    $("jumpLog").hidden = showingChatPreview;
    $("chatPreview").hidden = !showingChatPreview;
    $("activityTitle").textContent = showingChatPreview ? "最新消息" : "最近步骤";
    $("activityToggle").textContent = showingChatPreview ? "切换到步骤" : "切换到消息";
    $("activityToggle").setAttribute("aria-pressed", String(showingChatPreview));
    if (showingChatPreview) {
      unreadMessages = 0;
      renderChatPreview();
      updateUnreadBadge();
    }
  };

  function renderChatPreview() {
    var preview = $("chatPreview");
    preview.innerHTML = "";
    var latest = chatMessages.slice(-3);
    if (!latest.length) {
      var empty = document.createElement("div");
      empty.textContent = "暂无消息";
      preview.appendChild(empty);
      return;
    }
    latest.forEach(function (message) {
      var row = document.createElement("div");
      var sender = message.sender_symbol === playerSymbol ? "你" : "对手";
      row.textContent = sender + ": " +
        (message.content.kind === "image" ? "[图片]" : message.content.text);
      preview.appendChild(row);
    });
  }

  function receiveChatMessage(message) {
    if (chatMessages.some(function (item) { return item.id === message.id; })) return;
    chatMessages.push(message);
    while (chatMessages.length > 100) chatMessages.shift();
    if (
      message.sender_symbol !== playerSymbol &&
      !$("chatModal").classList.contains("is-open") &&
      !showingChatPreview
    ) {
      unreadMessages++;
    }
    renderChat();
    renderChatPreview();
    updateUnreadBadge();
  }

  function resetRoomChat() {
    chatImageRequestId++;
    chatMessages = [];
    chatImagePayload = null;
    unreadMessages = 0;
    var text = $("chatText");
    var input = $("chatImage");
    if (text) text.value = "";
    if (input) input.value = "";
    setImagePreview(null);
    renderChat();
    renderChatPreview();
    updateUnreadBadge();
    closeChatModal();
  }

  function renderChat() {
    var container = $("chatMessages");
    if (!container) return;
    container.innerHTML = "";
    chatMessages.forEach(function (message) {
      var bubble = document.createElement("div");
      bubble.className = "chat-message" +
        (message.sender_symbol === playerSymbol ? " is-mine" : "");
      if (message.content.kind === "image") {
        var image = document.createElement("img");
        image.alt = message.sender_symbol === playerSymbol ? "你发送的图片" : "对手发送的图片";
        image.src = "data:" + message.content.mime + ";base64," + message.content.data;
        bubble.appendChild(image);
      } else {
        var text = document.createElement("div");
        text.textContent = message.content.text;
        bubble.appendChild(text);
      }
      var meta = document.createElement("div");
      meta.className = "chat-message-meta";
      meta.textContent =
        (message.sender_symbol === playerSymbol ? "你" : "对手") + " · " +
        new Date(message.sent_at).toLocaleTimeString();
      bubble.appendChild(meta);
      container.appendChild(bubble);
    });
    container.scrollTop = container.scrollHeight;
  }

  function updateUnreadBadge() {
    var button = $("chatButton");
    button.textContent = "💬 对话" + (unreadMessages ? " (" + unreadMessages + ")" : "");
  }

  function updateChatAvailability() {
    $("chatButton").disabled = !(
      gameConfig.opponentMode === "pvp" &&
      currentRoom && roomReady && playerSymbol && isConnected && !opponentOffline
    );
  }

  window.openChatModal = function () {
    if ($("chatButton").disabled) return;
    unreadMessages = 0;
    updateUnreadBadge();
    renderChat();
    $("chatModal").classList.add("is-open");
    $("chatModal").setAttribute("aria-hidden", "false");
    $("chatText").focus();
  };

  window.closeChatModal = function () {
    $("chatModal").classList.remove("is-open");
    $("chatModal").setAttribute("aria-hidden", "true");
  };

  window.closeChatOnBackdrop = function (event) {
    if (event.target === event.currentTarget) closeChatModal();
  };

  function blobToBase64(blob) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () {
        resolve(String(reader.result).split(",")[1]);
      };
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  function canvasToBlob(canvas, mime, quality) {
    return new Promise(function (resolve, reject) {
      canvas.toBlob(function (blob) {
        if (blob) resolve(blob);
        else reject(new Error("图片编码失败"));
      }, mime, quality);
    });
  }

  function loadImage(file) {
    return new Promise(function (resolve, reject) {
      var image = new Image();
      var url = URL.createObjectURL(file);
      image.onload = function () {
        URL.revokeObjectURL(url);
        resolve(image);
      };
      image.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error("无法读取图片"));
      };
      image.src = url;
    });
  }

  async function compressChatImage(file) {
    var allowed = ["image/jpeg", "image/png", "image/webp"];
    if (allowed.indexOf(file.type) === -1) throw new Error("仅支持 JPEG、PNG 或 WebP");
    var image = await loadImage(file);
    var initialScale = Math.min(1, MAX_IMAGE_EDGE / Math.max(image.naturalWidth, image.naturalHeight));
    var scale = initialScale;
    var mime = file.type;
    var quality = 0.86;
    var blob = null;

    for (var attempt = 0; attempt < 8; attempt++) {
      var canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
      blob = await canvasToBlob(canvas, mime, quality);
      if (blob.size <= MAX_CHAT_IMAGE_BYTES) {
        return { kind: "image", mime: blob.type || mime, data: await blobToBase64(blob) };
      }
      scale *= 0.78;
      quality = Math.max(0.5, quality - 0.08);
    }
    throw new Error("图片压缩后仍超过 512 KiB");
  }

  function setImagePreview(payload) {
    var preview = $("chatImagePreview");
    preview.innerHTML = "";
    if (!payload) {
      preview.hidden = true;
      return;
    }
    var image = document.createElement("img");
    image.alt = "待发送图片";
    image.src = "data:" + payload.mime + ";base64," + payload.data;
    image.style.maxHeight = "120px";
    image.style.maxWidth = "100%";
    preview.appendChild(image);
    preview.hidden = false;
  }

  window.sendChatMessage = function () {
    if (!currentRoom || !isConnected) return;
    var text = $("chatText").value.trim();
    if (!text && !chatImagePayload) {
      alert("请输入消息或选择图片");
      return;
    }
    if (text) {
      sendJson({
        type: "chat_send",
        room_id: currentRoom,
        client_message_id: randomId(),
        content: { kind: "text", text: text },
      });
    }
    if (chatImagePayload) {
      sendJson({
        type: "chat_send",
        room_id: currentRoom,
        client_message_id: randomId(),
        content: chatImagePayload,
      });
    }
    $("chatText").value = "";
    $("chatImage").value = "";
    chatImagePayload = null;
    setImagePreview(null);
  };

  function updateConnectionStatus(status, text) {
    var el = $("connectionStatus");
    el.className = "connection-status status-" + status;
    el.textContent = "● " + text;
  }

  function updateConnectionInfo(text) {
    $("connectionInfo").style.display = "block";
    $("connectionInfo").textContent = text;
  }

  function updatePlayerInfo() {
    $("playerInfo").style.display = playerSymbol ? "block" : "none";
    if (!playerSymbol) return;
    $("yourPlayer").textContent = playerSymbol;
    $("opponentPlayer").textContent = playerSymbol === "X" ? "O" : "X";
    $("yourPlayer").className = playerSymbol === "X" ? "player-x" : "player-o";
    $("opponentPlayer").className = playerSymbol === "X" ? "player-o" : "player-x";
    $("currentRoomId").textContent = currentRoom || roomId || "";
    updateSwapButton();
    updateChatAvailability();
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
      gameState.currentPlayer + "</span>";
    var names = ["左上", "中上", "右上", "左中", "中心", "右中", "左下", "中下", "右下"];
    $("activeBoard").textContent =
      names[gameState.currentPosition] + " (" + (gameState.currentPosition + 1) + ")";
    var totals = Rules.getTotalScores(gameState);
    $("scoreX").textContent = totals.X;
    $("scoreO").textContent = totals.O;
    $("bonusInfo").textContent =
      "X: " + (gameState.bonusScores.X || 0) +
      " | O: " + (gameState.bonusScores.O || 0);
    updateSwapButton();
  }

  function renderBoard() {
    var overallBoard = $("overallBoard");
    overallBoard.innerHTML = "";
    for (var position = 0; position < BOARD_COUNT; position++) {
      var tile = getTileAtPosition(gameState, position);
      var miniBoard = document.createElement("div");
      miniBoard.className = "mini-board";
      miniBoard.id = "board-" + position;
      var isActive = position === gameState.currentPosition && !gameState.isGameOver;
      if (isActive) miniBoard.classList.add("active");
      if (isActive && isMyTurn) miniBoard.classList.add("playable");
      if (tile.winner) miniBoard.classList.add("won-" + tile.winner.toLowerCase());

      var label = document.createElement("div");
      label.className = "board-label";
      label.textContent = position + 1;
      miniBoard.appendChild(label);

      if (tile.fromTileId !== null && !tile.winner) {
        var source = document.createElement("div");
        source.className = "source-indicator";
        source.textContent = "S";
        source.title = "来源棋盘当前位于: " + (findTilePosition(gameState, tile.fromTileId) + 1);
        miniBoard.appendChild(source);
      }

      for (var cellIndex = 0; cellIndex < CELL_COUNT; cellIndex++) {
        var cell = document.createElement("div");
        cell.className = "cell";
        cell.dataset.position = position;
        cell.dataset.cellIndex = cellIndex;
        var value = tile.cells[cellIndex];
        var isPending = pendingOnlineMove &&
          pendingOnlineMove.position === position &&
          pendingOnlineMove.cellIndex === cellIndex;
        if (value || isPending) {
          var displayed = value || pendingOnlineMove.symbol;
          cell.classList.add(displayed.toLowerCase());
          if (isPending) cell.classList.add("pending");
          cell.textContent = displayed;
        }
        if (isActive && isMyTurn && !value && !tile.winner && !pendingOnlineMove) {
          cell.addEventListener("click", handleCellClick);
        }
        miniBoard.appendChild(cell);
      }
      overallBoard.appendChild(miniBoard);
    }
  }

  function updateSwapButton() {
    var button = $("swapButton");
    var remaining = Math.max(0, Math.ceil((swapCooldownUntil - Date.now()) / 1000));
    var onlineRoom = gameConfig.opponentMode === "pvp" && Boolean(currentRoom);
    var canRequest = onlineRoom && isConnected && !opponentOffline &&
      !Rules.hasAnyMove(gameState) && !swapPending && remaining === 0;
    button.style.display = onlineRoom ? "inline-block" : "none";
    button.disabled = !canRequest;
    if (swapPending) button.textContent = "等待交换确认…";
    else if (Rules.hasAnyMove(gameState)) button.textContent = "已落子，无法交换";
    else if (remaining > 0) button.textContent = "交换先后手 (" + remaining + "s)";
    else button.textContent = "⇄ 交换先后手";
  }

  window.requestSwap = function () {
    if (!currentRoom || !isConnected || Rules.hasAnyMove(gameState)) return;
    swapPending = true;
    updateSwapButton();
    sendJson({ type: "request_swap", room_id: currentRoom });
  };

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
    $("rulesModal").classList.add("is-open");
    $("rulesModal").setAttribute("aria-hidden", "false");
  };

  window.closeRulesModal = function () {
    $("rulesModal").classList.remove("is-open");
    $("rulesModal").setAttribute("aria-hidden", "true");
  };

  window.closeRulesOnBackdrop = function (event) {
    if (event.target === event.currentTarget) closeRulesModal();
  };

  window.resetGame = function () {
    cancelAI();
    if (gameConfig.opponentMode === "pvp" && currentRoom) {
      sendJson({ type: "reset_game", room_id: currentRoom });
      return;
    }
    resetGameLocal();
    isMyTurn = gameConfig.opponentMode !== "pvp";
    updateJumpLog("游戏重新开始");
  };

  function initGame() {
    clearJumpLog();
    hideGameResult();
    if (gameConfig.opponentMode !== "pvp") {
      isMyTurn = gameState.currentPlayer === "X";
    }
    updateUI();
    renderBoard();
    if (gameConfig.opponentMode !== "pvp") {
      updateJumpLog("你是 X，当前从中心棋盘开始");
    } else {
      updateJumpLog(isMyTurn ? "你的回合" : "等待对手行动…");
    }
    updateChatAvailability();
  }

  window.onload = function () {
    loadResumeCredentials();
    updateConnectionStatus("disconnected", "未连接");
    window.setInterval(updateSwapButton, 1000);
    $("settingsButton").setAttribute("aria-expanded", "false");
    $("chatButton").setAttribute("aria-expanded", "false");
    $("chatImage").addEventListener("change", async function (event) {
      var requestId = ++chatImageRequestId;
      var file = event.target.files && event.target.files[0];
      if (!file) {
        chatImagePayload = null;
        setImagePreview(null);
        return;
      }
      try {
        $("chatImagePreview").hidden = false;
        $("chatImagePreview").textContent = "正在压缩图片…";
        var compressed = await compressChatImage(file);
        if (requestId !== chatImageRequestId) return;
        chatImagePayload = compressed;
        setImagePreview(chatImagePayload);
      } catch (error) {
        if (requestId !== chatImageRequestId) return;
        chatImagePayload = null;
        event.target.value = "";
        setImagePreview(null);
        alert(error.message);
      }
    });
    $("chatText").addEventListener("keydown", function (event) {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        sendChatMessage();
      }
    });
    document.addEventListener("keydown", function (event) {
      if (event.key !== "Escape") return;
      if ($("chatModal").classList.contains("is-open")) closeChatModal();
      else if ($("rulesModal").classList.contains("is-open")) closeRulesModal();
      else closeSettings();
    });
    window.addEventListener("resize", renderBoard);
    syncConfigControls();
    updateUI();
    renderBoard();
    renderChatPreview();
    openRulesModal();

    var wsProtocol = location.protocol === "https:" ? "wss://" : "ws://";
    var autoUrl = wsProtocol + location.host;
    $("serverUrl").value = lastServerUrl || autoUrl;
    lastServerUrl = $("serverUrl").value;
    ensurePvpConnection();
  };
})();
