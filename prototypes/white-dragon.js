"use strict";
const motion = document.querySelector("#motion");
const hello = document.querySelector("#hello");
const backdrop = document.querySelector("#backdrop");
const speech = document.querySelector("#speech");
const stage = document.querySelector(".stage");
const greeting = document.querySelector("#greeting");
const reduced = matchMedia("(prefers-reduced-motion: reduce)");
let enabled = !reduced.matches;
let wave = null;
function syncMotion() {
  const running = enabled && !reduced.matches;
  document.body.dataset.motion = running ? "on" : "off";
  motion.textContent = reduced.matches ? "系统已减少动效" : running ? "暂停动效" : "开启动效";
  motion.setAttribute("aria-pressed", String(running));
  motion.disabled = reduced.matches;
  if (!running && wave) wave.cancel();
}
motion.addEventListener("click", () => { enabled = !enabled; syncMotion(); });
reduced.addEventListener("change", syncMotion);
stage.addEventListener("pointermove", (event) => {
  if (!enabled || reduced.matches || event.pointerType !== "mouse") return;
  const box = stage.getBoundingClientRect();
  const x = (event.clientX - box.left) / box.width - .5;
  const y = (event.clientY - box.top) / box.height - .5;
  stage.style.setProperty("--pointer-x", x * 12 + "px");
  stage.style.setProperty("--pointer-y", y * 7 + "px");
  stage.style.setProperty("--pointer-rotate", x * 2 + "deg");
});
stage.addEventListener("pointerleave", () => {
  ["--pointer-x", "--pointer-y", "--pointer-rotate"].forEach((name) => stage.style.removeProperty(name));
});
hello.addEventListener("click", () => {
  speech.textContent = "收到！今天也一起下出漂亮的一步吧。";
  if (!enabled || reduced.matches) return;
  if (wave) wave.cancel();
  wave = greeting.animate([
    { transform: "translateY(0) rotate(0)" },
    { transform: "translateY(-12px) rotate(-3deg)", offset: .3 },
    { transform: "translateY(-5px) rotate(2deg)", offset: .65 },
    { transform: "translateY(0) rotate(0)" },
  ], { duration: 850, easing: "ease-in-out" });
});
backdrop.addEventListener("click", () => {
  const light = document.body.dataset.background !== "light";
  document.body.dataset.background = light ? "light" : "dark";
  backdrop.setAttribute("aria-pressed", String(light));
  backdrop.textContent = light ? "切换深色背景" : "切换浅色背景";
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    document.body.dataset.motion = "off";
    if (wave) wave.cancel();
  } else syncMotion();
});
syncMotion();
