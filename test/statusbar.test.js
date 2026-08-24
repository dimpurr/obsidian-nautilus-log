/*
 * statusbar.test.js — the status bar persistent block (B · 状态栏常驻块).
 *
 * Bundles `src/statusbar.ts` with esbuild, keeping `obsidian` external and
 * resolving it to `obsidian-mock.cjs` so `setIcon` comes from the same stub
 * the bundle was built against. DOM comes from jsdom with the Obsidian DOM
 * helpers polyfilled onto the HTMLElement prototype.
 *
 * setInterval/clearInterval are stubbed so no real timer keeps `node --test`
 * alive; the tests drive ticks by invoking the captured callback. "now" is
 * pinned by stubbing `Date.now` (the statusbar reads it once per render).
 *
 * Covered:
 *   · 三种状态（跑 CLOCK / 只有 POMO / 空闲）各自的文本与 class
 *   · 超过 pomodoroMinutes 阈值 => is-overdue（只变样式，不停止计时）
 *   · 忘关警告 => is-forgotten
 *   · 状态切换重建 DOM 结构，tick 只刷文本
 *   · destroy() 后 interval 与订阅都已清除；再推快照不再更新 DOM
 */

"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const path = require("node:path");
const esbuild = require("esbuild");
const { JSDOM } = require("jsdom");

const SRC = path.join(__dirname, "..", "src");
const MOCK_OBSIDIAN = path.join(__dirname, "obsidian-mock.cjs");

/* ------------------------------------------------------------------ */
/* Bundle the statusbar with obsidian left external                    */
/* ------------------------------------------------------------------ */

const result = esbuild.buildSync({
  entryPoints: [path.join(SRC, "statusbar.ts")],
  bundle: true,
  format: "cjs",
  platform: "node",
  write: false,
  external: ["obsidian"],
});
const moduleShim = { exports: {} };
const mockRequire = (id) => {
  if (id === "obsidian") return require(MOCK_OBSIDIAN);
  return require(id);
};
// eslint-disable-next-line no-new-func
new Function("module", "exports", "require", result.outputFiles[0].text)(
  moduleShim,
  moduleShim.exports,
  mockRequire,
);
const { renderTimingStatusBar, STATUSBAR_TITLE_MAX_LENGTH } = moduleShim.exports;

/* ------------------------------------------------------------------ */
/* jsdom + Obsidian DOM helpers + stubbed timers                       */
/* ------------------------------------------------------------------ */

function makeDom() {
  const dom = new JSDOM("<!DOCTYPE html><body></body>", { url: "http://localhost/" });
  const H = dom.window.HTMLElement.prototype;
  H.addClass = function addClass(cls) { this.classList.add(cls); };
  H.removeClass = function removeClass(cls) { this.classList.remove(cls); };
  H.empty = function empty() { while (this.firstChild) this.removeChild(this.firstChild); };
  H.createEl = function createEl(tag, opts = {}) {
    const e = this.ownerDocument.createElement(tag);
    if (opts.cls) e.className = opts.cls;
    if (opts.text) e.textContent = opts.text;
    this.appendChild(e);
    return e;
  };
  H.setText = function setText(t) { this.textContent = t; };

  const intervals = [];
  const cleared = [];
  // 全文件统一 stub：绝不让真实定时器把 node --test 挂住；测试自行驱动 tick。
  dom.window.setInterval = (fn, ms) => { const id = { fn, ms }; intervals.push(id); return id; };
  dom.window.clearInterval = (id) => { cleared.push(id); };

  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  return { dom, intervals, cleared };
}

/** 把 Date.now 钉到固定时刻跑一段同步代码（statusbar 每次 render 读一次）。 */
function withNow(ms, fn) {
  const original = Date.now;
  Date.now = () => ms;
  try { return fn(); } finally { Date.now = original; }
}

/* ------------------------------------------------------------------ */
/* Fake timing runtime + snapshot builders                             */
/* ------------------------------------------------------------------ */

function makeRuntime(snapshot) {
  const listeners = new Set();
  let current = snapshot;
  return {
    getSnapshot: () => current,
    subscribe(listener) {
      listeners.add(listener);
      listener(current);
      return () => listeners.delete(listener);
    },
    publish(next) {
      current = next;
      for (const l of [...listeners]) l(current);
    },
    _listeners: listeners,
  };
}

