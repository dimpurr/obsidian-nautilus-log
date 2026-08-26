/*
 * controls.test.js — chart control button bar (src/controls.ts).
 *
 * Runs in jsdom: bundle controls.ts with esbuild into a single CJS file, install
 * the jsdom window/document/localStorage globals, then drive the three buttons
 * and assert on the `onChange` snapshots.
 *
 * Covered:
 *   · Eye       -> onChange receives showDone flipped
 *   · Collapse  -> onChange receives collapsed flipped AND localStorage written
 *   · Play      -> playback starts at workdayStartMinutes and advances;
 *                  a second click stops and returns playback to null
 *   · destroy() -> the playback interval stops firing (fake clock)
 */

"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const path = require("node:path");
const esbuild = require("esbuild");
const { JSDOM } = require("jsdom");

/* ------------------------------------------------------------------ */
/* Bundle controls.ts (same technique as the other test files).        */
/* ------------------------------------------------------------------ */

const result = esbuild.buildSync({
  entryPoints: [path.join(__dirname, "..", "src", "controls.ts")],
  bundle: true,
  format: "cjs",
  platform: "node",
  write: false,
});
const moduleShim = { exports: {} };
// eslint-disable-next-line no-new-func
new Function("module", "exports", "require", result.outputFiles[0].text)(
  moduleShim,
  moduleShim.exports,
  require,
);
const { renderChartControls } = moduleShim.exports;

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

const SETTINGS = {
  language: "en",
  workdayStartHour: 5,
  workdayEndHour: 21,
  descLength: 22,
  todoDuration: 15,
  urgentTrigger: "",
};

function makeFixture(overrides = {}) {
  const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
    url: "http://localhost/",
  });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  dom.window.localStorage.clear();

  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);

  const opts = {
    workdayStartMinutes: 300, // 05:00
    workdayEndMinutes: 1260, // 21:00
    nowMinutes: 360, // 06:00  -> 60-minute replay window
    ...overrides,
  };
  const storageKey = "nautilus-log:collapsed:v1:test-block";
  const calls = [];
  const handlers = {
    onChange(next) {
      calls.push(next);
    },
  };

  return { dom, container, opts, storageKey, calls, handlers };
}

function initialState(extra = {}) {
  return { showDone: false, collapsed: false, playback: null, ...extra };
}

function buttonsOf(container) {
  return container.querySelectorAll("button.nautilus-log-toggle-btn");
}

/* ------------------------------------------------------------------ */
/* Tests                                                               */
/* ------------------------------------------------------------------ */

test("点眼睛 -> onChange 收到 showDone 取反", () => {
  const { container, opts, storageKey, calls, handlers } = makeFixture();
  const { destroy } = renderChartControls(
    container,
    initialState(),
    handlers,
    SETTINGS,
    opts,
    storageKey,
  );

  const [eye] = buttonsOf(container);

  eye.click();
  assert.equal(calls.length, 1, "一次点击恰好触发一次 onChange");
  assert.equal(calls[0].showDone, true, "showDone 取反");
  assert.equal(calls[0].collapsed, false, "其它字段不受影响");
  assert.equal(calls[0].playback, null, "其它字段不受影响");

  eye.click();
  assert.equal(calls[1].showDone, false, "再点一次又取反回来");
  assert.equal(eye.getAttribute("aria-pressed"), "false", "aria-pressed 跟随状态");

  destroy();
});

test("点折叠 -> onChange 收到 collapsed 取反，且 localStorage 写入", () => {
  const { dom, container, opts, storageKey, calls, handlers } = makeFixture();
  const { destroy } = renderChartControls(
    container,
    initialState(),
    handlers,
    SETTINGS,
    opts,
    storageKey,
  );

  const [, , collapse] = buttonsOf(container);

  collapse.click();
  assert.equal(calls[calls.length - 1].collapsed, true, "collapsed 取反");
  assert.equal(
    dom.window.localStorage.getItem(storageKey),
    "true",
    "折叠态写入 localStorage",
  );
  assert.equal(collapse.getAttribute("aria-expanded"), "false", "aria-expanded 跟随状态");

  collapse.click();
  assert.equal(calls[calls.length - 1].collapsed, false, "再点一次展开");
  assert.equal(
    dom.window.localStorage.getItem(storageKey),
    "false",
    "展开态也写入 localStorage",
  );

  destroy();
});

