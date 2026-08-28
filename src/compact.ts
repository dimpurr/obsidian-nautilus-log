/*
 * compact.ts — 紧凑模式的替代内容 + 三个折叠面板。
 *
 * 补的是 `docs/parity-audit-2026-08-25.md` 的两条欠账：
 *
 *   §P1-4  紧凑模式没有任何替代内容 🔴
 *          上游窄容器下把螺旋盘的切片整片藏掉（styles.css:754 的
 *          `.nautilus-log-slice-group { display: none !important }`），换成两个
 *          `<details>`：`compact-event-list`（component.cljs:1221）与
 *          `compact-overview`（component.cljs:1638）。本移植此前只在
 *          `spiral.ts` 里加个 class 就 return ⇒ 侧栏里【读不出任何精确时间】
 *          （紧凑模式同时关掉了 hover tooltip）。
 *
 *   §P1-8  溢出面板降级（上游是可折叠 `<details>` 且带「总时长 · 条数」）、
 *          排期警告面板缺失（component.cljs:1691 `schedule-warning-panel`）。
 *          HTML 颜色图例见 `header.ts renderHtmlLegend`（同条欠账）。
 *
 * 🔴 类名一律照抄上游 —— `styles.css` 里那 28 条 `nautilus-log-compact-*`
 *    规则是整份从上游搬来的，自造类名等于白写一遍样式还对不上。
 *
 * ⚠️ 紧凑与否由 CSS 容器查询决定，**不是** JS：这些面板永远渲染，
 *    `@container (max-width: 520px)` 负责把它们从 `display:none` 打开。
 *    这与上游一致（上游同样无条件渲染 `compact-event-list`）。前置条件是块根
 *    必须有 `container-type: inline-size` —— 见 `header.ts enableContainerQueries`。
 *
 * 上游基线：404KSG/roam-nautilus-log @ 86b97c0
 */

import * as logCoreModule from "./vendor/log-core";
import type { Capacity, FlexTask, NautilusSettings } from "./contract";
import { stripTaskTokens } from "./parser";
import {
  appendPercentItem,
  appendReading,
  appendSeparator,
  appendSummaryItem,
  renderHtmlLegend,
  resolveCapacityMetrics,
} from "./header";

interface CompactCore {
  formatDuration(minutes: number): string;
}
const core = (logCoreModule as unknown) as CompactCore;

/** `logCore.uiCopy(language)` 的结果。 */
export type UiCopy = Record<string, Record<string, string>>;

/* ------------------------------------------------------------------ */
/* DOM / 格式化小工具                                                   */
/* ------------------------------------------------------------------ */

function el(tag: string, cls: string): HTMLElement {
  const node = document.createElement(tag);
  if (cls) node.setAttribute("class", cls);
  return node;
}

function appendTextChild(
  parent: HTMLElement,
  tag: string,
  cls: string,
  value?: string,
): HTMLElement {
  const node = el(tag, cls);
  if (value) node.textContent = value;
  parent.appendChild(node);
  return node;
}

function minutesToTime(minutes: number): string {
  const h = Math.floor((minutes / 60) % 24);
  const m = Math.floor(minutes % 60);
  return `${h < 10 ? `0${h}` : h}:${m < 10 ? `0${m}` : m}`;
}

function durationLabel(minutes: number): string {
  return core.formatDuration(minutes) || `${Math.max(0, Math.floor(minutes || 0))}m`;
}

/** 上游 `(if (= 1 count) :item :items)`。 */
function itemLabel(copy: UiCopy, count: number): string {
  const panels = copy?.panels || {};
  return count === 1 ? (panels.item || "item") : (panels.items || "items");
}

/** 折叠态宿主：单个面板的展开/收起状态，跨重渲染存活。
 *
 *  C2-075 / C2-085：侧栏与代码块每 60 秒 tick 一次会【整个】重渲染，`<details>`
 *  被重建 ⇒ 用户手动展开的面板 60 秒后又合上了（上游对应的是 Clojure atom
 *  `compact-list-open-state` / `compact-overview-open-state`，Component 重绘时显式
 *  读回）。宿主把状态存在调用方（main.ts / sidebar.ts 的 `Map`）而不是 DOM 里，
 *  重渲染时经 `options.state` 读回，展开态才活得下去。
 */
