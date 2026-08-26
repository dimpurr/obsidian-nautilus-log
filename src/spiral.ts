/*
 * spiral.ts — the Nautilus Log spiral day-chart renderer.
 *
 * This is a 1:1 TypeScript port of the upstream ClojureScript `show-events`
 * component (the thin shell).  ALL geometry — arc radii, label avoidance,
 * tooltip placement — lives in the vendored engine `src/vendor/log-core.js`;
 * we call it and never recompute the math ourselves.  The shell only:
 *
 *   · maps the plan/capacity data contract into render-ready rows,
 *   · drives the vendored geometry functions,
 *   · and emits an SVG tree whose class names are all `.nautilus-log-*`
 *     (styling is owned by W2).
 *
 * Upstream baseline: 404KSG/roam-nautilus-log @ 7bf19a1d.
 */

import * as logCoreModule from "./vendor/log-core";
import { createSvg } from "./svg-util";
import { createTooltip, type TooltipTarget } from "./tooltip";
import { renderCompactEventList } from "./compact";
// P1-1：盘上标签必须用【清洗后】的文本，不能是整行原始 markdown。
// 上游的清洗链是 parse-URLs + parse-rest（component.cljs:638-665），切片只用
// 清洗结果 `:description`。本移植的等价物是 parser.ts 的 taskDescription()。
import { taskDescription } from "./parser";
import type { DayState } from "./daystate";
import type {
  Capacity,
  LineId,
  NautilusSettings,
  ParsedPlan,
} from "./contract";

/* ------------------------------------------------------------------ */
/* Vendored engine, narrowed to the seams the spiral actually touches. */
/* ------------------------------------------------------------------ */

interface SpiralCore {
  /** 窄容器判定。上游据此在侧栏里省掉 hover 浮层并折叠明细。 */
  isCompactChartWidth(width: number): boolean;
  /** 把当天已闭合的 CLOCK 段聚成一个「实际耗时」摘要。见 SpiralOptions.clockEntries。 */
  completedTaskClockSummary(args: {
    taskUid: string;
    entries: unknown[];
    dayStartMs: number;
    dayEndMs: number;
  }): { actualMinutes: number; sessionCount: number; latestEndMinutes: number | null };
  /** 从完成锚点反推已完成任务的历史区间。拿不到结束时刻时返回 null
   *  —— 引擎不编造未被告知的历史。 */
  historicalDoneSlice(args: {
    done?: boolean;
    doneAt?: number;
    duration?: number;
    defaultDuration?: number;
    actualDuration?: number;
    lastClockEnd?: number;
  }): { start: number; end: number; duration: number } | null;
  normalizeScheduleSettings(args: {
    startHour?: number;
    endHour?: number;
    workdayStart?: number;
    workdayEnd?: number;
  }): { startHour: number; endHour: number; startMinutes: number; endMinutes: number };
  spiralCellInnerHour(args: {
    startMinute: number;
    endMinutes: number;
    windowStartMinutes?: number;
  }): number | null;
  hourlyGridSegments(args: {
    startMinutes: number;
    endMinutes: number;
  }): { start: number; end: number; label: string }[];
  pastTimelineSegments(args: {
    startMinutes: number;
    endMinutes: number;
    nowMinutes: number;
  }): { start: number; end: number }[];
  /** 空闲时段分组。吃 `freetime === true` 的事件，返回合并后的连续空档，
   *  每组已按整点切好 `segments`（与盘上的每小时格子对齐）。 */
  availableSlotGroups(args: {
    events: { start: number; end: number; freetime?: boolean }[];
    startMinutes: number;
    endMinutes: number;
    nowMinutes: number;
    clampToNow?: boolean;
  }): {
    key: string;
    start: number;
    end: number;
    duration: number;
    availableNow: boolean;
    segments: { start: number; end: number }[];
  }[];
  pastUnplannedSegments(args: {
    startMinutes: number;
    endMinutes: number;
    nowMinutes: number;
    occupiedEvents: unknown[];
  }): { start: number; end: number }[];
  placeLabelTracks(args: {
    labels: { uid: string; start: number; end: number }[];
    maxTracks: number;
  }): { uid: string; track: number }[];
  placeExternalLabels(args: Record<string, unknown>): {
    x: number; y: number; w: number; h: number;
    connectorKneeX?: number; connectorRailX?: number; side?: string; track: number;
  }[];
  overlappingFixedEventUids(args: { events: unknown[] }): string[];
  isCurrentPlannedTask(args: {
    event: unknown; nowMinutes: number; dailyPage: boolean;
  }): boolean;
  pastItemStatus(args: {
    event: unknown; nowMinutes: number; dailyPage: boolean;
  }): string | null;
  truncateTextToWidth(args: { text: string; maxWidth: number; font?: string }): string;
  uiCopy(language: string): Record<string, Record<string, string>>;
  formatDuration(minutes: number): string;
}

const core = (logCoreModule as unknown) as SpiralCore;

/* ------------------------------------------------------------------ */
/* Visual constants (mirror of upstream defaults, desktop only).       */
/* ------------------------------------------------------------------ */

/* 认证审计 L2-104：上游按 `platform.isMobile` 切三组几何量 ——
 * `component.cljs:31` mobile?、`:35` snail-scaler 0.7/1、`:55` font-size 12/14、
 * `:277` gap 14/24。本移植刻意让 spiral.ts 保持纯粹（不 import obsidian），
 * 所以平台由宿主经 `SpiralOptions.mobile` 注入，缺省桌面。
 * 🔴 这几个量必须是 `let` + `applyPlatform()`：它们被模块级常量与十几个
 *    渲染函数共享，改成逐层传参会把整份文件的签名都撕开。 */
let MOBILE = false;
let SNAIL_SCALER = 1;
let FONT_SIZE = 14;
const FONT_FAMILY =
  "'方正屏显雅宋简体', 'FZPingXianYaSong-R-GBK', 'PingFang SC', 'Microsoft YaHei', sans-serif";
const RECT_WIDTH_COEF = 1.55;
const RECT_HEIGHT_COEF = 1.15;
const RESERVE = 15;
const BENT_LINE_GAP = 5;
/* 认证审计 C1-060：上游 `iterate-rect-place`（component.cljs:193-252,290-297）
 * 是 `placeExternalLabels` 返回空时的第二套摆放算法，常量 init-starting-distance=30 /
 * tries-treshold=25 属于它。**本移植不移植它，因为它在两边都不可达**：
 * `log-core.js:1292` 是 `labels.map(...)`（一入一出），side-rails 分支
 * `:1322-1323` 返回 `candidate || fallback`，而 fallback = `externalLabelRect(...)`
 * 永远是对象 ⇒ 单标签调用恒返回长度 1 的数组。上游 `(or external-rect fallback-rect {})`
 * 里的 fallback-rect 同样恒被短路。故此处只保留恒定锚点兜底（见 getLegendRect）。 */

/** The spiral's radius profile: 5 empty cells, the outer ring, then the taper. */
const SNAIL_BLUEPRINT_OUTER_RADII: number[] = [
  0, 0, 0, 0, 0,
  135, 140, 145, 150,
  145, 140, 135, 130, 125, 120, 115, 110, 105, 100, 95, 90, 85, 80, 75, 70,
  68, 66, 64, 62,
];
let SNAIL_INNER_RADIUS = 50 * SNAIL_SCALER;
/* P1-9①：hover 浮层的锚点半径。上游 component.cljs:427 传的是
 * `8 + 最大外径`（= 158），即把锚点放到盘【外】8px；传内圈 50 会让锚点落在
 * 盘面内部，提示直接盖在切片上。 */
export let TOOLTIP_ANCHOR_RADIUS =
  8 + Math.max(...SNAIL_BLUEPRINT_OUTER_RADII) * SNAIL_SCALER;

/** 认证审计 L2-104：渲染前落实平台。桌面/移动只差这四个量。 */
function applyPlatform(mobile: boolean): void {
  MOBILE = mobile === true;
  SNAIL_SCALER = MOBILE ? 0.7 : 1;
  FONT_SIZE = MOBILE ? 12 : 14;
  SNAIL_INNER_RADIUS = 50 * SNAIL_SCALER;
  TOOLTIP_ANCHOR_RADIUS = 8 + Math.max(...SNAIL_BLUEPRINT_OUTER_RADII) * SNAIL_SCALER;
}

