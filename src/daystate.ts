/*
 * 笔记日期 → 时间轴状态。
 *
 * 上游 timelineDayState 已经把「看昨天 / 看今天 / 提前写明天」三种情况想透了，
 * 这里只负责把【笔记是哪一天】喂给它，一条规则都不自己发明。
 */

import type { DayMinutes } from './contract';

const core = require('./vendor/log-core') as {
  timelineDayState(a: {
    displayDate: Date | number | string;
    currentDate?: Date | number;
    startMinutes: number;
    endMinutes: number;
    nowMinutes: number;
    playback?: boolean;
  }): DayState;
};

export interface DayState {
  /** 'past' | 'today' | 'future' | 'other' */
  relation: string;
  timelineMinutes: number;
  /** 排程从哪一刻开始铺任务。看过去/未来时是【当天起点】，不是"现在"。 */
  scheduleFromMinutes: DayMinutes;
  /** 容量从哪一刻算。看过去时是当天终点（＝整天容量），看未来时是当天起点。 */
  capacityFromMinutes: DayMinutes;
  elapsedThroughMinutes: DayMinutes;
  /** 非今天时为 false —— 眼睛/播放这类"相对此刻"的交互没有意义。 */
  interactive: boolean;
  /** 未来的日子完全不画斜纹：明天还没开始，没有"已流逝"这回事。 */
  showElapsed: boolean;
  showAvailableSlots: boolean;
  /** 只有今天画红针。 */
  showNow: boolean;
}

/** 从 vault 路径里认出 YYYY-MM-DD。认不出返回 null（调用方退回今天）。 */
export function dateFromPath(path: string): Date | null {
  const m = /(\d{4})-(\d{2})-(\d{2})/.exec(String(path || ''));
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0);
  return Number.isFinite(d.getTime()) ? d : null;
}

export function resolveDayState(args: {
  sourcePath: string;
  startMinutes: number;
  endMinutes: number;
  nowMinutes: number;
  playback?: boolean;
  now?: Date;
}): DayState {
  const displayDate = dateFromPath(args.sourcePath) || args.now || new Date();
  return core.timelineDayState({
    displayDate,
    currentDate: args.now || new Date(),
    startMinutes: args.startMinutes,
    endMinutes: args.endMinutes,
    nowMinutes: args.nowMinutes,
    playback: args.playback === true,
  });
}
