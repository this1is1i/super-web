const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const path = require("node:path");
const WebSocket = require("ws");

let nextPort = 22000 + (process.pid % 1000);

class TestClient {
  constructor(socket) {
    this.socket = socket;
    this.messages = [];
    this.waiters = [];
    socket.on("message", (raw) => this.push(JSON.parse(raw.toString())));
  }

  push(message) {
    const waiterIndex = this.waiters.findIndex((waiter) => waiter.matches(message));
    if (waiterIndex !== -1) {
      const waiter = this.waiters.splice(waiterIndex, 1)[0];
      clearTimeout(waiter.timer);
      waiter.resolve(message);
      return;
    }
    this.messages.push(message);
  }

  next(type, predicate = () => true, timeoutMs = 3000) {
    const matches = (message) => message.type === type && predicate(message);
    const queuedIndex = this.messages.findIndex(matches);
    if (queuedIndex !== -1) return Promise.resolve(this.messages.splice(queuedIndex, 1)[0]);
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

  terminate() {
    this.socket.terminate();
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

async function createStartedRoom(url) {
  const first = await connect(url);
  const second = await connect(url);
  first.send({
    type: "create_room",
    rule_config: { boardVariant: "normal", swapEvery: 1 },
  });
  const created = await first.next("room_created");
  second.send({ type: "join_room", room_id: created.room_id });
  const [firstStart, secondStart] = await Promise.all([
    first.next("game_start"), second.next("game_start"),
  ]);
  return { first, second, created, firstStart, secondStart };
}

function assertCredentials(message) {
  assert.match(message.session_id, /^[0-9a-f-]{36}$/i);
  assert.match(message.resume_token, /^[0-9a-f]{64}$/i);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

test("a dropped member resumes the same seat with authoritative game state and chat history", async () => {
  const { child, url } = await startServer({ RECONNECT_GRACE_MS: "1000" });
  const clients = [];
  try {
    const room = await createStartedRoom(url);
    clients.push(room.first, room.second);
    assertCredentials(room.created);
    assertCredentials(room.firstStart);
    assertCredentials(room.secondStart);

    room.first.send({
      type: "make_move",
      room_id: room.created.room_id,
      client_move_id: "resume-state-move",
      state_version: 0,
      move: { position: 4, cell_index: 0 },
    });
    await Promise.all([room.first.next("turn_applied"), room.second.next("turn_applied")]);

    room.first.send({
      type: "chat_send",
      room_id: room.created.room_id,
      client_message_id: "before-drop",
      content: { kind: "text", text: "still here" },
    });
    await Promise.all([room.first.next("chat_message"), room.second.next("chat_message")]);

    room.second.terminate();
    const temporary = await room.first.next("player_temporarily_disconnected");
    assert.equal(temporary.player_symbol, "O");
    assert.ok(temporary.reconnect_deadline > Date.now());

    const replacement = await connect(url);
    clients.push(replacement);
    replacement.send({
      type: "resume_session",
      session_id: room.secondStart.session_id,
      resume_token: room.secondStart.resume_token,
    });
    const resumed = await replacement.next("session_resumed");
    assert.equal(resumed.room_id, room.created.room_id);
    assert.equal(resumed.player_symbol, "O");
    assert.equal(resumed.is_your_turn, true);
    assert.equal(resumed.game_state.boards[4].cells[0], "X");
    assert.equal(resumed.game_state.currentBoard, 0);
    assert.equal(resumed.chat_history.length, 1);
    assert.equal(resumed.chat_history[0].content.text, "still here");
    assert.equal(resumed.chat_history[0].client_message_id, "before-drop");
    assert.equal(resumed.session_id, room.secondStart.session_id);
    assert.notEqual(resumed.resume_token, room.secondStart.resume_token);
    assert.equal((await room.first.next("player_reconnected")).player_symbol, "O");

    const replay = await connect(url);
    clients.push(replay);
    replay.send({
      type: "resume_session",
      session_id: room.secondStart.session_id,
      resume_token: room.secondStart.resume_token,
    });
    assert.equal((await replay.next("session_error")).code, "INVALID_RESUME_TOKEN");
  } finally {
    await stopServer(child, clients);
  }
});

test("the previous resume token survives one lost session_resumed response", async () => {
  const { child, url } = await startServer({ RECONNECT_GRACE_MS: "1000" });
  const clients = [];
  try {
    const room = await createStartedRoom(url);
    clients.push(room.first, room.second);
    room.second.terminate();
    await room.first.next("player_temporarily_disconnected");

    const lostResponseConnection = await connect(url);
    clients.push(lostResponseConnection);
    lostResponseConnection.send({
      type: "resume_session",
      session_id: room.secondStart.session_id,
      resume_token: room.secondStart.resume_token,
    });
    const lostResponse = await lostResponseConnection.next("session_resumed");
    assert.notEqual(lostResponse.resume_token, room.secondStart.resume_token);
    lostResponseConnection.terminate();
    await room.first.next("player_temporarily_disconnected");

    const retry = await connect(url);
    clients.push(retry);
    retry.send({
      type: "resume_session",
      session_id: room.secondStart.session_id,
      resume_token: room.secondStart.resume_token,
    });
    const recovered = await retry.next("session_resumed");
    assert.equal(recovered.session_id, room.secondStart.session_id);
    assert.notEqual(recovered.resume_token, room.secondStart.resume_token);
    assert.notEqual(recovered.resume_token, lostResponse.resume_token);
  } finally {
    await stopServer(child, clients);
  }
});

test("confirm_resume clears the fallback token after the client stores the rotated token", async () => {
  const { child, url } = await startServer({ RECONNECT_GRACE_MS: "1000" });
  const clients = [];
  try {
    const room = await createStartedRoom(url);
    clients.push(room.first, room.second);
    room.second.terminate();
    await room.first.next("player_temporarily_disconnected");

    const replacement = await connect(url);
    clients.push(replacement);
    replacement.send({
      type: "resume_session",
      session_id: room.secondStart.session_id,
      resume_token: room.secondStart.resume_token,
    });
    const resumed = await replacement.next("session_resumed");

    replacement.send({
      type: "confirm_resume",
      session_id: resumed.session_id,
      resume_token: room.secondStart.resume_token,
    });
    assert.equal((await replacement.next("session_error")).code, "INVALID_RESUME_CONFIRMATION");

    replacement.send({
      type: "confirm_resume",
      session_id: resumed.session_id,
      resume_token: resumed.resume_token,
    });
    const confirmed = await replacement.next("resume_confirmed");
    assert.equal(confirmed.session_id, resumed.session_id);

    replacement.terminate();
    await room.first.next("player_temporarily_disconnected");
    const retry = await connect(url);
    clients.push(retry);
    retry.send({
      type: "resume_session",
      session_id: resumed.session_id,
      resume_token: room.secondStart.resume_token,
    });
    assert.equal((await retry.next("session_error")).code, "INVALID_RESUME_TOKEN");

    retry.send({
      type: "resume_session",
      session_id: resumed.session_id,
      resume_token: resumed.resume_token,
    });
    assert.equal((await retry.next("session_resumed")).session_id, resumed.session_id);
  } finally {
    await stopServer(child, clients);
  }
});

test("the room is released after the reconnect grace period expires", async () => {
  const { child, url } = await startServer({ RECONNECT_GRACE_MS: "120" });
  const clients = [];
  try {
    const room = await createStartedRoom(url);
    clients.push(room.first, room.second);
    room.second.terminate();
    await room.first.next("player_temporarily_disconnected");
    await room.first.next("player_disconnected");

    const replacement = await connect(url);
    clients.push(replacement);
    replacement.send({
      type: "resume_session",
      session_id: room.secondStart.session_id,
      resume_token: room.secondStart.resume_token,
    });
    assert.equal((await replacement.next("session_error")).code, "SESSION_NOT_FOUND");

    const joiner = await connect(url);
    clients.push(joiner);
    joiner.send({ type: "join_room", room_id: room.created.room_id });
    assert.match((await joiner.next("error")).message, /房间不存在/);
  } finally {
    await stopServer(child, clients);
  }
});

test("leave_room bypasses the grace period and invalidates the room immediately", async () => {
  const { child, url } = await startServer({ RECONNECT_GRACE_MS: "1000" });
  const clients = [];
  try {
    const room = await createStartedRoom(url);
    clients.push(room.first, room.second);
    room.first.send({ type: "leave_room", room_id: room.created.room_id });
    assert.equal((await room.second.next("player_disconnected")).type, "player_disconnected");

    const replacement = await connect(url);
    clients.push(replacement);
    replacement.send({
      type: "resume_session",
      session_id: room.firstStart.session_id,
      resume_token: room.firstStart.resume_token,
    });
    assert.equal((await replacement.next("session_error")).code, "SESSION_NOT_FOUND");

    const joiner = await connect(url);
    clients.push(joiner);
    joiner.send({ type: "join_room", room_id: room.created.room_id });
    assert.match((await joiner.next("error")).message, /房间不存在/);
  } finally {
    await stopServer(child, clients);
  }
});

test("one websocket cannot create twice or join its own room and swap remains safe", async () => {
  const { child, url } = await startServer();
  const clients = [];
  try {
    const client = await connect(url);
    clients.push(client);
    client.send({
      type: "create_room",
      rule_config: { boardVariant: "normal", swapEvery: 1 },
    });
    const created = await client.next("room_created");

    client.send({
      type: "create_room",
      rule_config: { boardVariant: "normal", swapEvery: 1 },
    });
    assert.equal((await client.next("error")).code, "CONNECTION_ALREADY_BOUND");

    client.send({ type: "join_room", room_id: created.room_id });
    client.send({ type: "request_swap", room_id: created.room_id });
    assert.equal((await client.next("error")).code, "CONNECTION_ALREADY_BOUND");
    assert.equal((await client.next("swap_unavailable")).type, "swap_unavailable");
  } finally {
    await stopServer(child, clients);
  }
});

test("destroying a room unbinds the surviving websocket so it can create again", async () => {
  const { child, url } = await startServer();
  const clients = [];
  try {
    const room = await createStartedRoom(url);
    clients.push(room.first, room.second);
    room.first.send({ type: "leave_room", room_id: room.created.room_id });
    await room.second.next("player_disconnected");
    room.second.send({
      type: "create_room",
      rule_config: { boardVariant: "normal", swapEvery: 1 },
    });
    const recreated = await room.second.next("room_created");
    assert.notEqual(recreated.room_id, room.created.room_id);
    assert.equal(recreated.player_symbol, "X");
  } finally {
    await stopServer(child, clients);
  }
});

test("a websocket already bound to one player cannot take over another offline seat", async () => {
  const { child, url } = await startServer({ RECONNECT_GRACE_MS: "1000" });
  const clients = [];
  try {
    const room = await createStartedRoom(url);
    clients.push(room.first, room.second);
    room.second.terminate();
    await room.first.next("player_temporarily_disconnected");

    room.first.send({
      type: "resume_session",
      session_id: room.secondStart.session_id,
      resume_token: room.secondStart.resume_token,
    });
    assert.equal((await room.first.next("session_error")).code, "SESSION_CONNECTION_IN_USE");
  } finally {
    await stopServer(child, clients);
  }
});

test("reset_game requires room membership and both players online", async () => {
  const { child, url } = await startServer({ RECONNECT_GRACE_MS: "1000" });
  const clients = [];
  try {
    const room = await createStartedRoom(url);
    const outsider = await connect(url);
    clients.push(room.first, room.second, outsider);

    room.first.send({
      type: "make_move",
      room_id: room.created.room_id,
      client_move_id: "reset-auth-move",
      state_version: 0,
      move: { position: 4, cell_index: 0 },
    });
    await Promise.all([room.first.next("turn_applied"), room.second.next("turn_applied")]);

    outsider.send({ type: "reset_game", room_id: room.created.room_id });
    assert.equal((await outsider.next("error")).code, "NOT_ROOM_MEMBER");
    await Promise.all([room.first.expectNo("game_reset"), room.second.expectNo("game_reset")]);

    room.second.terminate();
    await room.first.next("player_temporarily_disconnected");
    room.first.send({ type: "reset_game", room_id: room.created.room_id });
    assert.equal((await room.first.next("error")).code, "PLAYERS_OFFLINE");
    await room.first.expectNo("game_reset");

    const replacement = await connect(url);
    clients.push(replacement);
    replacement.send({
      type: "resume_session",
      session_id: room.secondStart.session_id,
      resume_token: room.secondStart.resume_token,
    });
    const resumed = await replacement.next("session_resumed");
    assert.equal(resumed.game_state.boards[4].cells[0], "X");
  } finally {
    await stopServer(child, clients);
  }
});

test("chat rate limits follow the player session across reconnects", async () => {
  const { child, url } = await startServer({ RECONNECT_GRACE_MS: "1000" });
  const clients = [];
  try {
    const room = await createStartedRoom(url);
    clients.push(room.first, room.second);
    for (let index = 0; index < 5; index++) {
      room.first.send({
        type: "chat_send",
        room_id: room.created.room_id,
        content: { kind: "text", text: `limited-${index}` },
      });
      await Promise.all([room.first.next("chat_message"), room.second.next("chat_message")]);
    }

    room.first.terminate();
    await room.second.next("player_temporarily_disconnected");
    const replacement = await connect(url);
    clients.push(replacement);
    replacement.send({
      type: "resume_session",
      session_id: room.firstStart.session_id,
      resume_token: room.firstStart.resume_token,
    });
    await replacement.next("session_resumed");

    replacement.send({
      type: "chat_send",
      room_id: room.created.room_id,
      content: { kind: "text", text: "must remain limited" },
    });
    assert.equal((await replacement.next("chat_error")).code, "CHAT_RATE_LIMITED");
    await room.second.expectNo("chat_message", 300);
  } finally {
    await stopServer(child, clients);
  }
});

test("messages sent while the opponent is offline are recovered from room history", async () => {
  const { child, url } = await startServer({ RECONNECT_GRACE_MS: "1000" });
  const clients = [];
  try {
    const room = await createStartedRoom(url);
    clients.push(room.first, room.second);
    room.second.terminate();
    await room.first.next("player_temporarily_disconnected");

    room.first.send({
      type: "chat_send",
      room_id: room.created.room_id,
      client_message_id: "while-offline",
      content: { kind: "text", text: "queued in history" },
    });
    await room.first.next("chat_message");

    const replacement = await connect(url);
    clients.push(replacement);
    replacement.send({
      type: "resume_session",
      session_id: room.secondStart.session_id,
      resume_token: room.secondStart.resume_token,
    });
    const resumed = await replacement.next("session_resumed");
    assert.equal(resumed.chat_history.length, 1);
    assert.equal(resumed.chat_history[0].client_message_id, "while-offline");
    assert.equal(resumed.chat_history[0].content.text, "queued in history");
  } finally {
    await stopServer(child, clients);
  }
});

test("resumed chat history keeps only the latest 100 messages", async () => {
  const { child, url } = await startServer({
    RECONNECT_GRACE_MS: "1000",
    CHAT_RATE_WINDOW_MS: "1",
    CHAT_TEXT_RATE_MAX: "500",
  });
  const clients = [];
  try {
    const room = await createStartedRoom(url);
    clients.push(room.first, room.second);
    for (let index = 0; index < 101; index++) {
      room.first.send({
        type: "chat_send",
        room_id: room.created.room_id,
        client_message_id: `history-${index}`,
        content: { kind: "text", text: `message-${index}` },
      });
      await Promise.all([room.first.next("chat_message"), room.second.next("chat_message")]);
      await delay(60);
    }

    room.second.terminate();
    await room.first.next("player_temporarily_disconnected");
    const replacement = await connect(url);
    clients.push(replacement);
    replacement.send({
      type: "resume_session",
      session_id: room.secondStart.session_id,
      resume_token: room.secondStart.resume_token,
    });
    const resumed = await replacement.next("session_resumed");
    assert.equal(resumed.chat_history.length, 100);
    assert.equal(resumed.chat_history[0].content.text, "message-1");
    assert.equal(resumed.chat_history[99].content.text, "message-100");

    room.first.send({
      type: "chat_send",
      room_id: room.created.room_id,
      client_message_id: "history-0",
      content: { kind: "text", text: "must not return" },
    });
    assert.equal((await room.first.next("chat_error")).code, "DUPLICATE_MESSAGE_EVICTED");
    await replacement.expectNo("chat_message", 300);
  } finally {
    await stopServer(child, clients);
  }
});

test("resumed chat history evicts oldest images when payloads exceed 10 MiB", async () => {
  const { child, url } = await startServer({
    RECONNECT_GRACE_MS: "1000",
    CHAT_RATE_WINDOW_MS: "1",
    CHAT_IMAGE_RATE_MAX: "100",
  });
  const clients = [];
  try {
    const room = await createStartedRoom(url);
    clients.push(room.first, room.second);
    const image = Buffer.concat([
      Buffer.from("89504e470d0a1a0a", "hex"),
      Buffer.alloc(512000 - 8),
    ]).toString("base64");
    const deliveredIds = [];
    for (let index = 0; index < 21; index++) {
      room.first.send({
        type: "chat_send",
        room_id: room.created.room_id,
        content: { kind: "image", mime: "image/png", data: image },
      });
      const [, delivered] = await Promise.all([
        room.first.next("chat_message", () => true, 10000),
        room.second.next("chat_message", () => true, 10000),
      ]);
      deliveredIds.push(delivered.id);
      await delay(60);
    }

    room.second.terminate();
    await room.first.next("player_temporarily_disconnected");
    const replacement = await connect(url);
    clients.push(replacement);
    replacement.send({
      type: "resume_session",
      session_id: room.secondStart.session_id,
      resume_token: room.secondStart.resume_token,
    });
    const resumed = await replacement.next("session_resumed", () => true, 10000);
    assert.equal(resumed.chat_history.length, 20);
    assert.equal(resumed.chat_history[0].id, deliveredIds[1]);
    assert.equal(resumed.chat_history[19].id, deliveredIds[20]);
  } finally {
    await stopServer(child, clients);
  }
});
