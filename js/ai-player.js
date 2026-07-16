// AI turn selection for Super Tic-Tac-Toe.
// The engine never applies game rules itself: legal turns and every simulated
// transition are delegated to the injected shared rules module.
(function (root, factory) {
  "use strict";
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.SuperTicTacToeAI = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var WIN_SCORE = 1000000000;
  var DEFAULT_HARD_DEPTH = 4;
  var DEFAULT_HARD_TIME_MS = 600;

  function createAbortError() {
    var error = new Error("AI turn selection was cancelled");
    error.name = "AbortError";
    return error;
  }

  function createTimeLimitError() {
    var error = new Error("AI search time limit reached");
    error.name = "TimeLimitError";
    return error;
  }

  function cloneState(state, Rules) {
    if (typeof structuredClone === "function") return structuredClone(state);
    var cloned = JSON.parse(JSON.stringify(state));
    if (typeof Rules.rehydrateGameState === "function") {
      return Rules.rehydrateGameState(cloned) || cloned;
    }
    return cloned;
  }

  function opposite(symbol) {
    return symbol === "X" ? "O" : "X";
  }

  function createAI(Rules) {
    if (!Rules || typeof Rules.getLegalMoves !== "function") {
      throw new TypeError("AI requires Rules.getLegalMoves(state)");
    }
    if (typeof Rules.applyTurn !== "function") {
      throw new TypeError("AI requires Rules.applyTurn(state, turn)");
    }
    if (typeof Rules.getTotalScores !== "function") {
      throw new TypeError("AI requires Rules.getTotalScores(state)");
    }

    function normalizeExchangePair(pair) {
      if (pair === undefined || pair === null) return null;
      if (
        !Array.isArray(pair) || pair.length !== 2 ||
        !Number.isInteger(pair[0]) || !Number.isInteger(pair[1]) ||
        pair[0] < 0 || pair[0] > 8 || pair[1] < 0 || pair[1] > 8 ||
        pair[0] === pair[1]
      ) {
        throw new TypeError("exchangePair must contain two different integer positions from 0 to 8");
      }
      return [pair[0], pair[1]];
    }

    function normalizeOptions(state, options) {
      var source = options || {};
      var difficulty = source.difficulty || "normal";
      if (difficulty !== "normal" && difficulty !== "hard") {
        throw new TypeError("difficulty must be normal or hard");
      }

      var pair = normalizeExchangePair(source.exchangePair);

      var maxDepth = source.maxDepth === undefined ? DEFAULT_HARD_DEPTH : source.maxDepth;
      maxDepth = Number(maxDepth);
      maxDepth = Number.isFinite(maxDepth) ? Math.max(0, Math.floor(maxDepth)) : DEFAULT_HARD_DEPTH;

      var timeLimitMs = source.timeLimitMs === undefined
        ? DEFAULT_HARD_TIME_MS
        : Math.max(0, Number(source.timeLimitMs) || 0);

      return {
        difficulty: difficulty,
        symbol: source.symbol || state.currentPlayer,
        exchangePair: pair,
        resolveExchangePair: typeof source.resolveExchangePair === "function"
          ? source.resolveExchangePair
          : null,
        rng: typeof source.rng === "function" ? source.rng : Math.random,
        maxDepth: maxDepth,
        timeLimitMs: timeLimitMs,
        now: typeof source.now === "function" ? source.now : Date.now,
        signal: source.signal || null,
        yieldControl: typeof source.yieldControl === "function"
          ? source.yieldControl
          : function () {
            return new Promise(function (resolve) { setTimeout(resolve, 0); });
          },
      };
    }

    function throwIfCancelled(config) {
      if (config.signal && config.signal.aborted) throw createAbortError();
    }

    function checkSearchBudget(config, deadline) {
      throwIfCancelled(config);
      if (config.now() >= deadline) throw createTimeLimitError();
    }

    function pairForPly(state, config, ply) {
      var pair;
      if (ply === 0 && config.exchangePair) {
        pair = config.exchangePair;
      } else if (config.resolveExchangePair) {
        pair = config.resolveExchangePair(state, ply);
      }
      if (pair === undefined || pair === null) {
        if (typeof Rules.getCycleExchangeForNextTurn === "function") {
          pair = Rules.getCycleExchangeForNextTurn(state);
        }
      }
      return normalizeExchangePair(pair);
    }

    function legalTurns(state, symbol, exchangePair) {
      var moves = Rules.getLegalMoves(state);
      if (!Array.isArray(moves)) {
        throw new TypeError("Rules.getLegalMoves(state) must return an array");
      }
      return moves.map(function (move) {
        return {
          position: move.position,
          cellIndex: move.cellIndex,
          symbol: symbol,
          exchangePair: exchangePair ? [exchangePair[0], exchangePair[1]] : null,
        };
      });
    }

    function totalScores(state) {
      return Rules.getTotalScores(state);
    }

    function evaluate(state, rootSymbol, remainingDepth) {
      if (state.isGameOver || state.overallWinner) {
        if (state.overallWinner === rootSymbol) return WIN_SCORE + remainingDepth;
        if (state.overallWinner === "draw") return 0;
        if (state.overallWinner === opposite(rootSymbol)) return -WIN_SCORE - remainingDepth;
      }

      var totals = totalScores(state);
      var opponent = opposite(rootSymbol);
      var score = ((totals[rootSymbol] || 0) - (totals[opponent] || 0)) * 1000;

      if (Array.isArray(state.boards)) {
        state.boards.forEach(function (board) {
          if (board.winner === rootSymbol) score += 100;
          if (board.winner === opponent) score -= 100;
        });
      }
      return score;
    }

    function applyForEvaluation(state, turn) {
      var next = cloneState(state, Rules);
      Rules.applyTurn(next, turn);
      return next;
    }

    function pickRandomTurn(turns, config) {
      var randomValue = Number(config.rng());
      if (!Number.isFinite(randomValue)) randomValue = 0;
      randomValue = Math.max(0, Math.min(0.9999999999999999, randomValue));
      return turns[Math.floor(randomValue * turns.length)];
    }

    function chooseNormal(state, config, deadline) {
      throwIfCancelled(config);
      var turns = legalTurns(state, config.symbol, pairForPly(state, config, 0));
      if (turns.length === 0) throw new Error("No legal turn exists");

      var bestScore = -Infinity;
      var bestTurns = [];
      for (var index = 0; index < turns.length; index++) {
        if (deadline !== undefined) {
          try {
            checkSearchBudget(config, deadline);
          } catch (error) {
            if (error && error.name === "TimeLimitError") {
              return bestTurns.length > 0 ? pickRandomTurn(bestTurns, config) : turns[0];
            }
            throw error;
          }
        } else {
          throwIfCancelled(config);
        }
        var turn = turns[index];
        var score = evaluate(applyForEvaluation(state, turn), config.symbol, 0);
        if (score > bestScore) {
          bestScore = score;
          bestTurns = [turn];
        } else if (score === bestScore) {
          bestTurns.push(turn);
        }
      }
      return pickRandomTurn(bestTurns, config);
    }

    function minimax(state, depth, alpha, beta, rootSymbol, config, deadline, ply) {
      checkSearchBudget(config, deadline);
      if (depth === 0 || state.isGameOver || state.overallWinner) {
        return evaluate(state, rootSymbol, depth);
      }

      var symbol = state.currentPlayer;
      var turns = legalTurns(state, symbol, pairForPly(state, config, ply));
      if (turns.length === 0) return evaluate(state, rootSymbol, depth);
      var maximizing = symbol === rootSymbol;
      var best = maximizing ? -Infinity : Infinity;

      for (var index = 0; index < turns.length; index++) {
        checkSearchBudget(config, deadline);
        var next = applyForEvaluation(state, turns[index]);
        var score = minimax(
          next, depth - 1, alpha, beta, rootSymbol, config, deadline, ply + 1
        );
        if (maximizing) {
          best = Math.max(best, score);
          alpha = Math.max(alpha, best);
        } else {
          best = Math.min(best, score);
          beta = Math.min(beta, best);
        }
        if (beta <= alpha) break;
      }
      return best;
    }

    function searchOneDepth(state, config, depth, deadline) {
      var turns = legalTurns(state, config.symbol, pairForPly(state, config, 0));
      var bestTurn = null;
      var bestScore = -Infinity;

      for (var index = 0; index < turns.length; index++) {
        checkSearchBudget(config, deadline);
        var next = applyForEvaluation(state, turns[index]);
        var score = minimax(
          next, depth - 1, -Infinity, Infinity,
          config.symbol, config, deadline, 1
        );
        if (score > bestScore) {
          bestScore = score;
          bestTurn = turns[index];
        }
      }
      return bestTurn;
    }

    function findTacticalTurn(state, config, deadline) {
      var turns = legalTurns(state, config.symbol, pairForPly(state, config, 0));
      var candidates = [];
      var startingTotals = totalScores(state);
      var index;

      for (index = 0; index < turns.length; index++) {
        checkSearchBudget(config, deadline);
        var next = applyForEvaluation(state, turns[index]);
        var nextTotals = totalScores(next);
        if (next.overallWinner === config.symbol) return turns[index];
        candidates.push({
          turn: turns[index],
          state: next,
          totals: nextTotals,
          ownGain: (nextTotals[config.symbol] || 0) - (startingTotals[config.symbol] || 0),
          opponentLoss: next.overallWinner === opposite(config.symbol) ? WIN_SCORE : 0,
          terminalLoss: next.overallWinner === opposite(config.symbol),
          terminalDraw: next.overallWinner === "draw",
        });
      }

      var safeTurns = [];
      var foundImmediateThreat = false;
      for (index = 0; index < candidates.length; index++) {
        checkSearchBudget(config, deadline);
        var candidate = candidates[index];
        if (candidate.terminalLoss) {
          foundImmediateThreat = true;
          continue;
        }
        if (candidate.terminalDraw) {
          safeTurns.push(candidate);
          continue;
        }
        var opponent = candidate.state.currentPlayer;
        var replies = legalTurns(
          candidate.state, opponent, pairForPly(candidate.state, config, 1)
        );
        var losesImmediately = false;
        for (var replyIndex = 0; replyIndex < replies.length; replyIndex++) {
          checkSearchBudget(config, deadline);
          var replyState = applyForEvaluation(candidate.state, replies[replyIndex]);
          var replyTotals = totalScores(replyState);
          var opponentGain = (replyTotals[opponent] || 0) - (candidate.totals[opponent] || 0);
          if (replyState.overallWinner === opponent) opponentGain = WIN_SCORE;
          candidate.opponentLoss = Math.max(candidate.opponentLoss, opponentGain);
          if (opponentGain > 0) {
            losesImmediately = true;
            foundImmediateThreat = true;
          }
        }
        if (!losesImmediately) safeTurns.push(candidate);
      }

      if (safeTurns.length > 0) {
        var bestSafe = safeTurns[0];
        for (index = 1; index < safeTurns.length; index++) {
          if (safeTurns[index].ownGain > bestSafe.ownGain) bestSafe = safeTurns[index];
        }
        if (foundImmediateThreat || bestSafe.ownGain > 0) return bestSafe.turn;
        return null;
      }

      if (candidates.length > 0 && foundImmediateThreat) {
        var leastLoss = candidates[0];
        for (index = 1; index < candidates.length; index++) {
          if (
            candidates[index].opponentLoss < leastLoss.opponentLoss ||
            (
              candidates[index].opponentLoss === leastLoss.opponentLoss &&
              candidates[index].ownGain > leastLoss.ownGain
            )
          ) {
            leastLoss = candidates[index];
          }
        }
        return leastLoss.turn;
      }
      return null;
    }

    function chooseHardSync(state, config) {
      var deadline = config.now() + config.timeLimitMs;
      var firstTurns = legalTurns(state, config.symbol, pairForPly(state, config, 0));
      if (firstTurns.length === 0) throw new Error("No legal turn exists");
      var fallback = firstTurns[0];
      if (config.timeLimitMs === 0) return fallback;

      try {
        var tactical = findTacticalTurn(state, config, deadline);
        if (tactical) return tactical;
      } catch (error) {
        if (error && error.name === "TimeLimitError") return fallback;
        throw error;
      }
      fallback = chooseNormal(state, config, deadline);
      var best = fallback;
      for (var depth = 1; depth <= config.maxDepth; depth++) {
        try {
          best = searchOneDepth(state, config, depth, deadline) || best;
        } catch (error) {
          if (error && error.name === "TimeLimitError") break;
          throw error;
        }
      }
      return best;
    }

    function chooseTurnSync(state, options) {
      var config = normalizeOptions(state, options);
      throwIfCancelled(config);
      if (config.difficulty === "normal") return chooseNormal(state, config);
      return chooseHardSync(state, config);
    }

    async function chooseTurn(state, options) {
      var config = normalizeOptions(state, options);
      throwIfCancelled(config);
      if (config.difficulty === "normal") return chooseNormal(state, config);

      var deadline = config.now() + config.timeLimitMs;
      var firstTurns = legalTurns(state, config.symbol, pairForPly(state, config, 0));
      if (firstTurns.length === 0) throw new Error("No legal turn exists");
      var fallback = firstTurns[0];
      if (config.timeLimitMs === 0) return fallback;

      try {
        var tactical = findTacticalTurn(state, config, deadline);
        if (tactical) return tactical;
      } catch (error) {
        if (error && error.name === "TimeLimitError") return fallback;
        throw error;
      }
      fallback = chooseNormal(state, config, deadline);
      var best = fallback;

      for (var depth = 1; depth <= config.maxDepth; depth++) {
        await config.yieldControl();
        throwIfCancelled(config);
        try {
          best = searchOneDepth(state, config, depth, deadline) || best;
        } catch (error) {
          if (error && error.name === "TimeLimitError") break;
          throw error;
        }
      }
      return best;
    }

    return {
      chooseTurn: chooseTurn,
      chooseTurnSync: chooseTurnSync,
    };
  }

  return { createAI: createAI };
});
