const test = require("node:test");
const assert = require("node:assert/strict");
const Rules = require("../js/game-rules");

test("initial state separates absolute positions from movable tile identities", () => {
  const state = Rules.createInitialGameState();

  assert.deepEqual(state.positionToTile, [0, 1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(state.currentPosition, 4);
  assert.equal(state.tiles.length, 9);
  assert.deepEqual(state.tiles.map((tile) => tile.id), state.positionToTile);
  assert.ok(state.tiles.every((tile) => tile.fromTileId === null));

  // Legacy consumers still see boards/currentBoard as the current position view.
  assert.equal(state.boards[4], state.tiles[4]);
  assert.equal(state.currentBoard, state.currentPosition);
});

test("initial state accepts only named variants and exchange frequencies from 1 through 20", () => {
  assert.throws(
    () => Rules.createInitialGameState({ boardVariant: "random-ish" }),
    /boardVariant/
  );
  assert.throws(
    () => Rules.createInitialGameState({ boardVariant: "" }),
    /boardVariant/
  );
  assert.throws(
    () => Rules.createInitialGameState({ boardVariant: "cycle", swapEvery: 0 }),
    /swapEvery/
  );
  assert.throws(
    () => Rules.createInitialGameState({ boardVariant: "chaos", swapEvery: 1.5 }),
    /swapEvery/
  );
  assert.throws(
    () => Rules.createInitialGameState({ boardVariant: "cycle", swapEvery: 21 }),
    /swapEvery/
  );
});

test("applyTurn accepts one authoritative turn object", () => {
  const state = Rules.createInitialGameState();

  assert.doesNotThrow(() => {
    Rules.applyTurn(state, { position: 4, cellIndex: 0, symbol: "X", exchangePair: null });
  });
  assert.equal(state.tiles[4].cells[0], "X");
});

test("legacy applyMove keeps canonical and compatibility state in sync", () => {
  const state = Rules.createInitialGameState();

  Rules.applyMove(state, 4, 0, "X");

  assert.equal(state.currentPosition, 0);
  assert.equal(state.currentBoard, 0);
  assert.equal(state.moveCount, 1);
  assert.equal(state.tiles[0].fromTileId, 4);
  assert.equal(state.boards[0], state.tiles[0]);
});

test("getLegalMoves exposes every empty cell in the current absolute position", () => {
  const state = Rules.createInitialGameState();
  state.tiles[4].cells[3] = "X";

  assert.equal(typeof Rules.getLegalMoves, "function");
  assert.deepEqual(Rules.getLegalMoves(state), [
    { position: 4, cellIndex: 0 },
    { position: 4, cellIndex: 1 },
    { position: 4, cellIndex: 2 },
    { position: 4, cellIndex: 4 },
    { position: 4, cellIndex: 5 },
    { position: 4, cellIndex: 6 },
    { position: 4, cellIndex: 7 },
    { position: 4, cellIndex: 8 },
  ]);
});

test("rehydrateGameState rebuilds positional aliases after JSON transport", () => {
  const state = Rules.createInitialGameState();
  state.positionToTile[0] = 1;
  state.positionToTile[1] = 0;
  state.currentPosition = 1;
  state.tiles[2].fromTileId = 0;
  const transported = JSON.parse(JSON.stringify(state));

  assert.notEqual(transported.boards[0], transported.tiles[1]);
  assert.equal(typeof Rules.rehydrateGameState, "function");
  const restored = Rules.rehydrateGameState(transported);

  assert.equal(restored, transported);
  assert.equal(restored.boards[0], restored.tiles[1]);
  assert.equal(restored.currentBoard, 1);
  assert.equal(restored.boards[2].fromBoard, 1);
});

test("rehydrateGameState normalizes a full tile without a winner as a draw", () => {
  const transported = JSON.parse(JSON.stringify(Rules.createInitialGameState()));
  transported.tiles[0].cells.fill("O");
  transported.tiles[0].winner = null;

  Rules.rehydrateGameState(transported);

  assert.equal(transported.tiles[0].winner, "draw");
  assert.deepEqual(transported.tiles[0].winningPatterns, []);
});

test("rehydrateGameState supplies defaults only when snapshot config is absent", () => {
  const transported = JSON.parse(JSON.stringify(Rules.createInitialGameState()));
  delete transported.boardVariant;
  delete transported.swapEvery;

  Rules.rehydrateGameState(transported);

  assert.equal(transported.boardVariant, "normal");
  assert.equal(transported.swapEvery, 1);
});

test("rehydrateGameState rejects malformed config, mappings, and tile shapes", () => {
  const cases = [
    {
      pattern: /boardVariant/,
      corrupt(state) { state.boardVariant = ""; },
    },
    {
      pattern: /swapEvery/,
      corrupt(state) { state.swapEvery = 21; },
    },
    {
      pattern: /positionToTile/,
      corrupt(state) { state.positionToTile[1] = 0; },
    },
    {
      pattern: /tile id/,
      corrupt(state) { state.tiles[0].id = 1; },
    },
    {
      pattern: /cells/,
      corrupt(state) { state.tiles[0].cells.pop(); },
    },
    {
      pattern: /cell value/,
      corrupt(state) { state.tiles[0].cells[0] = "Z"; },
    },
    {
      pattern: /winningPatterns/,
      corrupt(state) { state.tiles[0].winningPatterns = [8]; },
    },
    {
      pattern: /moveCount/,
      corrupt(state) { state.moveCount = -1; },
    },
    {
      pattern: /cycleCursor/,
      corrupt(state) { state.cycleCursor = 9; },
    },
    {
      pattern: /currentPlayer/,
      corrupt(state) { state.currentPlayer = "Z"; },
    },
    {
      pattern: /scores/,
      corrupt(state) { state.scores = null; },
    },
    {
      pattern: /scores/,
      corrupt(state) { state.scores.X = -1; },
    },
    {
      pattern: /scores/,
      corrupt(state) { state.scores.O = "0"; },
    },
    {
      pattern: /scores/,
      corrupt(state) {
        state.scores = [];
        state.scores.X = 0;
        state.scores.O = 0;
      },
    },
    {
      pattern: /isGameOver/,
      corrupt(state) { state.isGameOver = "false"; },
    },
    {
      pattern: /overallWinner/,
      corrupt(state) { state.overallWinner = {}; },
    },
  ];

  cases.forEach(({ pattern, corrupt }) => {
    const transported = JSON.parse(JSON.stringify(Rules.createInitialGameState()));
    corrupt(transported);
    const before = structuredClone(transported);
    assert.throws(() => Rules.rehydrateGameState(transported), pattern);
    assert.deepEqual(transported, before);
  });
});

test("rehydrateGameState safely rebuilds derived fields before a complete legal turn", () => {
  const transported = JSON.parse(JSON.stringify(Rules.createInitialGameState()));
  [0, 1, 2].forEach((tileId, patternIndex) => {
    transported.tiles[tileId].winner = "X";
    transported.tiles[tileId].winningPatterns = [patternIndex];
  });
  transported.bonusScores = null;
  transported.bonusBreakdown = "untrusted";

  Rules.rehydrateGameState(transported);

  assert.deepEqual(transported.bonusScores, { X: 2, O: 0 });
  assert.deepEqual(transported.bonusBreakdown.overall, { X: 2, O: 0 });
  assert.doesNotThrow(() => {
    Rules.applyTurn(transported, { position: 4, cellIndex: 3, symbol: "X" });
  });
  assert.equal(transported.tiles[4].cells[3], "X");
  assert.equal(transported.moveCount, 1);
  assert.equal(transported.currentPlayer, "O");
  assert.deepEqual(transported.bonusScores, { X: 2, O: 0 });
});

test("position queries resolve movable tile identities without copied mapping logic", () => {
  const state = Rules.createInitialGameState();
  state.positionToTile[0] = 1;
  state.positionToTile[1] = 0;

  assert.equal(typeof Rules.getTileAtPosition, "function");
  assert.equal(typeof Rules.findTilePosition, "function");
  assert.equal(Rules.getTileAtPosition(state, 0), state.tiles[1]);
  assert.equal(Rules.findTilePosition(state, 0), 1);
});

test("applyTurn rejects an illegal turn before mutating state", () => {
  const cases = [
    {
      turn: { position: 0, cellIndex: 0, symbol: "X" },
    },
    {
      turn: { position: -1, cellIndex: 0, symbol: "X" },
    },
    {
      turn: { position: 4, cellIndex: 9, symbol: "X" },
    },
    {
      turn: { position: 4, cellIndex: 0, symbol: "X" },
      setup(state) { state.tiles[4].cells[0] = "O"; },
    },
    {
      turn: { position: 4, cellIndex: 0, symbol: "O" },
    },
    {
      turn: { position: 4, cellIndex: 0, symbol: "X" },
      setup(state) { state.isGameOver = true; },
    },
  ];

  cases.forEach(({ turn, setup }) => {
    const state = Rules.createInitialGameState({ boardVariant: "cycle", swapEvery: 1 });
    if (setup) setup(state);
    const before = JSON.parse(JSON.stringify(state));

    assert.throws(() => Rules.applyTurn(state, turn));
    assert.deepEqual(JSON.parse(JSON.stringify(state)), before);
    assert.equal(state.cycleCursor, 0);
  });
});

test("applyTurn rejects malformed runtime fields before a legal move can partially apply", () => {
  const cases = [
    (state) => { state.scores = null; },
    (state) => { state.scores.X = -1; },
    (state) => { state.isGameOver = 0; },
    (state) => { state.overallWinner = {}; },
  ];

  cases.forEach((corrupt) => {
    const state = Rules.createInitialGameState({ boardVariant: "cycle", swapEvery: 1 });
    corrupt(state);
    const before = structuredClone(state);

    assert.throws(() => {
      Rules.applyTurn(state, { position: 4, cellIndex: 0, symbol: "X" });
    });
    assert.deepEqual(state, before);
    assert.equal(state.cycleCursor, 0);
  });
});

test("cycle mode exchanges the next fixed pair every N successful turns", () => {
  const state = Rules.createInitialGameState({ boardVariant: "cycle", swapEvery: 2 });

  const first = Rules.applyTurn(state, { position: 4, cellIndex: 0, symbol: "X" });
  assert.equal(first.exchange, null);
  assert.deepEqual(state.positionToTile, [0, 1, 2, 3, 4, 5, 6, 7, 8]);

  const second = Rules.applyTurn(state, { position: 0, cellIndex: 1, symbol: "O" });
  assert.deepEqual(second.exchange, [0, 1]);
  assert.deepEqual(state.positionToTile, [1, 0, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(state.tiles[4].cells[0], "X");
  assert.equal(state.tiles[0].cells[1], "O");
  assert.equal(state.currentPosition, 1);
  assert.equal(state.moveCount, 2);
});

test("exchange schedule queries are pure and shared across callers", () => {
  const cycle = Rules.createInitialGameState({ boardVariant: "cycle", swapEvery: 2 });
  cycle.moveCount = 1;
  cycle.cycleCursor = 8;
  const before = JSON.parse(JSON.stringify(cycle));

  assert.equal(typeof Rules.requiresExchangeOnNextTurn, "function");
  assert.equal(typeof Rules.getCycleExchangeForNextTurn, "function");
  assert.equal(Rules.requiresExchangeOnNextTurn(cycle), true);
  assert.deepEqual(Rules.getCycleExchangeForNextTurn(cycle), [8, 0]);
  assert.deepEqual(cycle, before);

  const chaos = Rules.createInitialGameState({ boardVariant: "chaos", swapEvery: 1 });
  assert.equal(Rules.requiresExchangeOnNextTurn(chaos), true);
  assert.equal(Rules.getCycleExchangeForNextTurn(chaos), null);

  const normal = Rules.createInitialGameState();
  assert.equal(Rules.requiresExchangeOnNextTurn(normal), false);
});

test("cycle mode closes the sequence with positions 9 and 1 before restarting", () => {
  const state = Rules.createInitialGameState({ boardVariant: "cycle", swapEvery: 1 });
  state.cycleCursor = 8;

  const closingTurn = Rules.applyTurn(state, { position: 4, cellIndex: 0, symbol: "X" });
  assert.deepEqual(closingTurn.exchange, [8, 0]);

  const restartedTurn = Rules.applyTurn(state, {
    position: state.currentPosition,
    cellIndex: 1,
    symbol: "O",
  });
  assert.deepEqual(restartedTurn.exchange, [0, 1]);
});

test("chaos mode applies the authoritative explicit exchange pair", () => {
  const state = Rules.createInitialGameState({ boardVariant: "chaos", swapEvery: 1 });

  const result = Rules.applyTurn(state, {
    position: 4,
    cellIndex: 3,
    symbol: "X",
    exchangePair: [2, 7],
  });

  assert.deepEqual(result.exchange, [2, 7]);
  assert.deepEqual(state.positionToTile, [0, 1, 7, 3, 4, 5, 6, 2, 8]);
  assert.equal(state.currentPosition, 3);
});

test("chaos mode rejects a missing or invalid due exchange before placing a mark", () => {
  [undefined, [3, 3]].forEach((exchangePair) => {
    const state = Rules.createInitialGameState({ boardVariant: "chaos", swapEvery: 1 });
    const before = JSON.parse(JSON.stringify(state));

    assert.throws(
      () => Rules.applyTurn(state, {
        position: 4,
        cellIndex: 0,
        symbol: "X",
        exchangePair,
      }),
      /exchange must contain two different valid positions/
    );
    assert.deepEqual(state, before);
  });
});

test("winning fallback follows the source tile to its real-time position", () => {
  const state = Rules.createInitialGameState({ boardVariant: "chaos", swapEvery: 1 });
  state.tiles[4].cells[0] = "X";
  state.tiles[4].cells[1] = "X";
  state.tiles[4].fromTileId = 1;
  state.tiles[2].winner = "O"; // The direct absolute destination is unavailable.

  Rules.applyTurn(state, {
    position: 4,
    cellIndex: 2,
    symbol: "X",
    exchangePair: [1, 4],
  });

  assert.equal(state.positionToTile[4], 1);
  assert.equal(state.currentPosition, 4);
  assert.equal(state.currentBoard, 4);
});

test("a fromTileId cycle terminates and falls back to the first playable position", () => {
  const state = Rules.createInitialGameState({ boardVariant: "chaos", swapEvery: 1 });
  state.tiles[4].cells[0] = "X";
  state.tiles[4].cells[1] = "X";
  state.tiles[4].fromTileId = 1;
  state.tiles[1].winner = "O";
  state.tiles[1].fromTileId = 4;
  state.tiles[2].winner = "O";

  Rules.applyTurn(state, {
    position: 4,
    cellIndex: 2,
    symbol: "X",
    exchangePair: [7, 8],
  });

  assert.equal(state.currentPosition, 0);
});

test("a full tile without winner metadata is not a playable direct destination", () => {
  const state = Rules.createInitialGameState();
  state.tiles[0].cells.fill("O");

  Rules.applyTurn(state, { position: 4, cellIndex: 0, symbol: "X" });

  assert.equal(state.currentPosition, 4);
  assert.ok(Rules.getLegalMoves(state).length > 0);
});

test("fallback skips a full source tile without winner metadata", () => {
  const state = Rules.createInitialGameState();
  state.tiles[4].cells[0] = "X";
  state.tiles[4].cells[1] = "X";
  state.tiles[4].fromTileId = 0;
  state.tiles[0].cells.fill("O");
  state.tiles[2].winner = "O";

  Rules.applyTurn(state, { position: 4, cellIndex: 2, symbol: "X" });

  assert.equal(state.currentPosition, 1);
  assert.ok(Rules.getLegalMoves(state).length > 0);
});

test("the game ends when the only undecided metadata belongs to a full tile", () => {
  const state = Rules.createInitialGameState();
  state.tiles.forEach((tile) => { tile.winner = "draw"; });
  state.tiles[0].winner = null;
  state.tiles[0].cells.fill("O");
  state.tiles[4].winner = null;
  state.tiles[4].cells = ["X", "O", "X", "X", "O", "O", "O", "X", null];

  const result = Rules.applyTurn(state, { position: 4, cellIndex: 8, symbol: "X" });

  assert.equal(result.gameOver, true);
  assert.equal(state.tiles[0].winner, "draw");
  assert.deepEqual(Rules.getLegalMoves(state), []);
});

test("bonuses are recomputed from the physical arrangement after exchange", () => {
  const state = Rules.createInitialGameState({ boardVariant: "chaos", swapEvery: 1 });
  state.tiles[0].winner = "X";
  state.tiles[0].winningPatterns = [0];
  state.tiles[1].winner = "X";
  state.tiles[1].winningPatterns = [1];
  state.tiles[3].winner = "X";
  state.tiles[3].winningPatterns = [2];

  Rules.applyTurn(state, {
    position: 4,
    cellIndex: 5,
    symbol: "X",
    exchangePair: [2, 3],
  });

  assert.deepEqual(state.bonusBreakdown.overall, { X: 2, O: 0 });
  assert.deepEqual(state.bonusScores, { X: 2, O: 0 });
});

test("an exchange can remove an existing physical-arrangement bonus", () => {
  const state = Rules.createInitialGameState({ boardVariant: "chaos", swapEvery: 1 });
  [0, 1, 2].forEach((tileId, patternIndex) => {
    state.tiles[tileId].winner = "X";
    state.tiles[tileId].winningPatterns = [patternIndex];
  });
  Rules.calculateBonuses(state);
  assert.equal(state.bonusScores.X, 2);

  Rules.applyTurn(state, {
    position: 4,
    cellIndex: 5,
    symbol: "X",
    exchangePair: [2, 3],
  });

  assert.deepEqual(state.bonusScores, { X: 0, O: 0 });
});

test("an exchange can break an existing physical nine-cell line", () => {
  const state = Rules.createInitialGameState({ boardVariant: "chaos", swapEvery: 1 });
  [0, 1, 2].forEach((tileId) => {
    [0, 1, 2].forEach((cellIndex) => {
      state.tiles[tileId].cells[cellIndex] = "X";
    });
  });
  Rules.calculateBonuses(state);
  assert.equal(state.bonusBreakdown.fullLines.X, 4);

  Rules.applyTurn(state, {
    position: 4,
    cellIndex: 5,
    symbol: "X",
    exchangePair: [2, 3],
  });

  assert.deepEqual(state.bonusBreakdown.fullLines, { X: 0, O: 0 });
});

test("a final-turn exchange determines bonuses before the overall winner", () => {
  const state = Rules.createInitialGameState({ boardVariant: "chaos", swapEvery: 1 });
  state.tiles.forEach((tile) => { tile.winner = "draw"; });
  [0, 1, 3].forEach((tileId, patternIndex) => {
    state.tiles[tileId].winner = "X";
    state.tiles[tileId].winningPatterns = [patternIndex];
  });
  state.tiles[4].winner = null;
  state.tiles[4].cells[0] = "X";
  state.tiles[4].cells[1] = "X";
  state.scores = { X: 0, O: 1 };

  const result = Rules.applyTurn(state, {
    position: 4,
    cellIndex: 2,
    symbol: "X",
    exchangePair: [2, 3],
  });

  assert.equal(result.gameOver, true);
  assert.deepEqual(state.bonusScores, { X: 2, O: 0 });
  assert.equal(state.overallWinner, "X");
});
