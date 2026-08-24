var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __commonJS = (cb, mod) => function __require() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/vendor/log-core.js
var require_log_core = __commonJS({
  "src/vendor/log-core.js"(exports2, module2) {
    var START_HOURS = Object.freeze(Array.from({ length: 24 }, (_value, hour) => hour));
    var END_HOURS = Object.freeze(Array.from({ length: 24 }, (_value, index) => index + 1));
    var DURATION_TOKEN_RE = /(?:^|\s)(\d+h(?:\d+(?:min|m))?|\d+(?:min|m))(?=\s|$)/i;
    var TIME_RANGE_TOKEN_RE = /(?:^|\s)(\d{1,2}(?::\d{1,2})?(?:\s*(?:am|pm))?\s*(?:-|–|až|to)\s*\d{1,2}(?::\d{1,2})?(?:\s*(?:am|pm))?)(?=\s|$)/i;
    function asNumber(value) {
      if (value === "" || value === null || value === void 0)
        return NaN;
      const number = Number(value);
      return Number.isFinite(number) ? number : NaN;
    }
    function asTimestamp(value) {
      if (value instanceof Date) {
        const timestamp = value.getTime();
        return Number.isFinite(timestamp) ? timestamp : NaN;
      }
      const numeric = asNumber(value);
      if (Number.isFinite(numeric))
        return numeric;
      if (typeof value !== "string")
        return NaN;
      const parsed = Date.parse(value);
      return Number.isFinite(parsed) ? parsed : NaN;
    }
    function cleanParsedText(text, token) {
      if (!token)
        return String(text ?? "");
      return String(text ?? "").replace(token, "").replace(/\s+/g, " ").trim();
    }
    function parseDurationToken({ text = "", fallback = 15 } = {}) {
      const source = String(text ?? "");
      const match = DURATION_TOKEN_RE.exec(source);
      if (!match) {
        return {
          minutes: Math.max(0, Math.round(asNumber(fallback) || 0)),
          token: "",
          cleanedText: source
        };
      }
      const token = match[1];
      const hours = Number(/(\d+)h/i.exec(token)?.[1] || 0);
      const minutes = Number(/(\d+)(?:min|m)/i.exec(token)?.[1] || 0);
      return {
        minutes: hours * 60 + minutes,
        token,
        cleanedText: cleanParsedText(source, token)
      };
    }
    function clockTokenMinutes(value, inheritedPeriod = null) {
      const match = /^\s*(\d{1,2})(?::(\d{1,2}))?\s*(am|pm)?\s*$/i.exec(String(value ?? ""));
      if (!match)
        return null;
      let hour = Number(match[1]);
      const minute = Number(match[2] || 0);
      const explicitPeriod = match[3]?.toLowerCase() || null;
      const period = explicitPeriod || inheritedPeriod;
      if (minute > 59)
        return null;
      if (period) {
        if (hour < 1 || hour > 12)
          return null;
        hour = hour % 12 + (period === "pm" ? 12 : 0);
      } else if (hour > 23)
        return null;
      return { minutes: hour * 60 + minute, explicitPeriod };
    }
    function intervalOverlap(start, end, windowStart, windowEnd) {
      return Math.max(0, Math.min(end, windowEnd) - Math.max(start, windowStart));
    }
    function alignIntervalToWindow({ start, end, windowStart, windowEnd } = {}) {
      const intervalStart = asNumber(start);
      const intervalEnd = asNumber(end);
      const rangeStart = asNumber(windowStart);
      const rangeEnd = asNumber(windowEnd);
      if (!Number.isFinite(intervalStart) || !Number.isFinite(intervalEnd) || intervalEnd <= intervalStart || !Number.isFinite(rangeStart) || !Number.isFinite(rangeEnd) || rangeEnd <= rangeStart) {
        return { start: intervalStart, end: intervalEnd };
      }
      const candidates = [0, 1440].map((shift) => ({
        start: intervalStart + shift,
        end: intervalEnd + shift
      }));
      const ranked = candidates.map((candidate) => ({
        ...candidate,
        overlap: intervalOverlap(candidate.start, candidate.end, rangeStart, rangeEnd),
        distance: Math.abs(candidate.start - rangeStart)
      })).sort((left, right) => right.overlap - left.overlap || left.distance - right.distance);
      const best = ranked[0];
      return best.overlap > 0 ? { start: best.start, end: best.end } : { start: intervalStart, end: intervalEnd };
    }
    function parseTimeRangeToken({
      text = "",
      windowStartMinutes,
      windowEndMinutes
    } = {}) {
      const source = String(text ?? "");
      const token = TIME_RANGE_TOKEN_RE.exec(source)?.[1];
      if (!token)
        return null;
      const parts = token.split(/\s*(?:-|–|až|to)\s*/i);
      if (parts.length !== 2)
        return null;
      const end = clockTokenMinutes(parts[1]);
      const start = clockTokenMinutes(parts[0], end?.explicitPeriod || null);
      if (!start || !end)
        return null;
      const sameTime = end.minutes === start.minutes;
      const continuousEnd = sameTime ? start.minutes : end.minutes > start.minutes ? end.minutes : end.minutes + 1440;
      const aligned = sameTime ? { start: start.minutes, end: continuousEnd } : alignIntervalToWindow({
        start: start.minutes,
        end: continuousEnd,
        windowStart: windowStartMinutes,
        windowEnd: windowEndMinutes
      });
      return {
        start: aligned.start,
        end: aligned.end,
        token,
        cleanedText: cleanParsedText(source, token),
        warningCode: sameTime ? "sameTime" : ""
      };
    }
    function normalizeHour(value, options, fallback) {
      const hour = asNumber(value);
      return options.includes(hour) ? hour : fallback;
    }
    function normalizeScheduleSettings({ startHour, endHour, workdayStart, workdayEnd } = {}) {
      const normalizedStart = normalizeHour(
        startHour === void 0 ? workdayStart : startHour,
        START_HOURS,
        5
      );
      const normalizedEnd = normalizeHour(
        endHour === void 0 ? workdayEnd : endHour,
        END_HOURS,
        21
      );
      const startMinutes = normalizedStart * 60;
      const endMinutes = (normalizedEnd <= normalizedStart ? normalizedEnd + 24 : normalizedEnd) * 60;
      return {
        startHour: normalizedStart,
        endHour: normalizedEnd,
        startMinutes,
        endMinutes
      };
    }
    function rendererArgumentValues(args) {
      let values = Array.isArray(args) ? args.slice() : [];
      while (values.length === 1 && Array.isArray(values[0]))
        values = values[0].slice();
      return values;
    }
    function runtimeOrFallback(runtime, key, fallback) {
      const value = runtime && runtime[key];
      return value === void 0 || value === null ? fallback : value;
    }
    function boundedInteger(value, min, max, fallback) {
      const number = asNumber(value);
      return Number.isInteger(number) && number >= min && number <= max ? number : fallback;
    }
    function resolveRendererSettings({ runtime = {}, args = [] } = {}) {
      const [argLength, argDuration, argStart, argTrigger, argEnd] = rendererArgumentValues(args);
      const schedule = normalizeScheduleSettings({
        startHour: runtimeOrFallback(runtime, "workday-start", argStart),
        endHour: runtimeOrFallback(runtime, "workday-end", argEnd)
      });
      const trigger = runtimeOrFallback(runtime, "color-1-trigger", argTrigger);
      return {
        "legend-len-limit": boundedInteger(
          runtimeOrFallback(runtime, "desc-length", argLength),
          15,
          30,
          22
        ),
        "default-duration": boundedInteger(
          runtimeOrFallback(runtime, "todo-duration", argDuration),
          5,
          60,
          15
        ),
        "workday-start": schedule.startMinutes,
        "workday-end": schedule.endMinutes,
        "workday-start-hour": schedule.startHour,
        "workday-end-hour": schedule.endHour,
        "custom-color-1-tag": trigger === void 0 || trigger === null ? "" : String(trigger),
        language: runtime.language === "zh" ? "zh" : "en"
      };
    }
    function hourlyGridSegments({ startMinutes, endMinutes } = {}) {
      const start = asNumber(startMinutes);
      const end = asNumber(endMinutes);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start)
        return [];
      const segments = [];
      for (let minute = start; minute < end; minute += 60) {
        segments.push({
          start: minute,
          end: Math.min(end, minute + 60),
          label: minute % 60 === 0 ? String(Math.floor(minute / 60) % 24) : ""
        });
      }
      return segments;
    }
    function pastTimelineSegments({ startMinutes, endMinutes, nowMinutes } = {}) {
      const start = asNumber(startMinutes);
      const end = asNumber(endMinutes);
      const now = asNumber(nowMinutes);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || !Number.isFinite(now) || now <= start) {
        return [];
      }
      const elapsedEnd = Math.min(end, now);
      return hourlyGridSegments({ startMinutes: start, endMinutes: end }).filter((segment) => segment.start < elapsedEnd).map((segment) => ({
        start: segment.start,
        end: Math.min(segment.end, elapsedEnd)
      }));
    }
    function localDayOrdinal(value) {
      if (typeof value === "string") {
        const match = /^([A-Za-z]+)\s+(\d{1,2})(?:st|nd|rd|th),\s*(\d{4})$/.exec(value.trim());
        if (match) {
          const months = [
            "january",
            "february",
            "march",
            "april",
            "may",
            "june",
            "july",
            "august",
            "september",
            "october",
            "november",
            "december"
          ];
          const month = months.indexOf(match[1].toLowerCase());
          const day = Number(match[2]);
          const year = Number(match[3]);
          if (month >= 0 && day >= 1 && day <= 31) {
            const timestamp2 = Date.UTC(year, month, day);
            const date2 = new Date(timestamp2);
            if (date2.getUTCFullYear() === year && date2.getUTCMonth() === month && date2.getUTCDate() === day) {
              return timestamp2 / 864e5;
            }
          }
        }
      }
      const timestamp = asTimestamp(value);
      if (!Number.isFinite(timestamp))
        return null;
      const date = new Date(timestamp);
      return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 864e5;
    }
    function timelineDayState({
      displayDate,
      currentDate = Date.now(),
      startMinutes,
      endMinutes,
      nowMinutes,
      playback = false
    } = {}) {
      const start = asNumber(startMinutes);
      const end = asNumber(endMinutes);
      const validRange = Number.isFinite(start) && Number.isFinite(end) && end > start;
      const safeStart = validRange ? start : 0;
      const safeEnd = validRange ? end : safeStart;
      const displayDay = localDayOrdinal(displayDate);
      const currentDay = localDayOrdinal(currentDate);
      const rawNow = asNumber(nowMinutes);
      const dayDelta = displayDay === null || currentDay === null ? 0 : currentDay - displayDay;
      const simulated = playback === true;
      const timelineMinutes = Number.isFinite(rawNow) ? simulated ? rawNow : rawNow + dayDelta * 1440 : safeStart;
      const sameCalendarDay = displayDay !== null && currentDay !== null && dayDelta === 0;
      const nextDayCarryover = displayDay !== null && currentDay !== null && dayDelta === 1 && safeEnd > 1440 && timelineMinutes < safeEnd;
      const relation = displayDay === null || currentDay === null ? "other" : sameCalendarDay || nextDayCarryover ? "today" : displayDay < currentDay ? "past" : "future";
      const cursor = validRange ? effectiveNow({ startMinutes: safeStart, endMinutes: safeEnd, nowMinutes: timelineMinutes }) : safeStart;
      const today = relation === "today";
      const past = relation === "past";
      return {
        relation,
        timelineMinutes,
        scheduleFromMinutes: past && !simulated ? safeStart : today || simulated ? cursor : safeStart,
        capacityFromMinutes: past && !simulated ? safeEnd : today || simulated ? cursor : safeStart,
        elapsedThroughMinutes: past && !simulated ? safeEnd : today || simulated ? cursor : safeStart,
        interactive: today,
        showElapsed: past || today || simulated,
        showAvailableSlots: !past || simulated,
        showNow: (today || simulated) && Number.isFinite(timelineMinutes) && timelineMinutes >= safeStart && timelineMinutes < safeEnd
      };
    }
    function pastUnplannedSegments({
      startMinutes,
      endMinutes,
      nowMinutes,
      occupiedEvents = []
    } = {}) {
      const start = asNumber(startMinutes);
      const end = asNumber(endMinutes);
      const now = asNumber(nowMinutes);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || !Number.isFinite(now) || now <= start) {
        return [];
      }
      const elapsedEnd = Math.min(end, now);
      const occupied = mergeIntervals(
        (Array.isArray(occupiedEvents) ? occupiedEvents : []).filter((event) => event && event.freetime !== true).map((event) => {
          const eventStart = asNumber(event.start);
          const eventEnd = asNumber(event.end);
          if (!Number.isFinite(eventStart) || !Number.isFinite(eventEnd) || eventEnd <= eventStart) {
            return null;
          }
          const clippedStart = clamp(eventStart, start, elapsedEnd);
          const clippedEnd = clamp(eventEnd, start, elapsedEnd);
          return clippedEnd > clippedStart ? [clippedStart, clippedEnd] : null;
        }).filter(Boolean)
      );
      const gaps = [];
      let cursor = start;
      for (const [occupiedStart, occupiedEnd] of occupied) {
        if (occupiedStart > cursor)
          gaps.push([cursor, occupiedStart]);
        cursor = Math.max(cursor, occupiedEnd);
      }
      if (cursor < elapsedEnd)
        gaps.push([cursor, elapsedEnd]);
      const cells = pastTimelineSegments({ startMinutes: start, endMinutes: end, nowMinutes: elapsedEnd });
      return gaps.flatMap(([gapStart, gapEnd]) => cells.map((cell) => ({
        start: Math.max(gapStart, cell.start),
        end: Math.min(gapEnd, cell.end)
      })).filter((segment) => segment.end > segment.start));
    }
    function splitIntervalAtHourBoundaries(start, end) {
      const segments = [];
      let cursor = start;
      while (cursor < end) {
        const nextHour = (Math.floor(cursor / 60) + 1) * 60;
        const segmentEnd = Math.min(end, nextHour);
        segments.push({ start: cursor, end: segmentEnd });
        cursor = segmentEnd;
      }
      return segments;
    }
    function availableSlotGroups({
      events = [],
      startMinutes,
      endMinutes,
      nowMinutes,
      clampToNow = false
    } = {}) {
      const start = asNumber(startMinutes);
      const end = asNumber(endMinutes);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start)
        return [];
      const rawNow = asNumber(nowMinutes);
      const cursor = clampToNow ? effectiveNow({ startMinutes: start, endMinutes: end, nowMinutes }) : start;
      const freeIntervals = mergeIntervals(
        (Array.isArray(events) ? events : []).filter((event) => event && event.freetime === true).map((event) => {
          const slotStart = asNumber(event.start);
          const slotEnd = asNumber(event.end);
          if (!Number.isFinite(slotStart) || !Number.isFinite(slotEnd) || slotEnd <= slotStart) {
            return null;
          }
          const clippedStart = clamp(slotStart, start, end);
          const clippedEnd = clamp(slotEnd, start, end);
          return clippedEnd > clippedStart ? [clippedStart, clippedEnd] : null;
        }).filter(Boolean)
      );
      return freeIntervals.map(([slotStart, slotEnd]) => {
        const visibleStart = clampToNow ? Math.max(slotStart, cursor) : slotStart;
        if (slotEnd <= visibleStart)
          return null;
        return {
          key: `slot:${visibleStart}:${slotEnd}`,
          start: visibleStart,
          end: slotEnd,
          duration: slotEnd - visibleStart,
          availableNow: clampToNow && Number.isFinite(rawNow) && rawNow >= slotStart && rawNow < slotEnd,
          segments: splitIntervalAtHourBoundaries(visibleStart, slotEnd)
        };
      }).filter(Boolean);
    }
    function pastItemStatus({ event, nowMinutes, dailyPage = false } = {}) {
      if (dailyPage !== true || !event)
        return null;
      const end = asNumber(event.end);
      const now = asNumber(nowMinutes);
      if (!Number.isFinite(end) || !Number.isFinite(now) || end > now)
        return null;
      if (event.done === true)
        return "completed";
      if (event.meeting === true)
        return "event";
      return null;
    }
    function spiralCellInnerHour({ startMinute, endMinutes, windowStartMinutes = 300 } = {}) {
      const start = asNumber(startMinute);
      const end = asNumber(endMinutes);
      const windowStart = asNumber(windowStartMinutes);
      if (!Number.isFinite(start) || !Number.isFinite(end) || !Number.isFinite(windowStart) || start < 0 || start >= end)
        return null;
      const pairedMinute = start + 12 * 60;
      const profileIndex = 5 + Math.floor((pairedMinute - windowStart) / 60);
      return pairedMinute < end ? profileIndex : null;
    }
    function overlappingFixedEventUids({ events = [] } = {}) {
      const fixedEvents = (Array.isArray(events) ? events : []).filter((event) => event && event.uid && event.meeting === true && !event.done).map((event) => ({ ...event, start: asNumber(event.start), end: asNumber(event.end) })).filter((event) => Number.isFinite(event.start) && Number.isFinite(event.end) && event.end > event.start);
      const conflicts = /* @__PURE__ */ new Set();
      for (let left = 0; left < fixedEvents.length; left += 1) {
        for (let right = left + 1; right < fixedEvents.length; right += 1) {
          const first = fixedEvents[left];
          const second = fixedEvents[right];
          if (first.start < second.end && second.start < first.end) {
            conflicts.add(first.uid);
            conflicts.add(second.uid);
          }
        }
      }
      return fixedEvents.filter((event) => conflicts.has(event.uid)).map((event) => event.uid);
    }
    function isCurrentPlannedTask({ event, nowMinutes, dailyPage = false } = {}) {
      if (dailyPage !== true || !event || event.todo !== true || event.done === true)
        return false;
      const start = asNumber(event.start);
      const end = asNumber(event.end);
      const now = asNumber(nowMinutes);
      return Number.isFinite(start) && Number.isFinite(end) && Number.isFinite(now) && end > start && start <= now && now < end;
    }
    function clamp(value, min, max) {
      return Math.min(max, Math.max(min, value));
    }
    function normalizedInterval(event, startMinutes, endMinutes, { includeDone = false } = {}) {
      if (!event || !includeDone && event.done || event.meeting !== true)
        return null;
      const start = asNumber(event.start);
      const end = asNumber(event.end);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start)
        return null;
      const clippedStart = clamp(start, startMinutes, endMinutes);
      const clippedEnd = clamp(end, startMinutes, endMinutes);
      return clippedEnd > clippedStart ? [clippedStart, clippedEnd] : null;
    }
    function burningCapacityBucket({
      startMinutes,
      endMinutes,
      nowMinutes,
      fixedEvents = []
    } = {}) {
      const start = asNumber(startMinutes);
      const end = asNumber(endMinutes);
      const now = asNumber(nowMinutes);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || !Number.isFinite(now) || now < start || now >= end) {
        return null;
      }
      const events = Array.isArray(fixedEvents) ? fixedEvents : [];
      const eventBurning = events.some((event) => {
        const interval = normalizedInterval(event, start, end);
        return interval && now >= interval[0] && now < interval[1];
      });
      return eventBurning ? "events" : "available";
    }
    function mergeIntervals(intervals) {
      const sorted = intervals.filter(Boolean).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      return sorted.reduce((merged, interval) => {
        const previous = merged[merged.length - 1];
        if (previous && interval[0] <= previous[1]) {
          previous[1] = Math.max(previous[1], interval[1]);
        } else {
          merged.push(interval.slice());
        }
        return merged;
      }, []);
    }
    function effectiveNow({ startMinutes, endMinutes, nowMinutes }) {
      const now = asNumber(nowMinutes);
      return Number.isFinite(now) ? clamp(now, startMinutes, endMinutes) : startMinutes;
    }
    function remainingDuration(task) {
      if (!task || task.done)
        return 0;
      const rawDuration = asNumber(task.duration);
      if (!Number.isFinite(rawDuration) || rawDuration <= 0)
        return 0;
      const progress = clamp(asNumber(task.progress) || 0, 0, 100);
      return Math.max(0, Math.round(rawDuration * (1 - progress / 100)));
    }
    function futureFixedIntervals({ startMinutes, endMinutes, nowMinutes, fixedEvents = [] }) {
      const cursor = effectiveNow({ startMinutes, endMinutes, nowMinutes });
      return mergeIntervals(
        fixedEvents.map((event) => normalizedInterval(event, Math.max(startMinutes, cursor), endMinutes)).filter(Boolean)
      );
    }
    function intervalMinutes(intervals) {
      return intervals.reduce((total, [start, end]) => total + Math.max(0, end - start), 0);
    }
    function scheduleTasks({
      startMinutes,
      endMinutes,
      nowMinutes,
      tasks = [],
      fixedEvents = []
    } = {}) {
      const start = asNumber(startMinutes);
      const end = asNumber(endMinutes);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
        return { scheduledTasks: [], overflowTasks: tasks.slice(), fixedMinutes: 0, intervals: [] };
      }
      const cursorStart = effectiveNow({ startMinutes: start, endMinutes: end, nowMinutes });
      const fixedIntervals = futureFixedIntervals({
        startMinutes: start,
        endMinutes: end,
        nowMinutes,
        fixedEvents
      });
      const scheduledTasks = [];
      const overflowTasks = [];
      let cursor = cursorStart;
      for (const task of tasks) {
        const duration = remainingDuration(task);
        if (!duration)
          continue;
        let placed = false;
        while (cursor < end && !placed) {
          const fixed = fixedIntervals.find(([fixedStart2, fixedEnd2]) => fixedEnd2 > cursor);
          if (!fixed) {
            if (cursor + duration <= end) {
              scheduledTasks.push({ ...task, duration, start: cursor, end: cursor + duration });
              cursor += duration;
              placed = true;
            } else {
              cursor = end;
            }
            continue;
          }
          const [fixedStart, fixedEnd] = fixed;
          if (fixedStart > cursor && cursor + duration <= fixedStart) {
            scheduledTasks.push({ ...task, duration, start: cursor, end: cursor + duration });
            cursor += duration;
            placed = true;
          } else {
            cursor = Math.max(cursor, fixedEnd);
          }
        }
        if (!placed)
          overflowTasks.push({ ...task, duration });
      }
      const fixedSegments = fixedIntervals.map(([fixedStart, fixedEnd]) => ({
        meeting: true,
        fixed: true,
        start: fixedStart,
        end: fixedEnd,
        duration: fixedEnd - fixedStart
      }));
      return {
        scheduledTasks,
        overflowTasks,
        fixedMinutes: intervalMinutes(fixedIntervals),
        intervals: fixedSegments.concat(scheduledTasks).sort((a, b) => a.start - b.start)
      };
    }
    function historicalDoneSlice({
      done,
      doneAt,
      duration,
      defaultDuration,
      actualDuration,
      lastClockEnd
    } = {}) {
      if (done !== true)
        return null;
      const actual = asNumber(actualDuration);
      const hasActual = Number.isFinite(actual) && actual > 0;
      const explicitEnd = asNumber(doneAt);
      const clockEnd = asNumber(lastClockEnd);
      const end = Number.isFinite(explicitEnd) ? explicitEnd : hasActual ? clockEnd : NaN;
      const explicitDuration = asNumber(duration);
      const fallbackDuration = asNumber(defaultDuration);
      const originalDuration = hasActual ? actual : Number.isFinite(explicitDuration) && explicitDuration > 0 ? explicitDuration : fallbackDuration;
      if (!Number.isFinite(end) || !Number.isFinite(originalDuration) || originalDuration <= 0) {
        return null;
      }
      return {
        start: end - originalDuration,
        end,
        duration: originalDuration,
        ...hasActual ? { durationSource: "actual" } : {}
      };
    }
    function completedTaskClockSummary({ taskUid, entries = [], dayStartMs, dayEndMs } = {}) {
      const dayStart = asTimestamp(dayStartMs);
      const dayEnd = asTimestamp(dayEndMs);
      if (!taskUid || !Number.isFinite(dayStart) || !Number.isFinite(dayEnd) || dayEnd <= dayStart) {
        return { actualMinutes: 0, sessionCount: 0, latestEndMinutes: null };
      }
      let actualMilliseconds = 0;
      let sessionCount = 0;
      let latestEnd = null;
      for (const entry of Array.isArray(entries) ? entries : []) {
        if (entry?.taskUid !== taskUid || entry?.running === true)
          continue;
        const start = asTimestamp(entry?.start);
        const end = asTimestamp(entry?.end);
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start)
          continue;
        const clippedStart = Math.max(dayStart, start);
        const clippedEnd = Math.min(dayEnd, end);
        if (clippedEnd <= clippedStart)
          continue;
        actualMilliseconds += clippedEnd - clippedStart;
        sessionCount += 1;
        latestEnd = latestEnd === null ? clippedEnd : Math.max(latestEnd, clippedEnd);
      }
      return {
        actualMinutes: Math.floor(actualMilliseconds / 6e4),
        sessionCount,
        latestEndMinutes: latestEnd === null ? null : Math.floor((latestEnd - dayStart) / 6e4)
      };
    }
    function calculateCapacity({
      startMinutes,
      endMinutes,
      nowMinutes,
      fixedEvents = [],
      allFixedEvents = fixedEvents,
      pendingTasks = []
    } = {}) {
      const start = asNumber(startMinutes);
      const end = asNumber(endMinutes);
      const cursor = Number.isFinite(start) && Number.isFinite(end) && end > start ? effectiveNow({ startMinutes: start, endMinutes: end, nowMinutes }) : 0;
      const fixedIntervals = Number.isFinite(start) && Number.isFinite(end) && end > start ? futureFixedIntervals({ startMinutes: start, endMinutes: end, nowMinutes, fixedEvents }) : [];
      const totalFixedIntervals = Number.isFinite(start) && Number.isFinite(end) && end > start ? mergeIntervals(
        (Array.isArray(allFixedEvents) ? allFixedEvents : []).map((event) => normalizedInterval(event, start, end, { includeDone: true })).filter(Boolean)
      ) : [];
      const rawAvailable = Math.max(0, (Number.isFinite(end) ? end : 0) - cursor);
      const availableMinutes = Math.max(0, rawAvailable - intervalMinutes(fixedIntervals));
      const totalFixedMinutes = intervalMinutes(totalFixedIntervals);
      const totalAvailableMinutes = Math.max(
        0,
        (Number.isFinite(start) && Number.isFinite(end) && end > start ? end - start : 0) - totalFixedMinutes
      );
      const demandMinutes = pendingTasks.reduce((total, task) => total + remainingDuration(task), 0);
      const overloadMinutes = Math.max(0, demandMinutes - availableMinutes);
      const slackMinutes = Math.max(0, availableMinutes - demandMinutes);
      const plan = scheduleTasks({ startMinutes: start, endMinutes: end, nowMinutes, tasks: pendingTasks, fixedEvents });
      const unplacedMinutes = plan.overflowTasks.reduce(
        (total, task) => total + remainingDuration(task),
        0
      );
      return {
        availableMinutes,
        demandMinutes,
        overloadMinutes,
        slackMinutes,
        unplacedMinutes,
        fixedMinutes: intervalMinutes(fixedIntervals),
        totalAvailableMinutes,
        totalFixedMinutes,
        burningBucket: burningCapacityBucket({
          startMinutes: start,
          endMinutes: end,
          nowMinutes,
          fixedEvents
        }),
        scheduledTasks: plan.scheduledTasks,
        overflowTasks: plan.overflowTasks
      };
    }
    function formatDuration(minutes) {
      const value = Math.max(0, Math.round(asNumber(minutes) || 0));
      const hours = Math.floor(value / 60);
      const remainder = value % 60;
      if (!hours)
        return `${remainder}m`;
      if (!remainder)
        return `${hours}h`;
      return `${hours}h${String(remainder).padStart(2, "0")}m`;
    }
    var UI_COPY = {
      en: {
        capacity: {
          available: "Available",
          events: "Events",
          demand: "Planned",
          overload: "Overload",
          fragmented: "No fitting slot",
          remaining: "Remaining",
          burningAvailable: "Flexible time is elapsing",
          burningEvents: "Event time is elapsing",
          now: "Current time"
        },
        allocation: {
          planned: "planned",
          free: "free",
          over: "over",
          noSlot: "no slot",
          left: "left"
        },
        legend: { urgent: "Urgent", event: "Event", task: "Task" },
        controls: {
          hideDone: "Hide completed items",
          showDone: "Show completed items",
          playback: "Play back the day",
          collapse: "Collapse Nautilus Log",
          expand: "Expand Nautilus Log"
        },
        panels: {
          overview: "Overview",
          overflow: "Unscheduled today",
          warnings: "Schedule warnings",
          schedule: "Schedule",
          item: "item",
          items: "items"
        },
        tooltips: {
          task: "Task",
          event: "Event",
          available: "Available slot",
          availableNow: "Available now"
        },
        warnings: {
          overnight: "Continues into the next day",
          sameTime: "Start and end times cannot be the same"
        }
      },
      zh: {
        capacity: {
          available: "\u53EF\u5B89\u6392",
          events: "\u4E8B\u4EF6",
          demand: "\u5DF2\u8BA1\u5212",
          overload: "\u8D85\u8F7D",
          fragmented: "\u7A7A\u6863\u4E0D\u8DB3",
          remaining: "\u4F59\u91CF",
          burningAvailable: "\u53EF\u5B89\u6392\u65F6\u95F4\u6B63\u5728\u6D41\u901D",
          burningEvents: "\u4E8B\u4EF6\u65F6\u95F4\u6B63\u5728\u6D41\u901D",
          now: "\u5F53\u524D\u65F6\u95F4"
        },
        allocation: {
          planned: "\u5DF2\u8BA1\u5212",
          free: "\u4F59\u91CF",
          over: "\u8D85\u8F7D",
          noSlot: "\u65E0\u5408\u9002\u7A7A\u6863",
          left: "\u5269\u4F59"
        },
        legend: { urgent: "\u7D27\u6025", event: "\u4E8B\u4EF6", task: "\u4EFB\u52A1" },
        controls: {
          hideDone: "\u9690\u85CF\u5DF2\u5B8C\u6210\u4E8B\u9879",
          showDone: "\u663E\u793A\u5DF2\u5B8C\u6210\u4E8B\u9879",
          playback: "\u56DE\u653E\u4E00\u6574\u5929",
          collapse: "\u6298\u53E0 Nautilus Log",
          expand: "\u5C55\u5F00 Nautilus Log"
        },
        panels: {
          overview: "\u6982\u89C8",
          overflow: "\u4ECA\u65E5\u653E\u4E0D\u4E0B",
          warnings: "\u65F6\u95F4\u8303\u56F4\u63D0\u9192",
          schedule: "\u65F6\u95F4\u5B89\u6392",
          item: "\u9879",
          items: "\u9879"
        },
        tooltips: {
          task: "\u4EFB\u52A1",
          event: "\u4E8B\u4EF6",
          available: "\u53EF\u7528\u7A7A\u6863",
          availableNow: "\u5F53\u524D\u53EF\u7528"
        },
        warnings: {
          overnight: "\u8FDE\u7EED\u5230\u6B21\u65E5",
          sameTime: "\u5F00\u59CB\u65F6\u95F4\u4E0E\u7ED3\u675F\u65F6\u95F4\u4E0D\u80FD\u76F8\u540C"
        }
      }
    };
    function uiCopy(language = "en") {
      return language === "en" ? UI_COPY.en : UI_COPY.zh;
    }
    function capacityMetrics({ capacity = {}, language = "en" } = {}) {
      const localized = uiCopy(language);
      const copy = localized.capacity;
      const allocation = localized.allocation;
      const burningBucket = capacity.burningBucket;
      const markBurning = (metric, bucket, label) => burningBucket === bucket ? { ...metric, burning: true, burningLabel: label } : metric;
      const availableMinutes = Math.max(0, asNumber(capacity.availableMinutes) || 0);
      const totalAvailableMinutes = asNumber(capacity.totalAvailableMinutes);
      const totalFixedMinutes = asNumber(capacity.totalFixedMinutes);
      const demandMinutes = Math.max(0, asNumber(capacity.demandMinutes) || 0);
      const freeMinutes = Math.max(0, availableMinutes - demandMinutes);
      const fullDayAvailableMinutes = Number.isFinite(totalAvailableMinutes) && totalAvailableMinutes > 0 ? totalAvailableMinutes : availableMinutes;
      const leftPercent = fullDayAvailableMinutes > 0 ? `${Math.round(freeMinutes / fullDayAvailableMinutes * 100)}%` : "0%";
      const available = markBurning({
        key: "available",
        label: copy.available,
        value: formatDuration(availableMinutes),
        ...Number.isFinite(totalAvailableMinutes) ? { total: formatDuration(totalAvailableMinutes) } : {},
        tone: "neutral"
      }, "available", copy.burningAvailable);
      const events = markBurning({
        key: "events",
        label: copy.events,
        value: formatDuration(capacity.fixedMinutes),
        ...Number.isFinite(totalFixedMinutes) ? { total: formatDuration(totalFixedMinutes) } : {},
        tone: "event"
      }, "events", copy.burningEvents);
      const demand = {
        key: "demand",
        label: copy.demand,
        value: formatDuration(demandMinutes),
        summaryLabel: allocation.planned,
        percent: leftPercent,
        percentLabel: allocation.left,
        percentTone: "neutral",
        tone: "neutral"
      };
      let status;
      if (capacity.overloadMinutes > 0) {
        status = {
          key: "overload",
          label: copy.overload,
          value: formatDuration(capacity.overloadMinutes),
          summaryLabel: allocation.over,
          tone: "warning"
        };
      } else if (capacity.unplacedMinutes > 0) {
        status = {
          key: "fragmented",
          label: copy.fragmented,
          value: formatDuration(capacity.unplacedMinutes),
          summaryLabel: allocation.noSlot,
          tone: "warning"
        };
      } else {
        status = {
          key: "remaining",
          label: copy.remaining,
          value: formatDuration(freeMinutes),
          summaryLabel: allocation.free,
          tone: "neutral"
        };
      }
      return {
        planned: demand,
        status,
        available,
        events
      };
    }
    function formatCapacitySummary(capacity) {
      const available = formatDuration(capacity.availableMinutes);
      const events = formatDuration(capacity.fixedMinutes);
      const demand = formatDuration(capacity.demandMinutes);
      if (capacity.overloadMinutes > 0) {
        return `\u53EF\u5B89\u6392 ${available} \xB7 \u4E8B\u4EF6 ${events} \xB7 \u5F85\u529E\u9700\u6C42 ${demand} \xB7 \u8D85\u8F7D ${formatDuration(capacity.overloadMinutes)}`;
      }
      if (capacity.unplacedMinutes > 0) {
        return `\u53EF\u5B89\u6392 ${available} \xB7 \u4E8B\u4EF6 ${events} \xB7 \u5F85\u529E\u9700\u6C42 ${demand} \xB7 \u7A7A\u6863\u4E0D\u8DB3 ${formatDuration(capacity.unplacedMinutes)}`;
      }
      return `\u53EF\u5B89\u6392 ${available} \xB7 \u4E8B\u4EF6 ${events} \xB7 \u5F85\u529E\u9700\u6C42 ${demand} \xB7 \u4F59\u91CF ${formatDuration(capacity.slackMinutes)}`;
    }
    function characterWidth(character) {
      return character === "\u2026" || character === "\xB7" || character.charCodeAt(0) <= 255 ? 1 : 2;
    }
    var textCanvasContext;
    function fallbackTextWidth(candidate) {
      return Array.from(candidate).reduce((sum, char) => sum + characterWidth(char), 0);
    }
    function browserTextWidth(candidate, font) {
      if (typeof document === "undefined" || !document.createElement)
        return fallbackTextWidth(candidate);
      if (!textCanvasContext)
        textCanvasContext = document.createElement("canvas").getContext("2d");
      if (!textCanvasContext)
        return fallbackTextWidth(candidate);
      if (font)
        textCanvasContext.font = font;
      return textCanvasContext.measureText(candidate).width;
    }
    function truncateTextToWidth(textOrOptions, maxWidth, measure = null) {
      const options = textOrOptions && typeof textOrOptions === "object" ? textOrOptions : null;
      const value = String(options ? options.text ?? "" : textOrOptions ?? "");
      const limit = Math.max(1, asNumber(options ? options.maxWidth : maxWidth) || 1);
      const requestedMeasure = options && options.measure || measure;
      const width = typeof requestedMeasure === "function" ? requestedMeasure : (candidate) => browserTextWidth(candidate, options?.font);
      if (width(value) <= limit)
        return value;
      const ellipsis = "\u2026";
      let result = "";
      for (const char of Array.from(value)) {
        if (width(result + char + ellipsis) > limit)
          break;
        result += char;
      }
      return result ? result + ellipsis : ellipsis;
    }
    function rangesOverlap(aStart, aEnd, bStart, bEnd) {
      return aStart < bEnd && bStart < aEnd;
    }
    function placeLabelTracks(labelsOrOptions, maxTracks = 3) {
      const options = Array.isArray(labelsOrOptions) ? null : labelsOrOptions || {};
      const labels = Array.isArray(labelsOrOptions) ? labelsOrOptions : options.labels || [];
      const requestedTracks = options && options.maxTracks !== void 0 ? options.maxTracks : maxTracks;
      const trackCount = Math.max(1, Math.floor(requestedTracks));
      const tracks = Array.from({ length: trackCount }, () => []);
      return labels.map((label) => {
        let selected = -1;
        for (let track = 0; track < trackCount; track += 1) {
          const collides = tracks[track].some((placed) => rangesOverlap(label.start, label.end, placed.start, placed.end));
          if (!collides) {
            selected = track;
            break;
          }
        }
        if (selected < 0)
          selected = trackCount - 1;
        tracks[selected].push(label);
        return { ...label, track: selected };
      });
    }
    function sideRailMaxVerticalOffset(options, exclusionRadius) {
      return Math.max(
        0,
        asNumber(options.maxVerticalOffset) || exclusionRadius * 0.92
      );
    }
    function sideRailSourceY(label, options) {
      const explicitAnchorY = Number(label.anchorY);
      if (Number.isFinite(explicitAnchorY))
        return explicitAnchorY;
      const centerY = asNumber(options.centerY) || 0;
      const exclusionRadius = Math.max(0, asNumber(options.exclusionRadius) || 0);
      return centerY - Math.sin(asNumber(label.angle) || 0) * exclusionRadius;
    }
    function sideRailSide(label) {
      return Math.cos(asNumber(label.angle) || 0) < 0 ? "left" : "right";
    }
    function compareSideRailSourceOrder(first, second, options) {
      const firstAnchorY = sideRailSourceY(first, options);
      const secondAnchorY = sideRailSourceY(second, options);
      if (Math.abs(firstAnchorY - secondAnchorY) > 0.5) {
        return firstAnchorY - secondAnchorY;
      }
      const firstSortKey = Number(first.sortKey);
      const secondSortKey = Number(second.sortKey);
      if (Number.isFinite(firstSortKey) && Number.isFinite(secondSortKey) && firstSortKey !== secondSortKey) {
        return sideRailSide(first) === "left" ? secondSortKey - firstSortKey : firstSortKey - secondSortKey;
      }
      return String(first.uid ?? "").localeCompare(String(second.uid ?? ""));
    }
    function externalLabelRect(label, options, track = 0) {
      const width = Math.max(1, asNumber(label.width) || 1);
      const height = Math.max(1, asNumber(label.height) || 1);
      const angle = asNumber(label.angle) || 0;
      const centerX = asNumber(options.centerX) || 0;
      const centerY = asNumber(options.centerY) || 0;
      const exclusionRadius = Math.max(0, asNumber(options.exclusionRadius) || 0);
      const gap = Math.max(0, asNumber(options.gap) || 0);
      const trackGap = Math.max(1, asNumber(options.trackGap) || 18);
      const directionX = Math.cos(angle);
      const directionY = -Math.sin(angle);
      if (options.layout === "side-rails") {
        const maxVerticalOffset = sideRailMaxVerticalOffset(options, exclusionRadius);
        const side = directionX < 0 ? -1 : 1;
        const verticalOffset = clamp(
          directionY * maxVerticalOffset,
          -maxVerticalOffset,
          maxVerticalOffset
        );
        const railDistance = exclusionRadius + gap + track * trackGap;
        const connectorKneeX = centerX + side * (exclusionRadius + gap * 0.42);
        const connectorRailX = centerX + side * (exclusionRadius + gap);
        const x = side > 0 ? centerX + railDistance : centerX - railDistance - width;
        return {
          ...label,
          x,
          y: centerY + verticalOffset - height / 2,
          width,
          height,
          w: width,
          h: height,
          side: side > 0 ? "right" : "left",
          anchorY: sideRailSourceY(label, options),
          connectorKneeX,
          connectorRailX,
          track
        };
      }
      const projectedHalfSize = Math.abs(directionX) * width / 2 + Math.abs(directionY) * height / 2;
      const distance = exclusionRadius + gap + projectedHalfSize + track * trackGap + 1e-3;
      const labelCenterX = centerX + directionX * distance;
      const labelCenterY = centerY + directionY * distance;
      return {
        ...label,
        x: labelCenterX - width / 2,
        y: labelCenterY - height / 2,
        width,
        height,
        w: width,
        h: height,
        track
      };
    }
    function sideRailCenterBounds(label, options, occupied, orderingGap) {
      const centerY = asNumber(options.centerY) || 0;
      const exclusionRadius = Math.max(0, asNumber(options.exclusionRadius) || 0);
      const maxVerticalOffset = sideRailMaxVerticalOffset(options, exclusionRadius);
      let minimum = centerY - maxVerticalOffset;
      let maximum = centerY + maxVerticalOffset;
      const side = sideRailSide(label);
      for (const placed of occupied) {
        if ((placed.side || sideRailSide(placed)) !== side)
          continue;
        const comparison = compareSideRailSourceOrder(label, placed, options);
        if (!comparison)
          continue;
        const placedCenterY = placed.y + (asNumber(placed.height ?? placed.h) || 0) / 2;
        if (comparison < 0)
          maximum = Math.min(maximum, placedCenterY - orderingGap);
        else
          minimum = Math.max(minimum, placedCenterY + orderingGap);
      }
      return { minimum, maximum };
    }
    function sideRailCenterCandidates(label, baseRect, options, occupied, collisionPadding) {
      const exclusionRadius = Math.max(0, asNumber(options.exclusionRadius) || 0);
      const maxVerticalOffset = sideRailMaxVerticalOffset(options, exclusionRadius);
      const height = Math.max(1, asNumber(label.height) || 1);
      const rowGap = Math.max(
        1,
        asNumber(options.rowGap) || height + collisionPadding + 4
      );
      const orderingGap = Math.max(1, asNumber(options.orderingGap) || rowGap);
      const { minimum, maximum } = sideRailCenterBounds(label, options, occupied, orderingGap);
      const desiredCenterY = baseRect.y + baseRect.height / 2;
      if (minimum > maximum) {
        const bandMinimum = (asNumber(options.centerY) || 0) - maxVerticalOffset;
        const bandMaximum = (asNumber(options.centerY) || 0) + maxVerticalOffset;
        if (maximum < bandMinimum)
          return [maximum];
        if (minimum > bandMaximum)
          return [minimum];
        return [(minimum + maximum) / 2];
      }
      const nearestCenterY = clamp(desiredCenterY, minimum, maximum);
      const maxSteps = Math.max(1, Math.ceil(maxVerticalOffset * 2 / rowGap));
      const candidates = [nearestCenterY];
      for (let step = 1; step <= maxSteps; step += 1) {
        candidates.push(nearestCenterY - step * rowGap);
        candidates.push(nearestCenterY + step * rowGap);
      }
      candidates.push(minimum, maximum);
      const seen = /* @__PURE__ */ new Set();
      return candidates.filter((candidate) => {
        if (candidate < minimum || candidate > maximum)
          return false;
        const key = Math.round(candidate * 1e3);
        if (seen.has(key))
          return false;
        seen.add(key);
        return true;
      });
    }
    function labelRectsOverlap(first, second, padding = 0) {
      const firstWidth = asNumber(first.width ?? first.w) || 0;
      const firstHeight = asNumber(first.height ?? first.h) || 0;
      const secondWidth = asNumber(second.width ?? second.w) || 0;
      const secondHeight = asNumber(second.height ?? second.h) || 0;
      return !(first.x + firstWidth + padding <= second.x || second.x + secondWidth + padding <= first.x || first.y + firstHeight + padding <= second.y || second.y + secondHeight + padding <= first.y);
    }
    function placeExternalLabels(options = {}) {
      const labels = Array.isArray(options.labels) ? options.labels : [];
      const collisionPadding = Math.max(0, asNumber(options.collisionPadding) || 0);
      const occupied = Array.isArray(options.occupiedRects) ? options.occupiedRects.slice() : [];
      return labels.map((label) => {
        let track = Math.max(0, Math.floor(asNumber(label.track) || 0));
        if (options.layout === "side-rails") {
          const searchLimit2 = Math.max(16, occupied.length * 2 + labels.length + 4);
          let candidate2 = null;
          let fallback = externalLabelRect(label, options, track);
          sideRailSearch:
            for (; track <= searchLimit2; track += 1) {
              const baseRect = externalLabelRect(label, options, track);
              const centerCandidates = sideRailCenterCandidates(
                label,
                baseRect,
                options,
                occupied,
                collisionPadding
              );
              for (const labelCenterY of centerCandidates) {
                const rowCandidate = {
                  ...baseRect,
                  y: labelCenterY - baseRect.height / 2,
                  rowOffset: labelCenterY - (baseRect.y + baseRect.height / 2)
                };
                fallback = rowCandidate;
                if (!occupied.some((rect) => labelRectsOverlap(rowCandidate, rect, collisionPadding))) {
                  candidate2 = rowCandidate;
                  break sideRailSearch;
                }
              }
            }
          occupied.push(candidate2 || fallback);
          return candidate2 || fallback;
        }
        let candidate = externalLabelRect(label, options, track);
        const searchLimit = occupied.length + labels.length + 4;
        while (track < searchLimit && occupied.some((rect) => labelRectsOverlap(candidate, rect, collisionPadding))) {
          track += 1;
          candidate = externalLabelRect(label, options, track);
        }
        occupied.push(candidate);
        return candidate;
      });
    }
    function isCompactChartWidth(width, threshold = 520) {
      const normalizedWidth = asNumber(width);
      const normalizedThreshold = asNumber(threshold);
      if (!Number.isFinite(normalizedWidth) || !Number.isFinite(normalizedThreshold))
        return false;
      return normalizedWidth <= normalizedThreshold;
    }
    function radialTooltipGeometry({
      startMinutes,
      endMinutes,
      centerX,
      centerY,
      radius
    } = {}) {
      const start = asNumber(startMinutes);
      const end = asNumber(endMinutes);
      const x = asNumber(centerX);
      const y = asNumber(centerY);
      const normalizedRadius = Math.max(0, asNumber(radius) || 0);
      if (![start, end, x, y].every(Number.isFinite) || end <= start)
        return null;
      const middle = (start + end) / 2;
      const rawAngle = (middle - 540) / 2;
      const angle = (rawAngle % 360 + 360) % 360;
      const radians = (180 - angle) * (Math.PI / 180);
      return {
        center: { x, y },
        direction: {
          x: x + normalizedRadius * Math.cos(radians),
          y: y - normalizedRadius * Math.sin(radians)
        }
      };
    }
    function placeFloatingTooltip({
      anchorX,
      anchorY,
      tooltipWidth,
      tooltipHeight,
      viewportWidth,
      viewportHeight,
      preferred = "right",
      margin = 12,
      gap = 10
    } = {}) {
      const xAnchor = asNumber(anchorX);
      const yAnchor = asNumber(anchorY);
      const width = Math.max(0, asNumber(tooltipWidth) || 0);
      const height = Math.max(0, asNumber(tooltipHeight) || 0);
      const viewportW = Math.max(0, asNumber(viewportWidth) || 0);
      const viewportH = Math.max(0, asNumber(viewportHeight) || 0);
      const safeMargin = Math.max(0, asNumber(margin) || 0);
      const safeGap = Math.max(0, asNumber(gap) || 0);
      if (!Number.isFinite(xAnchor) || !Number.isFinite(yAnchor))
        return null;
      const placements = {
        right: { x: xAnchor + safeGap, y: yAnchor - height / 2 },
        left: { x: xAnchor - safeGap - width, y: yAnchor - height / 2 },
        top: { x: xAnchor - width / 2, y: yAnchor - safeGap - height },
        bottom: { x: xAnchor - width / 2, y: yAnchor + safeGap }
      };
      const orderByPreference = {
        right: ["right", "left", "top", "bottom"],
        left: ["left", "right", "top", "bottom"],
        top: ["top", "bottom", "right", "left"],
        bottom: ["bottom", "top", "right", "left"]
      };
      const order = orderByPreference[preferred] || orderByPreference.right;
      const overflow = ({ x, y }) => Math.max(0, safeMargin - x) + Math.max(0, x + width - (viewportW - safeMargin)) + Math.max(0, safeMargin - y) + Math.max(0, y + height - (viewportH - safeMargin));
      const choice = order.map((placement) => ({ placement, ...placements[placement] })).reduce((best, candidate) => {
        const score = overflow(candidate);
        return !best || score < best.score ? { ...candidate, score } : best;
      }, null);
      const maxX = Math.max(safeMargin, viewportW - safeMargin - width);
      const maxY = Math.max(safeMargin, viewportH - safeMargin - height);
      return {
        x: Math.round(Math.min(maxX, Math.max(safeMargin, choice.x))),
        y: Math.round(Math.min(maxY, Math.max(safeMargin, choice.y))),
        placement: choice.placement
      };
    }
    module2.exports = {
      START_HOURS,
      END_HOURS,
      normalizeScheduleSettings,
      parseDurationToken,
      parseTimeRangeToken,
      alignIntervalToWindow,
      resolveRendererSettings,
      hourlyGridSegments,
      pastTimelineSegments,
      timelineDayState,
      pastUnplannedSegments,
      availableSlotGroups,
      pastItemStatus,
      spiralCellInnerHour,
      overlappingFixedEventUids,
      isCurrentPlannedTask,
      scheduleTasks,
      completedTaskClockSummary,
      historicalDoneSlice,
      calculateCapacity,
      burningCapacityBucket,
      formatDuration,
      uiCopy,
      capacityMetrics,
      formatCapacitySummary,
      truncateTextToWidth,
      placeLabelTracks,
      placeExternalLabels,
      radialTooltipGeometry,
      placeFloatingTooltip,
      isCompactChartWidth
    };
  }
});

