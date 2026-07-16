const test = require("node:test");
const assert = require("node:assert/strict");

const { createAI } = require("../js/ai-player");
const RealRules = require("../js/game-rules");

function createLineRules() {
  const calls = { legal: 0, turns: [] };

  function winnerOf(cells) {
    const lines = [
      [0, 1, 2], [3, 4, 5], [6, 7, 8],
      [0, 3, 6], [1, 4, 7], [2, 5, 8],
      [0, 4, 8], [2, 4, 6],
    ];
    for (const [a, b, c] of lines) {
      if (cells[a] && cells[a] === cells[b] && cells[a] === cells[c]) return cells[a];
    }
    return null;
  }

  return {
    calls,
    getLegalMoves(state) {
      calls.legal++;
      if (state.isGameOver) return [];
      return state.cells.flatMap((cell, cellIndex) => (
        cell === null ? [{ position: state.position, cellIndex }] : []
      ));
    },
    applyTurn(state, turn) {
      calls.turns.push(structuredClone(turn));
      assert.equal(turn.position, state.position);
      assert.equal(turn.symbol, state.currentPlayer);
      assert.equal(state.cells[turn.cellIndex], null);
      state.cells[turn.cellIndex] = turn.symbol;
      const winner = winnerOf(state.cells);
      if (winner) {
        state.isGameOver = true;
        state.overallWinner = winner;
        state.scores[winner]++;
      } else if (state.cells.every(Boolean)) {
        state.isGameOver = true;
        state.overallWinner = "draw";
      }
      state.currentPlayer = turn.symbol === "X" ? "O" : "X";
      return { gameOver: state.isGameOver };
    },
    getTotalScores(state) {
      return state.scores;
    },
  };
}

function createState(cells, currentPlayer = "O") {
  return {
    position: 4,
    cells: cells.slice(),
    currentPlayer,
    scores: { X: 0, O: 0 },
    bonusScores: { X: 0, O: 0 },
    isGameOver: false,
    overallWinner: null,
  };
}

function createPolicyDepthRules() {
  return {
    getLegalMoves(state) {
      if (state.phase === "root") {
        return [
          { position: 4, cellIndex: 0 },
          { position: 4, cellIndex: 1 },
        ];
      }
      if (state.phase === "reply") return [{ position: 4, cellIndex: 2 }];
      return [];
    },
    applyTurn(state, turn) {
      if (state.phase === "root") {
        state.rootChoice = turn.cellIndex;
        state.phase = "reply";
        state.currentPlayer = "X";
      } else {
        if (state.rootChoice === 0) state.boards = [{ winner: "X" }];
        state.phase = "done";
        state.currentPlayer = "O";
      }
    },
    getTotalScores(state) {
      return state.scores;
    },
  };
}

function createCompetingGainRules() {
  return {
    getLegalMoves(state) {
      if (state.finished) return [];
      return [
        { position: 4, cellIndex: 0 },
        { position: 4, cellIndex: 1 },
      ];
    },
    applyTurn(state, turn) {
      state.scores[turn.symbol] += turn.cellIndex === 0 ? 1 : 2;
      state.finished = true;
      state.currentPlayer = turn.symbol === "X" ? "O" : "X";
    },
    getTotalScores(state) {
      return state.scores;
    },
  };
}

function createTerminalOrderingRules(secondOutcome) {
  return {
    getLegalMoves(state) {
      if (state.phase === "root") {
        return [
          { position: 4, cellIndex: 0 },
          { position: 4, cellIndex: 1 },
        ];
      }
      if (state.phase === "reply") return [{ position: 4, cellIndex: 2 }];
      return [];
    },
    applyTurn(state, turn) {
      if (state.phase === "root" && turn.cellIndex === 0) {
        state.scores.O += state.losingMoveGain || 0;
        state.phase = "done";
        state.isGameOver = true;
        state.overallWinner = "X";
        state.currentPlayer = "X";
        return;
      }
      if (state.phase === "root" && secondOutcome === "draw") {
        state.phase = "done";
        state.isGameOver = true;
        state.overallWinner = "draw";
        state.currentPlayer = "X";
        return;
      }
      if (state.phase === "root") {
        state.phase = "reply";
        state.currentPlayer = "X";
        return;
      }
      state.scores.X += 1;
      state.phase = "done";
      state.currentPlayer = "O";
    },
    getTotalScores(state) {
      return state.scores;
    },
  };
}