/* Colors are CSS custom properties so W2 owns the palette. */
const SPIRAL_TEMPLATE_COLOR = "var(--nautilus-log-spiral)";
const CLOCK_HAND_COLOR = "#EA0F0F5B";
const TASK_FILL = "var(--nautilus-log-task-fill)";
const MEETING_FILL = "var(--nautilus-log-event-fill)";
const COMPLETED_FILL = "var(--nautilus-log-completed-fill)";
const PAST_EVENT_FILL = "var(--nautilus-log-past-event-fill)";
const URGENT_FILL = "var(--nautilus-log-urgent-fill)";
const COMPLETED_LEGEND = "var(--nautilus-log-completed)";
const TASK_LEGEND = "var(--nautilus-log-task)";
const MEETING_LEGEND = "var(--nautilus-log-event)";
const URGENT_LEGEND = "var(--nautilus-log-urgent)";

/* ------------------------------------------------------------------ */
/* Resolved renderer settings (derived from the contract).             */
/* ------------------------------------------------------------------ */

interface RendererSettings {
  workdayStart: number;
  workdayEnd: number;
  legendLenLimit: number;
  defaultDuration: number;
  language: "en" | "zh";
}

function deriveSettings(settings: NautilusSettings): RendererSettings {
  const normalized = core.normalizeScheduleSettings({
    startHour: settings.workdayStartHour,
    endHour: settings.workdayEndHour,
  });
  return {
    workdayStart: normalized.startMinutes,
    workdayEnd: normalized.endMinutes,
    legendLenLimit: settings.descLength,
    defaultDuration: settings.todoDuration,
    language: settings.language,
  };
}

/* ------------------------------------------------------------------ */
/* Pure geometry helpers (ported from the upstream shell).             */
/* ------------------------------------------------------------------ */

const PI = Math.PI;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function angleToRad(angle: number): number {
  return (180 - angle) * (PI / 180);
}

function minToAngle(minutes: number): number {
  return (((minutes - 540) / 2) % 360 + 360) % 360;
}

function posSweepAngle(startRadians: number, endRadians: number): number {
  return 2 * PI - (endRadians > startRadians
    ? endRadians - startRadians
    : endRadians - startRadians + 2 * PI);
}

function posSweepAngleMid(startRadians: number, endRadians: number): number {
  return endRadians + posSweepAngle(startRadians, endRadians) / 2;
}

function atVertex(radians: number): boolean {
  return (radians >= 1.01 && radians <= 2.05) ||
    (radians >= -2.05 && radians <= -1.01);
}

function coords(
  angle: number,
  radius: number,
  center: { x: number; y: number },
): [number, number] {
  const radians = angleToRad(angle);
  return [
    center.x + Math.cos(radians) * radius,
    center.y - Math.sin(radians) * radius,
  ];
}

function createArcPath(
  startAngle: number,
  endAngle: number,
  innerRadius: number,
  outerRadius: number,
  center: { x: number; y: number },
): string {
  const startRadians = angleToRad(startAngle);
  const endRadians = angleToRad(endAngle);
  const [sxo, syo] = coords(startAngle, outerRadius, center);
  const [exo, eyo] = coords(endAngle, outerRadius, center);
  const [sxi, syi] = coords(startAngle, innerRadius, center);
  const [exi, eyi] = coords(endAngle, innerRadius, center);
  const largeArc = posSweepAngle(startRadians, endRadians) >= PI ? 1 : 0;
  return (
    `M${sxo},${syo}` +
    ` A${outerRadius},${outerRadius} 0 ${largeArc} 1 ${exo},${eyo}` +
    ` L${exi},${eyi}` +
    ` A${innerRadius},${innerRadius} 0 ${largeArc} 0 ${sxi},${syi}Z`
  );
}

function outerRadiusAt(t: number): number {
  return SNAIL_BLUEPRINT_OUTER_RADII[t] * SNAIL_SCALER;
}

function spiralProfileIndex(minute: number, s: RendererSettings): number {
  const offset = Math.max(0, Math.floor((minute - s.workdayStart) / 60));
  return Math.min(SNAIL_BLUEPRINT_OUTER_RADII.length - 1, 5 + offset);
}

function spiralOuterRadius(minute: number, s: RendererSettings): number {
  return outerRadiusAt(spiralProfileIndex(minute, s));
}

function spiralCellInnerRadius(
  startMinute: number,
  s: RendererSettings,
  fallbackInnerRadius: number,
): number {
  const pairedHour = core.spiralCellInnerHour({
    startMinute,
    endMinutes: s.workdayEnd,
    windowStartMinutes: s.workdayStart,
  });
  if (typeof pairedHour === "number") {
    return Math.max(fallbackInnerRadius, outerRadiusAt(pairedHour));
  }
  return fallbackInnerRadius;
}

function displayWidth(s: string): number {
  let width = 0;
  for (const char of s) width += char.charCodeAt(0) > 255 ? 2 : 1;
  return width;
}

function minutesToTime(minutes: number): string {
  const h = Math.floor((minutes / 60) % 24);
  const m = minutes % 60;
  return (h < 10 ? "0" + h : String(h)) + ":" + (m < 10 ? "0" + m : String(m));
}

function durationLabel(minutes: number): string {
  return core.formatDuration(minutes) ||
    `${Math.max(0, Math.floor(minutes || 0))}m`;
}

/* P1-1：把一行原始 markdown 变成盘上要显示的描述。
 * 🔴 第二参传 0 是【有意的】—— taskDescription 的 descLength 语义是【字符数】
 *    (parser.ts:97 那段注释)，而这里的截断由 renderSlice 用像素宽度另做一次
 *    (legendLenLimit * FONT_SIZE / RECT_WIDTH_COEF)。传 descLength 会截两遍、
 *    产出 "标题……"。0（<=0）在 parser 里就是「只清洗、不截断」。 */
function cleanLabel(line: string): string {
  return taskDescription(line, 0) || line;
}

/* P1-5②：逐片入场的错峰延迟。上游 component.cljs:861/872/882 三处都设，
 * 公式一样：切片起始分钟 / 1440 * 6 秒。styles.css:783 的 animation-delay
 * 读的就是它 —— 不设 => 恒为 0 => 所有切片同时出现 = 没有回放动画。 */
function playbackDelay(startMinute: number | undefined): string {
  return `${((startMinute || 0) / 1440) * 6}s`;
}

/* P1-3：已完成比例的网点叠层（上游 component.cljs:855-866 的 dot-pattern）。
 * 上游把 <defs> 塞进每个切片里、id 固定为 "dot-pattern"；这里只在 <svg> 根发一次。
 * 同一页多张图会出现同 id，但内容逐字相同、url(#id) 取文档首个 —— 无影响。 */
const DOT_PATTERN_ID = "nautilus-log-dot-pattern";

function dotPatternDefs(): Element {
  return createSvg("defs", {},
    createSvg("pattern", {
      id: DOT_PATTERN_ID, width: "4", height: "4", patternUnits: "userSpaceOnUse",
    },
      createSvg("circle", { r: "0.5", cx: "1", cy: "1", fill: "gray" }),
      createSvg("circle", { r: "0.5", cx: "5", cy: "5", fill: "gray" })));
}

/* ------------------------------------------------------------------ */
/* Render-ready rows.                                                  */
/* ------------------------------------------------------------------ */

interface RenderEvent {
  uid: LineId;
  text: string;
  start: number;
  end: number;
  done: boolean;
  meeting: boolean;
  todo: boolean;
  progress: number;
  urgent?: boolean;
  freetime?: boolean;
}

interface Point { x: number; y: number; }

interface LegendRect {
  x: number;
  y: number;
  w: number;
  h: number;
  text: string;
  realRectRadians: number;
  connectorKneeX?: number;
  connectorRailX?: number;
}

/* ------------------------------------------------------------------ */
/* Legend rect placement (drives both dimensions and slice labels).    */
/* ------------------------------------------------------------------ */

function realRectRadians(rect: { x?: number; y?: number; w?: number; h?: number }, center: Point): number {
  const rcx = (rect.x ?? 0) + (rect.w ?? 0) / 2;
  const rcy = (rect.y ?? 0) + (rect.h ?? 0) / 2;
  return Math.atan2(rcy - center.y, rcx - center.x);
}

