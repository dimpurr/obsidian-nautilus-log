/*
 * progress-click.test.js — 盘面切片点击接线（spiral.ts 的 onProgressClick）。
 *
 * 与 tooltip.test.js 同一套 jsdom 打法：bundle 真 spiral.ts，渲染进一个
 * 非紧凑（clientWidth 600 > 520）容器 —— 那正是 hover/focus 通路存在的分支，
 * 点击也必须挂在那里（紧凑侧栏没有可交互切片，P1-8）。
 *
 * 覆盖：
 *   · 任务切片被点 → 回调收到该任务的 uid（按 allEvents 顺序定位切片）
 *   · 事件（meeting）切片不可点（对齐上游 click-to-progress）
 *   · destroy() 摘掉点击监听（防重渲染泄漏）
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { JSDOM } = require("jsdom");
const esbuild = require("esbuild");
const path = require("node:path");

const dom = new JSDOM("<!doctype html><body></body>", {
  pretendToBeVisual: true,
  url: "http://localhost/",
});
global.window = dom.window;
global.document = dom.window.document;

const result = esbuild.buildSync({
  entryPoints: [path.join(__dirname, "../src/spiral.ts")],
  bundle: true,
  format: "cjs",
  platform: "node",
  write: false,
  external: ["obsidian"],
  logLevel: "error",
});
const mod = { exports: {} };
// eslint-disable-next-line no-new-func
new Function("module", "exports", "require", result.outputFiles[0].text)(
  mod, mod.exports, require,
);
const { renderSpiral } = mod.exports;

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

const plan = {
  events: [
    { uid: "ev-1", string: "Standup", start: 480, end: 510, meeting: true, done: false },
  ],
  tasks: [
    { uid: "tk-1", string: "- [ ] Write report 60m", duration: 60, done: false },
  ],
  malformed: [],
};

const capacity = {
  availableMinutes: 0,
  demandMinutes: 0,
  overloadMinutes: 0,
  slackMinutes: 0,
  unplacedMinutes: 0,
  fixedMinutes: 0,
  totalAvailableMinutes: 0,
  totalFixedMinutes: 0,
  burningBucket: null,
  scheduledTasks: [
    { uid: "tk-1", string: "- [ ] Write report 60m", duration: 60, done: false, start: 540, end: 600 },
  ],
  overflowTasks: [],
};

const settings = {
  language: "en",
  workdayStartHour: 5,
  workdayEndHour: 21,
  descLength: 22,
  todoDuration: 15,
  urgentTrigger: "",
};

function makeHost() {
  const host = document.createElement("div");
  // 🔴 非紧凑才挂交互（hover/focus/click 同一通路）。jsdom 里 clientWidth 恒 0，
  //    必须显式钉住，否则 renderSpiral 直接走紧凑早退、一条监听都不挂。
  Object.defineProperty(host, "clientWidth", { value: 600, configurable: true });
  Object.defineProperty(host, "clientHeight", { value: 800, configurable: true });
  document.body.appendChild(host);
  return host;
}

/** 切片在 allEvents 顺序里：ev-1（meeting）在前，tk-1（task）在后。 */
function render({ onProgressClick } = {}) {
  const host = makeHost();
  const called = [];
  const handle = renderSpiral(host, plan, capacity, settings, 600, {
    onProgressClick: (uid) => {
      called.push(uid);
      if (typeof onProgressClick === "function") onProgressClick(uid);
    },
  });
  const slices = host.querySelectorAll(".nautilus-log-event-slice-group");
  return { host, called, handle, slices };
}

/* ------------------------------------------------------------------ */
/* Tests                                                               */
/* ------------------------------------------------------------------ */

test("点击任务切片 → onProgressClick 收到该任务的 uid", () => {
  const { host, called, slices } = render();
  assert.ok(slices.length >= 2, `应渲染出事件+任务切片，实际 ${slices.length}`);
  slices[1].dispatchEvent(new dom.window.Event("click", { bubbles: true, cancelable: true }));
  assert.deepEqual(called, ["tk-1"], "任务切片被点 → 回调必须带上任务 uid");
  host.remove();
});

test("事件（meeting）切片不可点（对齐上游 click-to-progress）", () => {
  const { host, called, slices } = render();
  slices[0].dispatchEvent(new dom.window.Event("click", { bubbles: true, cancelable: true }));
  assert.deepEqual(called, [], "meeting 切片没有 click-to-progress");
  host.remove();
});

test("不传 onProgressClick → 不挂点击；destroy() 摘掉监听", () => {
  const { host, called, slices, handle } = render();
  slices[1].dispatchEvent(new dom.window.Event("click"));
  assert.deepEqual(called, ["tk-1"], "传了回调就应可点");
  handle.destroy();
  slices[1].dispatchEvent(new dom.window.Event("click"));
  assert.deepEqual(called, ["tk-1"], "destroy 后点击不得再触发回调（重渲染会泄漏）");
  host.remove();
});
