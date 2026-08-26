/*
 * header.ts — the Nautilus Log capacity header.
 *
 * Replaces the single-line capacity readout with the upstream header: a summary
 * row (Planned · Remaining/Overload/No-fitting-slot · left %) and a capacity
 * row (Available / Events, each with current + full-day totals and a flame
 * marking whether this minute burns Available or Event time).
 *
 * All data comes from the vendored engine (`src/vendor/log-core.js`);
 * `capacityMetrics` does the metric math and the i18n, `burningCapacityBucket`
 * resolves the flame bucket, `formatCapacitySummary` supplies the one-line
 * hover summary.  This file only turns those results into DOM — it never
 * recomputes a number itself.
 *
 * Upstream baseline: 404KSG/roam-nautilus-log @ 7bf19a1d
 * (metrics-component / metric-reading-component / metric-summary-component /
 *  burning-flame-icon).
 */

import * as logCoreModule from "./vendor/log-core";
import { createSvg } from "./svg-util";
import type { Capacity, FixedEvent, NautilusSettings } from "./contract";

/* ------------------------------------------------------------------ */
/* Vendored engine, narrowed to the seams the header actually touches. */
/* ------------------------------------------------------------------ */

type BurningBucket = "available" | "events" | null;

/** One metric as returned by the engine's `capacityMetrics`.  Every field is
 *  optional so a partial/malformed capacity degrades to an empty cell instead
 *  of throwing. */
export interface MetricReading {
  key?: string;
  label?: string;
  value?: string;
  total?: string;
  summaryLabel?: string;
  percent?: string;
  percentLabel?: string;
  percentTone?: string;
  tone?: string;
  burning?: boolean;
  burningLabel?: string;
}

export interface CapacityMetricsResult {
  planned: MetricReading;
  status: MetricReading;
  available: MetricReading;
  events: MetricReading;
}

interface HeaderCore {
  capacityMetrics(args: {
    capacity: Capacity;
    language: string;
  }): CapacityMetricsResult | null;
  formatCapacitySummary(capacity: Capacity): string;
  burningCapacityBucket(args: {
    startMinutes: number;
    endMinutes: number;
    nowMinutes: number;
    fixedEvents: FixedEvent[];
  }): BurningBucket;
  normalizeScheduleSettings(args: {
    startHour: number;
    endHour: number;
  }): { startHour: number; endHour: number; startMinutes: number; endMinutes: number };
  uiCopy(language: string): Record<string, Record<string, string>>;
}

const core = (logCoreModule as unknown) as HeaderCore;

/* ------------------------------------------------------------------ */
/* DOM helpers                                                         */
/* ------------------------------------------------------------------ */

function el(tag: string, cls: string): HTMLElement {
  const node = document.createElement(tag);
  node.setAttribute("class", cls);
  return node;
}

function appendTextChild(
  parent: HTMLElement,
  tag: string,
  cls: string,
  value?: string,
): HTMLElement {
  const node = document.createElement(tag);
  if (cls) node.setAttribute("class", cls);
  if (value) node.textContent = value;
  parent.appendChild(node);
  return node;
}

/** `[value] [summaryLabel]` cell, e.g. "3h30m planned". */
export function appendSummaryItem(row: HTMLElement, metric: MetricReading): void {
  const tone = metric.tone || "neutral";
  const item = el(
    "span",
    `nautilus-log-metric-summary-item nautilus-log-metric--${tone}`,
  );
  appendTextChild(item, "strong", "nautilus-log-metric-value", metric.value || "0m");
  appendTextChild(item, "span", "nautilus-log-metric-summary-label", metric.summaryLabel);
  row.appendChild(item);
}

export function appendSeparator(row: HTMLElement): void {
  const sep = el("span", "nautilus-log-metric-separator");
  sep.setAttribute("aria-hidden", "true");
  sep.textContent = "·";
  row.appendChild(sep);
}

/** `[percent] [percentLabel]` cell, e.g. "45% left". */
export function appendPercentItem(row: HTMLElement, planned: MetricReading): void {
  const tone = planned.percentTone || "neutral";
  const item = el(
    "span",
    `nautilus-log-metric-summary-item nautilus-log-metric-percent nautilus-log-metric-percent--${tone}`,
  );
  appendTextChild(item, "strong", "nautilus-log-metric-value", planned.percent || "0%");
  appendTextChild(item, "span", "nautilus-log-metric-summary-label", planned.percentLabel);
  row.appendChild(item);
}

