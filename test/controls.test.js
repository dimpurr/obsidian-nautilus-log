/*
 * controls.test.js — chart control button bar (src/controls.ts).
 *
 * Runs in jsdom: bundle controls.ts with esbuild into a single CJS file, install
 * the jsdom window/document globals, then drive the three buttons and assert on
 * the `onChange` snapshots.
 *
 * 2026-08-28（社区审核 Local Storage 项）：折叠态的持久化从 `window.localStorage`
 * 换成 Obsidian 官方 device-local API（`app.loadLocalStorage` / `saveLocalStorage`），
 * 以【注入】的方式交给组件 —— 测试用内存 Map 模拟存储缝，不再碰 jsdom 的
 * localStorage。旧的 C2-054 用例断言从「jsdom localStorage」改成「注入的 store」。
 *
 * Covered:
 *   · Eye       -> onChange receives showDone flipped
 *   · Collapse  -> onChange receives collapsed flipped AND the injected storage
 *                  is written; a rebuilt component reads the persisted value back
 *   · Play      -> playback starts at workdayStartMinutes and advances;
 *                  a second click stops and returns playback to null
 *   · destroy() -> the playback interval stops firing (fake clock)
 *   · storage throwing (webviews) must never take the chart down
 *   · grep guard: no localStorage / sessionStorage anywhere under src/**
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
const { renderChartControls, collapsedStorageFromApp } = moduleShim.exports;

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

  // 🔴 存储现在是【注入】的（社区审核 Local Storage 项，2026-08-28）。
  //    测试用内存 Map 模拟真实实现（app.loadLocalStorage/saveLocalStorage）；
  //    collapsedStorageFromApp 那条用例单独钉工厂本身。
  const store = new Map();
  const storage = {
    read: (key) => store.get(key) === true,
    write: (key, value) => { store.set(key, value); },
  };

  const calls = [];
  const handlers = {
    onChange(next) {
      calls.push(next);
    },
  };

  return { dom, container, opts, storageKey, storage, store, calls, handlers };
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
  const { container, opts, storageKey, storage, calls, handlers } = makeFixture();
  const { destroy } = renderChartControls(
    container,
    initialState(),
    handlers,
    SETTINGS,
    opts,
    storageKey,
    storage,
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

test("点折叠 -> onChange 收到 collapsed 取反，且写入注入的存储", () => {
  const { container, opts, storage, store, storageKey, calls, handlers } = makeFixture();
  const { destroy } = renderChartControls(
    container,
    initialState(),
    handlers,
    SETTINGS,
    opts,
    storageKey,
    storage,
  );

  const [, , collapse] = buttonsOf(container);

  collapse.click();
  assert.equal(calls[calls.length - 1].collapsed, true, "collapsed 取反");
  assert.equal(
    store.get(storageKey),
    true,
    "折叠态写入注入的存储（不再是 window.localStorage）",
  );
  assert.equal(collapse.getAttribute("aria-expanded"), "false", "aria-expanded 跟随状态");

  collapse.click();
  assert.equal(calls[calls.length - 1].collapsed, false, "再点一次展开");
  assert.equal(
    store.get(storageKey),
    false,
    "展开态也写入注入的存储",
  );

  destroy();
});

test("注入的存储已记住折叠 -> 首次渲染即用记住的值并同步给 onChange", () => {
  const { container, opts, storage, store, storageKey, calls, handlers } = makeFixture();
  store.set(storageKey, true);

  const { destroy } = renderChartControls(
    container,
    initialState(), // 调用方还没意识到是折叠的
    handlers,
    SETTINGS,
    opts,
    storageKey,
    storage,
  );

  assert.equal(calls.length, 1, "渲染时同步一次真实的折叠态");
  assert.equal(calls[0].collapsed, true, "折叠态来自注入的存储");

  // 折叠态下按钮应为「展开」文案 + chevron-down
  const [, , collapse] = buttonsOf(container);
  assert.equal(collapse.getAttribute("aria-expanded"), "false", "图处于折叠态");

  destroy();
});

test("点播放 -> playback 从 workdayStart 推进；再点停止 -> 回到 null", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const { container, opts, storageKey, storage, calls, handlers } = makeFixture();
  const { destroy } = renderChartControls(
    container,
    initialState(),
    handlers,
    SETTINGS,
    opts,
    storageKey,
    storage,
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
  const { container, opts, storageKey, storage, calls, handlers } = makeFixture();
  const { destroy } = renderChartControls(
    container, initialState(), handlers, SETTINGS, opts, storageKey, storage,
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
  const { container, opts, storageKey, storage, calls, handlers } = makeFixture();
  const { destroy } = renderChartControls(
    container,
    initialState(),
    handlers,
    SETTINGS,
    opts,
    storageKey,
    storage,
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
/* 🔴 社区审核 Security 项：图标必须用 DOM API 构造，不写 innerHTML      */
/* ------------------------------------------------------------------ */

