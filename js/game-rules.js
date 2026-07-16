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
  var MATCHING_WIN_BONUS = 3;
  var FULL_LINE_BONUS = 4;
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

  function getValidatedConfig(config) {
    config = config || {};
    var boardVariant = config.boardVariant === undefined ? "normal" : config.boardVariant;
    var swapEvery = config.swapEvery === undefined ? 1 : config.swapEvery;
    if (["normal", "cycle", "chaos"].indexOf(boardVariant) === -1) {
      throw new Error("boardVariant must be normal, cycle, or chaos");
    }
    if (!Number.isInteger(swapEvery) || swapEvery < 1 || swapEvery > 20) {
      throw new Error("swapEvery must be an integer from 1 through 20");
    }
    return { boardVariant: boardVariant, swapEvery: swapEvery };
  }

  function createInitialGameState(options) {
    var config = getValidatedConfig(options);
    var tiles = Array.from({ length: BOARD_COUNT }, function (_, index) {
      return {
        id: index,
        cells: Array(CELL_COUNT).fill(null),
        winner: null,
        winningPatterns: [],
        isActive: index === CENTER_BOARD,
        fromTileId: null,
        fromBoard: null,
      };
    });
    var positionToTile = Array.from({ length: BOARD_COUNT }, function (_, index) {
      return index;
    });
    var gameState = {
      tiles: tiles,
      positionToTile: positionToTile,
      currentPosition: CENTER_BOARD,
      // Compatibility view for the existing server/client during migration.
      boards: tiles.slice(),
      currentBoard: CENTER_BOARD,
      boardVariant: config.boardVariant,
      swapEvery: config.swapEvery,
      moveCount: 0,
      cycleCursor: 0,
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
    return rehydrateGameState(gameState);
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

    WINNING_PATTERNS.forEach(function (pattern, overallPatternIndex) {
      var a = pattern[0], b = pattern[1], c = pattern[2];
      var winner = overallWinners[a];
      if (winner && winner !== "draw" && winner === overallWinners[b] && winner === overallWinners[c]) {
        var commonPatterns = getCommonWinningPatterns([
          gameState.boards[a], gameState.boards[b], gameState.boards[c],
        ]);
        var hasOverlappingFullLine = commonPatterns.some(function (localPatternIndex) {
          return getOverlappingFullLineIndex(overallPatternIndex, localPatternIndex) !== null;
        });
        if (commonPatterns.length === 0) {
          overall[winner] += NORMAL_OVERALL_BONUS;
        } else if (!hasOverlappingFullLine) {
          overall[winner] += MATCHING_WIN_BONUS;
        }
      }
    });

    FULL_BOARD_LINES.forEach(function (positions) {
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

  function normalizeFullTilesAsDraw(gameState) {
    gameState.tiles.forEach(function (tile) {
      if (
        tile.winner === null &&
        tile.cells.every(function (cell) { return cell !== null; })
      ) {
        tile.winner = "draw";
        tile.winningPatterns = [];
      }
    });
  }

  function checkGameEnd(gameState) {
    normalizeFullTilesAsDraw(gameState);
    var allBoardsEnded = gameState.boards.every(function (board) {
      return board.winner !== null;
    });
    if (!allBoardsEnded) return false;

    gameState.isGameOver = true;
    var totals = getTotalScores(gameState);
    gameState.overallWinner = totals.X === totals.O ? "draw" : (totals.X > totals.O ? "X" : "O");
    return true;
  }

  function getTileAtPosition(gameState, position) {
    return gameState.tiles[gameState.positionToTile[position]];
  }

  function findTilePosition(gameState, tileId) {
    return gameState.positionToTile.indexOf(tileId);
  }

  function syncPositionView(gameState) {
    gameState.boards = gameState.positionToTile.map(function (tileId) {
      return gameState.tiles[tileId];
    });
    gameState.currentBoard = gameState.currentPosition;
    gameState.boards.forEach(function (tile) {
      tile.fromBoard = tile.fromTileId === null
        ? null
        : findTilePosition(gameState, tile.fromTileId);
    });
  }

  function rehydrateGameState(gameState) {
    if (!gameState || !Array.isArray(gameState.tiles) || !Array.isArray(gameState.positionToTile)) {
      throw new Error("game state is missing tiles or positionToTile");
    }
    var config = getValidatedConfig(gameState);
    if (
      gameState.positionToTile.length !== BOARD_COUNT ||
      new Set(gameState.positionToTile).size !== BOARD_COUNT ||
      !gameState.positionToTile.every(function (tileId) {
        return Number.isInteger(tileId) && tileId >= 0 && tileId < BOARD_COUNT;
      })
    ) {
      throw new Error("positionToTile must be a permutation of tile ids 0 through 8");
    }
    if (gameState.tiles.length !== BOARD_COUNT) {
      throw new Error("tiles must contain exactly 9 entries");
    }
    gameState.tiles.forEach(function (tile, tileId) {
      if (!tile || typeof tile !== "object" || tile.id !== tileId) {
        throw new Error("each tile id must match its tiles array index");
      }
      if (!Array.isArray(tile.cells) || tile.cells.length !== CELL_COUNT) {
        throw new Error("each tile cells array must contain exactly 9 entries");
      }
      if (!tile.cells.every(function (cell) {
        return cell === null || cell === "X" || cell === "O";
      })) {
        throw new Error("each cell value must be null, X, or O");
      }
      if ([null, "X", "O", "draw"].indexOf(tile.winner) === -1) {
        throw new Error("tile winner must be null, X, O, or draw");
      }
      if (!Array.isArray(tile.winningPatterns)) {
        throw new Error("tile winningPatterns must be an array");
      }
      if (
        new Set(tile.winningPatterns).size !== tile.winningPatterns.length ||
        !tile.winningPatterns.every(function (patternIndex) {
          return Number.isInteger(patternIndex) &&
            patternIndex >= 0 && patternIndex < WINNING_PATTERNS.length;
        })
      ) {
        throw new Error("tile winningPatterns must contain unique valid pattern indexes");
      }
      if (
        tile.fromTileId !== null &&
        (!Number.isInteger(tile.fromTileId) || tile.fromTileId < 0 || tile.fromTileId >= BOARD_COUNT)
      ) {
        throw new Error("tile fromTileId must be null or a valid tile id");
      }
    });
    if (
      !Number.isInteger(gameState.currentPosition) ||
      gameState.currentPosition < 0 || gameState.currentPosition >= BOARD_COUNT
    ) {
      throw new Error("currentPosition must be a valid absolute position");
    }
    if (!Number.isInteger(gameState.moveCount) || gameState.moveCount < 0) {
      throw new Error("moveCount must be a non-negative integer");
    }
    if (
      !Number.isInteger(gameState.cycleCursor) ||
      gameState.cycleCursor < 0 || gameState.cycleCursor >= BOARD_COUNT
    ) {
      throw new Error("cycleCursor must be a valid exchange sequence index");
    }
    validateRuntimeFields(gameState);
    gameState.boardVariant = config.boardVariant;
    gameState.swapEvery = config.swapEvery;
    normalizeFullTilesAsDraw(gameState);
    syncPositionView(gameState);
    calculateBonuses(gameState);
    gameState.isGameOver = false;
    gameState.overallWinner = null;
    checkGameEnd(gameState);
    return gameState;
  }

  function isTilePlayable(tile) {
    return tile.winner === null && tile.cells.some(function (cell) { return cell === null; });
  }

  function findFallbackPosition(gameState, activeTileId) {
    var activeTile = gameState.tiles[activeTileId];
    if (isTilePlayable(activeTile)) return findTilePosition(gameState, activeTileId);

    var visited = new Set([activeTileId]);
    var sourceTileId = activeTile.fromTileId;
    while (sourceTileId !== null && !visited.has(sourceTileId)) {
      visited.add(sourceTileId);
      var sourceTile = gameState.tiles[sourceTileId];
      if (isTilePlayable(sourceTile)) return findTilePosition(gameState, sourceTileId);
      sourceTileId = sourceTile.fromTileId;
    }

    for (var position = 0; position < BOARD_COUNT; position++) {
      if (isTilePlayable(getTileAtPosition(gameState, position))) return position;
    }
    return null;
  }

  function validateExchange(exchange) {
    if (
      !Array.isArray(exchange) || exchange.length !== 2 ||
      !Number.isInteger(exchange[0]) || !Number.isInteger(exchange[1]) ||
      exchange[0] < 0 || exchange[0] >= BOARD_COUNT ||
      exchange[1] < 0 || exchange[1] >= BOARD_COUNT ||
      exchange[0] === exchange[1]
    ) {
      throw new Error("exchange must contain two different valid positions");
    }
  }

  function getLegalMoves(gameState) {
    if (gameState.isGameOver) return [];
    var position = gameState.currentPosition;
    var tile = getTileAtPosition(gameState, position);
    if (!tile || !isTilePlayable(tile)) return [];

    var moves = [];
    tile.cells.forEach(function (cell, cellIndex) {
      if (cell === null) moves.push({ position: position, cellIndex: cellIndex });
    });
    return moves;
  }

  function requiresExchangeOnNextTurn(gameState) {
    return (
      (gameState.boardVariant === "cycle" || gameState.boardVariant === "chaos") &&
      (gameState.moveCount + 1) % gameState.swapEvery === 0
    );
  }

  function getCycleExchangeForNextTurn(gameState) {
    if (gameState.boardVariant !== "cycle" || !requiresExchangeOnNextTurn(gameState)) {
      return null;
    }
    return [gameState.cycleCursor, (gameState.cycleCursor + 1) % BOARD_COUNT];
  }

  function validateRuntimeFields(gameState) {
    if (!gameState || typeof gameState !== "object") {
      throw new Error("game state is required");
    }
    if (gameState.currentPlayer !== "X" && gameState.currentPlayer !== "O") {
      throw new Error("currentPlayer must be X or O");
    }
    if (
      !gameState.scores || typeof gameState.scores !== "object" || Array.isArray(gameState.scores) ||
      !Number.isInteger(gameState.scores.X) || gameState.scores.X < 0 ||
      !Number.isInteger(gameState.scores.O) || gameState.scores.O < 0
    ) {
      throw new Error("scores must contain non-negative integer X and O values");
    }
    if (typeof gameState.isGameOver !== "boolean") {
      throw new Error("isGameOver must be a boolean");
    }
    if ([null, "X", "O", "draw"].indexOf(gameState.overallWinner) === -1) {
      throw new Error("overallWinner must be null, X, O, or draw");
    }
  }

  function validateTurn(gameState, turn) {
    validateRuntimeFields(gameState);
    if (!turn || typeof turn !== "object") throw new Error("turn is required");
    if (!Number.isInteger(turn.position) || turn.position < 0 || turn.position >= BOARD_COUNT) {
      throw new Error("turn.position must be a valid absolute position");
    }
    if (turn.position !== gameState.currentPosition) {
      throw new Error("turn.position must equal the current position");
    }
    if (!Number.isInteger(turn.cellIndex) || turn.cellIndex < 0 || turn.cellIndex >= CELL_COUNT) {
      throw new Error("turn.cellIndex must be a valid cell index");
    }
    if (turn.symbol !== "X" && turn.symbol !== "O") {
      throw new Error("turn.symbol must be X or O");
    }
    if (turn.symbol !== gameState.currentPlayer) {
      throw new Error("turn.symbol must equal the current player");
    }
    if (gameState.isGameOver) throw new Error("the game is already over");

    var tile = getTileAtPosition(gameState, turn.position);
    if (!tile || !isTilePlayable(tile) || tile.cells[turn.cellIndex] !== null) {
      throw new Error("turn is not a legal move");
    }

    if (
      gameState.boardVariant === "chaos" &&
      requiresExchangeOnNextTurn(gameState)
    ) {
      validateExchange(turn.exchangePair);
    }

  }

  function getTurnExchange(gameState, explicitExchange) {
    if (!requiresExchangeOnNextTurn(gameState)) return null;

    if (gameState.boardVariant === "cycle") {
      var exchange = getCycleExchangeForNextTurn(gameState);
      gameState.cycleCursor = (gameState.cycleCursor + 1) % BOARD_COUNT;
      return exchange;
    }
    if (gameState.boardVariant === "chaos") {
      validateExchange(explicitExchange);
      return explicitExchange.slice();
    }
    throw new Error("unknown board variant: " + gameState.boardVariant);
  }

  function applyTurn(gameState, turn) {
    validateTurn(gameState, turn);
    var boardIndex = turn.position;
    var cellIndex = turn.cellIndex;
    var symbol = turn.symbol;
    var explicitExchange = turn.exchangePair;
    var activeTile = getTileAtPosition(gameState, boardIndex);
    var activeTileId = activeTile.id;
    activeTile.cells[cellIndex] = symbol;

    var winningPatterns = getWinningPatternIndexes(gameState, boardIndex);
    if (winningPatterns.length > 0) {
      activeTile.winner = symbol;
      activeTile.winningPatterns = winningPatterns;
      gameState.scores[symbol]++;
    } else if (activeTile.cells.every(function (cell) { return cell !== null; })) {
      activeTile.winner = "draw";
      activeTile.winningPatterns = [];
    }

    var exchange = getTurnExchange(gameState, explicitExchange);
    gameState.moveCount++;
    if (exchange) {
      var firstTileId = gameState.positionToTile[exchange[0]];
      gameState.positionToTile[exchange[0]] = gameState.positionToTile[exchange[1]];
      gameState.positionToTile[exchange[1]] = firstTileId;
    }

    var nextPosition = cellIndex;
    if (!isTilePlayable(getTileAtPosition(gameState, nextPosition))) {
      nextPosition = findFallbackPosition(gameState, activeTileId);
    }
    if (nextPosition !== null) {
      gameState.currentPosition = nextPosition;
      var nextTile = getTileAtPosition(gameState, nextPosition);
      if (nextTile.id !== activeTileId) nextTile.fromTileId = activeTileId;
    }

    syncPositionView(gameState);
    gameState.currentPlayer = symbol === "X" ? "O" : "X";
    calculateBonuses(gameState);
    var gameOver = checkGameEnd(gameState);
    return {
      gameOver: gameOver,
      winningPatterns: winningPatterns,
      exchange: exchange,
    };
  }

  function applyMove(gameState, boardIndex, cellIndex, symbol) {
    return applyTurn(gameState, {
      position: boardIndex,
      cellIndex: cellIndex,
      symbol: symbol,
    });
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
    getTileAtPosition: getTileAtPosition,
    findTilePosition: findTilePosition,
    rehydrateGameState: rehydrateGameState,
    getLegalMoves: getLegalMoves,
    requiresExchangeOnNextTurn: requiresExchangeOnNextTurn,
    getCycleExchangeForNextTurn: getCycleExchangeForNextTurn,
    applyTurn: applyTurn,
    applyMove: applyMove,
    hasAnyMove: hasAnyMove,
  };
});