/** `[label] [value / total] [flame]` cell, e.g. "Available 5h11m / 15h 🔥". */
export function appendReading(row: HTMLElement, metric: MetricReading): void {
  const tone = metric.tone || "neutral";
  const item = el("div", `nautilus-log-metric nautilus-log-metric--${tone}`);
  appendTextChild(item, "span", "nautilus-log-metric-label", metric.label);

  const reading = el("span", "nautilus-log-metric-reading");
  const readingLabel = readingAriaText(metric);
  if (readingLabel) reading.setAttribute("aria-label", readingLabel);
  appendTextChild(reading, "strong", "nautilus-log-metric-value", metric.value || "0m");
  if (metric.total) {
    // 认证审计 L2-129：上游 `component.cljs:1585` 是 `(str "/ " total)` → "/ 15h"，
    //   没有前导空格。此前写 `` ` / ${total}` `` 多出一个空格，文本显示为 " / 15h"。
    appendTextChild(reading, "span", "nautilus-log-metric-total", `/ ${metric.total}`);
  }
  if (metric.burning && metric.burningLabel) {
    reading.appendChild(burningFlameIcon(metric.burningLabel));
  }
  item.appendChild(reading);
  row.appendChild(item);
}

/** The upstream flame glyph (24×24 stroke flame with a `<title>`). */
function burningFlameIcon(label: string): Element {
  const svg = createSvg("svg", {
    class: "nautilus-log-burning-icon",
    width: "16",
    height: "16",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "1.8",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    role: "img",
    "aria-label": label,
  });
  svg.appendChild(createSvg("title", {}, label));
  svg.appendChild(createSvg("path", {
    d: "M12 22c4.4 0 8-3.1 8-7.5 0-3.3-1.8-5.8-4.4-8.2.2 2.7-1.5 4.2-2.8 4.9.4-4.1-1.3-7.1-4.6-9.2.3 3.8-1 6-2.6 8.2A7.4 7.4 0 0 0 4 14.5C4 18.9 7.6 22 12 22Z",
  }));
  return svg;
}

/* ------------------------------------------------------------------ */
/* Metrics resolution                                                  */
/* ------------------------------------------------------------------ */

/** Decide which bucket the current minute burns.
 *
 *  The engine's `calculateCapacity` already stamps `capacity.burningBucket`;
 *  that value is authoritative.  Only when the field is entirely absent (e.g. a
 *  hand-built capacity) do we recompute through the vendored geometry.  The
 *  header has no fixed events at hand, so a recompute can only report a live
 *  minute as burning Available and an outside-window minute as burning nothing.
 */
function resolveBurningBucket(
  capacity: Capacity,
  settings: NautilusSettings,
  nowMinutes: number,
): BurningBucket {
  const present = capacity.burningBucket;
  if (present === "available" || present === "events") return present;
  if (present === null) return null;
  const schedule = core.normalizeScheduleSettings({
    startHour: settings.workdayStartHour,
    endHour: settings.workdayEndHour,
  });
  return core.burningCapacityBucket({
    startMinutes: schedule.startMinutes,
    endMinutes: schedule.endMinutes,
    nowMinutes,
    fixedEvents: [],
  });
}

function resolveMetrics(
  capacity: Capacity,
  settings: NautilusSettings,
  nowMinutes: number,
): CapacityMetricsResult | null {
  const bucket = resolveBurningBucket(capacity, settings, nowMinutes);
  const effective: Capacity =
    bucket === capacity.burningBucket
      ? capacity
      : { ...capacity, burningBucket: bucket };
  return core.capacityMetrics({
    capacity: effective,
    language: settings.language,
  });
}

/** Zeroed header shown when the engine itself fails.  Mirror of the upstream
 *  `capacity-metrics` `(or ...)` fallback. */
function neutralMetrics(settings: NautilusSettings): CapacityMetricsResult {
  let copy: Record<string, Record<string, string>> = {};
  try {
    copy = core.uiCopy(settings.language);
  } catch {
    copy = {};
  }
  const c = copy.capacity || {};
  const a = copy.allocation || {};
  return {
    planned: {
      key: "demand",
      label: c.demand || "Planned",
      value: "0m",
      summaryLabel: a.planned || "planned",
      percent: "0%",
      percentLabel: a.left || "left",
      percentTone: "neutral",
      tone: "neutral",
    },
    status: {
      key: "remaining",
      label: c.remaining || "Remaining",
      value: "0m",
      summaryLabel: a.free || "free",
      tone: "neutral",
    },
    available: {
      key: "available",
      label: c.available || "Available",
      value: "0m",
      tone: "neutral",
    },
    events: {
      key: "events",
      label: c.events || "Events",
      value: "0m",
      tone: "event",
    },
  };
}