function getLegendRect(
  rects: LegendRect[],
  text: string,
  sliceRadians: number,
  outerRadius: number,
  center: Point,
  settings: RendererSettings,
  orderKey: number,
  anchorY: number,
): LegendRect {
  const w = (FONT_SIZE / RECT_WIDTH_COEF) *
    Math.min(displayWidth(text), settings.legendLenLimit);
  const h = FONT_SIZE * RECT_HEIGHT_COEF;
  const maxSpiralRadius = Math.max(
    ...SNAIL_BLUEPRINT_OUTER_RADII.map((_, i) => outerRadiusAt(i)),
  );

  const external = core.placeExternalLabels({
    centerX: center.x,
    centerY: center.y,
    exclusionRadius: maxSpiralRadius,
    gap: MOBILE ? 14 : 24,
    trackGap: 18,
    layout: "side-rails",
    maxVerticalOffset: maxSpiralRadius * 0.92,
    rowGap: 26,
    collisionPadding: 6,
    occupiedRects: rects,
    labels: [{ uid: text, angle: sliceRadians, anchorY, sortKey: orderKey, width: w, height: h }],
  });

  let rect: LegendRect;
  if (external && external.length > 0) {
    const placed = external[0];
    rect = {
      x: placed.x,
      y: placed.y,
      w: placed.w,
      h: placed.h,
      text,
      realRectRadians: 0,
      connectorKneeX: placed.connectorKneeX,
      connectorRailX: placed.connectorRailX,
    };
  } else {
    // Never reached in practice (the engine always returns a candidate or a
    // fallback), but keep a deterministic anchor so dimensions never blow up.
    rect = { x: 0, y: 0, w, h, text, realRectRadians: 0 };
  }
  rect.realRectRadians = realRectRadians(rect, center);
  return rect;
}

function labelTrackMap(events: RenderEvent[]): Map<string, number> {
  const labels = events.map((e) => ({ uid: e.uid, start: e.start, end: e.end }));
  const placed = core.placeLabelTracks({ labels, maxTracks: 3 });
  const map = new Map<string, number>();
  for (const p of placed) map.set(p.uid, p.track);
  return map;
}

/* ------------------------------------------------------------------ */
/* Slice rendering (the core building block).                          */
/* ------------------------------------------------------------------ */

interface SliceOptions {
  startAngle: number;
  endAngle: number;
  innerRadius: number;
  outerRadius: number;
  center: Point;
  settings: RendererSettings;
  bgColor?: string;
  borderColor?: string;
  legendColor?: string;
  legendRect?: LegendRect | null;
  text?: string;
  strokeDasharray?: string;
  fontWeight?: string;
  done?: boolean;
  taskStartMin?: number;
  taskEndMin?: number;
  past?: boolean;
  timestamp?: string;
  /** P1-3：0-100。>0 时在切片上叠一层网点（上游 non-zero-progress?）。 */
  progress?: number;
}

function renderSlice(opts: SliceOptions): Element {
  const {
    startAngle, endAngle, innerRadius, outerRadius, center, settings,
    bgColor, borderColor, legendColor, legendRect,
    text, strokeDasharray, fontWeight, done,
    taskStartMin, taskEndMin, past, timestamp,
  } = opts;
  const progress = opts.progress || 0;
  const pbDelay = playbackDelay(taskStartMin);

  const startRadians = angleToRad(startAngle);
  const endRadians = angleToRad(endAngle);
  const midRadians = (taskStartMin !== undefined && taskEndMin !== undefined)
    ? posSweepAngleMid(angleToRad(minToAngle(taskStartMin)), angleToRad(minToAngle(taskEndMin)))
    : posSweepAngleMid(startRadians, endRadians);
  const lineOuterRadius = (taskStartMin !== undefined && taskEndMin !== undefined)
    ? spiralOuterRadius((taskStartMin + taskEndMin) / 2, settings)
    : outerRadius;

  const cx = center.x;
  const cy = center.y;
  const [legendLineStartX, legendLineStartY] = [
    cx + Math.cos(midRadians) * (lineOuterRadius + BENT_LINE_GAP),
    cy - Math.sin(midRadians) * (lineOuterRadius + BENT_LINE_GAP),
  ];

  const lx = legendRect ? legendRect.x : 0;
  const ly = legendRect ? legendRect.y : 0;
  const lw = legendRect ? legendRect.w : 0;
  const lh = legendRect ? legendRect.h : 0;
  const legendRadians = legendRect ? -legendRect.realRectRadians : 0;
  const vertex = atVertex(legendRadians);
  const onLeft = legendRadians <= -PI / 2 || legendRadians >= PI / 2;

  let lineEndX = lx;
  let lineEndY = ly;
  if (vertex) {
    lineEndX = lx + lw / 2;
    lineEndY = ly + (legendRadians < 0 ? 0 : lh);
  } else if (legendRadians < PI && legendRadians > PI / 2) {
    lineEndX = lx + lw + BENT_LINE_GAP;
    lineEndY = ly + lh * Math.sin(legendRadians);
  } else if (legendRadians < PI / 2 && legendRadians > 0) {
    lineEndX = lx;
    lineEndY = ly + lh / 2 + lh * (Math.sin(legendRadians) / 2);
  } else if (legendRadians < 0 && legendRadians > -PI / 2) {
    lineEndX = lx;
    lineEndY = ly + lh * (Math.cos(legendRadians) / 2);
  } else {
    lineEndX = lx + lw + BENT_LINE_GAP;
    lineEndY = ly + ((Math.sin(legendRadians) + 1) / 2) * lh;
  }

  const textX = vertex
    ? lineEndX
    : lineEndX + (onLeft ? -BENT_LINE_GAP : BENT_LINE_GAP);

  const path = createArcPath(startAngle, endAngle, innerRadius, outerRadius, center);
  const resolvedBorder = borderColor === undefined ? "none" : borderColor;
  const resolvedDash = strokeDasharray === undefined ? "2,2" : strokeDasharray;
  const resolvedBg = bgColor === undefined ? "rgba(255,255,255,0)" : bgColor;
  const resolvedLegend = legendColor === undefined
    ? resolvedBg.replace(")", ", 1)").replace("rgba(", "rgba(")
    : legendColor;
  const resolvedWeight = fontWeight === undefined ? "normal" : fontWeight;

  const group = createSvg("g", past ? { class: "nautilus-log-grid-past" } : {});

  // P1-3：网点叠层在实体切片【之前】—— 与上游一致（component.cljs:862 在 868 之上）。
  if (progress > 0) {
    group.appendChild(createSvg("path", {
      d: path,
      class: "nautilus-log-slice-progress",
      style: { "--pb-delay": pbDelay },
      fill: `url(#${DOT_PATTERN_ID})`,
    }));
  }

  group.appendChild(createSvg("path", {
    d: path,
    class: "nautilus-log-slice",
    style: { "--pb-delay": pbDelay },   // P1-5②
    "stroke-dasharray": resolvedDash,
    fill: resolvedBg,
    stroke: resolvedBorder,
  }));

  if (text) {
    const legendGroup = createSvg("g", {
      class: "nautilus-log-slice-group",
      style: { "--pb-delay": pbDelay },   // P1-5②（上游 component.cljs:882）
    });
    legendGroup.appendChild(createSvg("title", {}, text));

    const kneeX = legendRect?.connectorKneeX ?? (legendLineStartX + textX) / 2;
    const railX = legendRect?.connectorRailX ?? textX;
    legendGroup.appendChild(createSvg("path", {
      d: `M ${legendLineStartX},${legendLineStartY} L ${kneeX},${legendLineStartY} L ${railX},${lineEndY} L ${textX},${lineEndY}`,
      class: "nautilus-log-link-line",
      stroke: resolvedLegend,
      "stroke-width": "1.5px",
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
      fill: "none",
    }));

    const truncated = core.truncateTextToWidth({
      text,
      maxWidth: settings.legendLenLimit * (FONT_SIZE / RECT_WIDTH_COEF),
      font: `${FONT_SIZE}px ${FONT_FAMILY}`,
    });
    legendGroup.appendChild(createSvg("text", {
      x: textX,
      y: ly + lh,
      "text-anchor": vertex ? "middle" : (onLeft ? "end" : "start"),
      "alignment-baseline": "baseline",
      "font-weight": resolvedWeight,
      "text-decoration": done ? "line-through" : "none",
      fill: done ? COMPLETED_LEGEND : resolvedLegend,
    }, truncated || text));

    group.appendChild(legendGroup);
  }

  if (timestamp) {
    const timeTextX = cx + Math.cos(startRadians) * (outerRadius - 10);
    const timeTextY = cy - Math.sin(startRadians) * (outerRadius - 10);
    const upright = startAngle >= 270 || startAngle <= 90;
    group.appendChild(createSvg("text", {
      x: timeTextX,
      y: timeTextY,
      "font-size": FONT_SIZE - 3,
      "font-family": FONT_FAMILY,
      fill: resolvedBorder,
      transform: `rotate(${upright ? startAngle : startAngle - 180} ${timeTextX},${timeTextY})`,
      "text-anchor": "middle",
      "alignment-baseline": upright ? "after-edge" : "before-edge",
    }, timestamp));
  }

  return group;
}