function createTerminalOrderingState(losingMoveGain = 0) {
  return {
    phase: "root",
    currentPlayer: "O",
    scores: { X: 0, O: 0 },
    bonusScores: { X: 0, O: 0 },
    isGameOver: false,
    overallWinner: null,
    losingMoveGain,
  };
}

function createRealWinningState(boardVariant) {
  const state = RealRules.createInitialGameState({
    boardVariant,
    swapEvery: 1,
  });
  const activeTile = state.tiles[state.positionToTile[state.currentPosition]];
  activeTile.cells[0] = "X";
  activeTile.cells[1] = "X";
  return state;
}

function chooseWithJsonCloneOnly(ai, state, options) {
  const savedStructuredClone = global.structuredClone;
  global.structuredClone = undefined;
  try {
    return ai.chooseTurnSync(state, options);
  } finally {
    global.structuredClone = savedStructuredClone;
  }
}

function createObservedRealRules(observations) {
  return Object.assign({}, RealRules, {
    applyTurn(state, turn) {
      const result = RealRules.applyTurn(state, turn);
      observations.push({
        moveCount: state.moveCount,
        cycleCursor: state.cycleCursor,
        positionToTile: state.positionToTile.slice(),
        turn: structuredClone(turn),
      });
      return result;
    },
  });
}

test("factory requires shared legal-move and turn-transition rules", () => {
  assert.throws(() => createAI({}), /getLegalMoves/);
  assert.throws(
    () => createAI({ getLegalMoves() { return []; } }),
    /applyTurn/
  );
  assert.throws(
    () => createAI({
      getLegalMoves() { return []; },
      applyTurn() {},
    }),
    /getTotalScores/
  );
});

test("AI rejects exchange pairs outside the two distinct absolute-position contract", () => {
  const ai = createAI(createLineRules());
  const state = createState(Array(9).fill(null));
  const invalidPairs = [[-1, 2], [0, 9], [1, 1], [1.5, 2]];

  invalidPairs.forEach((exchangePair) => {
    assert.throws(
      () => ai.chooseTurnSync(state, { exchangePair }),
      /exchangePair/
    );
  });
});

test("normal AI uses injected RNG to vary equally scored legal turns", () => {
  const rules = createLineRules();
  const ai = createAI(rules);
  const state = createState([null, null, "X", "X", "O", "O", "O", "X", "X"]);

  const first = ai.chooseTurnSync(state, {
    difficulty: "normal",
    symbol: "O",
    rng: () => 0,
  });
  const last = ai.chooseTurnSync(state, {
    difficulty: "normal",
    symbol: "O",
    rng: () => 0.999999,
  });

  assert.deepEqual(first, { position: 4, cellIndex: 0, symbol: "O", exchangePair: null });
  assert.deepEqual(last, { position: 4, cellIndex: 1, symbol: "O", exchangePair: null });
  assert.ok(rules.calls.legal >= 2);
  assert.ok(rules.calls.turns.length >= 4);
});

test("normal AI heuristic takes an immediate win", () => {
  const rules = createLineRules();
  const ai = createAI(rules);
  const state = createState(["O", "O", null, "X", null, null, null, "X", null]);

  const turn = ai.chooseTurnSync(state, {
    difficulty: "normal",
    symbol: "O",
    rng: () => 0.75,
  });

  assert.equal(turn.cellIndex, 2);
});

test("hard AI takes an immediate win", () => {
  const rules = createLineRules();
  const ai = createAI(rules);
  const state = createState(["O", "O", null, "X", null, null, null, "X", null]);

  const turn = ai.chooseTurnSync(state, {
    difficulty: "hard",
    symbol: "O",
    maxDepth: 3,
    timeLimitMs: 1000,
  });

  assert.equal(turn.cellIndex, 2);
});