function baseSnapshot(overrides = {}) {
  return {
    revision: 1,
    status: "ready",
    notice: "",
    planSnapshot: null,
    entries: [],
    dailyReview: {},
    activeWork: { focused: null, recent: [], items: [], count: 0, windowMinutes: 45 },
    pomodoro: null,
    standalonePomodoro: null,
    now: new Date(),
    ...overrides,
  };
}

function clockSnapshot({ startMs, title = "Write report", taskString = "- [ ] Write report 45m", pomodoro = null }) {
  const focused = { start: new Date(startMs), running: true, clockUid: "c1", taskUid: "t1", taskString, title };
  return baseSnapshot({
    entries: [focused],
    activeWork: { focused, recent: [], items: [focused], count: 1, windowMinutes: 45 },
    pomodoro,
  });
}

function standaloneSnapshot(startedAtMs) {
  return baseSnapshot({ standalonePomodoro: { startedAt: startedAtMs } });
}

function makeCtx(runtime, overrides = {}) {
  return { runtime, language: "en", pomodoroMinutes: 45, forgottenTimerMinutes: 120, ...overrides };
}

const T0 = 1_700_000_000_000; // arbitrary fixed epoch ms for "now"

/* ------------------------------------------------------------------ */
/* Tests — running CLOCK                                               */
/* ------------------------------------------------------------------ */

test("running CLOCK: truncated title + elapsed text, is-active", () => {
  const { dom, intervals } = makeDom();
  const runtime = makeRuntime(clockSnapshot({ startMs: T0 - 60_000 }));
  const el = dom.window.document.createElement("div");

  withNow(T0, () => {
    const handle = renderTimingStatusBar(el, makeCtx(runtime), () => {});

    assert.equal(intervals.length, 1, "starts exactly one 1s interval");
    assert.equal(intervals[0].ms, 1000);
    assert.ok(el.classList.contains("nautilus-log-statusbar"));
    assert.ok(el.classList.contains("is-active"));
    assert.ok(!el.classList.contains("is-pomodoro"));
    assert.ok(!el.classList.contains("is-overdue"));
    assert.ok(!el.classList.contains("is-forgotten"));
    assert.equal(el.querySelector(".nautilus-log-statusbar-title").textContent, "Write report");
    assert.equal(el.querySelector(".nautilus-log-statusbar-title").title, "Write report");
    assert.equal(el.querySelector(".nautilus-log-statusbar-separator").textContent, "·");
    assert.equal(el.querySelector(".nautilus-log-statusbar-elapsed").textContent, "1:00");

    handle.destroy();
  });
});

test("running CLOCK: long title is truncated, full title kept in the tooltip", () => {
  const { dom } = makeDom();
  const long = "A very long task title that definitely overflows the status bar";
  const runtime = makeRuntime(clockSnapshot({ startMs: T0 - 60_000, title: long }));
  const el = dom.window.document.createElement("div");

  withNow(T0, () => {
    const handle = renderTimingStatusBar(el, makeCtx(runtime), () => {});
    const titleEl = el.querySelector(".nautilus-log-statusbar-title");
    assert.ok(
      titleEl.textContent.slice(0, -1).length === STATUSBAR_TITLE_MAX_LENGTH,
      "displayed title must be capped to the max length, not just CSS-ellipsized",
    );
    assert.ok(titleEl.textContent.endsWith("…"), "truncation must use an ellipsis");
    assert.equal(titleEl.title, long, "hover tooltip carries the full title");
    handle.destroy();
  });
});

test("overdue: adds is-overdue past pomodoroMinutes but keeps timing", () => {
  const { dom } = makeDom();
  const runtime = makeRuntime(clockSnapshot({
    startMs: T0 - 60_000,
    pomodoro: { startedAt: T0 - 46 * 60_000 },   // 46m in, threshold 45m
  }));
  const el = dom.window.document.createElement("div");

  withNow(T0, () => {
    const handle = renderTimingStatusBar(el, makeCtx(runtime, { pomodoroMinutes: 45 }), () => {});
    assert.ok(el.classList.contains("is-overdue"));
    assert.equal(
      el.querySelector(".nautilus-log-statusbar-elapsed").textContent,
      "1:00",
      "overdue only changes style, never stops the timer",
    );
    handle.destroy();
  });
});

