const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const css = fs.readFileSync(path.join(root, "css/main.css"), "utf8");
const main = fs.readFileSync(path.join(root, "js/main.js"), "utf8");

test("single-screen layout disables page scrolling and contains the required overlays", () => {
  assert.match(css, /html,[\s\S]*body\s*{[\s\S]*overflow:\s*hidden;/);
  assert.match(html, /id="settingsDrawer"/);
  assert.match(html, /id="settingsBackdrop"/);
  assert.match(html, /class="modal-overlay is-open"\s+id="rulesModal"/);
  assert.match(html, /id="rulesButton"/);
});

test("active-board highlighting is independent from local turn ownership", () => {
  assert.match(
    main,
    /var isActive = position === gameState\.currentPosition && !gameState\.isGameOver;/
  );
  assert.match(main, /if \(isActive && isMyTurn\) miniBoard\.classList\.add\("playable"\);/);
  assert.doesNotMatch(main, /isActive\s*=.*isMyTurn/);
});

test("the local-turn active board has a stronger, motion-safe highlight", () => {
  assert.match(css, /\.mini-board\.active\.playable\s*\{/);
  assert.match(css, /animation:\s*playable-board-pulse 1\.8s ease-in-out infinite;/);
  assert.match(css, /@keyframes playable-board-pulse/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
});

test("the visible history is capped at three entries", () => {
  assert.match(main, /while \(jumpLog\.children\.length > 3\)/);
  assert.match(css, /\.jump-log\s*{[\s\S]*grid-template-rows:\s*repeat\(3, 1fr\)/);
});

test("settings expose independent board and opponent mode controls", () => {
  assert.match(html, /id="boardVariant"/);
  assert.match(html, /value="normal"/);
  assert.match(html, /value="cycle"/);
  assert.match(html, /value="chaos"/);
  assert.match(html, /id="opponentMode"/);
  assert.match(html, /value="pvp"/);
  assert.match(html, /value="ai_normal"/);
  assert.match(html, /value="ai_hard"/);
  assert.match(html, /id="swapEvery"[^>]*min="1"[^>]*max="20"/);
});

test("the rules dialog explains the special board modes", () => {
  assert.match(html, /循环模式[^<]*固定顺序/);
  assert.match(html, /混沌模式[^<]*随机/);
  assert.match(html, /绝对位置/);
  assert.match(html, /每 N 手/);
});

test("the activity card can switch between steps and the latest messages", () => {
  assert.match(html, /id="activityCard"/);
  assert.match(html, /id="activityToggle"/);
  assert.match(html, /id="jumpLog"/);
  assert.match(html, /id="chatPreview"/);
  assert.match(main, /function\s+renderChatPreview\s*\(/);
  assert.match(main, /\.slice\(-3\)/);
  assert.match(main, /while \(chatMessages\.length > 100\)/);
});

test("online chat has a topbar entry and an accessible dialog", () => {
  assert.match(html, /id="chatButton"/);
  assert.match(html, /id="chatModal"[^>]*aria-hidden="true"/);
  assert.match(html, /id="chatMessages"/);
  assert.match(html, /id="chatText"[^>]*maxlength="500"/);
  assert.match(html, /id="chatImage"[^>]*accept="image\/jpeg,image\/png,image\/webp"/);
  assert.match(html, /id="chatSendButton"/);
  assert.match(main, /var roomReady = false;/);
  assert.match(main, /currentRoom && roomReady && playerSymbol && isConnected/);
});

test("the client uses authoritative atomic turns online and shared turns for AI", () => {
  assert.match(main, /case "turn_applied":/);
  assert.match(main, /client_move_id/);
  assert.match(main, /state_version/);
  assert.match(main, /Rules\.applyTurn\(gameState,\s*turn\)/);
  assert.match(main, /SuperTicTacToeAI/);
  assert.doesNotMatch(main, /Rules\.applyMove\(/);
  assert.match(css, /\.cell\.pending\s*{/);
});

test("the client can resume a room and handles chat errors independently", () => {
  assert.match(main, /type:\s*"resume_session"/);
  assert.match(main, /type:\s*"confirm_resume"/);
  assert.match(main, /case "session_resumed":/);
  assert.match(main, /case "resume_confirmed":/);
  assert.match(main, /case "chat_message":/);
  assert.match(main, /case "chat_error":/);
  assert.match(main, /RECONNECT_GRACE_MS\s*=\s*5\s*\*\s*60\s*\*\s*1000/);
  assert.match(
    main,
    /case "session_error":[\s\S]*message\.code === "SESSION_ACTIVE"[\s\S]*ws\.close\(\)/
  );
  const resumed = main.slice(
    main.indexOf('case "session_resumed":'),
    main.indexOf('case "resume_confirmed":')
  );
  assert.match(resumed, /renderChatPreview\(\);/);
  assert.match(resumed, /updateUnreadBadge\(\);/);
});

test("starting or resetting a local AI game enables the human board before rendering", () => {
  const start = main.indexOf("function initGame()");
  const end = main.indexOf("window.onload", start);
  const initGame = main.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.ok(
    initGame.indexOf('isMyTurn = gameState.currentPlayer === "X";') <
      initGame.indexOf("updateUI();")
  );
});

test("an online board freezes across disconnects and clears stale pending moves on resume", () => {
  assert.match(
    main,
    /socket\.onclose\s*=\s*function\s*\(\)\s*\{[\s\S]*roomReady\s*=\s*false;[\s\S]*isMyTurn\s*=\s*false;[\s\S]*renderBoard\(\);/
  );
  assert.match(
    main,
    /case "session_resumed":[\s\S]*pendingOnlineMove\s*=\s*null;[\s\S]*if \(gameState\.isGameOver\) showGameResult\(\);/
  );
  assert.match(
    main,
    /gameConfig\.opponentMode === "pvp"[\s\S]*!isConnected\s*\|\|\s*!roomReady/
  );
  assert.match(main, /if \(!sendJson\(message\)\) return;/);
});

test("leaving a room clears chat state and invalidates in-flight image compression", () => {
  assert.match(main, /function resetRoomChat\(\)/);
  assert.match(
    main,
    /function clearOnlineRoom\(message\)[\s\S]*resetRoomChat\(\);/
  );
  assert.match(main, /chatImageRequestId\+\+;/);
  assert.match(main, /if \(requestId !== chatImageRequestId\) return;/);
});

test("websocket recovery times out stalled handshakes and ignores stale socket callbacks", () => {
  assert.match(main, /CONNECT_TIMEOUT_MS\s*=\s*10\s*\*\s*1000/);
  assert.match(main, /var connectionGeneration = 0;/);
  assert.match(main, /function clearConnectionTimer\(\)/);
  assert.match(
    main,
    /connectionTimer\s*=\s*window\.setTimeout\([\s\S]*socket\.readyState !== WebSocket\.CONNECTING[\s\S]*scheduleReconnect\(\)/
  );
  assert.match(main, /if \(ws !== socket \|\| generation !== connectionGeneration\) return;/);
  const socketOpen = main.slice(main.indexOf("function openSocket"), main.indexOf("window.connectToServer"));
  assert.doesNotMatch(socketOpen, /reconnectAttempt\s*=\s*0/);
});

test("room resume has an application-level timeout after websocket open", () => {
  assert.match(main, /function startResumeTimeout\(socket, generation\)/);
  const resumeTimeout = main.slice(main.indexOf("function startResumeTimeout"), main.indexOf("function scheduleReconnect"));
  assert.match(resumeTimeout, /CONNECT_TIMEOUT_MS/);
  assert.match(resumeTimeout, /socket\.close\(\)/);
  const socketOpen = main.slice(main.indexOf("function openSocket"), main.indexOf("function enterLocalMode"));
  assert.match(socketOpen, /type:\s*"resume_session"[\s\S]*startResumeTimeout\(socket, generation\);/);
  const resumed = main.slice(main.indexOf('case "session_resumed":'), main.indexOf('case "resume_confirmed":'));
  assert.match(resumed, /clearConnectionTimer\(\);/);
});

test("an idle pvp socket reports disconnected instead of pretending to recover a room", () => {
  const socketOpen = main.slice(main.indexOf("function openSocket"), main.indexOf("function enterLocalMode"));
  assert.match(
    socketOpen,
    /if \(sessionId && resumeToken && currentRoom\)[\s\S]*scheduleReconnect\(\);[\s\S]*updateConnectionStatus\("disconnected", "连接已断开"\)/
  );
});

test("AI modes close websocket transport and pvp mode reconnects automatically", () => {
  assert.match(main, /function enterLocalMode\(\)/);
  assert.match(
    main,
    /function enterLocalMode\(\)[\s\S]*socket\.close\(\)[\s\S]*updateConnectionStatus\("local", "本地模式"\)/
  );
  assert.match(main, /function ensurePvpConnection\(\)/);
  assert.match(
    main,
    /nextConfig\.opponentMode === "pvp"[\s\S]*ensurePvpConnection\(\)[\s\S]*enterLocalMode\(\)/
  );
});

test("every new-game boundary clears the result overlay and stale room events are ignored", () => {
  assert.match(main, /function hideGameResult\(\)[\s\S]*winnerInfo[\s\S]*textContent = ""/);
  assert.match(main, /function initGame\(\)[\s\S]*hideGameResult\(\);/);
  assert.match(main, /case "room_created":[\s\S]*hideGameResult\(\);/);
  const resumed = main.slice(main.indexOf('case "session_resumed":'), main.indexOf('case "resume_confirmed":'));
  assert.match(resumed, /hideGameResult\(\);/);
  assert.match(main, /function isCurrentRoomMessage\(message\)/);
  assert.match(main, /case "turn_applied":[\s\S]*if \(!isCurrentRoomMessage\(message\)\) break;/);
  for (const type of [
    "chat_message",
    "player_temporarily_disconnected",
    "player_reconnected",
    "player_disconnected",
    "swap_request_sent",
    "swap_request",
    "swap_result",
    "swap_unavailable",
  ]) {
    const start = main.indexOf(`case "${type}":`);
    const end = main.indexOf("break;", start);
    assert.match(main.slice(start, end), /if \(!isCurrentRoomMessage\(message\)\)/);
  }
});