test("🔴 图标用 DOM API 构造，不写 innerHTML（回退即红）", () => {
  const { dom, container, opts, storageKey, storage, handlers } = makeFixture();
  // 审核的机械检查盯的是 `el.innerHTML =` 赋值。装一个抛错的 setter：
  // 实现里若还写 innerHTML，渲染当下就会炸；不写才走得到正常路径。
  const desc = Object.getOwnPropertyDescriptor(dom.window.Element.prototype, "innerHTML");
  Object.defineProperty(dom.window.Element.prototype, "innerHTML", {
    configurable: true,
    enumerable: desc.enumerable,
    get() { return desc.get.call(this); },
    set() { throw new Error("innerHTML assignment detected"); },
  });
  try {
    const { destroy } = renderChartControls(
      container,
      initialState(),
      handlers,
      SETTINGS,
      opts,
      storageKey,
      storage,
    );

    // 图标还在：三个按钮各带一个 <svg>，子元素与上游 path 集一致。
    const svgs = container.querySelectorAll("button svg");
    assert.equal(svgs.length, 3, "眼睛/播放/折叠各一个 svg");
    // showDone=false 初始 => 眼睛是 ICON_EYE_OFF（path + line，无 circle）。
    assert.ok(svgs[0].querySelector("path"), "眼睛图标有 path（上游 M17.94…）");
    assert.ok(svgs[0].querySelector("line"), "眼睛图标有 line（x1=1 y1=1 x2=23 y2=23）");
    assert.ok(svgs[1].querySelector("polygon"), "播放图标有 polygon（5 3 19 12 …）");

    // 点眼睛切到 showDone => ICON_EYE（path + circle）替换上去。
    container.querySelectorAll("button")[0].click();
    const eyeOn = container.querySelectorAll("button svg")[0];
    assert.ok(eyeOn.querySelector("circle"), "眼睛开启态图标有 circle（cx=12 cy=12 r=3）");

    destroy();
  } finally {
    Object.defineProperty(dom.window.Element.prototype, "innerHTML", desc);
  }
});

/* ------------------------------------------------------------------ */
/* 认证审计 C2-054 · 设备本地存储键的命名空间前缀                        */
/* ------------------------------------------------------------------ */

/** 上游 `component.cljs:1417-1418` 的键是
 *  `"nautilus-log:collapsed:v1:" + block-uid`；本移植的调用方传的是裸的
 *  `"<path>.md:<lineOffset>"`，于是存储里躺着一个毫无命名空间、也没有版本位
 *  的键。
 *
 *  ⚠️ 旧测试抓不到这条 —— 它把**自己造的、已经带前缀的**键喂进被测函数，
 *  再断言同一个键被写了，永远自洽。这条测试传的是**调用方真实会传的裸键**。 */
test("🔴 C2-054 折叠态的设备本地存储键带 nautilus-log:collapsed:v1: 前缀", () => {
  const { container, opts, storage, store, calls, handlers } = makeFixture();
  const blockKey = "Daily/2026-08-24.md:12";   // main.ts / sidebar.ts 真实传入的形态

  const { destroy } = renderChartControls(
    container,
    initialState(),
    handlers,
    SETTINGS,
    opts,
    blockKey,
    storage,
  );

  const [, , collapse] = buttonsOf(container);
  collapse.click();

  assert.equal(calls[calls.length - 1].collapsed, true);
  assert.ok(
    !store.has(blockKey),
    "裸键不该出现在存储里（无命名空间会撞上别的插件）",
  );
  assert.equal(
    store.get(`nautilus-log:collapsed:v1:${blockKey}`),
    true,
    "必须写在上游那个带版本位的命名空间下",
  );

  destroy();
});

test("🔴 C2-054 已带前缀的键原样通过（幂等，不叠第二层前缀）", () => {
  const { container, opts, storage, store, storageKey, handlers } = makeFixture();
  const { destroy } = renderChartControls(
    container,
    initialState(),
    handlers,
    SETTINGS,
    opts,
    storageKey,                      // "nautilus-log:collapsed:v1:test-block"
    storage,
  );
  buttonsOf(container)[2].click();
  assert.equal(store.get(storageKey), true);
  assert.equal(
    store.get(`nautilus-log:collapsed:v1:${storageKey}`),
    undefined,
    "不能把前缀叠两层",
  );
  destroy();
});

/* ------------------------------------------------------------------ */
/* 2026-08-28 · 注入式存储的语义                                        */
/* ------------------------------------------------------------------ */