export interface CompactState {
  /** 这个面板在宿主 Map 里的键。同一宿主可塞多个面板，互不干扰。 */
  key: string;
  states: Map<string, boolean>;
}

/** 折叠面板骨架：`<details class=…><summary class=…>text</summary>`。
 *  ⚠️ 加了 toggle 监听后，这个 <details> 就【带着监听器】交给了调用方 ——
 *  宿主重渲染前必须把它从文档剥掉/换掉，不能长期挂着；`re-render 读回`靠的是
 *  `onToggle` 把展开态写回宿主，不是靠复用这个旧节点。 */
function makeDetails(
  detailsCls: string,
  summaryCls: string,
  open: boolean,
  onToggle?: (open: boolean) => void,
): { details: HTMLElement; summary: HTMLElement } {
  const details = el("details", detailsCls);
  if (open) details.setAttribute("open", "");
  const summary = el("summary", summaryCls);
  details.appendChild(summary);
  if (onToggle) {
    details.addEventListener("toggle", () => onToggle(details.hasAttribute("open")));
  }
  return { details, summary };
}

/** 行首列表标记 / 复选框。**只**用于警告面板的左栏（`describeWarning`）——
 *  标题清洗已经统一到 `parser.ts stripTaskTokens`（认证审计 L1-031）。 */
const LIST_MARKER_RE = /^\s*[-*+]\s*/;
const CHECKBOX_RE = /^\[[ xX/-]\]\s*/;

/** 把一行原文变成可读标题 —— 对齐上游事件上的 `:description`。
 *
 *  剥掉列表标记 / 复选框 / 时间段 token / 时长 token / 进度 / 完成锚点：时间与
 *  时长在这一行的 `<time>` 单元格里已经有了，紧凑列的宽度只够放标题本身。
 *  🔴 认证审计 L1-031 / P1-068：此前这里自写了 `TIME_RANGE_RE` + 一条**要求
 *  分钟、区分大小写**的 `dHH:MM` 正则，与 `parser.ts` 的解析正则不一致
 *  （`d14` 会被解析成锚点却剥不掉）。现在整条清洗都委托给
 *  `parser.ts stripTaskTokens` —— 全仓一份实现，盘上图例与紧凑列表同源。
 *  ⚠️ 只清理不截断：截断交给 CSS 的 text-overflow（`.nautilus-log-compact-title`
 *  本来就是单行省略号），不像盘上的图例那样按 descLength 硬截 —— 侧栏里读时间
 *  与标题是这个列表存在的唯一理由，能多显示一个字是一个字。 */
function cleanTitle(text: string): string {
  try {
    return stripTaskTokens(text);
  } catch {
    return String(text ?? "").trim();
  }
}

/* ------------------------------------------------------------------ */
/* §P1-4  compact event list（上游 component.cljs:1221-1249）            */
/* ------------------------------------------------------------------ */

/** 紧凑列表吃的事件。结构上是 `spiral.ts` 的 `RenderEvent` 的子集，
 *  所以可以直接把 `allEvents` 递进来，无需转换。 */
export interface CompactEvent {
  uid: string;
  text: string;
  start: number;
  end: number;
  done?: boolean;
  meeting?: boolean;
  urgent?: boolean;
  freetime?: boolean;
}

/** 上游 `compact-item-tone`：`bg-color` → urgent / `meeting` → event / 其余 task。
 *  ⚠️ 偏离：上游判的是事件上已经烘焙好的 `:bg-color` 字段；本移植的 `bgColor`
 *  是在切片渲染器【内部】算的、不挂在事件上，所以这里直接判 `urgent` 标志位 ——
 *  语义等价（上游只有紧急触发词会给事件染 bg-color）。 */