/* ------------------------------------------------------------------ */
/* Past overlays (elapsed shading + hatched unrecorded gaps).          */
/* ------------------------------------------------------------------ */

function pastTimeOverlay(
  center: Point,
  settings: RendererSettings,
  innerRadius: number,
  elapsedThroughMinutes: number,
): Element {
  const segments = core.pastTimelineSegments({
    startMinutes: settings.workdayStart,
    endMinutes: settings.workdayEnd,
    nowMinutes: elapsedThroughMinutes,
  });
  const group = createSvg("g", { class: "nautilus-log-past-overlay", "aria-hidden": "true" });
  for (const segment of segments) {
    group.appendChild(createSvg("path", {
      d: createArcPath(
        minToAngle(segment.start),
        minToAngle(segment.end),
        spiralCellInnerRadius(segment.start, settings, innerRadius),
        spiralOuterRadius(segment.start, settings),
        center,
      ),
    }));
  }
  return group;
}

/** 占用区间在 [from, to) 里的补集 —— 也就是"没排任何东西"的空档。
 *  上游把这些空档当作 `freetime: true` 的事件混在同一份事件列表里
 *  （eventsToSlices / eventsToNewDimensions 都显式排除它们），
 *  唯一的消费者是 availableSlotGroups。盘上不画实体，只做 hover 预览。 */
function freeGaps(events: RenderEvent[], from: number, to: number): [number, number][] {
  const occupied = events
    .map((e) => [Math.max(from, e.start), Math.min(to, e.end)] as [number, number])
    .filter(([a, b]) => b > a)
    .sort((a, b) => a[0] - b[0]);
  const gaps: [number, number][] = [];
  let cursor = from;
  for (const [a, b] of occupied) {
    if (a > cursor) gaps.push([cursor, a]);
    if (b > cursor) cursor = b;
  }
  if (cursor < to) gaps.push([cursor, to]);
  return gaps;
}

/** 空闲时段的 hover 靶区。**类名与结构必须照抄上游**：
 *  外层 `<g class="nautilus-log-available-slot">` 一组一个（含 `--now` 修饰），
 *  内层每个整点分片一个 `.nautilus-log-available-slot-hit`。
 *  styles.css 早就把这套规则移植过来了（hover 时整组一起高亮），
 *  另造类名 = 白写一遍样式还对不上。
 *
 *  整组共享一个 tooltip：鼠标落在任何一个分片上，报的都是【整段连续空档】
 *  的时长 —— 这正是这个特性的价值（"这儿还能塞下多长的活"，
 *  而不是"这个格子有多长"）。
 *  🔴 默认完全透明、不改任何视觉：空档在盘上本来就该是空的。 */
function freeSlotLayer(
  groups: {
    key: string; start: number; end: number; duration: number;
    availableNow: boolean; segments: { start: number; end: number }[];
  }[],
  center: Point,
  settings: RendererSettings,
  innerRadius: number,
  label: (slot: { start: number; end: number; duration: number; availableNow: boolean }) => string,
): { group: Element; targets: { el: Element; groupIndex: number }[] } {
  const layer = createSvg("g", { class: "nautilus-log-available-slots" });
  const targets: { el: Element; groupIndex: number }[] = [];
  groups.forEach((slot, groupIndex) => {
    const drawn = slot.segments.filter((seg) => seg.end > seg.start);
    if (!drawn.length) return;
    const g = createSvg("g", {
      class: `nautilus-log-available-slot${slot.availableNow ? " nautilus-log-available-slot--now" : ""}`,
      // 键盘可达：与实体切片同一套 focus/blur 路径。
      tabindex: "0",
      role: "img",
      "aria-label": label(slot),
    });
    for (const segment of drawn) {
      g.appendChild(createSvg("path", {
        class: "nautilus-log-available-slot-hit",
        d: createArcPath(
          minToAngle(segment.start),
          minToAngle(segment.end),
          spiralCellInnerRadius(segment.start, settings, innerRadius),
          spiralOuterRadius(segment.start, settings),
          center,
        ),
      }));
    }
    layer.appendChild(g);
    targets.push({ el: g, groupIndex });
  });
  return { group: layer, targets };
}

function pastUnplannedOverlay(
  occupiedEvents: RenderEvent[],
  center: Point,
  settings: RendererSettings,
  innerRadius: number,
  elapsedThroughMinutes: number,
  patternId: string,
): Element {
  const segments = core.pastUnplannedSegments({
    startMinutes: settings.workdayStart,
    endMinutes: settings.workdayEnd,
    nowMinutes: elapsedThroughMinutes,
    occupiedEvents,
  });
  const group = createSvg("g", { class: "nautilus-log-unplanned-overlay", "aria-hidden": "true" });
  const defs = createSvg("defs");
  defs.appendChild(createSvg("pattern", {
    id: patternId,
    class: "nautilus-log-unplanned-pattern",
    width: 7,
    height: 7,
    patternUnits: "userSpaceOnUse",
    patternTransform: "rotate(45)",
  }, createSvg("line", {
    class: "nautilus-log-unplanned-stripe",
    x1: 0, y1: 0, x2: 0, y2: 7,
  })));
  group.appendChild(defs);
  for (const segment of segments) {
    group.appendChild(createSvg("path", {
      d: createArcPath(
        minToAngle(segment.start),
        minToAngle(segment.end),
        spiralCellInnerRadius(segment.start, settings, innerRadius),
        spiralOuterRadius(segment.start, settings),
        center,
      ),
      fill: `url(#${patternId})`,
    }));
  }
  return group;
}

/* ------------------------------------------------------------------ */
/* Hourly grid (snail template) + central label + now needle.          */
/* ------------------------------------------------------------------ */

function snailBlueprintComponent(
  center: Point,
  settings: RendererSettings,
  innerRadius: number,
  showElapsed: boolean,
  elapsedThroughMinutes: number,
): Element {
  const segments = core.hourlyGridSegments({
    startMinutes: settings.workdayStart,
    endMinutes: settings.workdayEnd,
  });
  const group = createSvg("g", { class: "nautilus-log-grid", "aria-hidden": "true" });
  for (const segment of segments) {
    group.appendChild(renderSlice({
      startAngle: minToAngle(segment.start),
      endAngle: minToAngle(segment.end),
      innerRadius: spiralCellInnerRadius(segment.start, settings, innerRadius),
      outerRadius: spiralOuterRadius(segment.start, settings),
      center,
      settings,
      borderColor: SPIRAL_TEMPLATE_COLOR,
      past: showElapsed && segment.end <= elapsedThroughMinutes,
      timestamp: segment.label,
    }));
  }
  if (settings.workdayEnd === 1440) {
    const angle = minToAngle(settings.workdayEnd);
    const radians = angleToRad(angle);
    const radius = spiralOuterRadius(settings.workdayEnd - 60, settings) + 12;
    const x = center.x + Math.cos(radians) * radius;
    const y = center.y - Math.sin(radians) * radius;
    group.appendChild(createSvg("text", {
      class: "nautilus-log-midnight-label",
      x, y,
      fill: SPIRAL_TEMPLATE_COLOR,
      "font-size": FONT_SIZE - 3,
      "text-anchor": "middle",
      "alignment-baseline": "central",
    }, "0"));
  }
  return group;
}

