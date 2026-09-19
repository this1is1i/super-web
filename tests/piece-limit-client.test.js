const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const Rules = require("../js/game-rules");

function client() {
  const elements = new Map();
  function element() {
    const classes = new Set();
    return {
      value: "", checked: false, hidden: false, style: {}, dataset: {}, children: [],
      classList: { add: (v) => classes.add(v), remove: (v) => classes.delete(v), contains: (v) => classes.has(v) },
      set innerHTML(_) { this.children = []; },
      get firstElementChild() { return this.children[0]; },
      appendChild(child) { this.children.push(child); },
      removeChild(child) { this.children.splice(this.children.indexOf(child), 1); },
      setAttribute() {}, addEventListener() {}, focus() {},
    };
  }
  function get(id) {
    if (!elements.has(id)) elements.set(id, element());
    return elements.get(id);
  }
  const sockets = [];
  class Socket {
    static OPEN = 1;
    static CLOSING = 2;
    constructor() { this.readyState = 0; this.sent = []; sockets.push(this); }
    send(raw) { this.sent.push(JSON.parse(raw)); }
    close() { this.readyState = 3; }
    receive(message) { this.onmessage({ data: JSON.stringify(message) }); }
  }
  let latestState;
  const alerts = [];
  const context = {
    SuperTicTacToeRules: {
      ...Rules,
      createInitialGameState(config) { latestState = Rules.createInitialGameState(config); return latestState; },
    },
    document: { getElementById: get, createElement: element, addEventListener() {} },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    location: { protocol: "http:", host: "localhost:8080" },
    WebSocket: Socket, console, Date, AbortController,
    alert: (message) => alerts.push(message), confirm: () => true,
    setTimeout: () => 1, clearTimeout() {}, setInterval() {}, addEventListener() {},
  };
  context.window = context;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../js/main.js"), "utf8"), context);
  context.onload();
  return { context, get, sockets, alerts, state: () => latestState };
}

test("settings enable, validate and disable a local piece limit across reset", () => {
  const c = client();
  assert.equal(c.get("pieceLimitEnabled").checked, false);
  assert.equal(c.get("pieceLimit").value, 7);
  c.get("opponentMode").value = "ai_normal";
  c.get("pieceLimitEnabled").checked = true;
  c.get("pieceLimit").value = "6";
  c.context.updateModeControls();
  assert.equal(c.get("pieceLimitField").hidden, false);
  c.context.applyGameConfig();
  assert.equal(c.state().pieceLimit, 6);
  c.context.resetGame();
  assert.equal(c.state().pieceLimit, 6);
  c.get("pieceLimit").value = "6.5";
  c.context.applyGameConfig();
  assert.equal(c.alerts.length, 1);
  assert.equal(c.state().pieceLimit, 6);
  c.get("pieceLimitEnabled").checked = false;
  c.context.applyGameConfig();
  assert.equal(c.state().pieceLimit, null);
});

test("room settings and the repeated-position result reach the browser", () => {
  const c = client();
  const socket = c.sockets[0];
  socket.readyState = 1;
  socket.onopen();
  const state = Rules.createInitialGameState({ pieceLimit: 6 });
  state.tiles.forEach((tile) => { if (tile.id !== 4) tile.winner = "draw"; });
  socket.receive({
    type: "game_start", room_id: "ABC123", player_symbol: "X", is_your_turn: true, state_version: 0,
    rule_config: { boardVariant: "normal", swapEvery: 1, pieceLimit: 6 }, game_state: state,
  });
  assert.equal(c.get("pieceLimitEnabled").checked, true);
  assert.equal(c.get("pieceLimit").value, 6);
  const ring = [0, 1, 2, 5, 8, 7, 6, 3];
  for (let step = 0; step < 22; step++) {
    const turn = { position: 4, cellIndex: ring[step % 8], symbol: state.currentPlayer };
    const result = Rules.applyTurn(state, turn);
    socket.receive({ type: "turn_applied", room_id: "ABC123", state_version: step + 1, turn, result });
    if (step === 5) {
      const cells = c.get("overallBoard").children[4].children.find((node) => node.className === "tile-content").children;
      assert.equal(cells.filter((cell) => cell.classList.contains("expiring")).length, 1);
    }
  }
  assert.match(c.get("winnerInfo").textContent, /三次重复/);
  assert.match(c.get("winnerInfo").textContent, /平局/);
  assert.equal(c.get("gameStatus").style.display, "block");
});
