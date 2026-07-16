const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const path = require("node:path");
const WebSocket = require("ws");

let nextPort = 21000 + (process.pid % 1000);

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

  sendRaw(message) {
    this.socket.send(message);
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

test("chat text is server-authored and broadcast exactly once to both room members", async () => {
  const { child, url } = await startServer();
  const clients = [];
  try {
    const room = await createStartedRoom(url);
    clients.push(room.first, room.second);
    room.first.send({
      type: "chat_send",
      room_id: room.created.room_id,
      client_message_id: "local-1",
      sender_symbol: "O",
      sent_at: 1,
      content: { kind: "text", text: "  hello  " },
    });

    const [senderCopy, recipientCopy] = await Promise.all([
      room.first.next("chat_message"), room.second.next("chat_message"),
    ]);
    assert.deepEqual(senderCopy, recipientCopy);
    assert.equal(senderCopy.room_id, room.created.room_id);
    assert.equal(senderCopy.client_message_id, "local-1");
    assert.equal(senderCopy.sender_symbol, "X");
    assert.equal(senderCopy.content.kind, "text");
    assert.equal(senderCopy.content.text, "hello");
    assert.match(senderCopy.id, /^[0-9a-f-]{36}$/i);
    assert.ok(Number.isInteger(senderCopy.sent_at));
    await Promise.all([room.first.expectNo("chat_message"), room.second.expectNo("chat_message")]);
  } finally {
    await stopServer(child, clients);
  }
});

test("non-object JSON and malformed frames are rejected without crashing or logging payloads", async () => {
  const { child, url } = await startServer();
  const clients = [];
  try {
    const client = await connect(url);
    clients.push(client);
    for (const frame of ["null", "[]", "42", '"text"']) {
      client.sendRaw(frame);
      assert.equal((await client.next("error")).code, "INVALID_MESSAGE");
    }

    client.sendRaw('{"secret":"SENSITIVE_FRAME",');
    assert.equal((await client.next("error")).code, "INVALID_JSON");
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.doesNotMatch(child.testOutput, /SENSITIVE_FRAME/);

    client.send({
      type: "create_room",
      rule_config: { boardVariant: "normal", swapEvery: 1 },
    });
    assert.equal((await client.next("room_created")).player_symbol, "X");
  } finally {
    await stopServer(child, clients);
  }
});

test("repeating a client_message_id returns the original acknowledgement without rebroadcasting", async () => {
  const { child, url } = await startServer();
  const clients = [];
  try {
    const room = await createStartedRoom(url);
    clients.push(room.first, room.second);
    const firstSend = {
      type: "chat_send",
      room_id: room.created.room_id,
      client_message_id: "retry-1",
      content: { kind: "text", text: "original" },
    };
    room.first.send(firstSend);
    const [originalAck] = await Promise.all([
      room.first.next("chat_message"), room.second.next("chat_message"),
    ]);

    room.first.send({
      ...firstSend,
      content: { kind: "text", text: "must not replace original" },
    });
    const retryAck = await room.first.next("chat_message");
    assert.deepEqual(retryAck, originalAck);
    await room.second.expectNo("chat_message", 300);

    room.second.send(firstSend);
    const [firstCopy, secondCopy] = await Promise.all([
      room.first.next("chat_message"), room.second.next("chat_message"),
    ]);
    assert.equal(firstCopy.sender_symbol, "O");
    assert.deepEqual(firstCopy, secondCopy);
    assert.notEqual(firstCopy.id, originalAck.id);
  } finally {
    await stopServer(child, clients);
  }
});

test("chat dedupe uses an independent fixed-size LRU window for each player", async () => {
  const { child, url } = await startServer({
    CHAT_DEDUPE_MAX_IDS: "2",
    CHAT_TEXT_RATE_MAX: "20",
  });
  const clients = [];
  try {
    const room = await createStartedRoom(url);
    clients.push(room.first, room.second);

    async function sendNew(sender, clientMessageId, text) {
      sender.send({
        type: "chat_send",
        room_id: room.created.room_id,
        client_message_id: clientMessageId,
        content: { kind: "text", text },
      });
      const [firstCopy, secondCopy] = await Promise.all([
        room.first.next("chat_message"), room.second.next("chat_message"),
      ]);
      assert.deepEqual(firstCopy, secondCopy);
      return firstCopy;
    }

    const x1 = await sendNew(room.first, "x-1", "x first");
    const x2 = await sendNew(room.first, "x-2", "x second");
    const o1 = await sendNew(room.second, "o-1", "o independent first");
    assert.equal(o1.sender_symbol, "O");

    const x3 = await sendNew(room.first, "x-3", "x third evicts x-1");
    assert.equal(x3.sender_symbol, "X");

    room.first.send({
      type: "chat_send",
      room_id: room.created.room_id,
      client_message_id: "x-2",
      content: { kind: "text", text: "retry inside window" },
    });
    assert.deepEqual(await room.first.next("chat_message"), x2);
    await room.second.expectNo("chat_message", 300);

    const x1OutsideWindow = await sendNew(room.first, "x-1", "x first admitted again");
    assert.notEqual(x1OutsideWindow.id, x1.id);
    const o2 = await sendNew(room.second, "o-2", "o independent second");
    assert.equal(o2.sender_symbol, "O");
  } finally {
    await stopServer(child, clients);
  }
});

test("chat rejects non-members and text outside the 1-500 character boundary", async () => {
  const { child, url } = await startServer();
  const clients = [];
  try {
    const room = await createStartedRoom(url);
    const outsider = await connect(url);
    clients.push(room.first, room.second, outsider);

    outsider.send({
      type: "chat_send",
      room_id: room.created.room_id,
      content: { kind: "text", text: "intrusion" },
    });
    assert.equal((await outsider.next("chat_error")).code, "NOT_ROOM_MEMBER");
    await room.first.expectNo("chat_message");

    room.first.send({
      type: "chat_send",
      room_id: room.created.room_id,
      content: { kind: "text", text: "   " },
    });
    assert.equal((await room.first.next("chat_error")).code, "INVALID_TEXT");

    room.first.send({
      type: "chat_send",
      room_id: room.created.room_id,
      content: { kind: "text", text: "x".repeat(501) },
    });
    assert.equal((await room.first.next("chat_error")).code, "INVALID_TEXT");

    room.first.send({
      type: "chat_send",
      room_id: room.created.room_id,
      client_message_id: "boundary-500",
      content: { kind: "text", text: "x".repeat(500) },
    });
    assert.equal((await room.second.next("chat_message")).content.text.length, 500);
  } finally {
    await stopServer(child, clients);
  }
});

test("chat accepts signed JPEG PNG and WebP images and rejects mismatches or images over 512 KiB", async () => {
  const { child, url } = await startServer({ CHAT_IMAGE_RATE_MAX: "20" });
  const clients = [];
  try {
    const room = await createStartedRoom(url);
    clients.push(room.first, room.second);
    const fixtures = [
      ["image/jpeg", Buffer.from([0xff, 0xd8, 0xff, 0x00])],
      ["image/png", Buffer.from("89504e470d0a1a0a", "hex")],
      ["image/webp", Buffer.from("RIFF0000WEBP")],
    ];

    for (const [mime, bytes] of fixtures) {
      room.first.send({
        type: "chat_send",
        room_id: room.created.room_id,
        content: { kind: "image", mime, data: bytes.toString("base64") },
      });
      const delivered = await room.second.next("chat_message");
      assert.equal(delivered.content.kind, "image");
      assert.equal(delivered.content.mime, mime);
      assert.equal(delivered.content.data, bytes.toString("base64"));
    }

    room.first.send({
      type: "chat_send",
      room_id: room.created.room_id,
      content: {
        kind: "image",
        mime: "image/jpeg",
        data: Buffer.from("89504e470d0a1a0a", "hex").toString("base64"),
      },
    });
    assert.equal((await room.first.next("chat_error")).code, "INVALID_IMAGE");

    const oversizedPng = Buffer.concat([
      Buffer.from("89504e470d0a1a0a", "hex"),
      Buffer.alloc(512 * 1024 - 7),
    ]);
    room.first.send({
      type: "chat_send",
      room_id: room.created.room_id,
      content: { kind: "image", mime: "image/png", data: oversizedPng.toString("base64") },
    });
    assert.equal((await room.first.next("chat_error")).code, "IMAGE_TOO_LARGE");
  } finally {
    await stopServer(child, clients);
  }
});

test("chat uses a dedicated rate limit without turning chat failures into game errors", async () => {
  const { child, url } = await startServer();
  const clients = [];
  try {
    const room = await createStartedRoom(url);
    clients.push(room.first, room.second);
    for (let index = 0; index < 6; index++) {
      room.first.send({
        type: "chat_send",
        room_id: room.created.room_id,
        content: { kind: "text", text: `message-${index}` },
      });
    }
    const error = await room.first.next("chat_error", (message) => message.code === "CHAT_RATE_LIMITED");
    assert.match(error.message, /频繁/);
    await room.first.expectNo("error");
  } finally {
    await stopServer(child, clients);
  }
});

test("transport flood protection silently drops over-limit frames before parsing", async () => {
  const { child, url } = await startServer();
  const clients = [];
  try {
    const nullClient = await connect(url);
    const malformedClient = await connect(url);
    clients.push(nullClient, malformedClient);
    for (let index = 0; index < 25; index++) {
      nullClient.sendRaw("null");
      malformedClient.sendRaw("{");
    }
    for (let index = 0; index < 20; index++) {
      assert.equal((await nullClient.next("error")).code, "INVALID_MESSAGE");
      assert.equal((await malformedClient.next("error")).code, "INVALID_JSON");
    }
    await Promise.all([
      nullClient.expectNo("error", 300),
      malformedClient.expectNo("error", 300),
    ]);

    await new Promise((resolve) => setTimeout(resolve, 1050));
    nullClient.send({
      type: "create_room",
      rule_config: { boardVariant: "normal", swapEvery: 1 },
    });
    assert.equal((await nullClient.next("room_created")).player_symbol, "X");
  } finally {
    await stopServer(child, clients);
  }
});
