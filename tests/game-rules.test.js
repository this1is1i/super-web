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

test("a matching-method overall win and a full 9-cell line stack to 8 points", () => {
  const state = Rules.createInitialGameState();
  [0, 1, 2].forEach((boardIndex) => {
    state.boards[boardIndex].winner = "X";
    state.boards[boardIndex].winningPatterns = [1];
    [3, 4, 5].forEach((cellIndex) => {
      state.boards[boardIndex].cells[cellIndex] = "X";
    });
  });

  Rules.calculateBonuses(state);

  assert.deepEqual(state.bonusBreakdown.overall, { X: 5, O: 0 });
  assert.deepEqual(state.bonusBreakdown.fullLines, { X: 3, O: 0 });
  assert.deepEqual(state.bonusScores, { X: 8, O: 0 });
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

test("all 9 cells in a physical column award 3 points", () => {
  const state = Rules.createInitialGameState();
  [2, 5, 8].forEach((boardIndex) => {
    [1, 4, 7].forEach((cellIndex) => {
      state.boards[boardIndex].cells[cellIndex] = "O";
    });
  });

  Rules.calculateBonuses(state);

  assert.deepEqual(state.bonusBreakdown.fullLines, { X: 0, O: 3 });
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