test("🔴 折叠 -> 写进注入的存储；重建组件 -> 读回还是折叠的", () => {
  const { container, opts, storage, store, storageKey, calls, handlers } = makeFixture();
  const first = renderChartControls(
    container,
    initialState(),
    handlers,
    SETTINGS,
    opts,
    storageKey,
    storage,
  );

  buttonsOf(container)[2].click();   // 折叠
  assert.equal(store.get(storageKey), true, "折叠态写进注入的存储");
  first.destroy();

  // 重建：同一个存储缝（模拟宿主视图重建，app 没变）。
  const fresh = document.createElement("div");
  document.body.appendChild(fresh);
  const calls2 = [];
  const second = renderChartControls(
    fresh,
    initialState(),   // 调用方仍不知道是折叠的
    { onChange: (next) => calls2.push(next) },
    SETTINGS,
    opts,
    storageKey,
    storage,
  );

  assert.equal(calls2.length, 1, "重建时同步一次真实的折叠态");
  assert.equal(calls2[0].collapsed, true, "从注入的存储读回折叠态");
  assert.ok(fresh.classList.contains("nautilus-log-collapsed"), "重建后图表就是折叠的");

  second.destroy();
  fresh.remove();
});

test("🔴 存储抛异常时图表照常渲染（webview storage 不可用的纪律）", () => {
  const { container, opts, storageKey, calls, handlers } = makeFixture();
  const throwing = {
    read() { throw new Error("storage read unavailable"); },
    write() { throw new Error("storage write unavailable"); },
  };

  const { destroy } = renderChartControls(
    container,
    initialState(),
    handlers,
    SETTINGS,
    opts,
    storageKey,
    throwing,
  );

  // 渲染没炸：三个按钮都在，读不到持久态不等于有折叠态，不触发多余 onChange。
  const buttons = buttonsOf(container);
  assert.equal(buttons.length, 3, "存储不可用图表照常渲染");
  assert.equal(calls.length, 0, "读不到持久态时不该额外同步 onChange");

  buttons[2].click();
  assert.equal(calls[calls.length - 1].collapsed, true, "折叠交互不受存储抛错影响");
  destroy();
});

test("collapsedStorageFromApp 把 App 的 device-local API 映射成布尔缝", () => {
  const backing = new Map();
  const written = [];
  const fakeApp = {
    loadLocalStorage(key) { return backing.has(key) ? backing.get(key) : null; },
    saveLocalStorage(key, data) {
      written.push([key, data]);
      if (data === null) backing.delete(key);
      else backing.set(key, data);
    },
  };
  const storage = collapsedStorageFromApp(fakeApp);

  assert.equal(storage.read("missing"), false, "缺省/null -> 未折叠");
  storage.write("k", true);
  assert.deepEqual(written[0], ["k", true], "写直接透传 saveLocalStorage（boolean 原值）");
  assert.equal(storage.read("k"), true, "boolean true 读回 true");
  storage.write("k", false);
  assert.equal(storage.read("k"), false, "boolean false 读回 false");
});

test("🔴 src/** 不再出现 window.localStorage / sessionStorage（社区审核机械检查，回退即红）", () => {
  const fs = require("node:fs");
  const root = path.join(__dirname, "..", "src");
  const files = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|js)$/.test(entry.name)) files.push(full);
    }
  })(root);
  assert.ok(files.length > 0, "扫描到 src/ 下的源码文件");

  const offenders = [];
  for (const f of files) {
    const lines = fs.readFileSync(f, "utf8").split("\n");
    lines.forEach((line, i) => {
      if (/\bwindow\.localStorage\b/.test(line)
          || /\bsessionStorage\b/.test(line)
          || /\blocalStorage\b/.test(line)) {
        offenders.push(`${path.relative(root, f)}:${i + 1}: ${line.trim()}`);
      }
    });
  }
  assert.deepEqual(offenders, [], "src/** 出现 localStorage/sessionStorage —— 审核的机械检查扫的就是这个");
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
  const { container, actions, legend, opts, storageKey, storage, handlers } = makeShellFixture();
  const { destroy } = renderChartControls(
    container,
    initialState(),
    handlers,
    SETTINGS,
    opts,
    storageKey,
    storage,
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
  const { container, actions, header, opts, storageKey, storage, handlers } = makeShellFixture();
  const { destroy } = renderChartControls(
    container,
    initialState(),
    handlers,
    SETTINGS,
    opts,
    storageKey,
    storage,
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
  assert.ok(
    header.classList.contains("nautilus-log-collapsed-hidden"),
    "上游折叠后整块只剩一排按钮；容量头部留着会从 height:0 的容器里溢出来"
    + "（内联 display 禁令：走 CSS 类）",
  );
  assert.equal(header.style.display, "", "折叠隐藏不写内联 display");

  buttonsOf(container)[2].click();   // 展开回来

  assert.equal(container.classList.contains("nautilus-log-collapsed"), false);
  assert.ok(
    !header.classList.contains("nautilus-log-collapsed-hidden"),
    "展开后头部还原（摘掉隐藏类）",
  );
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