test("localStorage 已记住折叠 -> 首次渲染即用记住的值并同步给 onChange", () => {
  const { dom, container, opts, storageKey, calls, handlers } = makeFixture();
  dom.window.localStorage.setItem(storageKey, "true");

  const { destroy } = renderChartControls(
    container,
    initialState(), // 调用方还没意识到是折叠的
    handlers,
    SETTINGS,
    opts,
    storageKey,
  );

  assert.equal(calls.length, 1, "渲染时同步一次真实的折叠态");
  assert.equal(calls[0].collapsed, true, "折叠态来自 localStorage");

  // 折叠态下按钮应为「展开」文案 + chevron-down
  const [, , collapse] = buttonsOf(container);
  assert.equal(collapse.getAttribute("aria-expanded"), "false", "图处于折叠态");

  destroy();
});

test("点播放 -> playback 从 workdayStart 推进；再点停止 -> 回到 null", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const { container, opts, storageKey, calls, handlers } = makeFixture();
  const { destroy } = renderChartControls(
    container,
    initialState(),
    handlers,
    SETTINGS,
    opts,
    storageKey,
  );

  const [, play] = buttonsOf(container);

  play.click();
  assert.equal(calls.length, 1, "点击播放立即开始");
  assert.deepEqual(calls[0].playback, { minute: 300 }, "从 workdayStart 开始");

  // 🔴 2026-08-24 起：推进【不再由本组件负责】。它只上报意图，
  //    时钟归宿主（view）——定时器放在这里会随组件重建变成清不掉的孤儿。
  //    推进与自动停止的覆盖在 test/playback.test.js。
  t.mock.timers.tick(5000);
  assert.equal(calls.length, 1, "本组件不得自行推进，tick 后不应有新回调");

  play.click();
  assert.equal(calls[calls.length - 1].playback, null, "再点一次 -> 停止回放");
  assert.equal(
    play.classList.contains("nautilus-log-playback-active"),
    false,
    "停止后退出活动态",
  );

  destroy();
});

test("本组件不自行停止回放（自动停止归宿主）", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const { container, opts, storageKey, calls, handlers } = makeFixture();
  const { destroy } = renderChartControls(
    container, initialState(), handlers, SETTINGS, opts, storageKey,
  );
  const [, play] = buttonsOf(container);
  play.click();
  const after = calls.length;
  t.mock.timers.tick(60_000);
  assert.equal(calls.length, after, "长时间后仍不应有自发回调");
  assert.notEqual(calls[calls.length - 1].playback, null, "状态保持在回放中");
  destroy();
});

test("destroy() 之后 interval 不再触发", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const { container, opts, storageKey, calls, handlers } = makeFixture();
  const { destroy } = renderChartControls(
    container,
    initialState(),
    handlers,
    SETTINGS,
    opts,
    storageKey,
  );

  const [, play] = buttonsOf(container);
  play.click();
  const before = calls.length;
  assert.equal(before, 1, "播放已开始");

  destroy();

  t.mock.timers.tick(5000);
  assert.equal(calls.length, before, "destroy 后 interval 不再触发");
  assert.equal(
    container.querySelectorAll("button").length,
    0,
    "按钮条已从容器移除",
  );
});

/* ------------------------------------------------------------------ */
/* 认证审计 C2-054 · localStorage 键的命名空间前缀                      */
/* ------------------------------------------------------------------ */

/** 上游 `component.cljs:1417-1418` 的键是
 *  `"nautilus-log:collapsed:v1:" + block-uid`；本移植的调用方传的是裸的
 *  `"<path>.md:<lineOffset>"`，于是 vault 级 localStorage 里躺着一个毫无
 *  命名空间、也没有版本位的键。
 *
 *  ⚠️ 旧测试抓不到这条 —— 它把**自己造的、已经带前缀的**键喂进被测函数，
 *  再断言同一个键被写了，永远自洽。这条测试传的是**调用方真实会传的裸键**。 */
test("🔴 C2-054 折叠态的 localStorage 键带 nautilus-log:collapsed:v1: 前缀", () => {
  const { dom, container, opts, calls, handlers } = makeFixture();
  const blockKey = "Daily/2026-08-24.md:12";   // main.ts / sidebar.ts 真实传入的形态

  const { destroy } = renderChartControls(
    container,
    initialState(),
    handlers,
    SETTINGS,
    opts,
    blockKey,
  );

  const [, , collapse] = buttonsOf(container);
  collapse.click();

  assert.equal(calls[calls.length - 1].collapsed, true);
  assert.equal(
    dom.window.localStorage.getItem(blockKey),
    null,
    "裸键不该出现在 vault 级 localStorage 里（无命名空间会撞上别的插件）",
  );
  assert.equal(
    dom.window.localStorage.getItem(`nautilus-log:collapsed:v1:${blockKey}`),
    "true",
    "必须写在上游那个带版本位的命名空间下",
  );

  destroy();
});

