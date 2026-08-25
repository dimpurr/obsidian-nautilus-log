/*
 * compact.test.js — regression tests for src/compact.ts.
 *
 * Same recipe as header.test.js: bundle the module with esbuild, install a
 * jsdom document, render into a container, assert on the serialized DOM.
 *
 * Covered (parity-audit-2026-08-25):
 *   · §P1-4 compact event list — `Schedule · N items` summary, sorted rows,
 *     dot tone (urgent/event/task), HH:MM–HH:MM range, done strike class,
 *     free-time rows filtered out, localisation;
 *   · §P1-4 compact overview — canonical summary line (planned/free/left),
 *     body limited to Available + Events + legend (upstream 5464e9d),
 *     warning modifier;
 *   · §P1-8 overflow panel — <details>, "total · N items" summary, durations;
 *   · §P1-8 schedule warning panel — localised messages, safe degrade when
 *     `plan.warnings` is absent.
 */

"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const path = require("node:path");
const esbuild = require("esbuild");
const { JSDOM } = require("jsdom");

/* ------------------------------------------------------------------ */
/* Load the bundled renderers                                          */
/* ------------------------------------------------------------------ */

const result = esbuild.buildSync({
  entryPoints: [path.join(__dirname, "..", "src", "compact.ts")],
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
const {
  renderCompactEventList,
  renderCompactOverview,
  renderOverflowPanel,
  renderWarningPanel,
} = moduleShim.exports;

const logCore = require(path.join(__dirname, "..", "src", "vendor", "log-core.js"));

const dom = new JSDOM("<!DOCTYPE html><body></body>");
globalThis.document = dom.window.document;

const copyEn = logCore.uiCopy("en");
const copyZh = logCore.uiCopy("zh");

function host() {
  return document.createElement("div");
}

function textOf(el) {
  return el ? el.textContent.replace(/\s+/g, " ").trim() : "";
}

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

const settings = {
  language: "en",
  workdayStartHour: 5,
  workdayEndHour: 21,
  descLength: 22,
  todoDuration: 15,
  urgentTrigger: "",
};

/** Deliberately out of order so the sort is actually exercised. */
const events = [
  { uid: "n.md:4", text: "- [ ] Review notes 30m", start: 810, end: 840, meeting: false, todo: true },
  { uid: "n.md:1", text: "12:30-14:00 Lunch with Ada", start: 750, end: 840, meeting: true, done: false },
  { uid: "n.md:2", text: "- [x] Morning routine", start: 300, end: 360, meeting: false, done: true },
  { uid: "n.md:3", text: "- [ ] Ship the hotfix 45m", start: 600, end: 645, meeting: false, urgent: true },
  { uid: "free", text: "", start: 400, end: 500, freetime: true },
];

function normalCapacity(extra) {
  return {
    availableMinutes: 311,
    demandMinutes: 90,
    overloadMinutes: 0,
    slackMinutes: 221,
    unplacedMinutes: 0,
    fixedMinutes: 0,
    totalAvailableMinutes: 900,
    totalFixedMinutes: 0,
    burningBucket: "available",
    scheduledTasks: [],
    overflowTasks: [],
    ...extra,
  };
}

/* ------------------------------------------------------------------ */
/* §P1-4  compact event list                                           */
/* ------------------------------------------------------------------ */

test("compact event list renders the upstream details/summary/list skeleton (P1-4)", () => {
  const container = host();
  renderCompactEventList(container, events, copyEn);

  const details = container.querySelector("details.nautilus-log-compact-details");
  assert.ok(details, "renders <details class=nautilus-log-compact-details>");
  const summary = details.querySelector("summary.nautilus-log-compact-summary");
  assert.ok(summary, "renders the compact summary head");
  // 4 real items: the freetime row must not be counted.
  assert.strictEqual(textOf(summary), "Schedule · 4 items", "summary is 'Schedule · N items'");

  const list = details.querySelector("ol.nautilus-log-compact-list");
  assert.ok(list, "the body is an <ol class=nautilus-log-compact-list>");
  assert.strictEqual(
    list.getAttribute("aria-label"),
    "Nautilus Log scheduled items",
    "list is labelled like upstream",
  );
  assert.strictEqual(
    list.querySelectorAll("li.nautilus-log-compact-item").length,
    4,
    "one row per non-freetime event",
  );
});

test("compact event list gives every row a precise HH:MM–HH:MM range (P1-4)", () => {
  // This is the whole point of the panel: compact mode also kills the hover
  // tooltip, so without these strings the sidebar shows no exact times at all.
  const container = host();
  renderCompactEventList(container, events, copyEn);
  const times = Array.from(
    container.querySelectorAll(".nautilus-log-compact-time"),
    textOf,
  );
  assert.deepStrictEqual(
    times,
    ["05:00–06:00", "10:00–10:45", "12:30–14:00", "13:30–14:00"],
    "rows are sorted by start then end and carry zero-padded ranges",
  );
});

test("compact event list strips the dHH:MM done anchor from the title (D8)", () => {
  const container = host();
  renderCompactEventList(
    container,
    [{ uid: "n.md:1", text: "- [x] Write report 30m d14:30", start: 840, end: 870, done: true }],
    copyEn,
  );
  assert.strictEqual(
    textOf(container.querySelector(".nautilus-log-compact-title")),
    "Write report",
    "the d14:30 anchor is ours (PORTING-DECISIONS §D8) and must not leak into the title",
  );
});

test("compact event list colours the dot by tone and strikes done rows (P1-4)", () => {
  const container = host();
  renderCompactEventList(container, events, copyEn);
  const rows = container.querySelectorAll("li.nautilus-log-compact-item");

  const tone = (i) => rows[i].querySelector(".nautilus-log-compact-dot").getAttribute("class");
  assert.match(tone(0), /nautilus-log-compact-dot--task/, "plain task → task dot");
  assert.match(tone(1), /nautilus-log-compact-dot--urgent/, "urgent task → urgent dot");
  assert.match(tone(2), /nautilus-log-compact-dot--event/, "meeting → event dot");
  assert.strictEqual(
    rows[0].querySelector(".nautilus-log-compact-dot").getAttribute("aria-hidden"),
    "true",
    "dots are decorative",
  );

  assert.ok(
    rows[0].classList.contains("nautilus-log-compact-item--done"),
    "the completed morning routine gets the --done modifier",
  );
  assert.strictEqual(
    container.querySelectorAll(".nautilus-log-compact-item--done").length,
    1,
    "only the done row is struck through",
  );
});

test("compact event list strips list markers from the title (P1-4)", () => {
  const container = host();
  renderCompactEventList(container, events, copyEn);
  const titles = Array.from(
    container.querySelectorAll(".nautilus-log-compact-title"),
    textOf,
  );
  assert.deepStrictEqual(titles, [
    "Morning routine",
    "Ship the hotfix",
    "Lunch with Ada",
    "Review notes",
  ], "list markers, checkboxes, time-range and duration tokens are all stripped");
  const first = container.querySelector("li.nautilus-log-compact-item");
  assert.strictEqual(first.getAttribute("title"), "Morning routine", "row carries a hover title");
});

test("compact event list localises the summary and singularises one item (P1-4)", () => {
  const one = host();
  renderCompactEventList(one, [events[1]], copyEn);
  assert.strictEqual(textOf(one.querySelector("summary")), "Schedule · 1 item");

  const zh = host();
  renderCompactEventList(zh, events, copyZh);
  assert.strictEqual(textOf(zh.querySelector("summary")), "时间安排 · 4 项");
});

/* ------------------------------------------------------------------ */
/* §P1-4  compact overview                                             */
/* ------------------------------------------------------------------ */

test("compact overview keeps the canonical summary on the fold line (P1-4)", () => {
  const container = host();
  renderCompactOverview(container, normalCapacity(), settings, 600, copyEn);

  const details = container.querySelector("details.nautilus-log-compact-overview");
  assert.ok(details, "renders <details class=nautilus-log-compact-overview>");

  const summary = details.querySelector("summary.nautilus-log-compact-overview-summary");
  assert.ok(summary, "summary carries both compact-summary classes");
  assert.ok(
    summary.classList.contains("nautilus-log-compact-summary"),
    "summary keeps the shared compact-summary class",
  );

  const content = summary.querySelector(".nautilus-log-compact-overview-summary-content");
  assert.ok(content, "summary wraps its cells in overview-summary-content");
  assert.strictEqual(
    textOf(content.querySelector(".nautilus-log-compact-overview-label")),
    "Overview",
    "label cell comes from panels.overview",
  );

  const cells = Array.from(
    content.querySelectorAll(".nautilus-log-metric-summary-item"),
    textOf,
  );
  assert.deepStrictEqual(
    cells,
    ["1h30mplanned", "3h41mfree", "25%left"],
    "planned / free-or-over / left% all stay on the fold line",
  );
  assert.ok(summary.getAttribute("aria-label"), "summary is aria-labelled");
});

test("compact overview body holds only Available / Events / legend (upstream 5464e9d)", () => {
  const container = host();
  renderCompactOverview(container, normalCapacity(), settings, 600, copyEn);
  const body = container.querySelector(".nautilus-log-compact-overview-body");
  assert.ok(body, "renders the overview body");

  const readings = body.querySelectorAll(
    ".nautilus-log-metrics-capacity .nautilus-log-metric",
  );
  assert.strictEqual(readings.length, 2, "exactly two readings in the body");
  assert.match(textOf(readings[0]), /Available/);
  assert.match(textOf(readings[0]), /5h11m/);
  assert.match(textOf(readings[1]), /Events/);

  assert.ok(
    body.querySelector(".nautilus-log-html-legend"),
    "legend is the second half of the body (P1-8 mount 2/2)",
  );

  // 🔴 The canonical planned/free/left summary must NOT be repeated in the body.
  assert.strictEqual(
    body.querySelectorAll(".nautilus-log-metric-summary-item").length,
    0,
    "body must not duplicate the summary cells that live on the fold line",
  );
  assert.doesNotMatch(textOf(body), /planned/, "no duplicated 'planned' in the body");
  assert.doesNotMatch(textOf(body), /left/, "no duplicated 'left' in the body");
});

test("compact overview flags an overloaded day with the warning modifier (P1-4)", () => {
  const container = host();
  renderCompactOverview(
    container,
    normalCapacity({ demandMinutes: 160, overloadMinutes: 60, slackMinutes: 0, availableMinutes: 100 }),
    settings,
    600,
    copyEn,
  );
  const details = container.querySelector("details.nautilus-log-compact-overview");
  assert.ok(
    details.classList.contains("nautilus-log-compact-overview--warning"),
    "overloaded status paints the summary with the warning colour",
  );

  const ok = host();
  renderCompactOverview(ok, normalCapacity(), settings, 600, copyEn);
  assert.ok(
    !ok.querySelector("details").classList.contains("nautilus-log-compact-overview--warning"),
    "a healthy day carries no warning modifier",
  );
});

test("compact overview survives a broken capacity (P1-4)", () => {
  const container = host();
  renderCompactOverview(container, { totally: "wrong" }, settings, 600, copyEn);
  assert.ok(
    container.querySelector("details.nautilus-log-compact-overview"),
    "a malformed capacity degrades to a zeroed overview instead of throwing",
  );
});

/* ------------------------------------------------------------------ */
/* §P1-8  overflow panel                                               */
/* ------------------------------------------------------------------ */

const overflowCapacity = normalCapacity({
  unplacedMinutes: 105,
  overflowTasks: [
    { uid: "n.md:9", string: "- [ ] Write the quarterly brief 60m", duration: 60, done: false },
    { uid: "n.md:10", string: "- [ ] Refactor the parser 45m", duration: 45, done: false },
  ],
});

test("overflow panel is a collapsible details with total and count (P1-8)", () => {
  const container = host();
  renderOverflowPanel(container, overflowCapacity, copyEn);

  const details = container.querySelector("details.nautilus-log-overflow-panel");
  assert.ok(details, "the panel is a real <details>, not a static div");
  assert.strictEqual(
    textOf(details.querySelector("summary")),
    "Unscheduled today · 1h45m · 2 items",
    "summary carries panel name · unplacedMinutes total · item count",
  );

  const rows = details.querySelectorAll("ul > li");
  assert.strictEqual(rows.length, 2, "one row per overflow task");
  assert.strictEqual(
    textOf(rows[0].querySelector(".nautilus-log-overflow-duration")),
    "1h",
    "each row shows its own duration",
  );
  assert.match(textOf(rows[0]), /Write the quarterly brief/);
});

test("overflow panel renders nothing when nothing overflows (P1-8)", () => {
  const container = host();
  const out = renderOverflowPanel(container, normalCapacity(), copyEn);
  assert.strictEqual(out, null);
  assert.strictEqual(container.children.length, 0, "no empty panel is emitted");
});

test("overflow panel hands the title cell to the caller's renderer (P1-8)", () => {
  const container = host();
  const seen = [];
  renderOverflowPanel(container, overflowCapacity, copyEn, (hostEl, task) => {
    seen.push(task.uid);
    hostEl.textContent = "MD:" + task.uid;
  });
  assert.deepStrictEqual(seen, ["n.md:9", "n.md:10"], "callback gets every task");
  assert.match(
    textOf(container.querySelector("li")),
    /MD:n\.md:9/,
    "MarkdownRenderer can still own the title cell",
  );
});

/* ------------------------------------------------------------------ */
/* §P1-8  schedule warning panel                                       */
/* ------------------------------------------------------------------ */

test("warning panel localises overnight / sameTime codes (P1-8)", () => {
  const plan = {
    warnings: [
      { line: 3, uid: "n.md:3", code: "overnight", message: "Continues into the next day" },
      { line: 7, uid: "n.md:7", code: "sameTime", message: "Start and end times cannot be the same" },
    ],
  };

  const en = host();
  renderWarningPanel(en, plan, copyEn);
  const details = en.querySelector("details.nautilus-log-warning-panel");
  assert.ok(details, "renders <details class=nautilus-log-warning-panel>");
  assert.strictEqual(
    textOf(details.querySelector("summary")),
    "Schedule warnings · 2 items",
    "summary carries panel name · count",
  );
  const messages = Array.from(
    details.querySelectorAll(".nautilus-log-warning-message"),
    textOf,
  );
  assert.deepStrictEqual(messages, [
    "Continues into the next day",
    "Start and end times cannot be the same",
  ]);

  const zh = host();
  renderWarningPanel(zh, plan, copyZh);
  assert.deepStrictEqual(
    Array.from(zh.querySelectorAll(".nautilus-log-warning-message"), textOf),
    ["连续到次日", "开始时间与结束时间不能相同"],
    "messages come from uiCopy(zh).warnings, not from the parser's raw string",
  );
  assert.strictEqual(textOf(zh.querySelector("summary")), "时间范围提醒 · 2 项");
});

test("warning panel points at the offending line, or its text when given (P1-8)", () => {
  const container = host();
  renderWarningPanel(
    container,
    {
      warnings: [
        { line: 3, uid: "n.md:3", code: "sameTime" },
        { uid: "n.md:7", code: "sameTime", text: "- 09:00-09:00 Standup" },
      ],
    },
    copyEn,
  );
  const rows = container.querySelectorAll("li");
  assert.strictEqual(
    textOf(rows[0].firstChild),
    "L4",
    "no text ⇒ falls back to a 1-based line reference",
  );
  assert.strictEqual(
    textOf(rows[1].firstChild),
    "09:00-09:00 Standup",
    "text wins when the parser supplies it",
  );
});

test("warning panel degrades safely when plan.warnings is absent (P1-8)", () => {
  // The parser side of this landed on a separate work stream; the renderer must
  // not care whether the field exists yet.
  for (const plan of [undefined, null, {}, { warnings: [] }, { warnings: null }]) {
    const container = host();
    assert.strictEqual(renderWarningPanel(container, plan, copyEn), null);
    assert.strictEqual(container.children.length, 0);
  }
});
