// Shared Super Tic-Tac-Toe rules for both Node.js and the browser.
(function (root, factory) {
  "use strict";
  var rules = factory();
  if (typeof module === "object" && module.exports) module.exports = rules;
  if (root) root.SuperTicTacToeRules = rules;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var BOARD_COUNT = 9;
  var CELL_COUNT = 9;
  var CENTER_BOARD = 4;
  var NORMAL_OVERALL_BONUS = 2;
  var MATCHING_WIN_BONUS = 4;
  var FULL_LINE_BONUS = 3;
  var WINNING_PATTERNS = [
    [0, 1, 2], [3, 4, 5], [6, 7, 8],
    [0, 3, 6], [1, 4, 7], [2, 5, 8],
    [0, 4, 8], [2, 4, 6],
  ];

  // The 9 rows, 9 columns and 2 diagonals of the physical 9x9 board.
  var FULL_BOARD_LINES = [];
  var macroIndex;
  var localIndex;
  var segment;
  var line;

  for (macroIndex = 0; macroIndex < 3; macroIndex++) {
    for (localIndex = 0; localIndex < 3; localIndex++) {
      line = [];
      for (segment = 0; segment < 3; segment++) {
        for (var localColumn = 0; localColumn < 3; localColumn++) {
          line.push([macroIndex * 3 + segment, localIndex * 3 + localColumn]);
        }
      }
      FULL_BOARD_LINES.push(line);
    }
  }

  for (macroIndex = 0; macroIndex < 3; macroIndex++) {
    for (localIndex = 0; localIndex < 3; localIndex++) {
      line = [];
      for (segment = 0; segment < 3; segment++) {
        for (var localRow = 0; localRow < 3; localRow++) {
          line.push([segment * 3 + macroIndex, localRow * 3 + localIndex]);
        }
      }
      FULL_BOARD_LINES.push(line);
    }
  }

  line = [];
  for (segment = 0; segment < 3; segment++) {
    for (localIndex = 0; localIndex < 3; localIndex++) {
      line.push([segment * 4, localIndex * 4]);
    }
  }
  FULL_BOARD_LINES.push(line);

  line = [];
  for (segment = 0; segment < 3; segment++) {
    for (localIndex = 0; localIndex < 3; localIndex++) {
      line.push([2 + segment * 2, 2 + localIndex * 2]);
    }
  }
  FULL_BOARD_LINES.push(line);

  function createInitialGameState() {
    return {
      boards: Array.from({ length: BOARD_COUNT }, function (_, index) {
        return {
          cells: Array(CELL_COUNT).fill(null),
          winner: null,
          winningPatterns: [],
          isActive: index === CENTER_BOARD,
          fromBoard: null,
        };
      }),
      currentBoard: CENTER_BOARD,
      currentPlayer: "X",
      scores: { X: 0, O: 0 },
      bonusScores: { X: 0, O: 0 },
      bonusBreakdown: {
        overall: { X: 0, O: 0 },
        fullLines: { X: 0, O: 0 },
      },
      isGameOver: false,
      overallWinner: null,
    };
  }

  function getWinningPatternIndexes(gameState, boardIndex, cellsOverride) {
    var cells = cellsOverride || gameState.boards[boardIndex].cells;
    var result = [];
    for (var index = 0; index < WINNING_PATTERNS.length; index++) {
      var pattern = WINNING_PATTERNS[index];
      var a = pattern[0], b = pattern[1], c = pattern[2];
      if (cells[a] && cells[a] === cells[b] && cells[a] === cells[c]) {
        result.push(index);
      }
    }
    return result;
  }

  function checkMiniBoardWin(gameState, boardIndex) {
    return getWinningPatternIndexes(gameState, boardIndex).length > 0;
  }

  function checkMiniBoardDraw(gameState, boardIndex) {
    var board = gameState.boards[boardIndex];
    return board.cells.every(function (cell) { return cell !== null; }) && !board.winner;
  }

  function findRecursiveAvailableBoard(gameState, boardIndex) {
    var visited = new Set();
    var stack = [boardIndex];
    while (stack.length > 0) {
      var current = stack.pop();
      if (visited.has(current)) continue;
      visited.add(current);
      var fromBoard = gameState.boards[current].fromBoard;
      if (fromBoard === null) break;
      if (!gameState.boards[fromBoard].winner) return fromBoard;
      stack.push(fromBoard);
    }
    return null;
  }

  function findFallbackBoardAfterWin(gameState, wonBoardIndex) {
    var fromBoard = gameState.boards[wonBoardIndex].fromBoard;
    if (fromBoard !== null && !gameState.boards[fromBoard].winner) return fromBoard;
    if (fromBoard !== null) {
      var recursiveBoard = findRecursiveAvailableBoard(gameState, fromBoard);
      if (recursiveBoard !== null) return recursiveBoard;
    }
    for (var index = 0; index < BOARD_COUNT; index++) {
      if (index !== wonBoardIndex && !gameState.boards[index].winner) return index;
    }
    return null;
  }

  function findNextBoardAfterWin(gameState, wonBoardIndex, moveCellIndex) {
    if (!gameState.boards[moveCellIndex].winner) return moveCellIndex;
    return findFallbackBoardAfterWin(gameState, wonBoardIndex);
  }

  function getCommonWinningPatterns(boards) {
    if (!boards.length || !boards[0].winningPatterns.length) return [];
    return boards[0].winningPatterns.filter(function (patternIndex) {
      return boards.slice(1).every(function (board) {
        return board.winningPatterns.indexOf(patternIndex) !== -1;
      });
    });
  }

  function getOverlappingFullLineIndex(overallPatternIndex, localPatternIndex) {
    if (overallPatternIndex <= 2 && localPatternIndex <= 2) {
      return overallPatternIndex * 3 + localPatternIndex;
    }
    if (
      overallPatternIndex >= 3 && overallPatternIndex <= 5 &&
      localPatternIndex >= 3 && localPatternIndex <= 5
    ) {
      return 9 + (overallPatternIndex - 3) * 3 + (localPatternIndex - 3);
    }
    if (overallPatternIndex === 6 && localPatternIndex === 6) return 18;
    if (overallPatternIndex === 7 && localPatternIndex === 7) return 19;
    return null;
  }

  function calculateBonuses(gameState) {
    var overall = { X: 0, O: 0 };
    var fullLines = { X: 0, O: 0 };
    var overallWinners = gameState.boards.map(function (board) { return board.winner; });
    var overlappingFullLines = new Set();

    WINNING_PATTERNS.forEach(function (pattern, overallPatternIndex) {
      var a = pattern[0], b = pattern[1], c = pattern[2];
      var winner = overallWinners[a];
      if (winner && winner !== "draw" && winner === overallWinners[b] && winner === overallWinners[c]) {
        var commonPatterns = getCommonWinningPatterns([
          gameState.boards[a], gameState.boards[b], gameState.boards[c],
        ]);
        overall[winner] += commonPatterns.length > 0 ? MATCHING_WIN_BONUS : NORMAL_OVERALL_BONUS;
        commonPatterns.forEach(function (localPatternIndex) {
          var fullLineIndex = getOverlappingFullLineIndex(overallPatternIndex, localPatternIndex);
          if (fullLineIndex !== null) overlappingFullLines.add(fullLineIndex);
        });
      }
    });

    FULL_BOARD_LINES.forEach(function (positions, fullLineIndex) {
      if (overlappingFullLines.has(fullLineIndex)) return;
      var first = gameState.boards[positions[0][0]].cells[positions[0][1]];
      if (!first) return;
      var isComplete = positions.every(function (position) {
        return gameState.boards[position[0]].cells[position[1]] === first;
      });
      if (isComplete) fullLines[first] += FULL_LINE_BONUS;
    });

    gameState.bonusBreakdown = { overall: overall, fullLines: fullLines };
    gameState.bonusScores = {
      X: overall.X + fullLines.X,
      O: overall.O + fullLines.O,
    };
    return gameState.bonusScores;
  }

  function getTotalScores(gameState) {
    return {
      X: gameState.scores.X + (gameState.bonusScores.X || 0),
      O: gameState.scores.O + (gameState.bonusScores.O || 0),
    };
  }

  function checkGameEnd(gameState) {
    var allBoardsEnded = gameState.boards.every(function (board) {
      return board.winner !== null;
    });
    if (!allBoardsEnded) return false;

    gameState.isGameOver = true;
    var totals = getTotalScores(gameState);
    gameState.overallWinner = totals.X === totals.O ? "draw" : (totals.X > totals.O ? "X" : "O");
    return true;
  }

  function applyMove(gameState, boardIndex, cellIndex, symbol) {
    var board = gameState.boards[boardIndex];
    board.cells[cellIndex] = symbol;

    var winningPatterns = getWinningPatternIndexes(gameState, boardIndex);
    if (winningPatterns.length > 0) {
      board.winner = symbol;
      board.winningPatterns = winningPatterns;
      gameState.scores[symbol]++;
      var wonNextBoard = findNextBoardAfterWin(gameState, boardIndex, cellIndex);
      if (wonNextBoard !== null) {
        gameState.currentBoard = wonNextBoard;
        gameState.boards[wonNextBoard].fromBoard = boardIndex;
      }
    } else if (checkMiniBoardDraw(gameState, boardIndex)) {
      board.winner = "draw";
      board.winningPatterns = [];
      var drawNextBoard = findNextBoardAfterWin(gameState, boardIndex, cellIndex);
      if (drawNextBoard !== null) {
        gameState.currentBoard = drawNextBoard;
        gameState.boards[drawNextBoard].fromBoard = boardIndex;
      }
    } else if (!gameState.boards[cellIndex].winner) {
      gameState.currentBoard = cellIndex;
      gameState.boards[cellIndex].fromBoard = boardIndex;
    } else {
      gameState.currentBoard = boardIndex;
    }

    gameState.currentPlayer = symbol === "X" ? "O" : "X";
    calculateBonuses(gameState);
    var gameOver = checkGameEnd(gameState);
    return { gameOver: gameOver, winningPatterns: winningPatterns };
  }

  function hasAnyMove(gameState) {
    return gameState.boards.some(function (board) {
      return board.cells.some(function (cell) { return cell !== null; });
    });
  }

  return {
    BOARD_COUNT: BOARD_COUNT,
    CELL_COUNT: CELL_COUNT,
    CENTER_BOARD: CENTER_BOARD,
    WINNING_PATTERNS: WINNING_PATTERNS,
    FULL_BOARD_LINES: FULL_BOARD_LINES,
    createInitialGameState: createInitialGameState,
    getWinningPatternIndexes: getWinningPatternIndexes,
    checkMiniBoardWin: checkMiniBoardWin,
    checkMiniBoardDraw: checkMiniBoardDraw,
    findRecursiveAvailableBoard: findRecursiveAvailableBoard,
    findFallbackBoardAfterWin: findFallbackBoardAfterWin,
    findNextBoardAfterWin: findNextBoardAfterWin,
    calculateBonuses: calculateBonuses,
    getTotalScores: getTotalScores,
    checkGameEnd: checkGameEnd,
    applyMove: applyMove,
    hasAnyMove: hasAnyMove,
  };
});
