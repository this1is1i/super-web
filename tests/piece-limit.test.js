const test = require("node:test");
const assert = require("node:assert/strict");
const Rules = require("../js/game-rules");
const { createAI } = require("../js/ai-player");

const ring = [0, 1, 2, 5, 8, 7, 6, 3];

function singleBoard(limit, options = {}) {
  const state = Rules.createInitialGameState({ pieceLimit: limit, ...options });
  state.tiles.forEach((tile) => { if (tile.id !== 4) tile.winner = "draw"; });
  return state;
}

function play(state, cellIndex, exchangePair = null) {
  return Rules.applyTurn(state, {
    position: state.currentPosition, cellIndex, symbol: state.currentPlayer, exchangePair,
  });
}

function seed(tile, entries) {
  tile.cells.fill(null);
  tile.moveOrder = entries.map(([cell, symbol]) => { tile.cells[cell] = symbol; return cell; });
}

test("piece limit is opt-in and accepts only integer capacities 3 through 8", () => {
  assert.equal(Rules.createInitialGameState().pieceLimit, null);
  for (const limit of [3, 6, 7, 8]) {
    assert.equal(Rules.createInitialGameState({ pieceLimit: limit }).pieceLimit, limit);
  }
  for (const limit of [0, 2, 9, 6.5, "7", false]) {
    assert.throws(() => Rules.createInitialGameState({ pieceLimit: limit }), /pieceLimit/);
  }
});

test("seven pieces remain until the eighth move removes the oldest regardless of color", () => {
  const state = singleBoard(7);
  for (let i = 0; i < 7; i++) play(state, ring[i]);
  assert.equal(state.tiles[4].cells.filter(Boolean).length, 7);
  const result = play(state, ring[7]);
  assert.equal(state.tiles[4].cells[0], null);
  assert.equal(state.tiles[4].cells[3], "O");
  assert.deepEqual(state.tiles[4].moveOrder, ring.slice(1));
  assert.deepEqual(result.removedPiece, { tileId: 4, cellIndex: 0, symbol: "X" });
});

test("expiration happens before checking a newly formed three-in-a-row", () => {
  const state = singleBoard(3);
  seed(state.tiles[4], [[0, "X"], [1, "X"], [3, "O"]]);
  play(state, 2);
  assert.equal(state.tiles[4].winner, null);
  assert.equal(state.tiles[4].cells[0], null);
  assert.equal(state.scores.X, 0);
});

test("surviving three-in-a-row seals the board and preserves its final pieces", () => {
  const state = Rules.createInitialGameState({ pieceLimit: 3 });
  seed(state.tiles[4], [[3, "O"], [0, "X"], [1, "X"]]);
  play(state, 2);
  assert.equal(state.tiles[4].cells[3], null);
  assert.equal(state.tiles[4].winner, "X");
  assert.equal(state.scores.X, 1);
  const frozen = JSON.stringify(state.tiles[4]);
  play(state, 0);
  assert.equal(JSON.stringify(state.tiles[4]), frozen);
});

test("an occupied expiring cell is still illegal and rejected without changing history", () => {
  const state = singleBoard(3);
  seed(state.tiles[4], [[0, "X"], [1, "O"], [3, "X"]]);
  const before = JSON.stringify(state);
  assert.throws(() => play(state, 0), /legal/);
  assert.equal(JSON.stringify(state), before);
});

test("expiration order follows tile identity through exchanges without deleting its source", () => {
  const state = Rules.createInitialGameState({ pieceLimit: 3, boardVariant: "chaos" });
  seed(state.tiles[4], [[0, "O"], [1, "X"], [3, "O"]]);
  state.tiles[4].fromTileId = 8;
  play(state, 7, [4, 0]);
  assert.equal(state.boards[0].id, 4);
  assert.equal(state.boards[0].cells[0], null);
  assert.deepEqual(state.boards[0].moveOrder, [1, 3, 7]);
  assert.equal(state.boards[0].fromTileId, 8);
  assert.equal(state.currentPosition, 7);
});

