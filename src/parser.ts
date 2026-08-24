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

const CHECKBOX_RE = /^-\s*\[( |x|X)\]\s*/;
const DONE_RE = /\[x\]/i;

/** Options the parser needs beyond the block text itself. */
export interface ParseOptions {
  /** Vault-relative path of the containing note; forms the uid prefix. */
  sourcePath: string;
  /** Resolved plugin settings (window + todoDuration + language-aware copy). */
  settings: NautilusSettings;
}

/** Strip the checkbox marker and any duration token from a raw task line,
 *  truncate the remainder to `descLength` glyphs for display. */
export function taskDescription(line: string, descLength: number): string {
  const { cleanedText } = logCore.parseDurationToken({ text: line });
  const description = cleanedText.replace(CHECKBOX_RE, '').trim();
  return logCore.truncateTextToWidth({ text: description, maxWidth: descLength });
}

function lineUid(sourcePath: string, lineIndex: number): LineId {
  return `${sourcePath}:${lineIndex}`;
}

export function parsePlan(source: string, options: ParseOptions): ParsedPlan {
  const { sourcePath, settings } = options;
  const schedule = logCore.normalizeScheduleSettings({
    startHour: settings.workdayStartHour,
    endHour: settings.workdayEndHour,
  });

  const events: FixedEvent[] = [];
  const tasks: FlexTask[] = [];
  const malformed: ParsedPlan['malformed'] = [];
  const lines = source.split('\n');

  for (let index = 0; index < lines.length; index += 1) {
    const text = lines[index].trim();
    if (!text) continue;
    const uid = lineUid(sourcePath, index);

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
      tasks.push({
        uid,
        string: text,
        duration: duration.minutes,
        done: DONE_RE.test(text),
      });
      continue;
    }

    malformed.push({ line: index, text, reason: 'Unrecognized line format' });
  }

  return { events, tasks, malformed };
}
