/*
 * pomo.test.js — the standalone count-up POMO control (src/pomo.ts).
 *
 * Bundles src/pomo.ts with esbuild into one CJS file, installs the jsdom
 * window/document globals, then drives the control against a minimal mock of
 * the timing runtime.  Time is fake: node:test mock timers advance `Date`, and
 * `window.setInterval` is replaced with a capturing fake so the test fires the
 * control's tick callback explicitly after advancing the clock.
 *
 * Covered (acceptance):
 *   · clicking start calls runtime.startStandalonePomodoro() and the elapsed
 *     count keeps rising with each tick;
 *   · past ctx.pomodoroMinutes the trigger gains `is-overdue` AND the count
 *     keeps going up (count-up, not countdown — no stop, no ring);
 *   · a running task CLOCK disables the start button (CLOCK always wins) and
 *     hides an already-running standalone POMO;
 *   · an existing standalonePomodoro in the snapshot restores the correct
 *     elapsed from its absolute startedAt (recovery, no accumulated counter);
 *   · destroy() clears the interval, unsubscribes, and removes the control.
 */

"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const path = require("node:path");
const esbuild = require("esbuild");
const { JSDOM } = require("jsdom");

/* ------------------------------------------------------------------ */
/* Bundle pomo.ts (same technique as the other test files).            */
/* ------------------------------------------------------------------ */

const result = esbuild.buildSync({
  entryPoints: [path.join(__dirname, "..", "src", "pomo.ts")],
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
const { renderPomoControl } = moduleShim.exports;

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

function makeDom() {
  const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
    url: "http://localhost/",
  });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  return dom;
}

/** Fake time: node mock timers own `Date`; `window.setInterval` is replaced
 *  with a capturing fake so the test controls exactly when ticks fire. */
function installClock(t, w) {
  t.mock.timers.enable({ apis: ["Date"] });
  const callbacks = new Set();
  w.setInterval = (fn, ms) => {
    const id = { fn, ms };
    callbacks.add(id);
    return id;
  };
  w.clearInterval = (id) => {
    callbacks.delete(id);
  };
  return {
    intervalCount: () => callbacks.size,
    /** Advance the mocked clock by `ms`, then fire every captured tick. */
    tick(ms = 1000) {
      t.mock.timers.tick(ms);
      for (const id of [...callbacks]) id.fn();
    },
  };
}

/** Minimal mock of the TimingRuntime surface pomo.ts touches. */
function makeRuntime(initial = {}) {
  const snapshot = {
    revision: 0,
    status: "ready",
    notice: "",
    planSnapshot: null,
    entries: [],
    dailyReview: {},
    activeWork: { focused: null, recent: [], items: [], count: 0, windowMinutes: 45 },
    pomodoro: null,
    standalonePomodoro: null,
    now: new Date(),
    ...initial,
  };
  const listeners = new Set();
  const runtime = {
    started: 0,
    stopped: 0,
    getSnapshot: () => snapshot,
    setSnapshot(next) {
      Object.assign(snapshot, next);
      for (const listener of [...listeners]) listener(snapshot);
    },
    subscribe(listener) {
      listeners.add(listener);
      listener(snapshot); // the real runtime delivers the current snapshot on subscribe
      return () => listeners.delete(listener);
    },
    startStandalonePomodoro() {
      runtime.started += 1;
      runtime.setSnapshot({ standalonePomodoro: { startedAt: Date.now() } });
      return Promise.resolve();
    },
    stopStandalonePomodoro() {
      runtime.stopped += 1;
      runtime.setSnapshot({ standalonePomodoro: null });
      return Promise.resolve();
    },
  };
  return runtime;
}

function setup(t, { snapshot } = {}) {
  const dom = makeDom();
  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  const clock = installClock(t, dom.window);
  // A snapshot may be a builder `(now) => snapshot` so tests can anchor
  // startedAt on the MOCKED clock (Date.now() is real until the mock is on).
  const resolved = typeof snapshot === "function" ? snapshot(Date.now()) : snapshot;
  const runtime = makeRuntime(resolved);
  const ctx = {
    runtime,
    language: "en",
    pomodoroMinutes: 45,
    forgottenTimerMinutes: 120,
    recentRetentionMinutes: 45,
  };
  const handle = renderPomoControl(container, ctx);
  return { dom, container, clock, runtime, ctx, handle };
}

const selectors = {
  start: ".nautilus-log-timing__pomodoro-start",
  running: ".nautilus-log-timing__trigger",
  elapsed: ".nautilus-log-timing__elapsed",
  close: ".nautilus-log-timing__pomodoro-close",
};

/* ------------------------------------------------------------------ */
/* Tests                                                               */
/* ------------------------------------------------------------------ */

test("click start → count-up elapsed rises with each tick", (t) => {
  const { container, clock, runtime, handle } = setup(t);
  const startBtn = container.querySelector(selectors.start);
  const running = container.querySelector(selectors.running);
  const elapsed = container.querySelector(selectors.elapsed);

  assert.equal(startBtn.hidden, false, "idle: start button visible");
  assert.equal(running.hidden, true, "idle: running reading hidden");

  startBtn.click();
  assert.equal(runtime.started, 1, "start click calls runtime.startStandalonePomodoro()");
  assert.equal(running.hidden, false, "running reading appears");
  assert.equal(elapsed.textContent, "0:00", "begins at zero");

  clock.tick(1000);
  assert.equal(elapsed.textContent, "0:01", "elapsed increments after 1s");
  clock.tick(1000);
  assert.equal(elapsed.textContent, "0:02", "and keeps going");

  handle.destroy();
});