for (const limit of [6, 7]) {
  test(`capacity ${limit}: third full repetition settles remaining boards and survives transport`, () => {
    let state = singleBoard(limit);
    state.tiles[0].winner = "X";
    seed(state.tiles[0], [[0, "X"], [1, "X"], [2, "X"]]);
    state.tiles[0].winningPatterns = [0];
    state.scores.X = 1;
    for (let i = 0; i < limit + 16; i++) {
      assert.equal(state.isGameOver, false);
      play(state, ring[i % 8]);
      // Resume after the second occurrence: restoring must neither forget nor count it again.
      if (i === limit + 7) {
        state = Rules.rehydrateGameState(JSON.parse(JSON.stringify(state)));
        state = Rules.rehydrateGameState(state);
      }
    }
    assert.equal(state.endReason, "threefold_repetition");
    assert.equal(state.isGameOver, true);
    assert.equal(state.tiles[4].winner, "draw");
    assert.equal(state.tiles[4].cells.filter(Boolean).length, limit);
    assert.equal(state.overallWinner, "X");
    assert.deepEqual(Rules.getTotalScores(state), { X: 1, O: 0 });
    const restored = Rules.rehydrateGameState(JSON.parse(JSON.stringify(state)));
    assert.equal(restored.endReason, "threefold_repetition");
    assert.equal(restored.overallWinner, "X");
    assert.deepEqual(Rules.getLegalMoves(restored), []);
  });
}

test("equal scores on repetition produce an overall draw", () => {
  const state = singleBoard(6);
  for (let i = 0; i < 22; i++) play(state, ring[i % 8]);
  assert.equal(state.isGameOver, true);
  assert.equal(state.overallWinner, "draw");
});

test("changing exchange phases allow games beyond 81 turns without a move-count cutoff", () => {
  const state = singleBoard(6, { boardVariant: "cycle", swapEvery: 20 });
  for (let i = 0; i < 100; i++) {
    assert.equal(state.isGameOver, false);
    play(state, ring[i % 8]);
  }
  assert.equal(state.moveCount, 100);
  assert.equal(state.isGameOver, false);
  assert.equal(state.tiles[4].winner, null);
});

test("repetition settlement preserves frozen physical-line bonuses and awards no undecided-board points", () => {
  const state = singleBoard(6);
  for (const id of [0, 1, 2]) {
    seed(state.tiles[id], [[0, "X"], [1, "X"], [2, "X"]]);
    state.tiles[id].winner = "X";
    state.tiles[id].winningPatterns = [0];
  }
  state.scores.X = 3;
  for (let i = 0; i < 22; i++) play(state, ring[i % 8]);
  assert.equal(state.endReason, "threefold_repetition");
  assert.equal(state.tiles[4].winner, "draw");
  assert.equal(state.scores.X, 3);
  assert.deepEqual(Rules.getTotalScores(state), { X: 7, O: 0 });
});

test("repetition identity includes age, player, routing, mapping and future exchange phase", () => {
  const state = singleBoard(6, { boardVariant: "cycle", swapEvery: 3 });
  seed(state.tiles[4], [[0, "X"], [1, "O"]]);
  const original = Rules.getRepetitionKey(state);
  for (const mutate of [
    (s) => s.tiles[4].moveOrder.reverse(),
    (s) => { s.currentPlayer = "O"; },
    (s) => { s.currentPosition = 0; },
    (s) => { s.tiles[4].fromTileId = 0; },
    (s) => { [s.positionToTile[0], s.positionToTile[4]] = [4, 0]; },
    (s) => { s.moveCount++; },
    (s) => { s.cycleCursor++; },
  ]) {
    const changed = structuredClone(state);
    mutate(changed);
    assert.notEqual(Rules.getRepetitionKey(changed), original);
  }
  state.moveCount += 3;
  assert.equal(Rules.getRepetitionKey(state), original, "absolute turn number cannot prevent repetition");
  state.boardVariant = "normal";
  const normalKey = Rules.getRepetitionKey(state);
  state.moveCount++;
  state.cycleCursor++;
  assert.equal(Rules.getRepetitionKey(state), normalKey);
});

test("transport rejects missing or corrupt expiration order rather than guessing ages", () => {
  const state = singleBoard(3);
  play(state, 0);
  for (const order of [undefined, [1], [0, 0], [9]]) {
    const transported = JSON.parse(JSON.stringify(state));
    transported.tiles[4].moveOrder = order;
    assert.throws(() => Rules.rehydrateGameState(transported), /moveOrder/);
  }
});

test("AI evaluates surviving marks with shared rules and does not mutate live history", () => {
  const state = singleBoard(3);
  seed(state.tiles[4], [[3, "O"], [0, "X"], [1, "X"]]);
  const before = JSON.stringify(state);
  for (const difficulty of ["normal", "hard"]) {
    const turn = createAI(Rules).chooseTurnSync(state, { difficulty, timeLimitMs: 1000 });
    assert.equal(turn.cellIndex, 2);
    assert.equal(JSON.stringify(state), before);
  }
});