/* P1-8：上游 `split-and-trim`（component.cljs:1212）：按第一个逗号切两段，
 * 每段截到 len-central-legend = 16 字。盘心只显示第一段。 */
const CENTRAL_LEGEND_LEN = 16;

function centralFirstRow(pageTitle: string): string {
  const first = String(pageTitle ?? "").split(",", 1)[0] ?? "";
  return first.slice(0, CENTRAL_LEGEND_LEN);
}

/** 宿主没传页名时的兜底：main.ts 在块容器上写了
 *  `data-nl-key = "<路径>\0<块内容>"`，从中取笔记名。取不到就空串
 *  （侧栏视图目前就走这条 —— 由宿主传 pageTitle 才会有值）。 */
function resolvePageTitle(container: HTMLElement, explicit?: string): string {
  if (typeof explicit === "string" && explicit.length > 0) return explicit;
  try {
    let node: Element | null = container as unknown as Element;
    for (let hops = 0; node && hops < 6; hops += 1) {
      const key = (node as HTMLElement).dataset?.nlKey;
      if (typeof key === "string" && key.length > 0) {
        const path = key.split("\u0000")[0];
        return (path.split("/").pop() || "").replace(/\.md$/i, "");
      }
      node = node.parentElement;
    }
  } catch {
    // DOM shim / 无父链：盘心第一行留空，不该因此把整张图带崩。
  }
  return "";
}

function centralLabelComponent(
  center: Point,
  centerNowLabel: string | null,
  firstRow = "",
): Element {
  const common = { x: center.x, "text-anchor": "middle", "dominant-baseline": "central" };
  const group = createSvg("g", { class: "nautilus-log-center-date" });
  // P1-8：第一行 = 页名 / 日期（上游 component.cljs:1003 的 first-row）。
  group.appendChild(createSvg("text", {
    ...common,
    y: center.y - 2,
    fill: "var(--nautilus-log-text-main)",
    "font-weight": "bold",
    "font-size": FONT_SIZE * 0.85,
  }, firstRow));
  if (centerNowLabel) {
    group.appendChild(createSvg("text", {
      ...common,
      y: center.y + 13,
      class: "nautilus-log-center-now",
      fill: "var(--nautilus-log-text-sub)",
      "font-weight": "600",
      "font-size": FONT_SIZE * 0.82,
    }, centerNowLabel));
  }
  return group;
}

function nowNeedleComponent(center: Point, timelineMinute: number, label: string): Element {
  const nowAngle = minToAngle(timelineMinute);
  const nowRad = angleToRad(nowAngle);
  const innerR = SNAIL_INNER_RADIUS + 2;
  const maxR = Math.max(...SNAIL_BLUEPRINT_OUTER_RADII);
  const x1 = center.x + innerR * Math.cos(nowRad);
  const y1 = center.y - innerR * Math.sin(nowRad);
  const x2 = center.x + (maxR + 15) * Math.cos(nowRad);
  const y2 = center.y - (maxR + 15) * Math.sin(nowRad);
  return createSvg("g", { class: "nautilus-log-now-needle", "aria-label": label },
    createSvg("line", {
      x1, y1, x2, y2,
      stroke: CLOCK_HAND_COLOR,
      "stroke-width": 2,
      "stroke-linecap": "round",
      class: "nautilus-log-now-needle-line",
    }));
}

/* ------------------------------------------------------------------ */
/* Per-event slice groups.                                             */
/* ------------------------------------------------------------------ */

function getHourBoundaries(startMin: number, endMin: number): number[] {
  let firstBound = Math.floor((startMin + 59) / 60) * 60;
  if (firstBound <= startMin) firstBound += 60;
  const boundaries: number[] = [];
  for (let b = firstBound; b < endMin; b += 60) boundaries.push(b);
  return boundaries;
}

function calculateSliceParams(
  event: RenderEvent,
  elapsedPage: boolean,
  interactive: boolean,
  timelineMinute: number,
  settings: RendererSettings,
): {
  startAngle: number;
  endAngle: number;
  bgColor: string | undefined;
  legendColor: string | null;
  done: boolean;
  meeting: boolean;
  current: boolean;
  pastStatus: string | null;
  progress: number;
} {
  const outerRadius = spiralOuterRadius(event.start, settings);
  const startAngle = minToAngle(event.start);
  const endAngle = minToAngle(event.end);
  const { todo, meeting, done, urgent } = event;
  const progress = event.progress || 0;

  const pastStatus = core.pastItemStatus({
    event,
    nowMinutes: timelineMinute,
    dailyPage: elapsedPage,
  });
  const current = core.isCurrentPlannedTask({
    event,
    nowMinutes: timelineMinute,
    dailyPage: interactive,
  });

  let bgColor: string | undefined;
  if (pastStatus === "completed") bgColor = COMPLETED_FILL;
  else if (pastStatus === "event") bgColor = PAST_EVENT_FILL;
  else if (meeting) bgColor = MEETING_FILL;
  else if (urgent) bgColor = URGENT_FILL;
  else if (todo) bgColor = TASK_FILL;

  const legendColor =
    pastStatus === "completed" ? COMPLETED_LEGEND
    : (meeting && !urgent) ? MEETING_LEGEND
    : (todo && !done && urgent) ? URGENT_LEGEND
    : (todo && !done) ? TASK_LEGEND
    : null;

  return { startAngle, endAngle, bgColor, legendColor, done, meeting, current, pastStatus, progress };
}

function eventSliceComponent(
  event: RenderEvent,
  legendRect: LegendRect,
  elapsedPage: boolean,
  interactive: boolean,
  timelineMinute: number,
  center: Point,
  settings: RendererSettings,
  conflict: boolean,
  copy: Record<string, Record<string, string>>,
  hoverEnabled: boolean,
): Element {
  const params = calculateSliceParams(event, elapsedPage, interactive, timelineMinute, settings);
  const { bgColor, legendColor, done, meeting, current, pastStatus, progress } = params;
  const startMin = event.start;
  const endMin = event.end;

  const boundaries = getHourBoundaries(startMin, endMin);
  const segments: Array<[number, number]> = [];
  let cursor = startMin;
  const bounds = boundaries.slice();
  while (bounds.length > 0) {
    const bound = bounds.shift() as number;
    segments.push([cursor, bound]);
    cursor = bound;
  }
  if (cursor < endMin) segments.push([cursor, endMin]);

  const kindLabel = copy.tooltips?.[meeting ? "event" : "task"] || "";
  const timeRange = `${minutesToTime(startMin)}–${minutesToTime(endMin)}`;
  const ariaLabel = `${event.text}. ${kindLabel}. ${timeRange}. ${durationLabel(endMin - startMin)}`;

  // P1-8：上游对【事件与任务一视同仁】都叫 nautilus-log-event-slice-group
  // （component.cljs:1080），hover 可用时再加 `--interactive`。原先任务用的
  // 自造名 nautilus-log-task-slice-group 在 styles.css 里 0 条规则 ⇒ 任务切片
  // 的 hover/focus 高亮、描边全都白写了。
  let groupClass = "nautilus-log-event-slice-group";
  if (hoverEnabled) groupClass += " nautilus-log-event-slice-group--interactive";
  if (pastStatus === "completed") groupClass += " nautilus-log-past--completed";
  else if (pastStatus === "event") groupClass += " nautilus-log-past--event";
  if (conflict) groupClass += " nautilus-log-event-conflict";
  if (current) groupClass += " nautilus-log-current-task";

  const attrs: Record<string, string | number> = {
    class: groupClass,
    "data-past-status": pastStatus ?? "",
  };
  // P1-8：紧凑模式下上游【不挂】tabindex/role/aria-label —— 那时没有浮层可显示，
  // 无条件可聚焦只会给键盘用户平添一串停不下来的空焦点（component.cljs:1092-1098）。
  if (hoverEnabled) {
    attrs["aria-label"] = ariaLabel;
    attrs.role = "img";
    attrs.tabindex = 0;
    attrs.focusable = "true";
  }
  if (current) attrs["aria-current"] = "true";

  const group = createSvg("g", attrs);
  for (let segIndex = 0; segIndex < segments.length; segIndex += 1) {
    const s = segments[segIndex][0];
    const e = segments[segIndex][1];
    const segInnerRadius = spiralCellInnerRadius(s, settings, SNAIL_INNER_RADIUS);
    const segOuterRadius = spiralOuterRadius(s, settings);
    group.appendChild(renderSlice({
      startAngle: minToAngle(s),
      endAngle: minToAngle(e),
      innerRadius: segInnerRadius,
      outerRadius: segOuterRadius,
      center,
      settings,
      bgColor,
      legendColor: legendColor ?? undefined,
      text: segIndex === 0 ? event.text : undefined,
      done,
      fontWeight: "bold",
      legendRect: segIndex === 0 ? legendRect : null,
      taskStartMin: startMin,
      taskEndMin: endMin,
      progress,   // P1-3
    }));
  }
  return group;
}