test("hard AI blocks an opponent's immediate win", () => {
  const rules = createLineRules();
  const ai = createAI(rules);
  const state = createState(["X", "X", null, "O", null, null, null, null, null]);

  const turn = ai.chooseTurnSync(state, {
    difficulty: "hard",
    symbol: "O",
    maxDepth: 2,
    timeLimitMs: 1000,
  });

  assert.equal(turn.cellIndex, 2);
});

test("hard AI blocks a threat that is not the first legal turn even when maxDepth is one", () => {
  const rules = createLineRules();
  const ai = createAI(rules);
  const state = createState([null, null, null, "X", "X", null, "O", null, null]);

  const turn = ai.chooseTurnSync(state, {
    difficulty: "hard",
    symbol: "O",
    rng: () => 0,
    maxDepth: 1,
    timeLimitMs: 1000,
  });

  assert.equal(turn.cellIndex, 5);
});

test("hard AI respects maxDepth one when only a non-tactical second-ply score differs", () => {
  const ai = createAI(createPolicyDepthRules());
  const state = {
    phase: "root",
    currentPlayer: "O",
    scores: { X: 0, O: 0 },
    bonusScores: { X: 0, O: 0 },
    boards: [],
    isGameOver: false,
    overallWinner: null,
  };

  const turn = ai.chooseTurnSync(state, {
    difficulty: "hard",
    symbol: "O",
    rng: () => 0,
    maxDepth: 1,
    timeLimitMs: 1000,
  });

  assert.equal(turn.cellIndex, 0);
});

test("hard tactical preflight wins and blocks a real mini-board at maxDepth zero", () => {
  const ai = createAI(RealRules);
  const winningState = RealRules.createInitialGameState();
  winningState.tiles[4].cells[3] = "X";
  winningState.tiles[4].cells[4] = "X";

  const winningTurn = ai.chooseTurnSync(winningState, {
    difficulty: "hard",
    symbol: "X",
    maxDepth: 0,
    timeLimitMs: 1000,
  });
  assert.equal(winningTurn.cellIndex, 5);

  const blockingState = RealRules.createInitialGameState();
  blockingState.tiles[4].cells[3] = "O";
  blockingState.tiles[4].cells[4] = "O";
  blockingState.tiles.forEach((tile, index) => {
    if (index !== 4) tile.winner = "draw";
  });

  const blockingTurn = ai.chooseTurnSync(blockingState, {
    difficulty: "hard",
    symbol: "X",
    maxDepth: 0,
    timeLimitMs: 1000,
  });
  assert.equal(blockingTurn.cellIndex, 5);
});

test("hard tactical preflight compares all safe immediate gains and is not weaker than normal", () => {
  const ai = createAI(createCompetingGainRules());
  const state = {
    currentPlayer: "O",
    scores: { X: 0, O: 0 },
    bonusScores: { X: 0, O: 0 },
    isGameOver: false,
    overallWinner: null,
    finished: false,
  };

  const normalTurn = ai.chooseTurnSync(state, {
    difficulty: "normal",
    symbol: "O",
    rng: () => 0,
  });
  const hardTurn = ai.chooseTurnSync(state, {
    difficulty: "hard",
    symbol: "O",
    rng: () => 0,
    maxDepth: 0,
    timeLimitMs: 1000,
  });

  assert.equal(normalTurn.cellIndex, 1);
  assert.equal(hardTurn.cellIndex, 1);
});

test("hard rejects an immediate overall loss even when the alternative concedes one point", () => {
  const ai = createAI(createTerminalOrderingRules("continue"));

  const turn = ai.chooseTurnSync(createTerminalOrderingState(), {
    difficulty: "hard",
    symbol: "O",
    maxDepth: 0,
    timeLimitMs: 1000,
  });

  assert.equal(turn.cellIndex, 1);
});

