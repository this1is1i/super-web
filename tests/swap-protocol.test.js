const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const path = require("node:path");
const WebSocket = require("ws");

class TestClient {
  constructor(socket) {
    this.socket = socket;
    this.messages = [];
    this.waiters = [];
    socket.on("message", (raw) => this.push(JSON.parse(raw.toString())));
  }

  push(message) {
    const waiterIndex = this.waiters.findIndex((waiter) => waiter.type === message.type);
    if (waiterIndex !== -1) {
      const waiter = this.waiters.splice(waiterIndex, 1)[0];
      clearTimeout(waiter.timer);
      waiter.resolve(message);
      return;
    }
    this.messages.push(message);
  }

  next(type, timeoutMs = 3000) {
    const queuedIndex = this.messages.findIndex((message) => message.type === type);
    if (queuedIndex !== -1) return Promise.resolve(this.messages.splice(queuedIndex, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = { type, resolve, timer: null };
      waiter.timer = setTimeout(() => {
        this.waiters = this.waiters.filter((item) => item !== waiter);
        reject(new Error(`Timed out waiting for ${type}`));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  send(message) {
    this.socket.send(JSON.stringify(message));
  }

  close() {
    this.socket.close();
  }
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.once("open", () => resolve(new TestClient(socket)));
    socket.once("error", reject);
  });
}

function waitForServer(child) {
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error(`Server did not start: ${output}`)), 5000);
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
      if (output.includes("超级井字棋已启动")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.stderr.on("data", (chunk) => { output += chunk.toString(); });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Server exited early with ${code}: ${output}`));
    });
  });
}

test("pre-game swap requires confirmation, swaps symbols, and enforces cooldown", async () => {
  const port = 19000 + (process.pid % 1000);
  const root = path.resolve(__dirname, "..");
  const child = spawn(process.execPath, ["js/server.js"], {
    cwd: root,
    env: { ...process.env, PORT: String(port), NODE_ENV: "production" },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let first;
  let second;
  try {
    await waitForServer(child);
    first = await connect(`ws://127.0.0.1:${port}`);
    second = await connect(`ws://127.0.0.1:${port}`);

    first.send({
      type: "create_room",
      rule_config: { boardVariant: "normal", swapEvery: 1 },
    });
    const created = await first.next("room_created");
    second.send({ type: "join_room", room_id: created.room_id });
    await Promise.all([first.next("game_start"), second.next("game_start")]);

    first.send({ type: "request_swap", room_id: created.room_id });
    assert.equal((await first.next("swap_request_sent")).room_id, created.room_id);
    assert.equal((await second.next("swap_request")).room_id, created.room_id);
    second.send({ type: "respond_swap", room_id: created.room_id, accepted: true });

    const [firstResult, secondResult] = await Promise.all([
      first.next("swap_result"), second.next("swap_result"),
    ]);
    assert.equal(firstResult.room_id, created.room_id);
    assert.equal(secondResult.room_id, created.room_id);
    assert.equal(firstResult.player_symbol, "O");
    assert.equal(firstResult.is_your_turn, false);
    assert.equal(secondResult.player_symbol, "X");
    assert.equal(secondResult.is_your_turn, true);

    first.send({ type: "request_swap", room_id: created.room_id });
    const cooldown = await first.next("swap_unavailable");
    assert.equal(cooldown.room_id, created.room_id);
    assert.match(cooldown.message, /冷却/);

    second.send({
      type: "make_move",
      room_id: created.room_id,
      client_move_id: "swap-cooldown-move",
      state_version: 0,
      move: { position: 4, cell_index: 0 },
    });
    await Promise.all([first.next("turn_applied"), second.next("turn_applied")]);

    first.send({ type: "request_swap", room_id: created.room_id });
    const afterMove = await first.next("swap_unavailable");
    assert.equal(afterMove.room_id, created.room_id);
    assert.match(afterMove.message, /已有玩家落子/);
  } finally {
    if (first) first.close();
    if (second) second.close();
    child.kill();
  }
});
