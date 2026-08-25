/*
 * THE CONTRACT — pinned data shapes shared by every module.
 *
 * This file exists so that the parser, the renderer, the panel and the styles
 * can be built independently against a fixed interface.  Everything here is
 * dictated by what the vendored upstream engine (`src/vendor/log-core.js`)
 * already expects; do not "improve" a field name without checking the engine.
 *
 * Upstream baseline: 404KSG/roam-nautilus-log @ 7bf19a1d
 */

/** Minutes since midnight of the plan's own day. May exceed 1440 when the
 *  chart window runs past midnight (e.g. 21:00–02:00 => end = 1560). */
export type DayMinutes = number;

/** Opaque, stable-within-a-render identity for one plan line.
 *  Roam used `:block/uid`; we use `"<vault-relative-path>:<0-based line>"`.
 *  The engine only ever uses this for Set membership and sort tie-breaks —
 *  never parse it or derive meaning from it. */
export type LineId = string;

/** A line with an explicit clock range: `12:30-14:00 Lunch`.
 *  `meeting: true` is REQUIRED — `normalizedInterval()` returns null without it. */
export interface FixedEvent {
  uid: LineId;
  string: string;          // full original line text, trigger tokens included
  start: DayMinutes;
  end: DayMinutes;
  meeting: true;
  done: boolean;
}

/** A flexible task: an unchecked list item, optionally carrying `45m` / `1h30m`.
 *  `duration` is ALREADY the estimate in minutes (fallback applied by parser). */
export interface FlexTask {
  uid: LineId;
  string: string;
  duration: number;        // minutes, > 0
  done: boolean;
  /** 完成度百分比，0–100 整数。来自 `d50%` token（audit §P1-3）。
   *  🔴 语义：`duration` 仍然是【原始估计】，progress 折减的是【剩余时长】，
   *  由引擎的 `log-core.js remainingDuration()`（:606-614）自己算：
   *      remaining = round(duration * (1 - progress/100))
   *  ⇒ 解析器必须喂【未折减的 duration + progress】，不要自己先乘好再喂，
   *    否则会被引擎二次折减（0.5 × 0.5 = 0.25）。 */
  progress?: number;
  urgent?: boolean;        // matched the urgent trigger word — colour only
  /** 完成时刻（当日分钟数）。来自 `d18:21` / `d18`（整点）这样的锚点，见 §D8。
   *  🔴 已完成任务【没有它就画不出来】—— historicalDoneSlice() 拿不到结束时刻
   *  会直接返回 null，引擎拒绝编造它没被告知的历史。 */
  doneAt?: DayMinutes;
}

/** 一条时间段告警。来自 `logCore.parseTimeRangeToken().warningCode`（audit §P1-8：
 *  此前 parser 三处调用把它全丢了）。`message` 已按 settings.language 本地化，
 *  取自引擎自己的 `uiCopy(lang).warnings[code]` —— 不要另写一份文案。
 *  🔴 解析器只负责把数据带出来，警告面板的渲染不在本文件的职责内。 */
export interface PlanWarning {
  /** 计划正文内的 0 起行号，与 malformed[].line 同一坐标系。 */
  line: number;
  uid: LineId;
  /** 引擎的原始码。当前 vendor 只会发 `'sameTime'`
   *  （已查：`src/vendor/log-core.js` 全文 `warningCode` 仅 :140 一处；
   *  `'overnight'` 只存在于 uiCopy 文案表，本版引擎不发）。 */
  code: string;
  /** 本地化后的可读文案；引擎文案表里查不到该 code 时回落成 code 本身。 */
  message: string;
}

/** What the code-block parser hands to the engine and the renderer. */
export interface ParsedPlan {
  events: FixedEvent[];
  tasks: FlexTask[];       // ORDER IS PRIORITY — do not sort
  malformed: { line: number; text: string; reason: string }[];
  /** 时间段告警（audit §P1-8）。永远是数组，没有告警时为空数组 —— 消费方不必判空。 */
  warnings: PlanWarning[];
}

/** Mirrors the 8 base settings upstream exposes, plus the 5 execution-layer
 *  settings. `actualTimeTracking` is the master switch: while it is off the
 *  four settings below it are not revealed in the settings tab. */
export interface NautilusSettings {
  language: "en" | "zh";
  workdayStartHour: number;   // 0..23
  workdayEndHour: number;     // 1..24; <= start means "next day"
  descLength: number;         // 15..30
  todoDuration: number;       // 5..60, fallback for untimed tasks
  urgentTrigger: string;      // "" disables
  // ── Execution layer ──
  actualTimeTracking: boolean;    // master switch; off hides the 4 below
  timingLineSidebar: boolean;     // Clock In pins current task to right sidebar
  pomodoroMinutes: number;        // pomodoro threshold; 0 = off, never stops work
  recentRetentionMinutes: number; // Recent retention; 0 = off
  forgottenTimerMinutes: number;  // forgotten-timer warning; 0 = off, warn only
}