test("hard ranks an overall draw above an immediately losing move with a score gain", () => {
  const ai = createAI(createTerminalOrderingRules("draw"));

  const turn = ai.chooseTurnSync(createTerminalOrderingState(2), {
    difficulty: "hard",
    symbol: "O",
    maxDepth: 0,
    timeLimitMs: 1000,
  });

  assert.equal(turn.cellIndex, 1);
});

test("search uses the frozen chaos pair now and resolved cycle pairs on future plies", () => {
  const rules = createLineRules();
  const ai = createAI(rules);
  const state = createState(["X", "X", null, "O", null, null, null, null, null]);

  const turn = ai.chooseTurnSync(state, {
    difficulty: "hard",
    symbol: "O",
    exchangePair: [1, 2],
    resolveExchangePair: (_state, ply) => ply > 0 ? [2, 3] : [1, 2],
    maxDepth: 2,
    timeLimitMs: 1000,
  });

  assert.deepEqual(turn.exchangePair, [1, 2]);
  assert.ok(rules.calls.turns.length > 0);
  assert.ok(rules.calls.turns.some((item) => JSON.stringify(item.exchangePair) === "[2,3]"));
  assert.ok(rules.calls.turns.every((item) => item.exchangePair !== null));
});

test("future exchange resolver output uses the same absolute-position validation", () => {
  const ai = createAI(createLineRules());
  const state = createState(Array(9).fill(null));

  assert.throws(
    () => ai.chooseTurnSync(state, {
      difficulty: "hard",
      symbol: "O",
      exchangePair: [0, 1],
      resolveExchangePair: () => [3, 3],
      maxDepth: 1,
      timeLimitMs: 1000,
    }),
    /exchangePair/
  );
});

test("hard AI returns a legal fallback when its time budget is already exhausted", () => {
  const rules = createLineRules();
  const ai = createAI(rules);
  const state = createState(["X", null, null, "O", null, null, null, null, null]);

  const turn = ai.chooseTurnSync(state, {
    difficulty: "hard",
    symbol: "O",
    rng: () => 0,
    maxDepth: 8,
    timeLimitMs: 0,
  });

  assert.deepEqual(turn, { position: 4, cellIndex: 1, symbol: "O", exchangePair: null });
});

test("hard fallback returns its known best when the deadline expires during traversal", () => {
  const rules = createLineRules();
  let fallbackStarted = false;
  let fallbackScoreCalls = 0;
  const getLegalMoves = rules.getLegalMoves.bind(rules);
  rules.getLegalMoves = (state) => {
    const moves = getLegalMoves(state);
    if (rules.calls.legal >= 12) fallbackStarted = true;
    return moves;
  };
  rules.getTotalScores = (state) => {
    if (fallbackStarted) fallbackScoreCalls++;
    return state.scores;
  };
  const ai = createAI(rules);
  const state = createState(Array(9).fill(null));

  const turn = ai.chooseTurnSync(state, {
    difficulty: "hard",
    symbol: "O",
    rng: () => 0,
    maxDepth: 0,
    timeLimitMs: 1,
    now: () => fallbackStarted && fallbackScoreCalls >= 1 ? 1 : 0,
  });

  assert.equal(turn.position, state.position);
  assert.equal(state.cells[turn.cellIndex], null);
  assert.equal(fallbackScoreCalls, 1);
});

test("JSON clone fallback preserves real normal-state aliases and does not mutate the source", () => {
  const ai = createAI(RealRules);
  const state = createRealWinningState("normal");
  const before = JSON.stringify(state);
  const nativeTurn = ai.chooseTurnSync(state, {
    difficulty: "normal",
    symbol: "X",
    rng: () => 0.999999,
  });

  const turn = chooseWithJsonCloneOnly(ai, state, {
    difficulty: "normal",
    symbol: "X",
    rng: () => 0.999999,
  });

  assert.deepEqual(turn, nativeTurn);
  assert.equal(turn.cellIndex, 2);
  assert.equal(JSON.stringify(state), before);
  assert.equal(state.boards[4], state.tiles[4]);
});

