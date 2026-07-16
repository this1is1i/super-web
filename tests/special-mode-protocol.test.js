const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const path = require("node:path");
const WebSocket = require("ws");

let nextPort = 23000 + (process.pid % 1000);

class TestClient {
  constructor(socket) {
    this.socket = socket;
    this.messages = [];
    this.waiters = [];
    socket.on("message", (raw) => this.push(JSON.parse(raw.toString())));
  }

  push(message) {
    const index = this.waiters.findIndex((waiter) => waiter.matches(message));
    if (index !== -1) {
      const waiter = this.waiters.splice(index, 1)[0];
      clearTimeout(waiter.timer);
      waiter.resolve(message);
      return;
    }
    this.messages.push(message);
  }

  next(type, predicate = () => true, timeoutMs = 3000) {
    const matches = (message) => message.type === type && predicate(message);
    const index = this.messages.findIndex(matches);
    if (index !== -1) return Promise.resolve(this.messages.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = { matches, resolve, timer: null };
      waiter.timer = setTimeout(() => {
        this.waiters = this.waiters.filter((item) => item !== waiter);
        reject(new Error(`Timed out waiting for ${type}`));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  async expectNo(type, timeoutMs = 150) {
    await assert.rejects(this.next(type, () => true, timeoutMs), /Timed out/);
  }

  send(message) {
    this.socket.send(JSON.stringify(message));
  }

  close() {
    if (this.socket.readyState < WebSocket.CLOSING) this.socket.close();
  }
}

function waitForServer(child) {
  return new Promise((resolve, reject) => {
    child.testOutput = "";
    const timer = setTimeout(() => reject(new Error(`Server did not start: ${child.testOutput}`)), 5000);
    child.stdout.on("data", (chunk) => {
      child.testOutput += chunk.toString();
      if (child.testOutput.includes("超级井字棋已启动")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.stderr.on("data", (chunk) => { child.testOutput += chunk.toString(); });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Server exited early with ${code}: ${child.testOutput}`));
    });
  });
}

async function startServer(extraEnv = {}) {
  const port = nextPort++;
  const root = path.resolve(__dirname, "..");
  const child = spawn(process.execPath, ["js/server.js"], {
    cwd: root,
    env: { ...process.env, PORT: String(port), NODE_ENV: "production", ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await waitForServer(child);
  return { child, url: `ws://127.0.0.1:${port}` };
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.once("open", () => resolve(new TestClient(socket)));
    socket.once("error", reject);
  });
}

async function createStartedRoom(url, ruleConfig = NORMAL_CONFIG) {
  const first = await connect(url);
  const second = await connect(url);
  first.send({ type: "create_room", rule_config: ruleConfig });
  const created = await first.next("room_created");
  second.send({ type: "join_room", room_id: created.room_id });
  const [firstStart, secondStart] = await Promise.all([
    first.next("game_start"), second.next("game_start"),
  ]);
  return { first, second, created, firstStart, secondStart };
}

async function stopServer(child, clients) {
  clients.forEach((client) => client && client.close());
  if (child.exitCode !== null) return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Server did not exit within 2 seconds")), 2000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill();
  });
}

const NORMAL_CONFIG = Object.freeze({ boardVariant: "normal", swapEvery: 1 });

test("create_room strictly validates rule_config without binding failed attempts", async () => {
  const { child, url } = await startServer();
  const clients = [];
  try {
    const client = await connect(url);
    clients.push(client);
    const invalidConfigs = [
      undefined,
      null,
      [],
      { boardVariant: "random", swapEvery: 1 },
      { boardVariant: "cycle", swapEvery: 0 },
      { boardVariant: "chaos", swapEvery: 1.5 },
      { boardVariant: "normal", swapEvery: 21 },
      { boardVariant: "normal", swapEvery: 1, extra: true },
    ];
    for (const ruleConfig of invalidConfigs) {
      const request = { type: "create_room" };
      if (ruleConfig !== undefined) request.rule_config = ruleConfig;
      client.send(request);
      const error = await client.next("error");
      assert.equal(error.code, "INVALID_RULE_CONFIG");
    }

    client.send({ type: "create_room", rule_config: NORMAL_CONFIG });
    const created = await client.next("room_created");
    assert.deepEqual(created.rule_config, NORMAL_CONFIG);
    assert.equal(created.state_version, 0);
    assert.equal(created.game_state.boardVariant, "normal");
    assert.equal(created.game_state.swapEvery, 1);
    assert.deepEqual(created.game_state.positionToTile, [0, 1, 2, 3, 4, 5, 6, 7, 8]);
  } finally {
    await stopServer(child, clients);
  }
});

test("joiners inherit the room owner's rule_config and authoritative state", async () => {
  const { child, url } = await startServer();
  const clients = [];
  try {
    const owner = await connect(url);
    const joiner = await connect(url);
    clients.push(owner, joiner);
    const config = { boardVariant: "cycle", swapEvery: 2 };
    owner.send({ type: "create_room", rule_config: config });
    const created = await owner.next("room_created");
    joiner.send({
      type: "join_room",
      room_id: created.room_id,
      rule_config: { boardVariant: "chaos", swapEvery: 1 },
    });
    const [ownerStart, joinerStart] = await Promise.all([
      owner.next("game_start"), joiner.next("game_start"),
    ]);
    for (const message of [created, ownerStart, joinerStart]) {
      assert.deepEqual(message.rule_config, config);
      assert.equal(message.state_version, 0);
      assert.equal(message.game_state.boardVariant, "cycle");
      assert.equal(message.game_state.swapEvery, 2);
      assert.equal(message.game_state.moveCount, 0);
      assert.deepEqual(message.game_state.positionToTile, [0, 1, 2, 3, 4, 5, 6, 7, 8]);
    }
  } finally {
    await stopServer(child, clients);
  }
});

test("make_move rejects unauthorized stale malformed and illegal requests atomically", async () => {
  const { child, url } = await startServer();
  const clients = [];
  try {
    const room = await createStartedRoom(url);
    const outsider = await connect(url);
    clients.push(room.first, room.second, outsider);
    const validMove = {
      type: "make_move",
      room_id: room.created.room_id,
      client_move_id: "move-1",
      state_version: 0,
      move: { position: 4, cell_index: 0 },
    };

    outsider.send(validMove);
    assert.equal((await outsider.next("error")).code, "NOT_ROOM_MEMBER");

    room.first.send({ ...validMove, client_move_id: "stale", state_version: 1 });
    assert.equal((await room.first.next("error")).code, "STATE_VERSION_MISMATCH");

    room.first.send({ ...validMove, client_move_id: "" });
    assert.equal((await room.first.next("error")).code, "INVALID_CLIENT_MOVE_ID");

    room.first.send({ ...validMove, client_move_id: "bad-shape", move: { position: "4", cell_index: 0 } });
    assert.equal((await room.first.next("error")).code, "INVALID_MOVE");

    room.second.send({ ...validMove, client_move_id: "wrong-player" });
    assert.equal((await room.second.next("error")).code, "NOT_YOUR_TURN");

    room.first.send({ ...validMove, client_move_id: "illegal", move: { position: 0, cell_index: 0 } });
    assert.equal((await room.first.next("error")).code, "ILLEGAL_MOVE");

    room.first.send(validMove);
    const [firstApplied, secondApplied] = await Promise.all([
      room.first.next("turn_applied"), room.second.next("turn_applied"),
    ]);
    assert.deepEqual(firstApplied, secondApplied);
    assert.equal(firstApplied.client_move_id, "move-1");
    assert.equal(firstApplied.state_version, 1);
    assert.deepEqual(firstApplied.turn, {
      position: 4,
      cellIndex: 0,
      symbol: "X",
      exchangePair: null,
    });
    assert.deepEqual(firstApplied.result, { exchange: null, gameOver: false });
    await Promise.all([room.first.expectNo("move_made"), room.second.expectNo("move_made")]);
  } finally {
    await stopServer(child, clients);
  }
});

test("make_move rejects play while the opponent is temporarily offline", async () => {
  const { child, url } = await startServer({ RECONNECT_GRACE_MS: "1000" });
  const clients = [];
  try {
    const room = await createStartedRoom(url);
    clients.push(room.first, room.second);
    room.second.socket.terminate();
    await room.first.next("player_temporarily_disconnected");
    room.first.send({
      type: "make_move",
      room_id: room.created.room_id,
      client_move_id: "offline-move",
      state_version: 0,
      move: { position: 4, cell_index: 0 },
    });
    assert.equal((await room.first.next("error")).code, "PLAYERS_OFFLINE");
    await room.first.expectNo("turn_applied");
  } finally {
    await stopServer(child, clients);
  }
});

test("cycle mode derives the first fixed exchange pair when swapEvery is 1", async () => {
  const { child, url } = await startServer();
  const clients = [];
  try {
    const room = await createStartedRoom(url, { boardVariant: "cycle", swapEvery: 1 });
    clients.push(room.first, room.second);
    room.first.send({
      type: "make_move",
      room_id: room.created.room_id,
      client_move_id: "cycle-first",
      state_version: 0,
      move: { position: 4, cell_index: 0 },
    });
    const [firstApplied, secondApplied] = await Promise.all([
      room.first.next("turn_applied"), room.second.next("turn_applied"),
    ]);
    assert.deepEqual(firstApplied, secondApplied);
    assert.deepEqual(firstApplied.turn.exchangePair, [0, 1]);
    assert.deepEqual(firstApplied.result.exchange, [0, 1]);
    assert.equal(firstApplied.state_version, 1);
  } finally {
    await stopServer(child, clients);
  }
});

test("cycle mode waits until the second successful turn when swapEvery is 2", async () => {
  const { child, url } = await startServer();
  const clients = [];
  try {
    const room = await createStartedRoom(url, { boardVariant: "cycle", swapEvery: 2 });
    clients.push(room.first, room.second);
    room.first.send({
      type: "make_move",
      room_id: room.created.room_id,
      client_move_id: "cycle-1",
      state_version: 0,
      move: { position: 4, cell_index: 0 },
    });
    const [, firstTurn] = await Promise.all([
      room.first.next("turn_applied"), room.second.next("turn_applied"),
    ]);
    assert.equal(firstTurn.result.exchange, null);

    room.second.send({
      type: "make_move",
      room_id: room.created.room_id,
      client_move_id: "cycle-2",
      state_version: 1,
      move: { position: 0, cell_index: 1 },
    });
    const [ownerCopy, secondTurn] = await Promise.all([
      room.first.next("turn_applied"), room.second.next("turn_applied"),
    ]);
    assert.deepEqual(ownerCopy, secondTurn);
    assert.deepEqual(secondTurn.turn.exchangePair, [0, 1]);
    assert.deepEqual(secondTurn.result.exchange, [0, 1]);
    assert.equal(secondTurn.state_version, 2);
  } finally {
    await stopServer(child, clients);
  }
});

test("chaos mode broadcasts one authoritative legal random exchange pair", async () => {
  const { child, url } = await startServer();
  const clients = [];
  try {
    const room = await createStartedRoom(url, { boardVariant: "chaos", swapEvery: 1 });
    clients.push(room.first, room.second);
    room.first.send({
      type: "make_move",
      room_id: room.created.room_id,
      client_move_id: "chaos-first",
      state_version: 0,
      move: { position: 4, cell_index: 0 },
    });
    const [firstApplied, secondApplied] = await Promise.all([
      room.first.next("turn_applied"), room.second.next("turn_applied"),
    ]);
    assert.deepEqual(firstApplied, secondApplied);
    const pair = firstApplied.turn.exchangePair;
    assert.equal(Array.isArray(pair), true);
    assert.equal(pair.length, 2);
    assert.ok(pair.every((position) => Number.isInteger(position) && position >= 0 && position < 9));
    assert.notEqual(pair[0], pair[1]);
    assert.deepEqual(firstApplied.result.exchange, pair);
    await Promise.all([room.first.expectNo("move_made"), room.second.expectNo("move_made")]);
  } finally {
    await stopServer(child, clients);
  }
});

test("duplicate client_move_id acknowledges the original turn without applying or broadcasting twice", async () => {
  const { child, url } = await startServer();
  const clients = [];
  try {
    const room = await createStartedRoom(url, { boardVariant: "cycle", swapEvery: 1 });
    clients.push(room.first, room.second);
    const request = {
      type: "make_move",
      room_id: room.created.room_id,
      client_move_id: "idempotent-cycle",
      state_version: 0,
      move: { position: 4, cell_index: 0 },
    };
    room.first.send(request);
    const [original] = await Promise.all([
      room.first.next("turn_applied"), room.second.next("turn_applied"),
    ]);
    assert.deepEqual(original.result.exchange, [0, 1]);

    room.first.send(request);
    assert.deepEqual(await room.first.next("turn_applied"), original);
    await room.second.expectNo("turn_applied", 300);

    room.first.send({ ...request, client_move_id: "new-stale-id" });
    const stale = await room.first.next("error");
    assert.equal(stale.code, "STATE_VERSION_MISMATCH");
    assert.equal(stale.state_version, 1);
    await room.second.expectNo("turn_applied", 300);
  } finally {
    await stopServer(child, clients);
  }
});

test("duplicate client_move_id is replayed while the opponent is offline without changing state", async () => {
  const { child, url } = await startServer();
  const clients = [];
  try {
    const room = await createStartedRoom(url, NORMAL_CONFIG);
    clients.push(room.first, room.second);
    const request = {
      type: "make_move",
      room_id: room.created.room_id,
      client_move_id: "replay-while-offline",
      state_version: 0,
      move: { position: 4, cell_index: 0 },
    };
    room.first.send(request);
    const [original] = await Promise.all([
      room.first.next("turn_applied"), room.second.next("turn_applied"),
    ]);

    room.second.socket.terminate();
    await room.first.next("player_temporarily_disconnected");

    room.first.send(request);
    assert.deepEqual(await room.first.next("turn_applied"), original);

    room.first.send({
      ...request,
      client_move_id: "new-id-while-offline",
      state_version: 1,
    });
    assert.equal((await room.first.next("error")).code, "PLAYERS_OFFLINE");

    const replacement = await connect(url);
    clients.push(replacement);
    replacement.send({
      type: "resume_session",
      session_id: room.secondStart.session_id,
      resume_token: room.secondStart.resume_token,
    });
    const resumed = await replacement.next("session_resumed");
    assert.equal(resumed.state_version, 1);
    assert.equal(resumed.game_state.moveCount, 1);
    assert.equal(resumed.game_state.tiles[4].cells[0], "X");
    await Promise.all([
      room.first.expectNo("turn_applied", 300),
      replacement.expectNo("turn_applied", 300),
    ]);
  } finally {
    await stopServer(child, clients);
  }
});

test("reset_game preserves rule_config while resetting state version mapping schedule and move dedupe", async () => {
  const { child, url } = await startServer();
  const clients = [];
  try {
    const config = { boardVariant: "cycle", swapEvery: 1 };
    const room = await createStartedRoom(url, config);
    clients.push(room.first, room.second);
    const move = {
      type: "make_move",
      room_id: room.created.room_id,
      client_move_id: "reusable-after-reset",
      state_version: 0,
      move: { position: 4, cell_index: 0 },
    };
    room.first.send(move);
    await Promise.all([room.first.next("turn_applied"), room.second.next("turn_applied")]);

    room.first.send({ type: "reset_game", room_id: room.created.room_id });
    const [firstReset, secondReset] = await Promise.all([
      room.first.next("game_reset"), room.second.next("game_reset"),
    ]);
    for (const reset of [firstReset, secondReset]) {
      assert.deepEqual(reset.rule_config, config);
      assert.equal(reset.state_version, 0);
      assert.equal(reset.game_state.boardVariant, "cycle");
      assert.equal(reset.game_state.swapEvery, 1);
      assert.equal(reset.game_state.moveCount, 0);
      assert.equal(reset.game_state.cycleCursor, 0);
      assert.equal(reset.game_state.currentPosition, 4);
      assert.deepEqual(reset.game_state.positionToTile, [0, 1, 2, 3, 4, 5, 6, 7, 8]);
      assert.ok(reset.game_state.tiles.every((tile) => tile.cells.every((cell) => cell === null)));
    }

    room.first.send(move);
    const [firstApplied, secondApplied] = await Promise.all([
      room.first.next("turn_applied"), room.second.next("turn_applied"),
    ]);
    assert.deepEqual(firstApplied, secondApplied);
    assert.equal(firstApplied.state_version, 1);
    assert.deepEqual(firstApplied.result.exchange, [0, 1]);
  } finally {
    await stopServer(child, clients);
  }
});

test("session_resumed restores special rule_config state_version and exchanged authoritative state", async () => {
  const { child, url } = await startServer({ RECONNECT_GRACE_MS: "1000" });
  const clients = [];
  try {
    const config = { boardVariant: "chaos", swapEvery: 1 };
    const room = await createStartedRoom(url, config);
    clients.push(room.first, room.second);
    room.first.send({
      type: "make_move",
      room_id: room.created.room_id,
      client_move_id: "before-special-resume",
      state_version: 0,
      move: { position: 4, cell_index: 0 },
    });
    const [, applied] = await Promise.all([
      room.first.next("turn_applied"), room.second.next("turn_applied"),
    ]);
    const expectedMapping = [0, 1, 2, 3, 4, 5, 6, 7, 8];
    const pair = applied.result.exchange;
    [expectedMapping[pair[0]], expectedMapping[pair[1]]] =
      [expectedMapping[pair[1]], expectedMapping[pair[0]]];

    room.second.socket.terminate();
    await room.first.next("player_temporarily_disconnected");
    const replacement = await connect(url);
    clients.push(replacement);
    replacement.send({
      type: "resume_session",
      session_id: room.secondStart.session_id,
      resume_token: room.secondStart.resume_token,
    });
    const resumed = await replacement.next("session_resumed");
    assert.deepEqual(resumed.rule_config, config);
    assert.equal(resumed.state_version, 1);
    assert.equal(resumed.game_state.boardVariant, "chaos");
    assert.equal(resumed.game_state.swapEvery, 1);
    assert.equal(resumed.game_state.moveCount, 1);
    assert.deepEqual(resumed.game_state.positionToTile, expectedMapping);
    assert.equal(resumed.game_state.tiles[4].cells[0], "X");
  } finally {
    await stopServer(child, clients);
  }
});