// src/parser.ts
var parser_exports = {};
__export(parser_exports, {
  parsePlan: () => parsePlan,
  taskDescription: () => taskDescription
});
module.exports = __toCommonJS(parser_exports);
var logCore = require_log_core();
var CHECKBOX_RE = /^[-*+]\s*\[( |x|X)\]\s*/;
var LIST_MARKER_RE = /^[-*+]\s+/;
var DONE_AT_RE = /(?:^|\s)d(\d{1,2}):(\d{2})(?=\s|$)/i;
var DONE_RE = /\[x\]/i;
function taskDescription(line, descLength) {
  const { cleanedText } = logCore.parseDurationToken({ text: line });
  const description = cleanedText.replace(CHECKBOX_RE, "").replace(LIST_MARKER_RE, "").replace(DONE_AT_RE, "").trim();
  return logCore.truncateTextToWidth({ text: description, maxWidth: descLength });
}
function lineUid(sourcePath, lineIndex) {
  return `${sourcePath}:${lineIndex}`;
}
var START_TIME_RE = /(?:^|\s)(\d{1,2}:\d{1,2}(?:\s*(?:am|pm))?|\d{1,2}\s*(?:am|pm))(?=\s|$)/i;
function pinnedRange(text, durationMinutes, startMinutes, endMinutes) {
  const token = START_TIME_RE.exec(text)?.[1];
  if (!token)
    return null;
  const probe = logCore.parseTimeRangeToken({
    text: `${token}-${token}`,
    windowStartMinutes: startMinutes,
    windowEndMinutes: endMinutes
  });
  if (!probe)
    return null;
  const h = Math.floor(probe.start / 60);
  const m = probe.start % 60;
  const endTotal = probe.start + Math.max(1, durationMinutes);
  const eh = Math.floor(endTotal / 60) % 24;
  const em = endTotal % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return logCore.parseTimeRangeToken({
    text: `${pad(h)}:${pad(m)}-${pad(eh)}:${pad(em)}`,
    windowStartMinutes: startMinutes,
    windowEndMinutes: endMinutes
  });
}
function parsePlan(source, options) {
  const { sourcePath, settings } = options;
  const lineOffset = options.lineOffset ?? 0;
  const schedule = logCore.normalizeScheduleSettings({
    startHour: settings.workdayStartHour,
    endHour: settings.workdayEndHour
  });
  const events = [];
  const tasks = [];
  const malformed = [];
  const lines = source.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const text = lines[index].trim();
    if (!text)
      continue;
    const uid = lineUid(sourcePath, lineOffset + index);
    const range = logCore.parseTimeRangeToken({
      text,
      windowStartMinutes: schedule.startMinutes,
      windowEndMinutes: schedule.endMinutes
    });
    if (range) {
      events.push({
        uid,
        string: text,
        start: range.start,
        end: range.end,
        meeting: true,
        done: DONE_RE.test(text)
      });
      continue;
    }
    if (CHECKBOX_RE.test(text)) {
      const duration = logCore.parseDurationToken({
        text,
        fallback: settings.todoDuration
      });
      const pinned = pinnedRange(text, duration.minutes, schedule.startMinutes, schedule.endMinutes);
      if (pinned) {
        events.push({
          uid,
          string: text,
          start: pinned.start,
          end: pinned.end,
          meeting: true,
          done: DONE_RE.test(text)
        });
        continue;
      }
      const anchor = DONE_AT_RE.exec(text);
      const anchorMinutes = anchor ? Number(anchor[1]) * 60 + Number(anchor[2]) : null;
      tasks.push({
        uid,
        string: text,
        duration: duration.minutes,
        done: DONE_RE.test(text),
        ...anchorMinutes !== null && anchorMinutes < 1440 ? { doneAt: anchorMinutes } : {}
      });
      continue;
    }
    malformed.push({ line: index, text, reason: "Unrecognized line format" });
  }
  return { events, tasks, malformed };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  parsePlan,
  taskDescription
});