test("running CLOCK under pomodoro threshold: no is-overdue", () => {
  const { dom } = makeDom();
  const runtime = makeRuntime(clockSnapshot({
    startMs: T0 - 60_000,
    pomodoro: { startedAt: T0 - 30 * 60_000 },
  }));
  const el = dom.window.document.createElement("div");

  withNow(T0, () => {
    const handle = renderTimingStatusBar(el, makeCtx(runtime, { pomodoroMinutes: 45 }), () => {});
    assert.ok(!el.classList.contains("is-overdue"));
    handle.destroy();
  });
});

test("forgotten clock: adds is-forgotten, does not stop or hide elapsed", () => {
  const { dom } = makeDom();
  const runtime = makeRuntime(clockSnapshot({ startMs: T0 - 3 * 3600_000, pomodoro: null }));
  const el = dom.window.document.createElement("div");

  withNow(T0, () => {
    const handle = renderTimingStatusBar(el, makeCtx(runtime, { forgottenTimerMinutes: 120 }), () => {});
    assert.ok(el.classList.contains("is-forgotten"));
    assert.ok(el.classList.contains("is-active"), "still running, still active");
    assert.equal(el.querySelector(".nautilus-log-statusbar-elapsed").textContent, "3:00:00");
    handle.destroy();
  });
});

test("clock under forgotten threshold: no is-forgotten", () => {
  const { dom } = makeDom();
  const runtime = makeRuntime(clockSnapshot({ startMs: T0 - 30 * 60_000, pomodoro: null }));
  const el = dom.window.document.createElement("div");

  withNow(T0, () => {
    const handle = renderTimingStatusBar(el, makeCtx(runtime, { forgottenTimerMinutes: 120 }), () => {});
    assert.ok(!el.classList.contains("is-forgotten"));
    handle.destroy();
  });
});

/* ------------------------------------------------------------------ */
/* Tests — standalone POMO                                             */
/* ------------------------------------------------------------------ */

test("standalone POMO: `elapsed · POMO`, is-active + is-pomodoro", () => {
  const { dom } = makeDom();
  const runtime = makeRuntime(standaloneSnapshot(T0 - 60_000));
  const el = dom.window.document.createElement("div");

  withNow(T0, () => {
    const handle = renderTimingStatusBar(el, makeCtx(runtime), () => {});
    assert.equal(el.querySelector(".nautilus-log-statusbar-elapsed").textContent, "1:00");
    assert.equal(el.querySelector(".nautilus-log-statusbar-separator").textContent, "·");
    assert.equal(el.querySelector(".nautilus-log-statusbar-pomo").textContent, "POMO");
    assert.equal(el.querySelector(".nautilus-log-statusbar-title"), null, "no task title in POMO mode");
    assert.ok(el.classList.contains("is-active"));
    assert.ok(el.classList.contains("is-pomodoro"));
    assert.ok(!el.classList.contains("is-forgotten"));
    assert.ok(!el.classList.contains("is-overdue"));
    handle.destroy();
  });
});

test("standalone POMO overdue: is-overdue, never is-forgotten", () => {
  const { dom } = makeDom();
  const runtime = makeRuntime(standaloneSnapshot(T0 - 50 * 60_000));
  const el = dom.window.document.createElement("div");

  withNow(T0, () => {
    const handle = renderTimingStatusBar(el, makeCtx(runtime, { pomodoroMinutes: 45 }), () => {});
    assert.ok(el.classList.contains("is-overdue"));
    assert.ok(!el.classList.contains("is-forgotten"));
    handle.destroy();
  });
});

/* ------------------------------------------------------------------ */
/* Tests — idle                                                        */
/* ------------------------------------------------------------------ */

test("idle: minimal clickable icon, no text, no state classes", () => {
  const { dom } = makeDom();
  const runtime = makeRuntime(baseSnapshot());
  const el = dom.window.document.createElement("div");

  const handle = renderTimingStatusBar(el, makeCtx(runtime), () => {});
  assert.equal(el.getAttribute("data-icon"), "timer", "idle shows only an icon");
  assert.equal(el.textContent.trim(), "");
  assert.equal(el.querySelector(".nautilus-log-statusbar-elapsed"), null);
  assert.ok(!el.classList.contains("is-active"));
  assert.ok(!el.classList.contains("is-pomodoro"));
  assert.ok(!el.classList.contains("is-overdue"));
  assert.ok(!el.classList.contains("is-forgotten"));
  handle.destroy();
});

/* ------------------------------------------------------------------ */
/* Tests — transitions & tick                                          */
/* ------------------------------------------------------------------ */