function compactItemTone(event: CompactEvent): "urgent" | "event" | "task" {
  if (event.urgent) return "urgent";
  if (event.meeting) return "event";
  return "task";
}

/**
 * `Schedule · N items` 折叠头 + 有序列表，每项 = 彩色圆点 / `HH:MM–HH:MM` /
 * 标题，已完成的加 `--done`（删除线 + 半透明）。
 *
 * 返回渲染出的 `<details>`；无可显示项时依然渲染（上游同样渲染空列表，
 * 折叠头会显示 `Schedule · 0 items`）。
 */
export function renderCompactEventList(
  parent: HTMLElement,
  events: CompactEvent[],
  copy: UiCopy,
  options: { open?: boolean; state?: CompactState } = {},
): HTMLElement {
  const items = (events || [])
    .filter((e) => e && e.freetime !== true
      && typeof e.start === "number" && Number.isFinite(e.start)
      && typeof e.end === "number" && Number.isFinite(e.end))
    .slice()
    .sort((a, b) => (a.start - b.start) || (a.end - b.end));

  const panels = copy?.panels || {};
  // C2-075：状态宿主在读回时优先；没有宿主才退回 `options.open` 的兜底。
  const stored = options.state?.states.get(options.state.key);
  const onToggle = options.state
    ? (open: boolean) => { options.state!.states.set(options.state!.key, open); }
    : undefined;
  const { details, summary } = makeDetails(
    "nautilus-log-compact-details",
    "nautilus-log-compact-summary",
    // 认证审计 G1-049：这条注释原先写着「上游侧栏默认展开」，**把上游语义写反了**：
    // 上游 `component.cljs:1730` 是 `(reset! compact-list-open-state (not sidebar?))`
    // —— 侧栏（紧凑）默认**折叠**，主视图才展开。默认值留作展开只是
    // 调用方不传时的兑底；真正的判据由 `spiral.ts` 传 `{open: !compact}`。
    stored !== undefined ? stored : options.open !== false,
    onToggle,
  );
  summary.textContent =
    `${panels.schedule || "Schedule"} · ${items.length} ${itemLabel(copy, items.length)}`;

  const list = el("ol", "nautilus-log-compact-list");
  list.setAttribute("aria-label", "Nautilus Logger scheduled items");
  for (const event of items) {
    const title = cleanTitle(event.text);
    const li = el(
      "li",
      `nautilus-log-compact-item${event.done ? " nautilus-log-compact-item--done" : ""}`,
    );
    li.setAttribute("title", title);
    const dot = el("i", `nautilus-log-compact-dot nautilus-log-compact-dot--${compactItemTone(event)}`);
    dot.setAttribute("aria-hidden", "true");
    li.appendChild(dot);
    appendTextChild(
      li, "time", "nautilus-log-compact-time",
      `${minutesToTime(event.start)}–${minutesToTime(event.end)}`,
    );
    appendTextChild(li, "span", "nautilus-log-compact-title", title);
    list.appendChild(li);
  }
  details.appendChild(list);
  parent.appendChild(details);
  return details;
}

/* ------------------------------------------------------------------ */
/* §P1-4  compact overview（上游 component.cljs:1638-1668）              */
/* ------------------------------------------------------------------ */

/**
 * 折叠概览。
 *
 * 🔴 照上游 `5464e9d` **之后**的行为：折叠头那一行放 canonical 的
 * planned / free-or-over / left 三段摘要，**展开的 body 里只有
 * Available / Events 两个读数 + 颜色图例**，不重复摘要。
 */
