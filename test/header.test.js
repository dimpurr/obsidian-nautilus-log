/*
 * header.test.js — smoke test for the capacity header renderer.
 *
 * Uses jsdom: we bundle `src/header.ts` with esbuild into a single CJS file,
 * install a jsdom document, render the header into a container, then assert on
 * the serialized DOM.
 *
 * Covered:
 *   · normal plan renders the six-item header (summary row + capacity row,
 *     current/full-day totals, and the flame when that minute burns);
 *   · overload renders "Overload", fragmented renders "No fitting slot" — and
 *     the two stay distinct;
 *   · zh settings produce Chinese copy;
 *   · null/missing burningBucket and a broken capacity degrade without throwing.
 */

"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const path = require("node:path");
const esbuild = require("esbuild");
const { JSDOM } = require("jsdom");

/* ------------------------------------------------------------------ */
/* Load the bundled renderer                                           */
/* ------------------------------------------------------------------ */

const result = esbuild.buildSync({
  entryPoints: [path.join(__dirname, "..", "src", "header.ts")],
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
const { renderCapacityHeader } = moduleShim.exports;

/* ------------------------------------------------------------------ */
/* jsdom                                                               */
/* ------------------------------------------------------------------ */

const dom = new JSDOM("<!DOCTYPE html><body></body>");
globalThis.document = dom.window.document;

function render(capacity, settings, nowMinutes) {
  const container = document.createElement("div");
  renderCapacityHeader(container, capacity, settings, nowMinutes);
  return container;
}

function textOf(el) {
  return el ? el.textContent.replace(/\s+/g, " ").trim() : "";
}

function summaryItems(container) {
  return container.querySelectorAll(
    ".nautilus-log-metrics-summary .nautilus-log-metric-summary-item",
  );
}

function readings(container) {
  return container.querySelectorAll(".nautilus-log-metrics-capacity .nautilus-log-metric");
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

const zhSettings = { ...settings, language: "zh" };

/** Normal day: 3h30m of demand against 14h30m full-day flexible time. */
function normalCapacity(extra) {
  return {
    availableMinutes: 311, // 5h11m
    demandMinutes: 90, // 1h30m
    overloadMinutes: 0,
    slackMinutes: 221, // 3h41m
    unplacedMinutes: 0,
    fixedMinutes: 0,
    totalAvailableMinutes: 900, // 15h
    totalFixedMinutes: 0,
    burningBucket: "available",
    scheduledTasks: [],
    overflowTasks: [],
    ...extra,
  };
}

/* ------------------------------------------------------------------ */
/* Tests                                                               */
/* ------------------------------------------------------------------ */

test("normal plan renders the six-item header with totals and a flame", () => {
  const container = render(normalCapacity(), settings, 600);
  const metrics = container.querySelector(".nautilus-log-metrics");

  assert.ok(metrics, "container should carry a .nautilus-log-metrics element");
  assert.ok(metrics.getAttribute("aria-label"), "metrics container should be labelled");

  // Summary row: Planned · Remaining · left% (three cells, two separators).
  const items = summaryItems(container);
  assert.strictEqual(items.length, 3, "summary row should hold three items");
  assert.strictEqual(
    container.querySelectorAll(".nautilus-log-metric-separator").length,
    2,
    "summary row should have two separators",
  );

  assert.match(textOf(items[0]), /1h30m/, "Planned cell carries the demand value");
  assert.match(textOf(items[0]), /planned/, "Planned cell carries its label");
  assert.match(textOf(items[1]), /3h41m/, "Remaining cell carries the slack value");
  assert.match(textOf(items[1]), /free/, "Remaining cell carries its label");
  assert.match(textOf(items[2]), /25%/, "left% cell carries the percentage");
  assert.match(textOf(items[2]), /left/, "left% cell carries its label");

  // Capacity row: Available and Events, each with current / full-day totals.
  const caps = readings(container);
  assert.strictEqual(caps.length, 2, "capacity row should hold two readings");
  assert.match(textOf(caps[0]), /Available/, "first reading is Available");
  assert.match(textOf(caps[0]), /5h11m/, "Available shows current minutes");
  assert.strictEqual(
    caps[0].querySelector(".nautilus-log-metric-total").textContent,
    "/ 15h",
    "Available full-day total reads '/ 15h' with no leading space (L2-129)",
  );
  assert.match(textOf(caps[1]), /Events/, "second reading is Events");
  assert.match(textOf(caps[1]), /0m/, "Events shows current minutes");
  assert.strictEqual(
    caps[1].querySelector(".nautilus-log-metric-total").textContent,
    "/ 0m",
    "Events full-day total reads '/ 0m' with no leading space (L2-129)",
  );

  // Flame: capacity burns Available, so only the Available reading carries it.
  const flames = container.querySelectorAll(".nautilus-log-burning-icon");
  assert.strictEqual(flames.length, 1, "a live Available minute shows one flame");
  assert.ok(
    caps[0].querySelector(".nautilus-log-burning-icon"),
    "the flame sits on the Available reading",
  );
  assert.match(
    caps[0].querySelector(".nautilus-log-burning-icon").getAttribute("aria-label"),
    /Flexible time is elapsing/,
    "flame carries the burning label",
  );
});

test("an event-burning minute puts the flame on the Events reading", () => {
  const container = render(
    normalCapacity({
      availableMinutes: 400,
      fixedMinutes: 20,
      totalFixedMinutes: 90,
      burningBucket: "events",
    }),
    settings,
    620,
  );
  const caps = readings(container);
  assert.strictEqual(
    caps[1].querySelectorAll(".nautilus-log-burning-icon").length,
    1,
    "the flame sits on the Events reading",
  );
  assert.strictEqual(
    caps[0].querySelectorAll(".nautilus-log-burning-icon").length,
    0,
    "the Available reading has no flame",
  );
});

test("overloaded plan renders Overload and not No fitting slot", () => {
  const container = render(
    normalCapacity({
      availableMinutes: 100,
      demandMinutes: 160,
      overloadMinutes: 60,
      slackMinutes: 0,
      unplacedMinutes: 0,
    }),
    settings,
    600,
  );

  const html = container.innerHTML;
  assert.match(html, /Overload/, "overload should appear in the summary row");
  assert.match(textOf(summaryItems(container)[1]), /1h/, "Overload cell carries the excess");
  assert.doesNotMatch(html, /No fitting slot/, "overload must not render as fragmented");

  // Warning tone is applied to the Overload summary cell.
  assert.ok(
    container.querySelector(
      ".nautilus-log-metrics-summary .nautilus-log-metric-summary-item.nautilus-log-metric--warning",
    ),
    "Overload summary cell should carry the warning tone",
  );
});

test("fragmented plan renders No fitting slot, distinct from Overload", () => {
  const container = render(
    normalCapacity({
      availableMinutes: 100,
      demandMinutes: 90,
      overloadMinutes: 0,
      slackMinutes: 10,
      unplacedMinutes: 30, // enough total time, but no continuous gap
    }),
    settings,
    600,
  );

  const html = container.innerHTML;
  assert.match(html, /No fitting slot/, "fragmentation should appear in the summary row");
  assert.match(textOf(summaryItems(container)[1]), /30m/, "No-fitting-slot cell carries the unplaced share");
  assert.doesNotMatch(html, />Overload</, "fragmented must not render as Overload");

  // 认证审计 L2-059：fragmented 态 tone:'warning'（log-core.js:1008-1012），
  //   summary 项必须落 --warning class（与 overload 同一路径）。
  assert.ok(
    container.querySelector(
      ".nautilus-log-metrics-summary .nautilus-log-metric-summary-item.nautilus-log-metric--warning",
    ),
    "fragmented status cell should carry the warning tone (L2-059)",
  );
});

test("zh settings produce Chinese copy", () => {
  const container = render(normalCapacity(), zhSettings, 600);

  const html = container.innerHTML;
  assert.match(html, /已计划/, "Planned label is localised");
  assert.match(html, /余量/, "Remaining label is localised");
  assert.match(html, /可安排/, "Available label is localised");
  assert.match(html, /事件/, "Events label is localised");
  assert.match(html, /剩余/, "left% label is localised");
  assert.match(html, /可安排时间正在流逝/, "flame label is localised");
});

test("null burningBucket renders a flame-less header without throwing", () => {
  const container = render(normalCapacity({ burningBucket: null }), settings, 100);
  assert.strictEqual(
    container.querySelectorAll(".nautilus-log-burning-icon").length,
    0,
    "no flame when the engine says nothing is burning",
  );
  assert.strictEqual(
    summaryItems(container).length,
    3,
    "summary row still renders",
  );
});

test("missing burningBucket still renders (degraded flame) without throwing", () => {
  const { burningBucket, ...noBucket } = normalCapacity();
  const container = render(noBucket, settings, 600);
  assert.strictEqual(
    summaryItems(container).length,
    3,
    "a capacity without burningBucket still renders the six-item header",
  );
});

test("broken capacity degrades to a zeroed header instead of throwing", () => {
  const container = render({ totally: "wrong" }, settings, 600);
  assert.strictEqual(
    summaryItems(container).length,
    3,
    "a broken capacity still renders a neutral header",
  );
  assert.match(textOf(summaryItems(container)[0]), /0m/, "neutral header shows zeroed values");
});

/* ------------------------------------------------------------------ */
/* §P1-8 HTML colour legend + §P1-4 container-query context            */
/* ------------------------------------------------------------------ */

test("header mounts the HTML colour legend (P1-8)", () => {
  const container = render(normalCapacity(), settings, 600);
  const legend = container.querySelector(".nautilus-log-html-legend");

  assert.ok(legend, "header renders one .nautilus-log-html-legend");
  assert.strictEqual(
    legend.getAttribute("aria-label"),
    "Nautilus Log legend",
    "legend is labelled like upstream html-legend-component",
  );

  const dots = legend.querySelectorAll(".nautilus-log-legend-dot");
  assert.strictEqual(dots.length, 3, "three colour dots: urgent / event / task");
  assert.ok(dots[0].classList.contains("nautilus-log-legend-dot--urgent"));
  assert.ok(dots[1].classList.contains("nautilus-log-legend-dot--event"));
  assert.ok(dots[2].classList.contains("nautilus-log-legend-dot--task"));
  for (const dot of dots) {
    assert.strictEqual(dot.getAttribute("aria-hidden"), "true", "dots are decorative");
  }

  const items = legend.querySelectorAll(".nautilus-log-legend-item");
  assert.strictEqual(items.length, 3, "three legend items");
  assert.strictEqual(textOf(items[0]), "Urgent");
  assert.strictEqual(textOf(items[1]), "Event");
  assert.strictEqual(textOf(items[2]), "Task");

  // The legend lives in the header actions column, like upstream.
  assert.ok(
    container.querySelector(".nautilus-log-header-actions .nautilus-log-html-legend"),
    "legend sits inside .nautilus-log-header-actions",
  );
});

test("legend copy is localised (P1-8)", () => {
  const container = render(normalCapacity(), zhSettings, 600);
  const items = container.querySelectorAll(
    ".nautilus-log-html-legend .nautilus-log-legend-item",
  );
  assert.deepStrictEqual(
    Array.from(items, textOf),
    ["紧急", "事件", "任务"],
    "legend.urgent / legend.event / legend.task come from uiCopy(zh)",
  );
});

test("header establishes the container-query context (P1-4 precondition)", () => {
  // Every `.nautilus-log-compact-*` rule in styles.css lives inside
  // `@container (max-width: 520px)`; without `container-type` on the block root
  // the whole block is dead CSS and the compact panels stay display:none.
  const container = render(normalCapacity(), settings, 600);
  assert.strictEqual(
    container.style.getPropertyValue("container-type"),
    "inline-size",
    "block root must carry container-type: inline-size",
  );
});

test("header keeps the upstream copy / actions skeleton", () => {
  const container = render(normalCapacity(), settings, 600);
  const header = container.querySelector("header.nautilus-log-header");
  assert.ok(header, "metrics are wrapped in <header class=nautilus-log-header>");
  assert.ok(
    header.classList.contains("nautilus-log-header--compact"),
    "header carries the --compact modifier the container query keys off",
  );
  assert.ok(
    header.querySelector(".nautilus-log-header-copy .nautilus-log-metrics"),
    "metrics sit in the copy column",
  );
});

/* ------------------------------------------------------------------ */
/* 认证审计 C2-056 / C2-091 / S1-003 · 块根必须发射上游的骨架类         */
/* ------------------------------------------------------------------ */

/** styles.css 是从上游 extension.css 整份搬来的，块根的**所有**规则都挂在
 *  `.nautilus-log-container` 上：flex 列布局、padding、`position: relative`、
 *  `container-type`，以及
 *    `.nautilus-log-container:hover .nautilus-log-controls-top{opacity:1}`
 *  这条「控制栏 hover 才浮现」。本移植的块根只叫 `nautilus-log`，
 *  在 styles.css 里**一条规则都没有** ⇒ 按钮恒为 opacity .38，
 *  只有键盘 focus 进去才亮；紧凑内边距（styles.css:712）也拿不到。
 *
 *  ⚠️ 只断言内联 `container-type` 抓不住这条 —— 那是本移植自己补的补丁，
 *  它让 @container 活过来，却不会让上面那族选择器匹配上。 */
test("🔴 C2-056 块根发射 nautilus-log-container（hover 浮现 / 块根布局全族的挂点）", () => {
  const container = render(normalCapacity(), settings, 600);
  assert.ok(
    container.classList.contains("nautilus-log-container"),
    "上游 component.cljs:1870 的块根类名；styles.css:55/597/712 全都以它为选择器",
  );
});

test("🔴 C2-056 容器上下文只建在最外层（侧栏把 header 放进 shell 时不重复建）", () => {
  const root = document.createElement("div");
  root.className = "nautilus-log";
  renderCapacityHeader(root, normalCapacity(), settings, 600);

  const shell = document.createElement("div");
  shell.className = "nautilus-log-shell";
  root.appendChild(shell);
  renderCapacityHeader(shell, normalCapacity(), settings, 600);

  assert.equal(
    shell.classList.contains("nautilus-log-container"),
    false,
    "内层再建一个容器上下文会让 @container 按 shell 的宽度求值（块根还有 padding）",
  );
  assert.equal(shell.style.getPropertyValue("container-type"), "");
});
