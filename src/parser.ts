/*
 * Code-block parser for Nautilus Log on Obsidian.
 *
 * Turns the self-contained ```nautilus block into a ParsedPlan (see
 * src/contract.ts).  Time and duration tokens are NOT parsed here — they are
 * delegated to the vendored engine so the parser can never drift from the
 * engine's own token grammar.
 *
 * Block grammar (line order = priority, never sorted):
 *   - a line carrying a clock range  -> FixedEvent (meeting: true)
 *   - a `- [ ]` / `- [x]` list item  -> FlexTask, optional `45m` / `1h30m`
 *   - anything else non-empty        -> ParsedPlan.malformed (never dropped)
 */

import type {
  ParsedPlan,
  FixedEvent,
  FlexTask,
  LineId,
  DayMinutes,
  NautilusSettings,
} from './contract';

/** The small slice of the vendored engine this parser touches. The runtime
 *  return shapes are the engine's own (parseDurationToken yields an object,
 *  not a bare number), so they are typed here rather than via the contract's
 *  looser LogCore seam. */
const logCore = require('./vendor/log-core') as unknown as {
  parseDurationToken(args: {
    text?: string;
    fallback?: number;
  }): { minutes: number; token: string; cleanedText: string };
  parseTimeRangeToken(args: {
    text?: string;
    windowStartMinutes?: number;
    windowEndMinutes?: number;
  }): {
    start: number;
    end: number;
    token: string;
    cleanedText: string;
  } | null;
  normalizeScheduleSettings(args: {
    startHour: number;
    endHour: number;
  }): { startMinutes: number; endMinutes: number };
  truncateTextToWidth(args: { text: string; maxWidth: number }): string;
};

const CHECKBOX_RE = /^[-*+]\s*\[( |x|X)\]\s*/;
/** 裸列表标记（无复选框）。事件行推荐写成 `- 08:30-09:30 起床`，
 *  与 `- [ ]` 在阅读模式下缩进一致；不写 `- ` 也仍然接受。 */
const LIST_MARKER_RE = /^[-*+]\s+/;
/** 完成时刻锚点：`d18:21`（沿用上游 Todo Trigger 的写法）。
 *  没有它，已完成任务无法落到盘上 —— 见 contract.ts FlexTask.doneAt。 */
const DONE_AT_RE = /(?:^|\s)d(\d{1,2}):(\d{2})(?=\s|$)/i;
const DONE_RE = /\[x\]/i;

/** Options the parser needs beyond the block text itself. */
export interface ParseOptions {
  /** Vault-relative path of the containing note; forms the uid prefix. */
  sourcePath: string;
  /** Resolved plugin settings (window + todoDuration + language-aware copy). */
  settings: NautilusSettings;
  /** 计划正文在文件中的起始行号（0 起）。方案 5 下计划来自代码块【之后】的
   *  兄弟行，uid 必须用真实行号，否则跨块会撞 uid、点击定位也会跳错行。 */
  lineOffset?: number;
}

/** Strip the checkbox marker and any duration token from a raw task line,
 *  truncate the remainder to `descLength` glyphs for display. */
export function taskDescription(line: string, descLength: number): string {
  const { cleanedText } = logCore.parseDurationToken({ text: line });
  // 先剥复选框，再剥裸列表标记 —— 否则 `- 08:30-09:30 起床` 的图例会带着 "- "。
  const description = cleanedText
    .replace(CHECKBOX_RE, '')
    .replace(LIST_MARKER_RE, '')
    .replace(DONE_AT_RE, '')
    .trim();
  return logCore.truncateTextToWidth({ text: description, maxWidth: descLength });
}

function lineUid(sourcePath: string, lineIndex: number): LineId {
  return `${sourcePath}:${lineIndex}`;
}


/** 单个时刻 token（不是区间）：`09:00` / `9:30` / `9am` / `9 pm`。
 *  🔴 故意【不】接受裸数字（`9`）—— 那和「第 9 章」「9 个」无法区分，会把普通
 *  任务误判成固定事件。必须带冒号或 am/pm 才算表达了时刻意图。
 *  与引擎 clockTokenMinutes 的可接受集合保持一致（它未导出，无法直接复用）。 */
const START_TIME_RE = /(?:^|\s)(\d{1,2}:\d{1,2}(?:\s*(?:am|pm))?|\d{1,2}\s*(?:am|pm))(?=\s|$)/i;