export function renderCompactOverview(
  parent: HTMLElement,
  capacity: Capacity,
  settings: NautilusSettings,
  nowMinutes: number,
  copy: UiCopy,
  options: { open?: boolean; state?: CompactState } = {},
): HTMLElement {
  const metrics = resolveCapacityMetrics(capacity, settings, nowMinutes);
  const planned = metrics.planned;
  const status = metrics.status;
  const warning = status.tone === "warning";
  const panels = copy?.panels || {};
  const overviewLabel = panels.overview || "Overview";

  // C2-085：状态宿主在读回时优先；没有宿主才退回 `options.open === true`。
  const stored = options.state?.states.get(options.state.key);
  const onToggle = options.state
    ? (open: boolean) => { options.state!.states.set(options.state!.key, open); }
    : undefined;
  const { details, summary } = makeDetails(
    `nautilus-log-compact-overview${warning ? " nautilus-log-compact-overview--warning" : ""}`,
    "nautilus-log-compact-summary nautilus-log-compact-overview-summary",
    stored !== undefined ? stored : options.open === true,   // 上游 compact-overview-open-state 默认 false
    onToggle,
  );
  summary.setAttribute(
    "aria-label",
    `${overviewLabel}. ${planned.value || ""} ${planned.summaryLabel || ""}. `
    + `${status.value || ""} ${status.summaryLabel || ""}. `
    + `${planned.percent || ""} ${planned.percentLabel || ""}`,
  );

  const content = el("span", "nautilus-log-compact-overview-summary-content");
  appendTextChild(content, "span", "nautilus-log-compact-overview-label", overviewLabel);
  appendSeparator(content);
  appendSummaryItem(content, planned);
  appendSeparator(content);
  appendSummaryItem(content, status);
  appendSeparator(content);
  appendPercentItem(content, planned);
  summary.appendChild(content);

  const body = el("div", "nautilus-log-compact-overview-body");
  const capacityRow = el("div", "nautilus-log-metrics-capacity");
  appendReading(capacityRow, metrics.available);
  appendReading(capacityRow, metrics.events);
  body.appendChild(capacityRow);
  renderHtmlLegend(body, copy);      // §P1-8 图例挂载点 2/2
  details.appendChild(body);

  parent.appendChild(details);
  return details;
}

/* ------------------------------------------------------------------ */
/* §P1-8  overflow panel（上游 component.cljs:1676-1689）                */
/* ------------------------------------------------------------------ */

/**
 * 「今日放不下」面板。相对现状的两处修复：
 *   · 变回可折叠的 `<details>`（现状是写死 `▼` 的普通 div，点不动）；
 *   · 折叠头补上 `unplacedMinutes` 总计 ——「放不下多少」比「有几条」更要紧。
 *
 * `renderTitle` 让调用方保留 MarkdownRenderer 那条路（溢出任务里的
 * `[[链接]]` / `#标签` 要是活的）；不传则退化为纯文本。
 * 🔴 项目符号交给 `<ul>` 自己出，不要塞进 markdown 字符串 —— 行首的 `· `
 *    会被 Markdown 当列表标记吃掉（现状 main.ts 注释里记着这个坑）。
 */
export function renderOverflowPanel(
  parent: HTMLElement,
  capacity: Capacity,
  copy: UiCopy,
  renderTitle?: (host: HTMLElement, task: FlexTask) => void,
): HTMLElement | null {
  const overflow = capacity?.overflowTasks || [];
  if (overflow.length === 0) return null;

  const panels = copy?.panels || {};
  const total = capacity.unplacedMinutes || 0;
  // 认证审计 L2-134 / C2-097：上游 `component.cljs:1682` 是个默认**折叠**的
  //   <details>（不写 :open）。此前硬编码 open ⇒ 溢出面板默认展开，与上游相反。
  //   改成默认折叠，与其余面板（compact-event-list / compact-overview）一致。
  const { details, summary } = makeDetails("nautilus-log-overflow-panel", "", false);
  summary.textContent = `${panels.overflow || "Unscheduled today"} · ${durationLabel(total)}`
    + ` · ${overflow.length} ${itemLabel(copy, overflow.length)}`;

  const list = el("ul", "");
  for (const task of overflow) {
    const li = el("li", "");
    const host = appendTextChild(li, "span", "");
    if (renderTitle) renderTitle(host, task);
    else host.textContent = cleanTitle(task.string);
    appendTextChild(li, "span", "nautilus-log-overflow-duration", durationLabel(task.duration));
    list.appendChild(li);
  }
  details.appendChild(list);
  parent.appendChild(details);
  return details;
}