/* ------------------------------------------------------------------ */
/* ARIA text (mirror of the upstream reading/summary join)             */
/* ------------------------------------------------------------------ */

function metricAriaText(metric: MetricReading): string {
  let s = `${metric.label || ""} ${metric.value || ""}`.trim();
  if (metric.total) s += ` / ${metric.total}`;
  if (metric.percent) s += `, ${metric.percent} ${metric.percentLabel || ""}`.trim();
  if (metric.burning && metric.burningLabel) s += `, ${metric.burningLabel}`;
  return s;
}

function readingAriaText(metric: MetricReading): string {
  if (!metric.total && !metric.burning) return "";
  let s = metric.value || "";
  if (metric.total) s += ` / ${metric.total}`;
  if (metric.burning && metric.burningLabel) s += `. ${metric.burningLabel}`;
  return s;
}

/* ------------------------------------------------------------------ */
/* Shared seams reused by the compact panels (src/compact.ts)          */
/* ------------------------------------------------------------------ */

/**
 * Resolve the four capacity metrics, never throwing.
 *
 * Mirror of the upstream `capacity-metrics` `(or ... fallback)` in
 * `component.cljs:1556`: a null/blown engine result degrades to the zeroed
 * reading instead of taking the block down.  `compact.ts` needs exactly the
 * same numbers for the compact Overview, so the resolution lives here rather
 * than being duplicated.  见 parity-audit §P1-4。
 */
export function resolveCapacityMetrics(
  capacity: Capacity,
  settings: NautilusSettings,
  nowMinutes: number,
): CapacityMetricsResult {
  try {
    return resolveMetrics(capacity, settings, nowMinutes) ?? neutralMetrics(settings);
  } catch {
    return neutralMetrics(settings);
  }
}

/**
 * 让块根真正成为上游那套 DOM 骨架的容器节点。
 *
 * 认证审计 C2-056 / C2-057 / C2-091 / S1-003：`styles.css` 是从上游
 * `extension.css` 整份搬来的，块根的所有规则都挂在 `.nautilus-log-container`
 * 上（`container-type: inline-size` 之外还有 flex 列布局、padding、
 * `position: relative`、以及 `:hover .nautilus-log-controls-top{opacity:1}` 与
 * `@container` 里的紧凑内边距）。而本移植的块根 div 只叫 `nautilus-log`
 * —— 那个类在 `styles.css` 里**一条规则都没有**，于是上述整族全部失效。
 *
 * 取舍：**发射上游类名**，而不是把 CSS 选择器改成 `.nautilus-log`。
 * 理由 —— CSS 是逐段从上游搬来的、将来还要按上游 diff 对账；一旦把选择器
 * 改名，每次对账都要额外维护一张「改名表」，而 DOM 侧多加一个 class 是
 * 零成本且与上游逐字一致的。`position: relative` 也必须来自这条规则，
 * 否则 `.nautilus-log-collapsed .nautilus-log-controls-top{position:absolute}`
 * 会相对错误的祖先定位。
 *
 * 内联 `container-type` 作为兜底保留：jsdom 测试与不加载 styles.css 的
 * 环境里没有 CSS 规则可用。
 */
export function enableContainerQueries(root: HTMLElement): void {
  if (!root) return;
  // 🔴 上游 `component.cljs:1870` 的块根就是这个类。
  //    幂等且只认最外层：侧栏会把 header 放进 `.nautilus-log-shell`，那时
  //    容器上下文已经由块根建立，内层再建一个会让 `@container` 按错误的
  //    宽度求值（shell 与块根之间还隔着 padding）。
  if (root.closest?.(".nautilus-log-container")) return;
  root.classList?.add("nautilus-log-container");
  const style = root.style as (CSSStyleDeclaration & { containerType?: string }) | undefined;
  if (!style) return;
  // `containerType` 在旧 TS lib / 测试 shim 里可能不存在，两条路都走一遍。
  try {
    style.setProperty?.("container-type", "inline-size");
  } catch { /* shim without setProperty */ }
  if (!style.containerType) style.containerType = "inline-size";
}

/**
 * The upstream HTML colour legend (`component.cljs:1626` `html-legend-component`).
 *
 * Three dots + localized words, straight out of `logCore.uiCopy(lang).legend`
 * (`legend.urgent` / `legend.event` / `legend.task` — zero call sites before
 * this, see parity-audit §P1-8).  Mounted twice, exactly like upstream: in the
 * header actions column (below) and inside the compact Overview body
 * (`compact.ts`).
 */