export const DEFAULT_SETTINGS: NautilusSettings = {
  language: "en",
  workdayStartHour: 5,
  workdayEndHour: 21,
  descLength: 22,
  todoDuration: 15,
  urgentTrigger: "",
  actualTimeTracking: false,
  timingLineSidebar: true,
  pomodoroMinutes: 45,
  recentRetentionMinutes: 45,
  forgottenTimerMinutes: 120,
};

/** capacityMetrics 返回的单项。`percent`/`percentLabel` 就是上游的 `left` 百分比。 */
export interface CapacityMetric {
  key: string;
  label: string;
  value: string;
  summaryLabel?: string;
  percent?: string;
  percentLabel?: string;
  percentTone?: string;
  tone?: string;
}

/** Shape returned by the vendored `calculateCapacity()`. Field names are the
 *  engine's, not ours. */
export interface Capacity {
  availableMinutes: number;
  demandMinutes: number;
  overloadMinutes: number;
  slackMinutes: number;
  unplacedMinutes: number;
  fixedMinutes: number;
  totalAvailableMinutes: number;
  totalFixedMinutes: number;
  burningBucket: unknown;
  scheduledTasks: (FlexTask & { start: DayMinutes; end: DayMinutes })[];
  overflowTasks: FlexTask[];
}

/** The vendored engine, loaded as CommonJS. Only the seams we actually use are
 *  typed; the module exports ~40 functions. */
export interface LogCore {
  calculateCapacity(args: {
    startMinutes: DayMinutes;
    endMinutes: DayMinutes;
    nowMinutes: DayMinutes;
    fixedEvents?: FixedEvent[];
    allFixedEvents?: FixedEvent[];
    pendingTasks?: FlexTask[];
  }): Capacity;
  scheduleTasks(args: {
    startMinutes: DayMinutes;
    endMinutes: DayMinutes;
    nowMinutes: DayMinutes;
    tasks?: FlexTask[];
    fixedEvents?: FixedEvent[];
    // 🔴 2026-08-25 收紧：`scheduledTasks` 原本写成 unknown[]，因为当初本移植
    //    从不直接调这个函数（只用 calculateCapacity 内部算好的那份）。P0-5 之后
    //    要拿它的结果去画盘，形状必须钉死 —— 它与 Capacity.scheduledTasks 同构。
  }): { scheduledTasks: (FlexTask & { start: DayMinutes; end: DayMinutes })[]; overflowTasks: FlexTask[] };
  /* ⚠️ 2026-08-24 修正：这两个返回的是【对象】，不是标量。
   *    初版契约把 parseDurationToken 写成 `number | null` —— 错的，实测：
   *      parseDurationToken({text:'写简报 45m'})
   *        => { minutes: 45, token: '45m', cleanedText: '写简报' }
   *      parseTimeRangeToken({text:'12:30-14:00 午饭', windowStartMinutes:300, windowEndMinutes:1260})
   *        => { start: 750, end: 840, token: '12:30-14:00', cleanedText: '午饭', warningCode: '' }
   *    `cleanedText` 是剥掉 token 后的正文 —— 渲染图例时该用它，别自己再写一遍剥离逻辑。 */
  parseDurationToken(args: { text?: string; fallback?: number }):
    { minutes: number; token: string; cleanedText: string } | null;
  parseTimeRangeToken(args: {
    text?: string;
    windowStartMinutes?: DayMinutes;
    windowEndMinutes?: DayMinutes;
  }): { start: DayMinutes; end: DayMinutes; token: string; cleanedText: string; warningCode: string } | null;
  normalizeScheduleSettings(args: { startHour: number; endHour: number }): {
    startHour: number; endHour: number;
    startMinutes: DayMinutes; endMinutes: DayMinutes;
  };
  /* ⚠️ 2026-08-24 二次修正：又一个「照契约猜返回值」会栽的地方。
   *    capacityMetrics 收的是【解构对象】，不是 (capacity, settings)：
   *      capacityMetrics({ capacity, language })
   *        => { planned:{label,value,percent,percentLabel,percentTone,tone}, status, available, events }
   *    传成两个位置参数不会报错，但所有数值都变成 0m / 0% —— 静默错，最难查。 */
  capacityMetrics(args: { capacity: Capacity; language?: string }): {
    planned: CapacityMetric;
    status: CapacityMetric;
    available: CapacityMetric;
    events: CapacityMetric;
  };
  /* 🔴 formatCapacitySummary 收裸 capacity，且【硬编码中文、没有 i18n】
   *    （上游疏漏）。英文界面下会冒出中文，别拿它做面向用户的文案。 */
  formatCapacitySummary(capacity: Capacity): string;
  formatDuration(minutes: number): string;
  uiCopy(language: string): Record<string, Record<string, string>>;
  [k: string]: unknown;
}