/* ------------------------------------------------------------------ */
/* §P1-8  schedule warning panel（上游 component.cljs:1691-1702）         */
/* ------------------------------------------------------------------ */

/** 解析层产出的一条排期警告。
 *  ⚠️ 形状由另一条工作线（`ParsedPlan.warnings`）供给；本文件只渲染，
 *  且**字段不存在时安全降级**（见 `renderWarningPanel` 的 `?? []`）。 */
export interface PlanWarning {
  line?: number;
  uid?: string;
  code?: string;
  message?: string;
  /** 可选：出问题的那一行的正文。解析层给了就直接用（＝上游的
   *  `(:description event)`），没给则退回行号引用。 */
  text?: string;
}

/** 上游 `localized-warning`：上游拿中文原文当 key 做 case，本移植改用引擎的
 *  `warningCode`（`log-core.js:140` 目前只发 `sameTime`，`overnight` 由解析层
 *  自行判定），拿不到 code 时退回解析层给的 `message`。 */
function localizedWarning(warning: PlanWarning, copy: UiCopy): string {
  const table = copy?.warnings || {};
  const code = warning.code || "";
  if (code && table[code]) return table[code];
  // 上游是拿中文原文当 key 的，兼容之
  const raw = warning.message || "";
  if (raw === "连续到次日") return table.overnight || raw;
  if (raw === "开始时间与结束时间不能相同") return table.sameTime || raw;
  return raw;
}

/**
 * 排期警告折叠面板：跨午夜 / 起止时间相同这类问题。
 *
 * `plan` 只要求形状上有 `warnings` —— 没有这个字段（或还没接线）时
 * 一条不渲染、返回 null，绝不抛。
 */
export function renderWarningPanel(
  parent: HTMLElement,
  plan: { warnings?: PlanWarning[] } | null | undefined,
  copy: UiCopy,
): HTMLElement | null {
  const warnings = plan?.warnings ?? [];
  if (!Array.isArray(warnings) || warnings.length === 0) return null;

  const panels = copy?.panels || {};
  const { details, summary } = makeDetails("nautilus-log-warning-panel", "", false);
  summary.textContent = `${panels.warnings || "Schedule warnings"} · ${warnings.length}`
    + ` ${itemLabel(copy, warnings.length)}`;

  const list = el("ul", "");
  for (const warning of warnings) {
    const li = el("li", "");
    appendTextChild(li, "span", "", describeWarning(warning));
    appendTextChild(li, "span", "nautilus-log-warning-message", localizedWarning(warning, copy));
    list.appendChild(li);
  }
  details.appendChild(list);
  parent.appendChild(details);
  return details;
}

/** 左栏是「哪一行出的问题」。
 *  认证审计 C2-107：上游放的是 `(:description event)` ＝**任务标题**，
 *  `parser.ts` 现在会把它塞进 `warning.text`（此前从不产这个字段，
 *  于是这里恒走 `L12` 行号那条兜底，上游语义整个丢了）。
 *  没有 `text` 时仍退回 `uid`（`filepath:line`，见 PORTING-DECISIONS.md §1）
 *  的行号部分，再退回 `line` —— 别的调用方直接递原文也不会炸。 */
function describeWarning(warning: PlanWarning): string {
  // ⚠️ 这里【不】再清洗一遍：`text` 已经是解析层给的标题。调用方若直接递原文
  //    （测试里就有），只剥列表标记与复选框，其余原样保留。
  if (warning.text) {
    return String(warning.text)
      .replace(LIST_MARKER_RE, "")
      .replace(CHECKBOX_RE, "")
      .trim();
  }
  const fromUid = typeof warning.uid === "string" ? warning.uid.split(":").pop() : "";
  const line = warning.line ?? (fromUid ? Number(fromUid) : NaN);
  return Number.isFinite(line) ? `L${Number(line) + 1}` : "—";
}