test("JSON clone fallback simulates a real cycle-state exchange consistently", () => {
  const ai = createAI(RealRules);
  const state = createRealWinningState("cycle");
  const before = JSON.stringify(state);

  const turn = chooseWithJsonCloneOnly(ai, state, {
    difficulty: "normal",
    symbol: "X",
    exchangePair: [0, 1],
    rng: () => 0.999999,
  });

  assert.equal(turn.cellIndex, 2);
  assert.deepEqual(turn.exchangePair, [0, 1]);
  assert.equal(JSON.stringify(state), before);
});

test("JSON clone fallback simulates a real chaos-state exchange consistently", () => {
  const ai = createAI(RealRules);
  const state = createRealWinningState("chaos");
  const before = JSON.stringify(state);

  const turn = chooseWithJsonCloneOnly(ai, state, {
    difficulty: "normal",
    symbol: "X",
    exchangePair: [1, 2],
    rng: () => 0.999999,
  });

  assert.equal(turn.cellIndex, 2);
  assert.deepEqual(turn.exchangePair, [1, 2]);
  assert.equal(JSON.stringify(state), before);
});

test("hard real cycle and chaos simulations advance future exchange state", () => {
  const cycleObservations = [];
  const cycleAI = createAI(createObservedRealRules(cycleObservations));
  const cycleState = RealRules.createInitialGameState({ boardVariant: "cycle", swapEvery: 1 });
  const cycleTurn = cycleAI.chooseTurnSync(cycleState, {
    difficulty: "hard",
    symbol: "X",
    maxDepth: 1,
    timeLimitMs: 1000,
  });

  assert.deepEqual(cycleTurn.exchangePair, [0, 1]);
  assert.ok(cycleObservations.some((item) => (
    item.moveCount === 2 &&
    item.cycleCursor === 2 &&
    JSON.stringify(item.positionToTile.slice(0, 3)) === "[1,2,0]"
  )));
  assert.equal(cycleState.moveCount, 0);
  assert.equal(cycleState.cycleCursor, 0);

  const chaosObservations = [];
  const chaosAI = createAI(createObservedRealRules(chaosObservations));
  const chaosState = RealRules.createInitialGameState({ boardVariant: "chaos", swapEvery: 1 });
  const chaosTurn = chaosAI.chooseTurnSync(chaosState, {
    difficulty: "hard",
    symbol: "X",
    exchangePair: [0, 1],
    resolveExchangePair: () => [1, 2],
    maxDepth: 1,
    timeLimitMs: 1000,
  });

  assert.deepEqual(chaosTurn.exchangePair, [0, 1]);
  assert.ok(chaosObservations.some((item) => (
    item.moveCount === 2 &&
    JSON.stringify(item.positionToTile.slice(0, 3)) === "[1,2,0]"
  )));
  assert.equal(chaosState.moveCount, 0);
});

test("AI task rejects when cancelled before or between search iterations", async () => {
  const rules = createLineRules();
  const ai = createAI(rules);
  const state = createState(["X", null, null, "O", null, null, null, null, null]);
  const alreadyCancelled = new AbortController();
  alreadyCancelled.abort();

  assert.throws(
    () => ai.chooseTurnSync(state, { difficulty: "hard", signal: alreadyCancelled.signal }),
    { name: "AbortError" }
  );
  await assert.rejects(
    ai.chooseTurn(state, { difficulty: "hard", signal: alreadyCancelled.signal }),
    { name: "AbortError" }
  );

  const betweenIterations = new AbortController();
  await assert.rejects(
    ai.chooseTurn(state, {
      difficulty: "hard",
      signal: betweenIterations.signal,
      maxDepth: 4,
      timeLimitMs: 1000,
      yieldControl: async () => { betweenIterations.abort(); },
    }),
    { name: "AbortError" }
  );
});

test("AI reports that no turn exists instead of inventing a move", () => {
  const rules = createLineRules();
  const ai = createAI(rules);
  const state = createState(Array(9).fill("X"));

  assert.throws(
    () => ai.chooseTurnSync(state, { difficulty: "normal", symbol: "O" }),
    /no legal turn/i
  );
});