test("🔴 显隐走 CSS 类（is-hidden），不写内联 display（回退即红）", (t) => {
  const { container, handle } = setup(t);
  const startBtn = container.querySelector(selectors.start);
  const running = container.querySelector(selectors.running);

  // idle：start 可见，running 隐藏。两类元素都不许有内联 display。
  assert.equal(startBtn.style.display, "", "可见元素不留内联 display");
  assert.equal(running.style.display, "", "隐藏元素同样不写内联 display（社区审核禁令）");
  assert.ok(running.classList.contains("is-hidden"), "隐藏 = 带 is-hidden 类");
  assert.ok(!startBtn.classList.contains("is-hidden"), "可见 = 不带 is-hidden 类");

  handle.destroy();
});

test("past threshold → is-overdue added and the count KEEPS rising", (t) => {
  const { container, clock, handle } = setup(t, {
    snapshot: (now) => ({ standalonePomodoro: { startedAt: now - 50 * 60 * 1000 } }),
  });
  const running = container.querySelector(selectors.running);
  const elapsed = container.querySelector(selectors.elapsed);

  assert.equal(elapsed.textContent, "50:00", "50 minutes elapsed");
  assert.equal(running.classList.contains("is-overdue"), true, "past the 45m threshold");

  clock.tick(1000);
  assert.equal(elapsed.textContent, "50:01", "still counting up after the threshold");
  assert.equal(running.classList.contains("is-overdue"), true, "stays overdue");

  handle.destroy();
});

test("running task CLOCK → start button disabled and not startable", (t) => {
  const focused = {
    start: new Date(),
    running: true,
    title: "Focused task",
    taskUid: "t1",
    clockUid: "c1",
    taskString: "{{TODO}} Focused task",
  };
  const { container, runtime, handle } = setup(t, {
    snapshot: {
      activeWork: { focused, recent: [], items: [focused], count: 1, windowMinutes: 45 },
      standalonePomodoro: null,
    },
  });
  const startBtn = container.querySelector(selectors.start);

  assert.equal(startBtn.disabled, true, "CLOCK running → start disabled");

  startBtn.click();
  assert.equal(runtime.started, 0, "click on the disabled start must not start a POMO");

  handle.destroy();
});

test("restores correct elapsed from an existing standalonePomodoro (recovery)", (t) => {
  const { container, handle } = setup(t, {
    snapshot: (now) => ({ standalonePomodoro: { startedAt: now - 5 * 60 * 1000 } }),
  });
  const elapsed = container.querySelector(selectors.elapsed);

  assert.equal(elapsed.textContent, "5:00", "recovered 5 minutes of elapsed from startedAt");
  assert.equal(container.querySelector(selectors.running).hidden, false, "running reading shown");

  handle.destroy();
});

test("stop button calls stopStandalonePomodoro() and returns to idle", (t) => {
  const { container, runtime, handle } = setup(t);
  const startBtn = container.querySelector(selectors.start);
  const running = container.querySelector(selectors.running);
  const closeBtn = container.querySelector(selectors.close);

  startBtn.click();
  assert.equal(running.hidden, false, "standalone POMO running");

  closeBtn.click();
  assert.equal(runtime.stopped, 1, "stop click calls runtime.stopStandalonePomodoro()");
  assert.equal(running.hidden, true, "running reading hidden");
  assert.equal(startBtn.hidden, false, "start button back");
  assert.equal(startBtn.disabled, false, "and enabled again");

  handle.destroy();
});

test("a task CLOCK starting hides an active standalone POMO (CLOCK priority)", (t) => {
  const { container, runtime, handle } = setup(t);
  const startBtn = container.querySelector(selectors.start);
  const running = container.querySelector(selectors.running);

  startBtn.click();
  assert.equal(running.hidden, false, "standalone POMO running");

  // A task CLOCK starts: the runtime clears standalonePomodoro and sets focused.
  const focused = {
    start: new Date(),
    running: true,
    title: "Focused",
    taskUid: "t",
    clockUid: "c",
    taskString: "{{TODO}} Focused",
  };
  runtime.setSnapshot({
    standalonePomodoro: null,
    activeWork: { focused, recent: [], items: [focused], count: 1, windowMinutes: 45 },
  });

  assert.equal(running.hidden, true, "standalone POMO hidden while a CLOCK runs");
  assert.equal(startBtn.hidden, false, "start button shown");
  assert.equal(startBtn.disabled, true, "and disabled — CLOCK always has priority");

  handle.destroy();
});

test("destroy() clears the interval, unsubscribes, and stops all updates", (t) => {
  const { container, clock, runtime, handle } = setup(t);
  const startBtn = container.querySelector(selectors.start);
  const running = container.querySelector(selectors.running);

  startBtn.click();
  assert.equal(running.hidden, false, "standalone POMO running");
  const before = container.innerHTML;

  handle.destroy();
  assert.equal(
    container.querySelector(".nautilus-log-timing__pomo"),
    null,
    "control removed from the container",
  );

  // Time passes and the runtime pushes again — nothing may come back.
  clock.tick(5000);
  assert.equal(container.innerHTML, "", "no updates after destroy");

  // A late runtime publish must not re-create anything either.
  runtime.setSnapshot({ standalonePomodoro: { startedAt: Date.now() - 1000 } });
  assert.equal(container.innerHTML, "", "late publish is ignored after destroy");

  handle.destroy(); // idempotent — must not throw
});