/* ------------------------------------------------------------------ */
/* events -> slices + legend rects.                                    */
/* ------------------------------------------------------------------ */

function eventsToSlices(
  events: RenderEvent[],
  elapsedPage: boolean,
  interactive: boolean,
  timelineMinute: number,
  center: Point,
  settings: RendererSettings,
  copy: Record<string, Record<string, string>>,
  hoverEnabled: boolean,
  initRects: LegendRect[] = [],
): { group: Element; rects: LegendRect[] } {
  const visible = events.filter((e) => e.freetime !== true);
  const trackMap = labelTrackMap(visible);
  const conflictUids = new Set<string>(
    core.overlappingFixedEventUids({ events: visible }),
  );

  const rects = initRects.slice();
  const group = createSvg("g");

  for (const event of visible) {
    const midRadians = posSweepAngleMid(
      angleToRad(minToAngle(event.start)),
      angleToRad(minToAngle(event.end)),
    );
    const midMinute = (event.start + event.end) / 2;
    const sourceRadius = spiralOuterRadius(midMinute, settings);
    const anchorY = center.y - Math.sin(midRadians) * (sourceRadius + 5);
    const text = event.text;
    const radius =
      SNAIL_BLUEPRINT_OUTER_RADII[spiralProfileIndex(event.start, settings)] +
      18 * (trackMap.get(event.uid) ?? 0);
    const newRect = getLegendRect(rects, text, midRadians, radius, center, settings, event.start, anchorY);
    rects.push(newRect);

    group.appendChild(eventSliceComponent(
      event,
      newRect,
      elapsedPage,
      interactive,
      timelineMinute,
      center,
      settings,
      conflictUids.has(event.uid),
      copy,
      hoverEnabled,
    ));
  }

  return { group, rects };
}

/* ------------------------------------------------------------------ */
/* Dimension computation (center + viewBox).                           */
/* ------------------------------------------------------------------ */

interface Bounds { left: number; right: number; top: number; bottom: number; }

function spiralGridBounds(center: Point, settings: RendererSettings): Bounds {
  const segments = core.hourlyGridSegments({
    startMinutes: settings.workdayStart,
    endMinutes: settings.workdayEnd,
  });
  const points: Array<[number, number]> = [];
  for (const segment of segments) {
    const radius = spiralOuterRadius(segment.start, settings);
    points.push(coords(minToAngle(segment.start), radius, center));
    points.push(coords(minToAngle(segment.end), radius, center));
  }
  if (points.length > 0) {
    const xs = points.map((p) => p[0]);
    const ys = points.map((p) => p[1]);
    return {
      left: Math.min(...xs),
      right: Math.max(...xs),
      top: Math.min(...ys),
      bottom: Math.max(...ys),
    };
  }
  const radius = Math.max(...SNAIL_BLUEPRINT_OUTER_RADII.map((_, i) => outerRadiusAt(i)));
  return {
    left: center.x - radius,
    right: center.x + radius,
    top: center.y - radius,
    bottom: center.y + radius,
  };
}

function eventsToNewDimensions(
  events: RenderEvent[],
  center: Point,
  settings: RendererSettings,
): [number, number, number, number] {
  const visible = events.filter((e) => e.freetime !== true);
  const gridBounds = spiralGridBounds(center, settings);
  const trackMap = labelTrackMap(visible);

  let leftMin = gridBounds.left;
  let rightMax = gridBounds.right;
  let topMin = gridBounds.top;
  let bottomMax = gridBounds.bottom;
  const rects: LegendRect[] = [];

  for (const event of visible) {
    const midRadians = posSweepAngleMid(
      angleToRad(minToAngle(event.start)),
      angleToRad(minToAngle(event.end)),
    );
    const midMinute = (event.start + event.end) / 2;
    const sourceRadius = spiralOuterRadius(midMinute, settings);
    const anchorY = center.y - Math.sin(midRadians) * (sourceRadius + 5);
    const text = event.text;
    const radius =
      SNAIL_BLUEPRINT_OUTER_RADII[spiralProfileIndex(event.start, settings)] +
      18 * (trackMap.get(event.uid) ?? 0);
    const rect = getLegendRect(rects, text, midRadians, radius, center, settings, event.start, anchorY);
    rects.push(rect);
    leftMin = Math.min(leftMin, rect.x);
    rightMax = Math.max(rightMax, rect.x + rect.w);
    topMin = Math.min(topMin, rect.y);
    bottomMax = Math.max(bottomMax, rect.y + rect.h);
  }

  return [
    RESERVE + center.x - leftMin,
    RESERVE + (rightMax - leftMin),
    RESERVE + center.y - topMin,
    3 * RESERVE + (bottomMax - topMin) + (settings.workdayStart < 420 ? RESERVE : 0),
  ];
}

/* ------------------------------------------------------------------ */
/* Public entry point.                                                 */
/* ------------------------------------------------------------------ */

/**
 * 认证审计 L1-138 / L2-006：算出**被显示那一天**的本地 00:00。
 *
 * 首选宿主直接给的 `displayDate`（笔记日期）。宿主没接线时退而求其次：
 * 引擎的 `timelineMinutes` 在非回放下 = `nowMinutes + dayDelta * 1440`
 * （log-core.js:317-318，`dayDelta = 今天 - 显示日`），可以反推出日偏移。
 * 回放时 `timelineMinutes` 就是回放游标、反推不成立，这时只能退回今天。
 */
function resolveDisplayedDayStart(
  displayDate: Date | number | null | undefined,
  ds: DayState | undefined,
  nowMinutes: number,
): Date {
  if (displayDate != null) {
    const explicit = new Date(displayDate as Date);
    if (Number.isFinite(explicit.getTime())) {
      return new Date(explicit.getFullYear(), explicit.getMonth(), explicit.getDate());
    }
  }
  const today = new Date();
  if (ds && Number.isFinite(ds.timelineMinutes) && Number.isFinite(nowMinutes)) {
    const dayDelta = Math.round((ds.timelineMinutes - nowMinutes) / 1440);
    if (dayDelta !== 0) {
      return new Date(today.getFullYear(), today.getMonth(), today.getDate() - dayDelta);
    }
  }
  return new Date(today.getFullYear(), today.getMonth(), today.getDate());
}

let patternCounter = 0;

/**
 * Render the Nautilus Log spiral into `container`.
 *
 * The chart is treated as the current day's Daily Page: elapsed shading is
 * drawn up to `nowMinutes` and the red needle marks the current instant.  No
 * interactivity is wired (hover tooltips, playback, and the execution layer
 * are deliberately out of scope for this stage).
 */
export interface SpiralOptions {
  /** 显示已完成项。对应上游的「眼睛」按钮。 */
  showDone?: boolean;
  /** 今天的 CLOCK 记录（执行层的 entries）。
   *  🔴 P0-4：没有它，已完成任务的切片长度永远是【估计值】，而且
   *  **没打 `dHH:MM` 锚点但打过卡的任务在盘上根本画不出来** ——
   *  上游用 `completedTaskClockSummary` 把当天的 CLOCK 段聚成 Actual
   *  再喂给 `historicalDoneSlice`（component.cljs:679-693）。
   *  执行层关闭 / 拿不到时省略即可，行为退回纯估计值。 */
  clockEntries?: { taskUid?: string; start?: unknown; end?: unknown; running?: boolean }[];
  /** 回放中的时刻；给了就用它当"当前时刻"画针与流逝区。 */
  playbackMinute?: number | null;
  /** 认证审计 L2-104：宿主平台。Obsidian 侧传 `Platform.isMobile`。
   *  缺省桌面 —— spiral.ts 不 import obsidian，保持可测。 */
  mobile?: boolean;
  /** 认证审计 L1-138 / L2-006：**被显示的那一天**（笔记日期）。
   *  CLOCK 汇总的日窗口要按它算，不是按 `new Date()`。
   *  宿主不传时从 dayState 的日偏移反推，再退到今天。 */
  displayDate?: Date | number | null;
  /** 笔记日期与今天的关系。缺省即按"今天"处理（向后兼容）。
   *  🔴 看昨天不该画红针、看明天不该画斜纹 —— 全由它决定，别自己判。 */
  dayState?: DayState;
  /** P1-8：盘心第一行 —— 上游放的是【页名】（Roam 日记页标题，
   *  component.cljs:1354 `(split-and-trim page-title len-central-legend)`：
   *  按第一个逗号切两段、每段截 16 字）。本移植的等价物是笔记名。
   *  宿主不传时退化到从块容器的 data-nl-key 里取笔记名（见 resolvePageTitle）。 */
  pageTitle?: string;
}

