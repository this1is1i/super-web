const test = require("node:test");
const assert = require("node:assert/strict");
const Rules = require("../js/game-rules");

function effects() { return require("../js/board-effects"); }

test("visual transition tracks placement and exchanged tiles without mutating rules state", () => {
  const Effects = effects();
  const state = Rules.createInitialGameState({ boardVariant: "chaos" });
  const before = Effects.snapshot(state);
  Rules.applyTurn(state, { position: 4, cellIndex: 0, symbol: "X", exchangePair: [4, 0] });
  const frozen = JSON.stringify(state);
  const plan = Effects.describe(before, Effects.snapshot(state));
  assert.deepEqual(plan.placed, [{ tileId: 4, cellIndex: 0, symbol: "X" }]);
  assert.deepEqual(plan.exchanged.map((tile) => tile.tileId).sort(), [0, 4]);
  assert.equal(JSON.stringify(state), frozen);
  assert.equal(before.tiles[4].cells[0], null);
});

test("expiration and surviving wins produce separate visual events", () => {
  const Effects = effects();
  const state = Rules.createInitialGameState({ pieceLimit: 3 });
  state.tiles[4].cells[3] = "O";
  state.tiles[4].cells[0] = "X";
  state.tiles[4].cells[1] = "X";
  state.tiles[4].moveOrder = [3, 0, 1];
  const before = Effects.snapshot(state);
  Rules.applyTurn(state, { position: 4, cellIndex: 2, symbol: "X" });
  const plan = Effects.describe(before, Effects.snapshot(state));
  assert.deepEqual(plan.removed, [{ tileId: 4, cellIndex: 3, symbol: "O" }]);
  assert.deepEqual(plan.won, [4]);
  assert.deepEqual(plan.route, { from: 4, to: 2 });
});

test("pending renders, resets and skipped reconnect turns do not replay animations", () => {
  const Effects = effects();
  const state = Rules.createInitialGameState();
  const first = Effects.snapshot(state);
  assert.equal(Effects.describe(null, first), null);
  assert.equal(Effects.describe(first, first), null);
  state.moveCount = 8;
  assert.equal(Effects.describe(first, Effects.snapshot(state)), null);
  assert.equal(Effects.describe(Effects.snapshot(state), first), null);
});

function animationHarness() {
  const pending = [];
  const surfaces = Array.from({ length: 9 }, () => ({
    style: {}, inert: false,
    querySelector() { return this; },
    animate() {
      let finish, cancel;
      const finished = new Promise((resolve, reject) => { finish = resolve; cancel = reject; });
      const animation = { finished, cancel() { cancel(new Error("cancelled")); }, finish };
      pending.push(animation);
      return animation;
    },
  }));
  const board = {
    querySelector(selector) {
      const tile = selector.match(/data-tile-id="(\d+)"/);
      if (tile) return surfaces[Number(tile[1])];
      const position = Number(selector.match(/board-(\d+)/)[1]);
      return { getBoundingClientRect() { return { left: position * 50, top: 0, width: 45, height: 45 }; } };
    },
  };
  return { pending, surfaces, board, effects: effects().create({}, {}) };
}

test("presentation settles before the next turn and blocks moving hit targets only until completion", async () => {
  const fixture = animationHarness();
  const state = Rules.createInitialGameState({ boardVariant: "chaos" });
  fixture.effects.render(fixture.board, state);
  Rules.applyTurn(state, { position: 4, cellIndex: 4, symbol: "X", exchangePair: [0, 1] });
  fixture.effects.render(fixture.board, state);
  let settled = false;
  const completion = fixture.effects.settled().then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(fixture.surfaces[0].inert, true);
  assert.equal(fixture.surfaces[1].inert, true);
  assert.equal(fixture.surfaces[4].inert, false);
  fixture.pending.forEach((animation) => animation.finish());
  await completion;
  assert.equal(settled, true);
  assert.equal(fixture.surfaces[0].inert, false);
  assert.equal(fixture.surfaces[1].inert, false);
});

test("disabling motion or resetting releases animation waiters and interaction locks", async () => {
  for (const action of ["disable", "reset"]) {
    const fixture = animationHarness();
    const state = Rules.createInitialGameState({ boardVariant: "chaos" });
    fixture.effects.render(fixture.board, state);
    Rules.applyTurn(state, { position: 4, cellIndex: 4, symbol: "X", exchangePair: [0, 1] });
    fixture.effects.render(fixture.board, state);
    const completion = fixture.effects.settled();
    if (action === "disable") fixture.effects.setEnabled(false);
    else fixture.effects.reset();
    await completion;
    assert.equal(fixture.surfaces[0].inert, false);
    assert.equal(fixture.surfaces[1].inert, false);
  }
});