/** `09:00` + 30m => 合成区间字符串交给引擎解析。
 *  自己算分钟数会与引擎的 am/pm、跨午夜对齐逻辑漂移，所以只负责【找 token】，
 *  解释与窗口对齐一律回交 parseTimeRangeToken。 */
function pinnedRange(
  text: string,
  durationMinutes: number,
  startMinutes: number,
  endMinutes: number,
): { start: number; end: number } | null {
  const token = START_TIME_RE.exec(text)?.[1];
  if (!token) return null;
  const probe = logCore.parseTimeRangeToken({
    text: `${token}-${token}`,
    windowStartMinutes: startMinutes,
    windowEndMinutes: endMinutes,
  });
  if (!probe) return null;
  const h = Math.floor(probe.start / 60);
  const m = probe.start % 60;
  const endTotal = probe.start + Math.max(1, durationMinutes);
  const eh = Math.floor(endTotal / 60) % 24;
  const em = endTotal % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return logCore.parseTimeRangeToken({
    text: `${pad(h)}:${pad(m)}-${pad(eh)}:${pad(em)}`,
    windowStartMinutes: startMinutes,
    windowEndMinutes: endMinutes,
  });
}

export function parsePlan(source: string, options: ParseOptions): ParsedPlan {
  const { sourcePath, settings } = options;
  const lineOffset = options.lineOffset ?? 0;
  const schedule = logCore.normalizeScheduleSettings({
    startHour: settings.workdayStartHour,
    endHour: settings.workdayEndHour,
  });

  const events: FixedEvent[] = [];
  const tasks: FlexTask[] = [];
  const malformed: ParsedPlan['malformed'] = [];
  const lines = source.split('\n');

  // 计划正文的【顶层缩进】：以第一条非空行为准。比它更深的行是【子项】，
  // 不参与排程 —— 与上游一致（上游只 pull 直接子块，嵌套块连读都不读）。
  //
  // 为什么这样设计（上游没写，但从行为能反推）：
  //  · 双重计入：`写周报 60m` 下挂 `收集数据 20m` + `画图 20m`，
  //    平铺会算成 100m，而真实需求是 60m。上游直接规避了这个问题。
  //  · 优先级＝行序：平铺列表的顺序无歧义，树没有（深度优先还是广度优先？）。
  //  · 子项是「怎么做」，父项才是「排什么」——可调度的单位是父项。
  let baseIndent: number | null = null;
  for (const raw of lines) {
    if (raw.trim()) { baseIndent = raw.length - raw.trimStart().length; break; }
  }

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    const text = raw.trim();
    if (!text) continue;
    const indent = raw.length - raw.trimStart().length;
    if (baseIndent !== null && indent > baseIndent) continue;   // 子项：跳过
    const uid = lineUid(sourcePath, lineOffset + index);

    const range = logCore.parseTimeRangeToken({
      text,
      windowStartMinutes: schedule.startMinutes,
      windowEndMinutes: schedule.endMinutes,
    });
    if (range) {
      events.push({
        uid,
        string: text,
        start: range.start as DayMinutes,
        end: range.end as DayMinutes,
        meeting: true,
        done: DONE_RE.test(text),
      });
      continue;
    }

    if (CHECKBOX_RE.test(text)) {
      const duration = logCore.parseDurationToken({
        text,
        fallback: settings.todoDuration,
      });
      // 只写了开始时刻（`- [ ] 09:00 写周报 30m`）=> 视为钉死的事件。
      // 写了时刻就是表达「这件事就在这个点」，没写时长则用默认时长。
      const pinned = pinnedRange(text, duration.minutes, schedule.startMinutes, schedule.endMinutes);
      if (pinned) {
        events.push({
          uid,
          string: text,
          start: pinned.start as DayMinutes,
          end: pinned.end as DayMinutes,
          meeting: true,
          done: DONE_RE.test(text),
        });
        continue;
      }
      const anchor = DONE_AT_RE.exec(text);
      const anchorMinutes = anchor
        ? Number(anchor[1]) * 60 + Number(anchor[2])
        : null;
      tasks.push({
        uid,
        string: text,
        duration: duration.minutes,
        done: DONE_RE.test(text),
        ...(anchorMinutes !== null && anchorMinutes < 1440
          ? { doneAt: anchorMinutes as DayMinutes }
          : {}),
      });
      continue;
    }

    malformed.push({ line: index, text, reason: 'Unrecognized line format' });
  }

  return { events, tasks, malformed };
}
