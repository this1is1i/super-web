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
    /ws\.onclose\s*=\s*function\s*\(\)\s*\{[\s\S]*roomReady\s*=\s*false;[\s\S]*isMyTurn\s*=\s*false;[\s\S]*renderBoard\(\);/
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
