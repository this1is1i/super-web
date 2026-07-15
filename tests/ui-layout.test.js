const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const css = fs.readFileSync(path.join(root, "css/main.css"), "utf8");
const main = fs.readFileSync(path.join(root, "js/main.js"), "utf8");

test("single-screen layout disables page scrolling and contains the required overlays", () => {
  assert.match(css, /html,[\s\S]*body\s*{[\s\S]*overflow:\s*hidden;/);
  assert.match(html, /id="settingsDrawer"/);
  assert.match(html, /id="settingsBackdrop"/);
  assert.match(html, /class="modal-overlay is-open"\s+id="rulesModal"/);
  assert.match(html, /id="rulesButton"/);
});

test("active-board highlighting is independent from local turn ownership", () => {
  assert.match(
    main,
    /board\.isActive\s*=\s*index === gameState\.currentBoard && !gameState\.isGameOver;/
  );
  assert.match(main, /if \(isMyTurn\) miniBoard\.classList\.add\("playable"\);/);
  assert.doesNotMatch(main, /board\.isActive\s*=.*isMyTurn/);
});

test("the visible history is capped at three entries", () => {
  assert.match(main, /while \(jumpLog\.children\.length > 3\)/);
  assert.match(css, /\.jump-log\s*{[\s\S]*grid-template-rows:\s*repeat\(3, 1fr\)/);
});
