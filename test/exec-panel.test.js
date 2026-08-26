/*
 * exec-panel.test.js — the execution panel (three views).
 *
 * Bundles `src/exec-panel.ts` with esbuild, keeping `obsidian` external and
 * resolving it to `obsidian-mock.cjs` so the panel and the test share the same
 * DOM helper shapes. DOM comes from jsdom, with the Obsidian DOM helpers the
 * panel relies on (createDiv / createEl / setText / addClass / empty)
 * polyfilled onto the jsdom HTMLElement prototype — the same trick the sidebar
 * test uses.
 *
 * The runtime is a controllable fake implementing the `TimingRuntime` shape:
 * getSnapshot / subscribe / startTask / stopTask / completeTask /
 * deleteCurrentClock / openTask / locate. It records every call so the tests
 * can assert interactions, and it lets a test push a fresh snapshot (revision
 * bump) or a same-revision clock tick (now only).
 *
 * Covered:
 *   · Timing view renders the focused CLOCK row and recent rows;
 *   · no CLOCK => Timing shows an empty state, does not crash;
 *   · Plan view lists unfinished direct-child tasks and its empty states;
 *   · Review view renders the summary and per-row variance;
 *   · forgotten-timer threshold shows a warning and never auto-stops/deletes;
 *   · row actions call the right runtime methods (start/stop/complete/open/locate);
 *   · delete current CLOCK needs a two-click confirmation;
 *   · a same-revision tick updates elapsed text without rebuilding the list;
 *   · destroy() unsubscribes — later snapshots do not re-render.
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
/* Bundle the panel with obsidian left external                        */
/* ------------------------------------------------------------------ */

