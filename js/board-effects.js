// Presentation only. The shared rules remain the sole source of game transitions.
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.SuperTicTacToeEffects = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function snapshot(state) {
    return {
      moveCount: state.moveCount,
      currentPosition: state.currentPosition,
      mapping: state.positionToTile.slice(),
      tiles: state.tiles.map(function (tile) {
        return { id: tile.id, cells: tile.cells.slice(), winner: tile.winner };
      }),
    };
  }

  function describe(before, after) {
    if (!before || after.moveCount !== before.moveCount + 1) return null;
    var plan = { placed: [], removed: [], exchanged: [], won: [], route: null };
    after.tiles.forEach(function (tile) {
      var old = before.tiles[tile.id];
      tile.cells.forEach(function (symbol, cellIndex) {
        if (symbol && !old.cells[cellIndex]) plan.placed.push({ tileId: tile.id, cellIndex: cellIndex, symbol: symbol });
        if (!symbol && old.cells[cellIndex]) plan.removed.push({ tileId: tile.id, cellIndex: cellIndex, symbol: old.cells[cellIndex] });
      });
      if (!old.winner && (tile.winner === "X" || tile.winner === "O")) plan.won.push(tile.id);
      var from = before.mapping.indexOf(tile.id);
      var to = after.mapping.indexOf(tile.id);
      if (from !== to) plan.exchanged.push({ tileId: tile.id, from: from, to: to });
    });
    if (before.currentPosition !== after.currentPosition) {
      plan.route = { from: before.currentPosition, to: after.currentPosition };
    }
    return plan;
  }

  function create(root, document) {
    var previous = null;
    var animations = [];
    var decorations = [];
    var enabled = true;
    var reduced = root.matchMedia ? root.matchMedia("(prefers-reduced-motion: reduce)") : { matches: false };

    function clear() {
      animations.forEach(function (animation) { animation.cancel(); });
      decorations.forEach(function (node) { node.remove(); });
      animations = [];
      decorations = [];
    }

    function animate(node, frames, options, cleanup) {
      if (!node || typeof node.animate !== "function") { if (cleanup) cleanup(); return; }
      var animation = node.animate(frames, options);
      animations.push(animation);
      animation.finished.then(function () {
        animations = animations.filter(function (item) { return item !== animation; });
        if (cleanup) cleanup();
      }, function () { if (cleanup) cleanup(); });
    }

    function render(board, state) {
      clear();
      var next = snapshot(state);
      var plan = describe(previous, next);
      previous = next;
      if (!plan || !enabled || reduced.matches) return;
      function surface(tileId) { return board.querySelector('[data-tile-id="' + tileId + '"]'); }
      function cell(mark) { return surface(mark.tileId).querySelector('[data-cell-index="' + mark.cellIndex + '"]'); }
      plan.placed.forEach(function (mark) {
        animate(cell(mark), [
          { transform: "scale(.55)", opacity: 0 },
          { transform: "scale(1.12)", opacity: 1, offset: .65 },
          { transform: "scale(1)", opacity: 1 },
        ], { duration: 240, easing: "cubic-bezier(.2,.8,.2,1)" });
      });
      plan.removed.forEach(function (mark) {
        var ghost = document.createElement("span");
        ghost.className = "departing-mark " + mark.symbol.toLowerCase();
        ghost.textContent = mark.symbol;
        ghost.setAttribute("aria-hidden", "true");
        cell(mark).appendChild(ghost);
        decorations.push(ghost);
        animate(ghost, [
          { transform: "scale(1)", opacity: .85 },
          { transform: "scale(.15) translateY(-18px)", opacity: 0 },
        ], { duration: 300, easing: "ease-in", fill: "backwards" }, function () { ghost.remove(); });
      });
      plan.exchanged.forEach(function (item) {
        var node = surface(item.tileId);
        var from = board.querySelector('#board-' + item.from).getBoundingClientRect();
        var to = board.querySelector('#board-' + item.to).getBoundingClientRect();
        var x = from.left - to.left, y = from.top - to.top;
        node.style.zIndex = "15";
        node.inert = true;
        animate(node, [
          { transform: "translate(" + x + "px," + y + "px)", opacity: .8 },
          { transform: "translate(" + x / 2 + "px," + (y / 2 - 14) + "px) scale(.93)", offset: .5 },
          { transform: "translate(0,0)", opacity: 1 },
        ], { duration: 440, easing: "cubic-bezier(.22,.7,.24,1)" }, function () { node.style.zIndex = ""; node.inert = false; });
      });
      plan.won.forEach(function (tileId) {
        animate(surface(tileId), [{ filter: "brightness(1.8)" }, { filter: "brightness(1)" }], { duration: 650 });
      });
      if (plan.route && !state.isGameOver) {
        var bounds = board.getBoundingClientRect();
        var start = board.querySelector('#board-' + plan.route.from).getBoundingClientRect();
        var end = board.querySelector('#board-' + plan.route.to).getBoundingClientRect();
        var dx = end.left + end.width / 2 - start.left - start.width / 2;
        var dy = end.top + end.height / 2 - start.top - start.height / 2;
        var trail = document.createElement("span");
        trail.className = "route-trail";
        trail.setAttribute("aria-hidden", "true");
        trail.style.left = (start.left + start.width / 2 - bounds.left) + "px";
        trail.style.top = (start.top + start.height / 2 - bounds.top) + "px";
        trail.style.width = Math.hypot(dx, dy) + "px";
        trail.style.rotate = Math.atan2(dy, dx) + "rad";
        board.appendChild(trail);
        decorations.push(trail);
        animate(trail, [{ transform: "scaleX(0)", opacity: 0 }, { transform: "scaleX(1)", opacity: .7, offset: .6 }, { opacity: 0 }],
          { duration: 480, delay: plan.exchanged.length ? 250 : 80, fill: "both" }, function () { trail.remove(); });
      }
    }

    if (reduced.addEventListener) reduced.addEventListener("change", function () { if (reduced.matches) clear(); });
    return {
      render: render,
      settled: function () {
        return Promise.all(animations.map(function (animation) {
          return animation.finished.catch(function () {});
        }));
      },
      reset: function () { clear(); previous = null; },
      setEnabled: function (value) { enabled = value; if (!enabled) clear(); },
    };
  }
  return { snapshot: snapshot, describe: describe, create: create };
});