test("state transitions rebuild the DOM structure", () => {
  const { dom } = makeDom();
  const runtime = makeRuntime(baseSnapshot());
  const el = dom.window.document.createElement("div");

  withNow(T0, () => {
    const handle = renderTimingStatusBar(el, makeCtx(runtime), () => {});
    // idle first
    assert.equal(el.getAttribute("data-icon"), "timer");
    assert.equal(el.querySelector(".nautilus-log-statusbar-elapsed"), null);

    // -> running CLOCK
    runtime.publish(clockSnapshot({ startMs: T0 - 60_000 }));
    assert.equal(el.querySelector(".nautilus-log-statusbar-title").textContent, "Write report");
    assert.equal(el.querySelector(".nautilus-log-statusbar-elapsed").textContent, "1:00");
    assert.ok(el.classList.contains("is-active"));
    assert.ok(!el.classList.contains("is-pomodoro"));

    // -> standalone POMO
    runtime.publish(standaloneSnapshot(T0 - 60_000));
    assert.equal(el.querySelector(".nautilus-log-statusbar-title"), null, "title span must be gone");
    assert.equal(el.querySelector(".nautilus-log-statusbar-elapsed").textContent, "1:00");
    assert.equal(el.querySelector(".nautilus-log-statusbar-pomo").textContent, "POMO");
    assert.ok(el.classList.contains("is-pomodoro"));

    // -> back to idle
    runtime.publish(baseSnapshot());
    assert.equal(el.querySelector(".nautilus-log-statusbar-elapsed"), null);
    assert.equal(el.getAttribute("data-icon"), "timer");
    assert.ok(!el.classList.contains("is-active"));
    assert.ok(!el.classList.contains("is-pomodoro"));

    handle.destroy();
  });
});

test("interval tick refreshes elapsed with a fresh now", () => {
  const { dom, intervals } = makeDom();
  const runtime = makeRuntime(clockSnapshot({ startMs: T0 - 60_000 }));
  const el = dom.window.document.createElement("div");
  const original = Date.now;
  let now = T0;
  Date.now = () => now;
  try {
    const handle = renderTimingStatusBar(el, makeCtx(runtime), () => {});
    assert.equal(el.querySelector(".nautilus-log-statusbar-elapsed").textContent, "1:00");
    now = T0 + 30_000;
    intervals[0].fn();
    assert.equal(el.querySelector(".nautilus-log-statusbar-elapsed").textContent, "1:30");
    handle.destroy();
  } finally {
    Date.now = original;
  }
});

/* ------------------------------------------------------------------ */
/* Tests — lifecycle                                                    */
/* ------------------------------------------------------------------ */

test("destroy clears the interval and unsubscribes; post-destroy snapshots never re-render", () => {
  const { dom, intervals, cleared } = makeDom();
  const runtime = makeRuntime(clockSnapshot({ startMs: T0 - 60_000 }));
  const el = dom.window.document.createElement("div");

  withNow(T0, () => {
    const handle = renderTimingStatusBar(el, makeCtx(runtime), () => {});
    assert.equal(intervals.length, 1);
    const id = intervals[0];
    assert.equal(runtime._listeners.size, 1, "subscribes exactly once");

    handle.destroy();

    assert.deepEqual(cleared, [id], "clearInterval called with the started interval id");
    assert.equal(runtime._listeners.size, 0, "subscription must be removed on destroy");

    // pushing a snapshot through the runtime must not touch the DOM
    const before = el.innerHTML;
    runtime.publish(clockSnapshot({ startMs: T0 - 120_000, title: "Changed task" }));
    assert.equal(el.innerHTML, before, "post-destroy snapshot push must not re-render");

    // even a direct invocation of the captured listener must be a no-op
    const rawListener = runtime._listeners.size > 0 ? [...runtime._listeners][0] : null;
    if (rawListener) rawListener(runtime.getSnapshot());
    assert.equal(el.innerHTML, before, "destroyed render must be a hard no-op");
  });
});

test("click handler fires while alive and is removed on destroy", () => {
  const { dom } = makeDom();
  const runtime = makeRuntime(baseSnapshot());
  const el = dom.window.document.createElement("div");
  const clicked = { n: 0 };

  const handle = renderTimingStatusBar(el, makeCtx(runtime), () => { clicked.n += 1; });
  el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  assert.equal(clicked.n, 1, "click opens the sidebar via onClick");

  handle.destroy();
  el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  assert.equal(clicked.n, 1, "listener must be removed on destroy");
});