export function renderHtmlLegend(
  parent: HTMLElement,
  copy: Record<string, Record<string, string>>,
): HTMLElement {
  const legendCopy = copy?.legend || {};
  const root = el("div", "nautilus-log-html-legend");
  root.setAttribute("aria-label", "Nautilus Log legend");
  const tones: [string, string][] = [
    ["urgent", legendCopy.urgent || "Urgent"],
    ["event", legendCopy.event || "Event"],
    ["task", legendCopy.task || "Task"],
  ];
  for (const [tone, label] of tones) {
    const item = el("span", "nautilus-log-legend-item");
    const dot = el("i", `nautilus-log-legend-dot nautilus-log-legend-dot--${tone}`);
    dot.setAttribute("aria-hidden", "true");
    item.appendChild(dot);
    item.appendChild(document.createTextNode(label));
    root.appendChild(item);
  }
  parent.appendChild(root);
  return root;
}

/* ------------------------------------------------------------------ */
/* Public seam                                                         */
/* ------------------------------------------------------------------ */

/**
 * Render the six-item capacity header into `container`.
 *
 * - Summary row: Planned value+label, status value+label (Remaining /
 *   Overload / No fitting slot), and the left-% cell.
 * - Capacity row: Available and Events, each with current / full-day totals
 *   and the flame when that minute is consuming the bucket.
 *
 * Never throws: a broken or null engine result degrades to a zeroed header
 * rather than taking down the block.
 */
export function renderCapacityHeader(
  container: HTMLElement,
  capacity: Capacity,
  settings: NautilusSettings,
  nowMinutes: number,
): void {
  // 🔴 必须最先做：不给块根建立容器查询上下文，styles.css 里所有
  //    `@container` 规则（含紧凑模式全部 28 条）恒不生效。见 §P1-4。
  enableContainerQueries(container);

  const metrics = resolveCapacityMetrics(capacity, settings, nowMinutes);

  const ordered = [metrics.planned, metrics.status, metrics.available, metrics.events];
  const ariaLabel = ordered.map(metricAriaText).filter(Boolean).join(", ");

  const root = el("div", "nautilus-log-metrics");
  if (ariaLabel) root.setAttribute("aria-label", ariaLabel);

  // 🔴 不用 vendor 的 formatCapacitySummary 做 title：它【硬编码中文、没有 i18n】
  //    （上游疏漏，2026-08-24 实测：language:'en' 下照样返回「可安排 · 事件 · 待办需求」）。
  //    改由已经 i18n 过的 capacityMetrics 结果自行拼装。
  const summary = ordered
    .map((m) => (m && m.label && m.value ? `${m.label} ${m.value}` : ""))
    .filter(Boolean)
    .join(" · ");
  if (summary) root.title = summary;

  const summaryRow = el("div", "nautilus-log-metrics-summary");
  appendSummaryItem(summaryRow, metrics.planned);
  appendSeparator(summaryRow);
  appendSummaryItem(summaryRow, metrics.status);
  appendSeparator(summaryRow);
  appendPercentItem(summaryRow, metrics.planned);

  const capacityRow = el("div", "nautilus-log-metrics-capacity");
  appendReading(capacityRow, metrics.available);
  appendReading(capacityRow, metrics.events);

  root.appendChild(summaryRow);
  root.appendChild(capacityRow);

  // 上游 `component.cljs:1876-1883` 的 header 骨架：左列文案 / 右列动作 + 图例。
  // ⚠️ `nautilus-log-header--compact` 这里【无条件】加 —— 上游靠 React state
  //    切换它，但本移植用到它的三条规则本身就关在 `@container (max-width:520px)`
  //    里（styles.css:719-726），宽容器下加不加都没有效果，因此不需要在 JS 里
  //    再算一次宽度（也就不会和 spiral.ts 的 isCompactChartWidth 打架）。
  const header = el("header", "nautilus-log-header nautilus-log-header--compact");
  const copyCol = el("div", "nautilus-log-header-copy");
  copyCol.appendChild(root);
  header.appendChild(copyCol);

  const actionsCol = el("div", "nautilus-log-header-actions");
  let copy: Record<string, Record<string, string>> = {};
  try {
    copy = core.uiCopy(settings.language);
  } catch {
    copy = {};
  }
  renderHtmlLegend(actionsCol, copy);   // §P1-8 图例挂载点 1/2
  header.appendChild(actionsCol);

  container.appendChild(header);
}