test("🔴 C2-054 已带前缀的键原样通过（幂等，不叠第二层前缀）", () => {
  const { dom, container, opts, storageKey, handlers } = makeFixture();
  const { destroy } = renderChartControls(
    container,
    initialState(),
    handlers,
    SETTINGS,
    opts,
    storageKey,                      // "nautilus-log:collapsed:v1:test-block"
  );
  buttonsOf(container)[2].click();
  assert.equal(dom.window.localStorage.getItem(storageKey), "true");
  assert.equal(
    dom.window.localStorage.getItem(`nautilus-log:collapsed:v1:${storageKey}`),
    null,
    "不能把前缀叠两层",
  );
  destroy();
});

/* ------------------------------------------------------------------ */
/* 认证审计 C2-023 / C2-024 / C2-057 · 挂载点与折叠骨架                  */
/* ------------------------------------------------------------------ */

/** 造出宿主在调 renderChartControls 之前已经画好的那部分骨架：
 *  块根（container）> header > [header-copy, header-actions > legend]。 */
function makeShellFixture(overrides = {}) {
  const f = makeFixture(overrides);
  const doc = f.dom.window.document;
  f.container.className = "nautilus-log nautilus-log-container";
  const header = doc.createElement("header");
  header.className = "nautilus-log-header nautilus-log-header--compact";
  const copy = doc.createElement("div");
  copy.className = "nautilus-log-header-copy";
  const actions = doc.createElement("div");
  actions.className = "nautilus-log-header-actions";
  const legend = doc.createElement("div");
  legend.className = "nautilus-log-html-legend";
  actions.appendChild(legend);
  header.appendChild(copy);
  header.appendChild(actions);
  f.container.appendChild(header);
  return { ...f, header, actions, legend };
}

test("🔴 C2-023 控制栏挂进 header-actions 列（图例之前），不再是块根的兄弟", () => {
  const { container, actions, legend, opts, storageKey, handlers } = makeShellFixture();
  const { destroy } = renderChartControls(
    container,
    initialState(),
    handlers,
    SETTINGS,
    opts,
    storageKey,
  );

  const bar = container.querySelector(".nautilus-log-controls-top");
  assert.ok(bar, "按钮条渲染出来了");
  assert.equal(
    bar.parentNode,
    actions,
    "上游 component.cljs:1880-1883 把 controls 放在 header-actions 列里；"
    + "挂在块根上会让紧凑宽度下 header 塌成一条 32px 空条、按钮掉到下面",
  );
  assert.equal(actions.firstChild, bar, "上游顺序：controls 在 html-legend 之前");
  assert.equal(bar.nextSibling, legend);

  destroy();
  assert.equal(actions.querySelectorAll("button").length, 0, "destroy 要从真实父节点上摘干净");
});

test("🔴 C2-057/C2-024 折叠后：块根拿 nautilus-log-collapsed，按钮条浮回块根，头部不再显示", () => {
  const { container, actions, header, opts, storageKey, handlers } = makeShellFixture();
  const { destroy } = renderChartControls(
    container,
    initialState(),
    handlers,
    SETTINGS,
    opts,
    storageKey,
  );

  assert.equal(
    container.classList.contains("nautilus-log-collapsed"),
    false,
    "展开态不带折叠类",
  );

  buttonsOf(container)[2].click();   // 折叠

  // styles.css:692-709 的整族（浮到块上方 + 只留折叠键）全部挂在这个类上。
  assert.equal(
    container.classList.contains("nautilus-log-collapsed"),
    true,
    "上游 component.cljs:1870 折叠时给容器加 nautilus-log-collapsed",
  );
  const bar = container.querySelector(".nautilus-log-controls-top");
  assert.equal(
    bar.parentNode,
    container,
    "折叠态必须离开 header-actions —— 否则会跟着被藏掉的头部一起消失",
  );
  assert.notEqual(bar.parentNode, actions);
  assert.equal(
    header.style.display,
    "none",
    "上游折叠后整块只剩一排按钮；容量头部留着会从 height:0 的容器里溢出来",
  );

  buttonsOf(container)[2].click();   // 展开回来

  assert.equal(container.classList.contains("nautilus-log-collapsed"), false);
  assert.equal(header.style.display, "", "展开后头部还原");
  assert.equal(
    container.querySelector(".nautilus-log-controls-top").parentNode,
    actions,
    "展开后按钮条回到 header-actions",
  );

  destroy();
  assert.equal(
    container.classList.contains("nautilus-log-collapsed"),
    false,
    "destroy 不能把折叠类留在宿主的 DOM 上",
  );
});
