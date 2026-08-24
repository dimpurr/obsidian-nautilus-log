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

const MOBILE = false;
const SNAIL_SCALER = 1;
const FONT_SIZE = MOBILE ? 12 : 14;
const FONT_FAMILY =
  "'方正屏显雅宋简体', 'FZPingXianYaSong-R-GBK', 'PingFang SC', 'Microsoft YaHei', sans-serif";
const RECT_WIDTH_COEF = 1.55;
const RECT_HEIGHT_COEF = 1.15;
const RESERVE = 15;
const BENT_LINE_GAP = 5;
const STARTING_DISTANCE = 30;
const TRIES_THRESHOLD = 25;

/** The spiral's radius profile: 5 empty cells, the outer ring, then the taper. */
const SNAIL_BLUEPRINT_OUTER_RADII: number[] = [
  0, 0, 0, 0, 0,
  135, 140, 145, 150,
  145, 140, 135, 130, 125, 120, 115, 110, 105, 100, 95, 90, 85, 80, 75, 70,
  68, 66, 64, 62,
];
const SNAIL_INNER_RADIUS = 50 * SNAIL_SCALER;

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
}

function renderSlice(opts: SliceOptions): Element {
  const {
    startAngle, endAngle, innerRadius, outerRadius, center, settings,
    bgColor, borderColor, legendColor, legendRect,
    text, strokeDasharray, fontWeight, done,
    taskStartMin, taskEndMin, past, timestamp,
  } = opts;

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

  group.appendChild(createSvg("path", {
    d: path,
    class: "nautilus-log-slice",
    "stroke-dasharray": resolvedDash,
    fill: resolvedBg,
    stroke: resolvedBorder,
  }));

  if (text) {
    const legendGroup = createSvg("g", { class: "nautilus-log-slice-group" });
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

function centralLabelComponent(
  center: Point,
  centerNowLabel: string | null,
): Element {
  const common = { x: center.x, "text-anchor": "middle", "dominant-baseline": "central" };
  const group = createSvg("g", { class: "nautilus-log-center-date" });
  // First row is the page title / date (rendered by the panel host, if any).
  group.appendChild(createSvg("text", {
    ...common,
    y: center.y - 2,
    fill: "var(--nautilus-log-text-main)",
    "font-weight": "bold",
    "font-size": FONT_SIZE * 0.85,
  }, ""));
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
): Element {
  const params = calculateSliceParams(event, elapsedPage, interactive, timelineMinute, settings);
  const { bgColor, legendColor, done, meeting, current, pastStatus } = params;
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

  let groupClass = meeting
    ? "nautilus-log-event-slice-group"
    : "nautilus-log-task-slice-group";
  if (pastStatus === "completed") groupClass += " nautilus-log-past--completed";
  else if (pastStatus === "event") groupClass += " nautilus-log-past--event";
  if (conflict) groupClass += " nautilus-log-event-conflict";
  if (current) groupClass += " nautilus-log-current-task";

  const attrs: Record<string, string | number> = {
    class: groupClass,
    "data-past-status": pastStatus ?? "",
    "aria-label": ariaLabel,
    role: "img",
    tabindex: 0,
    focusable: "true",
  };
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
  /** 回放中的时刻；给了就用它当"当前时刻"画针与流逝区。 */
  playbackMinute?: number | null;
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
  const timelineMinute = effectiveNow;
  const elapsedThrough = clamp(effectiveNow, workdayStart, workdayEnd);
  const showElapsed = true;
  const interactive = true;
  const showNow = effectiveNow >= workdayStart && effectiveNow < workdayEnd;

  // Fixed events stay visible even after they have passed; flexible work is
  // already scheduled by the engine and handed to us via `capacity`.
  const fixedEvents: RenderEvent[] = plan.events
    .filter((e) => e.end > workdayStart && e.start < workdayEnd)
    .map((e) => ({
      uid: e.uid,
      text: e.string,
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
    text: t.string,
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
  const doneEvents: RenderEvent[] = (showDone ? plan.tasks : [])
    .filter((t) => t.done)
    .map((t) => {
      const slice = core.historicalDoneSlice({
        done: true,
        doneAt: t.doneAt,
        duration: t.duration,
        defaultDuration: s.defaultDuration,
      });
      if (!slice) return null;
      return {
        uid: t.uid,
        text: t.string,
        start: Math.max(workdayStart, slice.start),
        end: Math.min(workdayEnd, slice.end),
        done: true,
        meeting: false,
        todo: true,
        progress: 0,
      } as RenderEvent;
    })
    .filter((e): e is RenderEvent => e !== null && e.start < e.end);

  const allEvents = fixedEvents.concat(taskEvents, doneEvents);

  const initialWidth = container.clientWidth || 600;
  const initialHeight = container.clientHeight || 800;
  const initialCenter = { x: initialWidth / 2, y: initialHeight / 2 };

  const [centerX, suggestedWidth, centerY, suggestedHeight] =
    eventsToNewDimensions(allEvents, initialCenter, s);
  const center = { x: centerX, y: centerY };

  const { group: sliceGroups } = eventsToSlices(
    allEvents,
    showElapsed,
    interactive,
    timelineMinute,
    center,
    s,
    copy,
    [],
  );

  const svg = createSvg("svg", {
    viewBox: `0 0 ${suggestedWidth} ${suggestedHeight}`,
    width: "100%",
    xmlns: "http://www.w3.org/2000/svg",
    class: "nautilus-log-svg",
    "font-family": FONT_FAMILY,
    "font-size": FONT_SIZE,
    style: { "max-width": `${suggestedWidth}px` },
  });

  const root = createSvg("g");
  if (showElapsed) {
    root.appendChild(pastTimeOverlay(center, s, SNAIL_INNER_RADIUS, elapsedThrough));
  }
  if (showElapsed) {
    patternCounter += 1;
    const patternId = `nautilus-log-unplanned-${patternCounter}`;
    root.appendChild(pastUnplannedOverlay(
      allEvents,
      center,
      s,
      SNAIL_INNER_RADIUS,
      elapsedThrough,
      patternId,
    ));
  }
  root.appendChild(sliceGroups);
  root.appendChild(snailBlueprintComponent(center, s, SNAIL_INNER_RADIUS, showElapsed, elapsedThrough));
  if (showNow) {
    root.appendChild(nowNeedleComponent(
      center,
      timelineMinute,
      `${copy.capacity?.now || "Current time"} ${minutesToTime(timelineMinute)}`,
    ));
  }
  root.appendChild(centralLabelComponent(center, showNow ? minutesToTime(timelineMinute) : null));

  svg.appendChild(root);
  container.appendChild(svg);

  // ── 紧凑模式 ──────────────────────────────────────────────────────────
  // 上游 guide：「Compact sidebar charts omit hover tooltips」——
  // 窄容器里浮层会被裁切、也没地方放，所以紧凑时直接不挂 hover。
  const width = container.clientWidth || initialWidth;
  const compact = core.isCompactChartWidth(width);
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
    svg.querySelectorAll(".nautilus-log-event-slice-group, .nautilus-log-task-slice-group"),
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

  tooltip.attach(targets, {
    centerX: center.x, centerY: center.y, radius: SNAIL_INNER_RADIUS,
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