/** 供外部（main.ts）在重渲染前清理上一次的监听。 */
export interface SpiralHandle { destroy(): void }

export function renderSpiral(
  container: HTMLElement,
  plan: ParsedPlan,
  capacity: Capacity,
  settings: NautilusSettings,
  nowMinutes: number,
  options: SpiralOptions = {},
): SpiralHandle {
  const s = deriveSettings(settings);
  const workdayStart = s.workdayStart;
  const workdayEnd = s.workdayEnd;
  const copy = core.uiCopy(s.language);

  // 回放：把"当前时刻"换成回放游标。不改任何 Markdown —— 上游语义就是纯视觉。
  const effectiveNow = options.playbackMinute ?? nowMinutes;
  const playbackActive = options.playbackMinute != null;
  const ds = options.dayState;
  applyPlatform(options.mobile === true);   // 认证审计 L2-104
  // 过去的日子：斜纹铺满整天（那天已经过完了）；未来：不铺。
  const elapsedThrough = ds
    ? clamp(ds.elapsedThroughMinutes, workdayStart, workdayEnd)
    : clamp(effectiveNow, workdayStart, workdayEnd);
  // 🔴 认证审计 L1-064：切片着色的「此刻」是引擎的 elapsedThroughMinutes，
  //    **不是真实时钟**（上游 component.cljs:1308-1311 传的就是它）。用真实时钟
  //    会让「看昨天」时所有已完成任务 / 已过去的会议都不变灰 —— 斜纹铺满了整天，
  //    切片却还是彩色的。
  const timelineMinute = elapsedThrough;
  // 🔴 未来的日子【完全不画】已流逝区 —— 明天还没开始。
  const showElapsed = ds ? ds.showElapsed : true;
  // 🔴 认证审计 L1-109：`interactive` 是引擎给的（上游 `(:interactive timeline-state)`，
  //    log-core.js:340 `interactive: today`）。硬编码 true 会让**明天** 09:00 的任务
  //    在真实时钟 09:30 时被标成 `.nautilus-log-current-task` / `aria-current`。
  const interactive = ds ? ds.interactive === true : true;
  // 🔴 只有今天画红针。看昨天/明天时画一根"现在"的针是没有意义的。
  const showNow = ds ? ds.showNow : (effectiveNow >= workdayStart && effectiveNow < workdayEnd);

  // Fixed events stay visible even after they have passed; flexible work is
  // already scheduled by the engine and handed to us via `capacity`.
  const fixedEvents: RenderEvent[] = plan.events
    .filter((e) => e.end > workdayStart && e.start < workdayEnd)
    .map((e) => ({
      uid: e.uid,
      text: cleanLabel(e.string),   // P1-1
      start: Math.max(workdayStart, e.start),
      end: Math.min(workdayEnd, e.end),
      done: e.done,
      meeting: true,
      todo: false,
      progress: 0,
    }))
    .filter((e) => e.start < e.end);

  const taskEvents: RenderEvent[] = capacity.scheduledTasks.map((t) => ({
    uid: t.uid,
    text: cleanLabel(t.string),   // P1-1
    start: t.start,
    end: t.end,
    done: t.done || false,
    meeting: false,
    todo: true,
    progress: t.progress || 0,
    urgent: t.urgent,
  }));

  // 已完成的任务不进排程（remainingDuration=0），所以不在 scheduledTasks 里。
  // 它们要画成灰色历史切片，位置由引擎的 historicalDoneSlice 从完成锚点反推。
  // 🔴 没有锚点就拿不到结束时刻 => 返回 null => 不画。这是上游的明确立场：
  //    "does not invent history"。
  const showDone = options.showDone !== false;
  // 当天窗口的绝对毫秒 —— completedTaskClockSummary 要的是时间戳不是分钟。
  const clockEntries = options.clockEntries || [];
  // 🔴 认证审计 L1-138 / L2-006：窗口口径必须对齐上游 `dailyPageBounds`
  //    （UP/src/index.js:79-93）：**所显示那天的 00:00 → 次日 00:00**
  //    （只有 workdayEnd > 1440 的跨夜设置才改成 dayStart + endMinutes）。
  //    原实现两处都错：① 恒用 `new Date()` 的今天午夜（`dayAnchor` 取了却
  //    `void dayAnchor`），看历史页时 CLOCK 段全落在窗口外 ⇒ actualMinutes=0；
  //    ② 把窗口收窄到工作日区间，workdayStart 前 / workdayEnd 后的打卡被裁掉。
  const displayedDayStart = resolveDisplayedDayStart(
    options.displayDate, playbackActive ? undefined : ds, nowMinutes);
  const clockDayStartMs = displayedDayStart.getTime();
  const clockDayEndMs = workdayEnd > 1440
    ? clockDayStartMs + workdayEnd * 60000
    : new Date(
      displayedDayStart.getFullYear(),
      displayedDayStart.getMonth(),
      displayedDayStart.getDate() + 1,
    ).getTime();
  const summaryCache = new Map<string, ReturnType<SpiralCore['completedTaskClockSummary']> | null>();
  const clockSummaryFor = (uid: string) => {
    if (!clockEntries.length) return null;
    if (summaryCache.has(uid)) return summaryCache.get(uid) ?? null;
    const out = core.completedTaskClockSummary({
      taskUid: uid,
      entries: clockEntries,
      dayStartMs: clockDayStartMs,
      dayEndMs: clockDayEndMs,
    });
    summaryCache.set(uid, out);
    return out;
  };
  const allDoneEvents: RenderEvent[] = plan.tasks
    .filter((t) => t.done)
    .map((t) => {
      // P0-4：有 CLOCK 记录就用实际耗时，并在缺 `dHH:MM` 锚点时用
      //   最后一段 CLOCK 的结束时刻兜底（上游 `:done-at (or done-at last-clock-end)`）。
      const summary = clockSummaryFor(t.uid);
      const slice = core.historicalDoneSlice({
        done: true,
        doneAt: t.doneAt,
        duration: t.duration,
        defaultDuration: s.defaultDuration,
        ...(summary && summary.actualMinutes > 0 ? { actualDuration: summary.actualMinutes } : {}),
        ...(summary && summary.latestEndMinutes !== null ? { lastClockEnd: summary.latestEndMinutes } : {}),
      });
      if (!slice) return null;
      return {
        uid: t.uid,
        text: cleanLabel(t.string),   // P1-1
        start: Math.max(workdayStart, slice.start),
        end: Math.min(workdayEnd, slice.end),
        done: true,
        meeting: false,
        todo: true,
        progress: t.progress || 0,   // P1-3（parser 未填时为 0）
      } as RenderEvent;
    })
    .filter((e): e is RenderEvent => e !== null && e.start < e.end);

  const doneEvents = showDone ? allDoneEvents : [];
  const allEvents = fixedEvents.concat(taskEvents, doneEvents);
  // 🔴 认证审计 L1-077：「这段时间没记录任何东西」的占用集合**永远包含已完成任务**，
  //    与「眼睛」开关无关（上游 component.cljs:1299
  //    `past-occupied-events (vec (concat events done-todos))`，:1327 传的就是它）。
  //    用受 showDone 门控的集合会把已经干完的时间误标成空白斜纹。
  const pastOccupiedEvents = fixedEvents.concat(taskEvents, allDoneEvents);

  // 空闲时段预览。过去的日子不给 —— "那天还剩多少空档"没有意义。
  // 🔴 认证审计 L1-066：判据用引擎的 `showAvailableSlots`（log-core.js:342
  //    `!past || simulated`），不自造公式。自造的 `showNow || !showElapsed` 在
  //    「今天但此刻已过收工时间」和「回放游标落在窗口外」两处与上游分叉。
  const offerFreeSlots = ds ? ds.showAvailableSlots === true : true;
  const freeSlots = offerFreeSlots
    ? core.availableSlotGroups({
      events: freeGaps(allEvents, workdayStart, workdayEnd)
        .map(([a, b]) => ({ start: a, end: b, freetime: true })),
      startMinutes: workdayStart,
      endMinutes: workdayEnd,
      nowMinutes: timelineMinute,
      // 🔴 认证审计 L1-085：上游 component.cljs:1334 是 `(or daily-page? playback?)`，
      //    其中 daily-page? = interactive?。用 `showNow` 会额外要求「此刻落在窗口内」——
      //    23:00 看今天（窗口 5–21）时会把已经过完的一整天当成还空着。
      clampToNow: interactive || playbackActive,
    })
    : [];

  const initialWidth = container.clientWidth || 600;
  const initialHeight = container.clientHeight || 800;
  const initialCenter = { x: initialWidth / 2, y: initialHeight / 2 };

  const [centerX, suggestedWidth, centerY, suggestedHeight] =
    eventsToNewDimensions(allEvents, initialCenter, s);
  const center = { x: centerX, y: centerY };

  // 🔴 紧凑判定必须【在渲染切片之前】—— 它决定切片要不要带 `--interactive`
  //    与 tabindex（P1-8）。上游同样在 show-events 顶部就算好
  //    `hover-enabled? (not compact?)`（component.cljs:1310）。
  const compact = core.isCompactChartWidth(container.clientWidth || initialWidth);
  const hoverEnabled = !compact;

  const { group: sliceGroups } = eventsToSlices(
    allEvents,
    showElapsed,
    interactive,
    timelineMinute,
    center,
    s,
    copy,
    hoverEnabled,
    [],
  );

  const svg = createSvg("svg", {
    viewBox: `0 0 ${suggestedWidth} ${suggestedHeight}`,
    width: "100%",
    xmlns: "http://www.w3.org/2000/svg",
    // P1-5①：`playback-active` 必须落在 <svg> 上（上游 component.cljs:1320）。
    // styles.css:778 的选择器要求它是 .nautilus-log-slice 的【祖先】——
    // 挂在按钮上时按钮自己变个样，盘上一片都不会逐个亮起。
    class: `nautilus-log-svg${options.playbackMinute != null ? " nautilus-log-playback-active" : ""}`,
    "font-family": FONT_FAMILY,
    "font-size": FONT_SIZE,
    style: { "max-width": `${suggestedWidth}px` },
  });

  const root = createSvg("g");
  root.appendChild(dotPatternDefs());   // P1-3
  if (showElapsed) {
    root.appendChild(pastTimeOverlay(center, s, SNAIL_INNER_RADIUS, elapsedThrough));
  }
  if (showElapsed) {
    patternCounter += 1;
    const patternId = `nautilus-log-unplanned-${patternCounter}`;
    root.appendChild(pastUnplannedOverlay(
      pastOccupiedEvents,
      center,
      s,
      SNAIL_INNER_RADIUS,
      elapsedThrough,
      patternId,
    ));
  }
  const slotTitle = (slot: { availableNow: boolean }): string => (slot.availableNow
    ? (copy.tooltips?.availableNow || "Available now")
    : (copy.tooltips?.available || "Available slot"));
  // 🔴 认证审计 C1-102：空闲层**只在 hover 可用（非紧凑）时**渲染
  //    （上游 component.cljs:1331-1332 `(and hover-enabled? (:showAvailableSlots …))`）。
  //    紧凑模式下这些靶区带 tabindex=0 却因为提前返回而没有任何 tooltip ⇒
  //    键盘用户会踩到一串毫无反馈的空焦点（与 P1-8 钉住的原则自相矛盾）。
  const freeLayer = hoverEnabled
    ? freeSlotLayer(
      freeSlots, center, s, SNAIL_INNER_RADIUS,
      (slot) => `${slotTitle(slot)} ${minutesToTime(slot.start)}–${minutesToTime(slot.end)} ${durationLabel(slot.duration)}`,
    )
    : { group: createSvg("g", { class: "nautilus-log-available-slots" }), targets: [] };
  root.appendChild(freeLayer.group);   // 在 slices 之前：实体切片压过靶区
  root.appendChild(sliceGroups);
  root.appendChild(snailBlueprintComponent(center, s, SNAIL_INNER_RADIUS, showElapsed, elapsedThrough));
  if (showNow) {
    root.appendChild(nowNeedleComponent(
      center,
      timelineMinute,
      `${copy.capacity?.now || "Current time"} ${minutesToTime(timelineMinute)}`,
    ));
  }
  root.appendChild(centralLabelComponent(
    center,
    showNow ? minutesToTime(timelineMinute) : null,
    centralFirstRow(resolvePageTitle(container, options.pageTitle)),   // P1-8
  ));

  svg.appendChild(root);
  container.appendChild(svg);
  // 紧凑日程清单：无条件渲染，显示与否交给 styles.css 的 @container 查询
  //   （同上游 component.cljs:1221）。🔴 少了它，窄容器下 slice-group 被
  //   CSS 隐藏、hover 又被关掉 => 侧栏里读不出任何精确时间。
  // 🔴 紧凑（侧栏）时默认【折叠】—— 上游 guide 中英两版都明写
  //    「keep the Schedule section folded」，实现见 component.cljs:1730
  //    `(reset! compact-list-open-state (not sidebar?))`（认证审计 G1-049）。
  renderCompactEventList(container, allEvents,
    copy as unknown as Parameters<typeof renderCompactEventList>[2], { open: !compact });

  // ── 紧凑模式 ──────────────────────────────────────────────────────────
  // 上游 guide：「Compact sidebar charts omit hover tooltips」——
  // 窄容器里浮层会被裁切、也没地方放，所以紧凑时直接不挂 hover。
  // 容器可能是精简的 DOM shim（测试里就是），classList/ownerDocument 都要兜住，
  // 不能因为环境缺一个 API 就把整张图带崩。
  container.classList?.[compact ? "add" : "remove"]("nautilus-log-compact");

  if (compact || !container.ownerDocument) {
    return { destroy() { /* 紧凑模式 / 无文档环境：没挂任何监听 */ } };
  }

  // ── 悬停提示 ──────────────────────────────────────────────────────────
  const tooltip = createTooltip(container);
  const targets: TooltipTarget[] = [];

  // 已渲染的切片：aria-label 已由渲染器写好，这里只取时间与文案。
  const sliceEls = Array.from(
    svg.querySelectorAll(".nautilus-log-event-slice-group"),
  );
  allEvents.forEach((ev, i) => {
    const el = sliceEls[i];
    if (!el) return;
    targets.push({
      el,
      startMinutes: ev.start,
      endMinutes: ev.end,
      lines: [
        truncate(ev.text, 60),
        `${minutesToTime(ev.start)}–${minutesToTime(ev.end)}`,
        durationLabel(ev.end - ev.start),
      ],
    });
  });

  // 空闲时段：整组共享文案，报【整段】时长而不是单个格子。
  for (const t of freeLayer.targets) {
    const slot = freeSlots[t.groupIndex];
    if (!slot) continue;
    targets.push({
      el: t.el,
      startMinutes: slot.start,
      endMinutes: slot.end,
      lines: [
        slotTitle(slot),
        `${minutesToTime(slot.start)}–${minutesToTime(slot.end)}`,
        durationLabel(slot.duration),
      ],
    });
  }

  tooltip.attach(targets, {
    centerX: center.x, centerY: center.y, radius: TOOLTIP_ANCHOR_RADIUS,   // P1-9①
  });

  return {
    destroy() { tooltip.destroy(); },
  };
}

/** 提示里的标题不该无限长；图例的 legendLenLimit 是给盘上用的，这里放宽一些。 */
function truncate(text: string, max: number): string {
  const t = text.replace(/^[-*+]\s*(\[[ xX]\]\s*)?/, "").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}