const result = esbuild.buildSync({
  entryPoints: [path.join(SRC, "exec-panel.ts")],
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
const { renderExecPanel } = moduleShim.exports;

/* ------------------------------------------------------------------ */
/* jsdom + Obsidian DOM helpers + globals                              */
/* ------------------------------------------------------------------ */

function makeDom() {
  const dom = new JSDOM("<!DOCTYPE html><body></body>", { url: "http://localhost/" });
  const H = dom.window.HTMLElement.prototype;
  H.addClass = function addClass(cls) { this.classList.add(cls); };
  H.empty = function empty() { while (this.firstChild) this.removeChild(this.firstChild); };
  H.createDiv = function createDiv(opts = {}) {
    const d = dom.window.document.createElement("div");
    if (opts.cls) d.className = opts.cls;
    this.appendChild(d);
    return d;
  };
  H.createEl = function createEl(tag, opts = {}) {
    const e = dom.window.document.createElement(tag);
    if (opts.cls) e.className = opts.cls;
    if (opts.text) e.textContent = opts.text;
    this.appendChild(e);
    return e;
  };
  H.setText = function setText(t) { this.textContent = t; };
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  return dom;
}

/* ------------------------------------------------------------------ */
/* Controllable TimingRuntime fake                                     */
/* ------------------------------------------------------------------ */

function makeRuntime(initialSnapshot) {
  let snapshot = initialSnapshot;
  const listeners = new Set();
  const calls = {
    startTask: [],
    stopTask: 0,
    completeTask: [],
    deleteCurrentClock: [],
    openTask: [],
    locate: 0,
    requestRefresh: 0,
  };
  const notify = () => {
    for (const listener of [...listeners]) listener(snapshot);
  };
  return {
    calls,
    listenerCount: () => listeners.size,
    getSnapshot: () => snapshot,
    /** Data change: bumps revision so the panel full-renders. */
    push(next) {
      snapshot = { ...snapshot, ...next, revision: (snapshot.revision || 0) + 1 };
      notify();
    },
    /** Pure clock tick: same revision, only `now` moves. */
    pushTick(now) {
      snapshot = { ...snapshot, now };
      notify();
    },
    subscribe(listener) {
      listeners.add(listener);
      listener(snapshot);
      return () => { listeners.delete(listener); };
    },
    startTask(uid) { calls.startTask.push(uid); return Promise.resolve(); },
    stopTask() { calls.stopTask += 1; return Promise.resolve(); },
    completeTask(uid) { calls.completeTask.push(uid); return Promise.resolve(); },
    deleteCurrentClock(uid) { calls.deleteCurrentClock.push(uid); return Promise.resolve(); },
    openTask(uid, opts) { calls.openTask.push({ uid, opts }); return Promise.resolve(); },
    locate() { calls.locate += 1; return Promise.resolve(); },
    requestRefresh() { calls.requestRefresh += 1; return Promise.resolve(); },
  };
}

function makeCtx(runtime, overrides = {}) {
  return {
    runtime,
    language: "en",
    pomodoroMinutes: 45,
    forgottenTimerMinutes: 0,
    recentRetentionMinutes: 45,
    ...overrides,
  };
}

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

const NOW = new Date(2026, 7, 24, 12, 0, 0); // 2026-08-24 12:00 local

function focusedSnapshot(overrides = {}) {
  const focused = {
    clockUid: "Journal/2026-08-24.md:5",
    taskUid: "Journal/2026-08-24.md:3",
    taskString: "{{TODO}} Write report 45m",
    title: "Write report",
    start: new Date(2026, 7, 24, 11, 30),
    running: true,
    status: "TODO",
    activeKind: "focused",
  };
  const recent = {
    clockUid: "Journal/2026-08-24.md:9",
    taskUid: "Journal/2026-08-24.md:7",
    taskString: "{{TODO}} Reply emails 20m",
    title: "Reply emails",
    start: new Date(2026, 7, 24, 11, 40),
    end: new Date(2026, 7, 24, 11, 50),
    running: false,
    status: "TODO",
    activeKind: "recent",
  };
  return {
    revision: 1,
    status: "ready",
    notice: "",
    planSnapshot: {
      plan: { uid: "Journal/2026-08-24.md:1" },
      tasks: [
        { uid: "Journal/2026-08-24.md:3", string: "{{TODO}} Write report 45m", title: "Write report", plannedMinutes: 45, remainingMinutes: 20, progress: 0 },
        { uid: "Journal/2026-08-24.md:4", string: "{{TODO}} Call standup 15m", title: "Call standup", plannedMinutes: 15, remainingMinutes: 15, progress: 0 },
      ],
    },
    entries: [focused, recent],
    dailyReview: {
      summary: { totalCount: 3, completedCount: 1, comparedCount: 1, plannedMinutes: 45, actualMinutes: 50, varianceMinutes: 5 },
      rows: [
        { uid: "Journal/2026-08-24.md:3", title: "Write report", plannedMinutes: 45, status: "TODO", state: "live", actualMinutes: 30, varianceMinutes: null },
        { uid: "Journal/2026-08-24.md:6", title: "Ship v1", plannedMinutes: 45, status: "DONE", state: "compared", actualMinutes: 50, varianceMinutes: 5 },
        { uid: "Journal/2026-08-24.md:4", title: "Call standup", plannedMinutes: 15, status: "TODO", state: "not-started", actualMinutes: 0, varianceMinutes: null },
      ],
    },
    activeWork: { focused, recent: [recent], items: [focused, recent], count: 2, windowMinutes: 45 },
    pomodoro: null,
    standalonePomodoro: null,
    now: NOW,
    ...overrides,
  };
}

function mount(runtime, overrides = {}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const panel = renderExecPanel(container, makeCtx(runtime, overrides));
  return { container, panel };
}

function findTab(container, label) {
  return [...container.querySelectorAll(".nautilus-log-exec-tab")]
    .find((button) => button.textContent === label);
}

/* ------------------------------------------------------------------ */
/* Tests — Timing view                                                 */
/* ------------------------------------------------------------------ */

test("Timing view renders the focused CLOCK and recent rows", () => {
  makeDom();
  const runtime = makeRuntime(focusedSnapshot());
  const { container, panel } = mount(runtime);

  const rows = container.querySelectorAll(".nautilus-log-exec-row");
  assert.equal(rows.length, 2, "focused + one recent row");

  const focusedRow = container.querySelector(".nautilus-log-exec-row.is-focused");
  assert.ok(focusedRow, "focused row carries is-focused");
  assert.equal(focusedRow.querySelector(".nautilus-log-exec-row-title").textContent, "Write report");
  const focusedButtons = [...focusedRow.querySelectorAll(".nautilus-log-exec-row-actions button")].map((b) => b.textContent);
  assert.ok(focusedButtons.includes("Clock Out"), "focused row offers Clock Out");
  assert.ok(focusedButtons.includes("Complete task"), "focused row offers Complete");
  assert.ok(focusedButtons.includes("Delete current CLOCK"), "focused row offers Delete current CLOCK");
  assert.match(focusedRow.querySelector(".nautilus-log-exec-row-meta").textContent, /Timing 30:00/);

  const recentRow = container.querySelector(".nautilus-log-exec-row:not(.is-focused)");
  assert.ok(recentRow, "recent row exists");
  assert.equal(recentRow.querySelector(".nautilus-log-exec-row-title").textContent, "Reply emails");
  assert.match(recentRow.textContent, /Recent · 35m left/);
  assert.ok([...recentRow.querySelectorAll("button")].some((b) => b.textContent === "Clock In"), "recent row offers Clock In");

  panel.destroy();
});

test("Timing view shows an empty state when no CLOCK is running", () => {
  makeDom();
  const runtime = makeRuntime(focusedSnapshot({
    activeWork: { focused: null, recent: [], items: [], count: 0, windowMinutes: 45 },
    entries: [],
  }));
  const { container, panel } = mount(runtime);

  const empty = container.querySelector(".nautilus-log-exec-empty");
  assert.ok(empty, "empty state present");
  assert.equal(empty.textContent, "No active work. Open Plan to start a task.");
  assert.equal(container.querySelectorAll(".nautilus-log-exec-row").length, 0);

  panel.destroy();
});

/* ------------------------------------------------------------------ */
/* Tests — Plan view                                                   */
/* ------------------------------------------------------------------ */

test("Plan view lists unfinished direct-child tasks", () => {
  makeDom();
  const runtime = makeRuntime(focusedSnapshot());
  const { container, panel } = mount(runtime);

  findTab(container, "Plan").click();

  const rows = container.querySelectorAll(".nautilus-log-exec-row");
  assert.equal(rows.length, 2, "two unfinished direct children");
  assert.equal(container.querySelector(".nautilus-log-exec-row-title").textContent, "Write report");
  const allButtons = [...container.querySelectorAll(".nautilus-log-exec-row-actions button")].map((b) => b.textContent);
  assert.ok(allButtons.includes("Clock In"), "unfocused plan row offers Clock In");
  assert.ok(allButtons.includes("Complete task"));
  // the focused plan row offers Clock Out + Delete
  const focusedInPlan = container.querySelector(".nautilus-log-exec-row.is-focused");
  assert.ok(focusedInPlan, "focused task still marked when shown in Plan");
  assert.ok([...focusedInPlan.querySelectorAll("button")].some((b) => b.textContent === "Clock Out"));

  panel.destroy();
});

test("Plan view empty states", () => {
  makeDom();

  // No plan at all.
  const runtime = makeRuntime(focusedSnapshot({ planSnapshot: null }));
  const a = mount(runtime);
  findTab(a.container, "Plan").click();
  assert.equal(
    a.container.querySelector(".nautilus-log-exec-empty").textContent,
    "No Nautilus Log was found on today’s Daily Note.",
  );
  a.panel.destroy();

  // A plan with no unfinished tasks.
  const runtime2 = makeRuntime(focusedSnapshot({ planSnapshot: { plan: { uid: "x" }, tasks: [] } }));
  const b = mount(runtime2);
  findTab(b.container, "Plan").click();
  assert.equal(
    b.container.querySelector(".nautilus-log-exec-empty").textContent,
    "The Primary Plan has no unfinished direct-child tasks.",
  );
  b.panel.destroy();
});

/* ------------------------------------------------------------------ */
/* Tests — Review view                                                 */
/* ------------------------------------------------------------------ */

test("Review view renders the summary and per-row variance", () => {
  makeDom();
  const runtime = makeRuntime(focusedSnapshot());
  const { container, panel } = mount(runtime);

  findTab(container, "Review").click();

  const summary = container.querySelector(".nautilus-log-exec-review-summary");
  assert.ok(summary, "review summary present");
  assert.match(summary.textContent, /Completed 1\/3/);
  assert.match(summary.textContent, /Compared 1/);
  assert.match(summary.textContent, /Variance \+5m/);
  // T3-081: 摘要行的正偏差也要带 is-over —— 不只是 Review 行级有。
  assert.ok(
    container.querySelector(
      ".nautilus-log-exec-review-totals .nautilus-log-exec-review-total.is-over",
    ),
    "a positive summary variance paints the summary cell is-over too",
  );

  const rows = container.querySelectorAll(".nautilus-log-exec-review-row");
  assert.equal(rows.length, 3);

  const comparedRow = container.querySelector(".nautilus-log-exec-review-row.is-compared");
  assert.ok(comparedRow, "compared row rendered");
  assert.equal(comparedRow.querySelector(".nautilus-log-exec-review-title").textContent, "Ship v1");
  assert.match(comparedRow.textContent, /\+5m/);
  assert.ok(comparedRow.querySelector(".nautilus-log-exec-review-variance.is-over"), "positive variance is is-over");

  const liveRow = container.querySelector(".nautilus-log-exec-review-row.is-live");
  assert.ok(liveRow.querySelector("[data-review-live-actual]"), "live row exposes live actual for ticking");

  const notStarted = container.querySelector(".nautilus-log-exec-review-row.is-not-started");
  assert.match(notStarted.textContent, /Actual —/);

  panel.destroy();
});

test("Review view shows an empty state when the plan has no tasks", () => {
  makeDom();
  const runtime = makeRuntime(focusedSnapshot({
    dailyReview: { summary: { totalCount: 0, completedCount: 0, comparedCount: 0, plannedMinutes: 0, actualMinutes: 0, varianceMinutes: 0 }, rows: [] },
  }));
  const { container, panel } = mount(runtime);
  findTab(container, "Review").click();
  assert.equal(
    container.querySelector(".nautilus-log-exec-empty").textContent,
    "The Primary Plan has no direct-child tasks to review.",
  );
  panel.destroy();
});

/* ------------------------------------------------------------------ */
/* Tests — forgotten-timer warning                                     */
/* ------------------------------------------------------------------ */

test("forgotten timer threshold shows a warning but never touches the CLOCK", () => {
  makeDom();
  const snap = focusedSnapshot();
  snap.activeWork.focused.start = new Date(2026, 7, 24, 11, 0); // running 60 min by 12:00
  const runtime = makeRuntime(snap);
  const { container, panel } = mount(runtime, { forgottenTimerMinutes: 30 });

  const focusedRow = container.querySelector(".nautilus-log-exec-row.is-focused");
  assert.ok(focusedRow.classList.contains("is-forgotten"), "focused row flagged is-forgotten");
  const warn = container.querySelector(".nautilus-log-exec-forgotten");
  assert.ok(warn, "forgotten warning banner present");
  assert.match(warn.textContent, /Check CLOCK/);
  assert.match(warn.textContent, /Write report/);
  assert.ok(focusedRow.querySelector(".nautilus-log-exec-row-meta").classList.contains("is-warning"));

  // 🔴 只警告：绝不自动停止或删除。
  assert.equal(runtime.calls.stopTask, 0, "never auto Clock Out");
  assert.deepEqual(runtime.calls.deleteCurrentClock, [], "never auto deletes the CLOCK");

  panel.destroy();
});

test("forgottenTimerMinutes = 0 disables the warning", () => {
  makeDom();
  const snap = focusedSnapshot();
  snap.activeWork.focused.start = new Date(2026, 7, 24, 11, 0);
  const runtime = makeRuntime(snap);
  const { container, panel } = mount(runtime, { forgottenTimerMinutes: 0 });

  assert.ok(!container.querySelector(".nautilus-log-exec-forgotten"), "no warning banner when disabled");
  const focusedRow = container.querySelector(".nautilus-log-exec-row.is-focused");
  assert.ok(!focusedRow.classList.contains("is-forgotten"), "row not flagged when disabled");

  panel.destroy();
});

/* ------------------------------------------------------------------ */
/* Tests — interactions                                                */
/* ------------------------------------------------------------------ */

test("row actions call the right runtime methods", () => {
  makeDom();
  const runtime = makeRuntime(focusedSnapshot());
  const { container, panel } = mount(runtime);

  const title = container.querySelector(".nautilus-log-exec-row-title");
  title.click();
  assert.deepEqual(
    runtime.calls.openTask,
    [{ uid: "Journal/2026-08-24.md:3", opts: { sidebar: false } }],
    "clicking the title opens the task",
  );

  const clockOut = [...container.querySelectorAll(".nautilus-log-exec-row-actions button")].find((b) => b.textContent === "Clock Out");
  clockOut.click();
  assert.equal(runtime.calls.stopTask, 1, "Clock Out stops the current task");

  const complete = [...container.querySelectorAll(".nautilus-log-exec-row-actions button")].find((b) => b.textContent === "Complete task");
  complete.click();
  assert.deepEqual(runtime.calls.completeTask, ["Journal/2026-08-24.md:3"]);

  const identity = container.querySelector(".nautilus-log-exec-identity");
  identity.click();
  assert.equal(runtime.calls.locate, 1, "Locate calls runtime.locate()");

  panel.destroy();
});

test("Clock In on an unfocused plan task starts that task", () => {
  makeDom();
  const runtime = makeRuntime(focusedSnapshot());
  const { container, panel } = mount(runtime);
  findTab(container, "Plan").click();

  const unfocusedRow = container.querySelector(".nautilus-log-exec-row:not(.is-focused)");
  const clockIn = [...unfocusedRow.querySelectorAll("button")].find((b) => b.textContent === "Clock In");
  clockIn.click();
  assert.deepEqual(runtime.calls.startTask, ["Journal/2026-08-24.md:4"]);
  assert.equal(runtime.calls.stopTask, 0, "switching happens inside runtime.startTask, not the panel");

  panel.destroy();
});

test("delete current CLOCK needs a two-click confirmation", () => {
  makeDom();
  const runtime = makeRuntime(focusedSnapshot());
  const { container, panel } = mount(runtime);

  const deleteBtn = [...container.querySelectorAll(".nautilus-log-exec-row-actions button")]
    .find((b) => b.textContent === "Delete current CLOCK");
  deleteBtn.click();
  assert.deepEqual(runtime.calls.deleteCurrentClock, [], "first click only arms the confirmation");
  assert.equal(deleteBtn.textContent, "Click again to delete current CLOCK");

  deleteBtn.click();
  assert.deepEqual(runtime.calls.deleteCurrentClock, ["Journal/2026-08-24.md:3"], "second click deletes the CLOCK");

  panel.destroy();
});

/* ------------------------------------------------------------------ */
/* Tests — subscription lifecycle                                      */
/* ------------------------------------------------------------------ */

test("a same-revision tick updates elapsed text without rebuilding the list", () => {
  makeDom();
  const runtime = makeRuntime(focusedSnapshot());
  const { container, panel } = mount(runtime);

  const rowBefore = container.querySelector(".nautilus-log-exec-row.is-focused");
  const metaBefore = rowBefore.querySelector(".nautilus-log-exec-row-meta.is-live");
  // Capture the string now — `metaBefore` is a live node, so reading
  // `.textContent` after the tick would already show the updated value.
  const metaBeforeText = metaBefore.textContent;

  runtime.pushTick(new Date(2026, 7, 24, 12, 0, 30)); // 30 s later, same revision

  const rowAfter = container.querySelector(".nautilus-log-exec-row.is-focused");
  assert.equal(rowAfter, rowBefore, "same row node retained — no rebuild");
  const metaAfterText = rowAfter.querySelector(".nautilus-log-exec-row-meta.is-live").textContent;
  assert.match(metaAfterText, /Timing 30:30/);
  assert.notEqual(metaAfterText, metaBeforeText, "elapsed text updated in place");

  panel.destroy();
});

test("destroy() unsubscribes; later snapshots do not re-render", () => {
  makeDom();
  const runtime = makeRuntime(focusedSnapshot());
  const { container, panel } = mount(runtime);

  assert.equal(runtime.listenerCount(), 1, "subscribed on mount");

  panel.destroy();
  assert.equal(runtime.listenerCount(), 0, "unsubscribed on destroy");

  const before = container.innerHTML;
  runtime.push(focusedSnapshot({ revision: 999 }));
  assert.equal(container.innerHTML, before, "no re-render after destroy");
});

/* ------------------------------------------------------------------ */
/* Tests — freshness on mount (认证审计 T3-033)                         */
/* ------------------------------------------------------------------ */

test("mounting the panel requests one fresh refresh (T3-033)", () => {
  makeDom();
  const runtime = makeRuntime(focusedSnapshot());
  const { container, panel } = mount(runtime);

  assert.equal(
    runtime.calls.requestRefresh,
    1,
    "the panel asks the runtime for fresh data the moment it mounts",
  );

  panel.destroy();
});

/* ------------------------------------------------------------------ */
/* Tests — Plan sections / capacity strip / duration fallback          */
/*                                                                     */
/* These cover what the hand-written panel silently dropped when the   */
/* vendored `timing-topbar.js` was re-implemented instead of reused    */
/* (PORTING-DECISIONS.md §D3, parity audit §P1-2). The data comes from */
/* `planSnapshot.execution`, which the vendored runtime has always     */
/* produced and the panel never read.                                  */
/* ------------------------------------------------------------------ */

/** Snapshot whose planSnapshot carries the runtime's execution projection. */
function scheduledSnapshot(overrides = {}) {
  const base = focusedSnapshot();
  const write = { ...base.planSnapshot.tasks[0], start: 12 * 60, end: 12 * 60 + 45 };
  const standup = { ...base.planSnapshot.tasks[1] };
  return {
    ...base,
    planSnapshot: {
      ...base.planSnapshot,
      execution: {
        scheduledTasks: [write],
        overflowTasks: [standup],
        // capacityMetrics inputs — capacitySummary reads these three groups.
        availableMinutes: 300,
        totalAvailableMinutes: 600,
        demandMinutes: 60,
        fixedMinutes: 0,
        totalFixedMinutes: 0,
        overloadMinutes: 0,
        unplacedMinutes: 0,
      },
    },
    ...overrides,
  };
}

test("Plan splits into Scheduled / Unscheduled sections, each with a count", () => {
  makeDom();
  const runtime = makeRuntime(scheduledSnapshot());
  const { container, panel } = mount(runtime);
  findTab(container, "Plan").click();

  const headings = [...container.querySelectorAll(".nautilus-log-exec-plan-label")]
    .map((n) => n.textContent);
  // 折叠箭头不再拼进标签文本 —— 它是独立的 aria-hidden 图标（见下一条断言）。
  assert.deepEqual(headings, ["Scheduled today · 1", "Unscheduled today · 1"]);

  // Unscheduled starts collapsed: only the scheduled row is rendered.
  const rows = container.querySelectorAll(".nautilus-log-exec-row");
  assert.equal(rows.length, 1, "collapsed Unscheduled contributes no rows");
  assert.ok(rows[0].classList.contains("is-scheduled"));

  const disclosure = container.querySelector(".nautilus-log-exec-plan-heading.is-collapsible");
  assert.equal(disclosure.getAttribute("aria-expanded"), "false");
  disclosure.click();
  assert.equal(
    container.querySelector(".nautilus-log-exec-plan-heading.is-collapsible").getAttribute("aria-expanded"),
    "true",
  );
  const expanded = container.querySelectorAll(".nautilus-log-exec-row");
  assert.equal(expanded.length, 2, "expanding Unscheduled reveals its row");
  assert.ok([...expanded].some((r) => r.classList.contains("is-unscheduled")));

  panel.destroy();
});

test("scheduled rows carry the Today HH:MM–HH:MM · Remaining/Planned meta", () => {
  makeDom();
  const runtime = makeRuntime(scheduledSnapshot());
  const { container, panel } = mount(runtime);
  findTab(container, "Plan").click();

  const meta = container.querySelector(".nautilus-log-exec-row.is-scheduled .nautilus-log-exec-row-meta");
  // remainingMinutes 20 < plannedMinutes 45 => both halves are shown.
  assert.equal(meta.textContent, "Today 12:00–12:45 · Remaining 20m · Planned 45m");
  // The focused task is also the scheduled one: its meta must NOT be the
  // stopwatch, and must not be claimed by the per-second live updater.
  assert.equal(meta.classList.contains("is-live"), false);

  const unscheduledMeta = () => container
    .querySelector(".nautilus-log-exec-row.is-unscheduled .nautilus-log-exec-row-meta").textContent;
  container.querySelector(".nautilus-log-exec-plan-heading.is-collapsible").click();
  assert.equal(unscheduledMeta(), "Unscheduled today · Planned 15m");

  panel.destroy();
});

test("capacity strip is present on all three tabs", () => {
  makeDom();
  const runtime = makeRuntime(scheduledSnapshot());
  const { container, panel } = mount(runtime);

  const stripText = () => {
    const strip = container.querySelector(".nautilus-log-exec-capacity");
    assert.ok(strip, "capacity strip rendered");
    return strip.textContent;
  };
  // planned = demandMinutes, status = free (availableMinutes - demand),
  // left = free / totalAvailableMinutes.
  assert.equal(stripText(), "1h planned · 4h free · 40% left");
  findTab(container, "Plan").click();
  assert.equal(stripText(), "1h planned · 4h free · 40% left");
  findTab(container, "Review").click();
  assert.equal(stripText(), "1h planned · 4h free · 40% left");

  panel.destroy();
});

test("no execution projection => no capacity strip, Plan stays flat", () => {
  makeDom();
  const runtime = makeRuntime(focusedSnapshot()); // no planSnapshot.execution
  const { container, panel } = mount(runtime);
  assert.equal(container.querySelector(".nautilus-log-exec-capacity"), null);
  findTab(container, "Plan").click();
  assert.equal(container.querySelectorAll(".nautilus-log-exec-plan-section").length, 0);
  assert.equal(container.querySelectorAll(".nautilus-log-exec-row").length, 2);
  panel.destroy();
});

test("untimed tasks fall back to ctx.todoDuration, not a hard-coded 15", () => {
  makeDom();
  const focused = {
    clockUid: "Journal/2026-08-24.md:5",
    taskUid: "Journal/2026-08-24.md:3",
    taskString: "{{TODO}} Untimed chore", // no duration token
    title: "Untimed chore",
    start: new Date(2026, 7, 24, 11, 30),
    running: true,
    status: "TODO",
  };
  const snapshot = focusedSnapshot();
  const runtime = makeRuntime({
    ...snapshot,
    entries: [focused],
    activeWork: { focused, recent: [], items: [focused], count: 1, windowMinutes: 45 },
  });
  const { container, panel } = mount(runtime, { todoDuration: 30 });

  const row = container.querySelector(".nautilus-log-exec-row.is-focused");
  assert.equal(row.dataset.plannedMinutes, "30", "reads todo-duration from the context");
  assert.match(row.querySelector(".nautilus-log-exec-row-meta").textContent, /Planned 30m/);

  panel.destroy();
});

test("a running task's progress reduces its remaining minutes (d50%)", () => {
  makeDom();
  const focused = {
    clockUid: "Journal/2026-08-24.md:5",
    taskUid: "Journal/2026-08-24.md:3",
    taskString: "{{TODO}} Write report 45m d50%",
    title: "Write report",
    start: new Date(2026, 7, 24, 11, 30),
    running: true,
    status: "TODO",
  };
  const snapshot = focusedSnapshot();
  const runtime = makeRuntime({
    ...snapshot,
    entries: [focused],
    activeWork: { focused, recent: [], items: [focused], count: 1, windowMinutes: 45 },
  });
  const { container, panel } = mount(runtime);

  const row = container.querySelector(".nautilus-log-exec-row.is-focused");
  assert.equal(row.dataset.plannedMinutes, "45");
  // 45m at 50% done => 23m remaining (timing-core.js:352 rounding), never 0.
  assert.equal(row.dataset.remainingMinutes, "23");

  panel.destroy();
});

/* ------------------------------------------------------------------ */
/* Tests — write-back window (认证审计 T3-032)                          */
/*                                                                     */
/* MINE's structure key contains `status`, so a queued write used to    */
/* rebuild the whole table: the list flickers and — worse — an already  */
/* armed delete-confirmation button becomes an orphan node whose 2.5s   */
/* timeout then resets a button that is no longer in the document.      */
/* Upstream only greys the buttons out during that frame.               */
/* ------------------------------------------------------------------ */

test("status==='working' greys the buttons out instead of rebuilding the rows", () => {
  makeDom();
  const runtime = makeRuntime(focusedSnapshot());
  const { container, panel } = mount(runtime);

  const rowBefore = container.querySelector(".nautilus-log-exec-row.is-focused");
  const deleteBefore = rowBefore.querySelector(".is-delete-clock");

  // Arm the delete confirmation, then let a write-back land.
  deleteBefore.click();
  assert.ok(deleteBefore.classList.contains("is-confirming"), "confirmation armed");

  runtime.push({ status: "working" });

  const rowAfter = container.querySelector(".nautilus-log-exec-row.is-focused");
  assert.equal(rowAfter, rowBefore, "the row node must survive the write-back");
  const deleteAfter = rowAfter.querySelector(".is-delete-clock");
  assert.equal(deleteAfter, deleteBefore, "the armed button must not become an orphan node");
  assert.ok(deleteAfter.classList.contains("is-confirming"), "confirmation survives the write-back");
  assert.equal(deleteAfter.disabled, true, "…but every row action is disabled meanwhile");
  assert.equal(
    [...rowAfter.querySelectorAll(".nautilus-log-exec-row-actions button")].every((b) => b.disabled),
    true,
  );

  // The confirmed refresh re-enables them again.
  runtime.push({ status: "ready" });
  assert.equal(
    [...container.querySelectorAll(".nautilus-log-exec-row-actions button")].some((b) => b.disabled),
    false,
    "buttons come back once the write-back is confirmed",
  );

  panel.destroy();
});

/* ------------------------------------------------------------------ */
/* Tests — live context + view state (认证审计 T3-034)                  */
/* ------------------------------------------------------------------ */

test("context is read per render: refresh() picks up new settings and keeps the view", () => {
  makeDom();
  const runtime = makeRuntime(scheduledSnapshot());
  const container = document.createElement("div");
  document.body.appendChild(container);
  let ctx = makeCtx(runtime);
  const panel = renderExecPanel(container, () => ctx);

  findTab(container, "Plan").click();
  container.querySelector(".nautilus-log-exec-plan-heading.is-collapsible").click();
  assert.deepEqual(panel.getViewState(), { view: "plan", unscheduledExpanded: true });

  // The user switches the language in settings — no remount.
  ctx = makeCtx(runtime, { language: "zh" });
  panel.refresh();

  assert.ok(findTab(container, "计划"), "tabs re-render in the new language");
  assert.deepEqual(
    panel.getViewState(),
    { view: "plan", unscheduledExpanded: true },
    "a settings change must not kick the user back to Timing / collapse the section",
  );
  assert.equal(
    container.querySelector(".nautilus-log-exec-tab.is-active").textContent,
    "计划",
    "the Plan tab is still the active one",
  );
  assert.equal(
    container.querySelectorAll(".nautilus-log-exec-row.is-unscheduled").length,
    1,
    "the expanded Unscheduled section is still expanded",
  );

  panel.destroy();
});

test("a rebuilt panel can be handed the previous view state", () => {
  makeDom();
  const runtime = makeRuntime(scheduledSnapshot());
  const container = document.createElement("div");
  document.body.appendChild(container);
  const panel = renderExecPanel(container, makeCtx(runtime), {
    viewState: { view: "plan", unscheduledExpanded: true },
  });

  assert.equal(container.querySelector(".nautilus-log-exec-tab.is-active").textContent, "Plan");
  assert.equal(container.querySelectorAll(".nautilus-log-exec-row.is-unscheduled").length, 1);
  panel.destroy();
});

/* ------------------------------------------------------------------ */
/* Tests — dHH:MM done anchor (认证审计 T1-022 / G1-089)                */
/* ------------------------------------------------------------------ */

test("the dHH:MM done anchor never reaches Timing / Review row titles", () => {
  makeDom();
  const base = focusedSnapshot();
  const focused = { ...base.activeWork.focused, title: "Weekly report d11:20" };
  const runtime = makeRuntime({
    ...base,
    entries: [focused],
    activeWork: { ...base.activeWork, focused, recent: [], items: [focused], count: 1 },
    forgottenTimerMinutes: 0,
    dailyReview: {
      ...base.dailyReview,
      rows: [{ ...base.dailyReview.rows[0], title: "Weekly report d11:20" }],
    },
  });
  const { container, panel } = mount(runtime);

  const rowTitle = container.querySelector(".nautilus-log-exec-row-title");
  assert.equal(rowTitle.textContent, "Weekly report");
  assert.equal(rowTitle.title, "Weekly report");

  findTab(container, "Review").click();
  const reviewTitle = container.querySelector(".nautilus-log-exec-review-title");
  assert.equal(reviewTitle.textContent, "Weekly report");

  panel.destroy();
});

test("the forgotten-clock warning line uses the anchor-free title too", () => {
  makeDom();
  const base = focusedSnapshot();
  const focused = {
    ...base.activeWork.focused,
    title: "Weekly report d11:20",
    start: new Date(2026, 7, 24, 6, 0), // 6h before NOW
  };
  const runtime = makeRuntime({
    ...base,
    entries: [focused],
    activeWork: { ...base.activeWork, focused, recent: [], items: [focused], count: 1 },
  });
  const { container, panel } = mount(runtime, { forgottenTimerMinutes: 120 });

  const warning = container.querySelector(".nautilus-log-exec-forgotten");
  // T3-045: MINE renders a whole extra warning row (upstream only prefixes the
  // row meta). That superset is intentional — this asserts it is still there.
  assert.ok(warning, "the extra forgotten-clock warning row is still rendered");
  assert.equal(warning.textContent, "Check CLOCK: Weekly report");
  // …and it never stops or deletes the CLOCK.
  assert.equal(runtime.calls.stopTask, 0);
  assert.deepEqual(runtime.calls.deleteCurrentClock, []);

  panel.destroy();
});

/* ------------------------------------------------------------------ */
/* Tests — collapse arrow is an icon, not text                          */
/* ------------------------------------------------------------------ */

test("the collapse arrow is a separate aria-hidden icon, not part of the label", () => {
  makeDom();
  const runtime = makeRuntime(scheduledSnapshot());
  const { container, panel } = mount(runtime);
  findTab(container, "Plan").click();

  const disclosure = container.querySelector(".nautilus-log-exec-plan-heading.is-collapsible");
  const arrow = disclosure.querySelector(".nautilus-log-exec-plan-arrow");
  assert.ok(arrow, "arrow rendered as its own element");
  assert.equal(arrow.getAttribute("aria-hidden"), "true", "screen readers must not read ▾/▸");
  assert.equal(arrow.textContent, "▸");
  assert.equal(
    disclosure.querySelector(".nautilus-log-exec-plan-label").textContent,
    "Unscheduled today · 1",
    "the label text carries no arrow glyph",
  );

  disclosure.click();
  assert.equal(
    container.querySelector(".nautilus-log-exec-plan-arrow").textContent,
    "▾",
    "the arrow flips with aria-expanded",
  );

  panel.destroy();
});
