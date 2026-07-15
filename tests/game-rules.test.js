const test = require("node:test");
const assert = require("node:assert/strict");
const Rules = require("../js/game-rules");

test("the physical board exposes exactly 20 unique 9-cell lines", () => {
  const serialized = Rules.FULL_BOARD_LINES.map((line) => {
    assert.equal(line.length, 9);
    assert.equal(new Set(line.map((position) => position.join(":"))).size, 9);
    return JSON.stringify(line);
  });
  assert.equal(Rules.FULL_BOARD_LINES.length, 20);
  assert.equal(new Set(serialized).size, 20);
});

test("an overlapping full 9-cell line takes precedence and scores 4 points", () => {
  const state = Rules.createInitialGameState();
  [0, 1, 2].forEach((boardIndex) => {
    state.boards[boardIndex].winner = "X";
    state.boards[boardIndex].winningPatterns = [1];
    [3, 4, 5].forEach((cellIndex) => {
      state.boards[boardIndex].cells[cellIndex] = "X";
    });
  });

  Rules.calculateBonuses(state);

  assert.deepEqual(state.bonusBreakdown.overall, { X: 0, O: 0 });
  assert.deepEqual(state.bonusBreakdown.fullLines, { X: 4, O: 0 });
  assert.deepEqual(state.bonusScores, { X: 4, O: 0 });
});

test("independent full 9-cell lines each retain their 4-point value", () => {
  const state = Rules.createInitialGameState();
  [0, 1, 2].forEach((boardIndex) => {
    state.boards[boardIndex].winner = "X";
    state.boards[boardIndex].winningPatterns = [1];
    [3, 4, 5].forEach((cellIndex) => {
      state.boards[boardIndex].cells[cellIndex] = "X";
    });
  });
  [3, 4, 5].forEach((boardIndex) => {
    [0, 1, 2].forEach((cellIndex) => {
      state.boards[boardIndex].cells[cellIndex] = "X";
    });
  });

  Rules.calculateBonuses(state);

  assert.deepEqual(state.bonusBreakdown.overall, { X: 0, O: 0 });
  assert.deepEqual(state.bonusBreakdown.fullLines, { X: 8, O: 0 });
  assert.deepEqual(state.bonusScores, { X: 8, O: 0 });
});

test("overlapping vertical and diagonal achievements also score only 4 points", () => {
  const scenarios = [
    { boards: [2, 5, 8], cells: [1, 4, 7], pattern: 4 },
    { boards: [0, 4, 8], cells: [0, 4, 8], pattern: 6 },
    { boards: [2, 4, 6], cells: [2, 4, 6], pattern: 7 },
  ];

  scenarios.forEach((scenario) => {
    const state = Rules.createInitialGameState();
    scenario.boards.forEach((boardIndex) => {
      state.boards[boardIndex].winner = "O";
      state.boards[boardIndex].winningPatterns = [scenario.pattern];
      scenario.cells.forEach((cellIndex) => {
        state.boards[boardIndex].cells[cellIndex] = "O";
      });
    });

    Rules.calculateBonuses(state);

    assert.deepEqual(state.bonusBreakdown.overall, { X: 0, O: 0 });
    assert.deepEqual(state.bonusBreakdown.fullLines, { X: 0, O: 4 });
    assert.deepEqual(state.bonusScores, { X: 0, O: 4 });
  });
});

test("a common mini-board win pattern without a full 9-cell line scores 3 points", () => {
  const state = Rules.createInitialGameState();
  [0, 1, 2].forEach((boardIndex) => {
    state.boards[boardIndex].winner = "X";
    state.boards[boardIndex].winningPatterns = [4];
    [1, 4, 7].forEach((cellIndex) => {
      state.boards[boardIndex].cells[cellIndex] = "X";
    });
  });

  Rules.calculateBonuses(state);

  assert.deepEqual(state.bonusBreakdown.overall, { X: 3, O: 0 });
  assert.deepEqual(state.bonusBreakdown.fullLines, { X: 0, O: 0 });
  assert.deepEqual(state.bonusScores, { X: 3, O: 0 });
});

test("different mini-board win methods retain the normal 2-point overall bonus", () => {
  const state = Rules.createInitialGameState();
  [0, 1, 2].forEach((boardIndex, index) => {
    state.boards[boardIndex].winner = "O";
    state.boards[boardIndex].winningPatterns = [index];
  });

  Rules.calculateBonuses(state);

  assert.deepEqual(state.bonusBreakdown.overall, { X: 0, O: 2 });
});

test("all 9 cells in a physical column award 4 points", () => {
  const state = Rules.createInitialGameState();
  [2, 5, 8].forEach((boardIndex) => {
    [1, 4, 7].forEach((cellIndex) => {
      state.boards[boardIndex].cells[cellIndex] = "O";
    });
  });

  Rules.calculateBonuses(state);

  assert.deepEqual(state.bonusBreakdown.fullLines, { X: 0, O: 4 });
});

test("a move records every winning method created at once", () => {
  const state = Rules.createInitialGameState();
  state.boards[4].cells = ["O", "X", "O", "X", null, "X", "O", "X", "O"];

  Rules.applyMove(state, 4, 4, "X");

  assert.equal(state.boards[4].winner, "X");
  assert.ok(state.boards[4].winningPatterns.includes(1));
  assert.ok(state.boards[4].winningPatterns.includes(4));
});

test("total scores include mini-board and all bonus points", () => {
  const state = Rules.createInitialGameState();
  state.scores = { X: 4, O: 3 };
  state.bonusScores = { X: 8, O: 2 };
  assert.deepEqual(Rules.getTotalScores(state), { X: 12, O: 5 });
});
