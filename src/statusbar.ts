/*
 * statusbar.ts — 状态栏常驻块（B · 状态栏常驻块）。
 *
 * 执行层最核心的价值是「我现在有没有在计时、计了多久」——必须不打开任何东西
 * 就看得见。上游 topbar 是两层：常驻 trigger 与点开的 popover；这里实现常驻那层，
 * 落到 Obsidian 的状态栏（plugin.addStatusBarItem() 给的元素）。popover 那层由主
 * 会话把 onClick 接成「打开侧栏」。
 *
 * 显示语义（对照 src/vendor/timing-topbar.js 的 renderTrigger）：
 *   · 有任务 CLOCK 在跑：任务标题（截断）+ 已用时长
 *   · 无任务 CLOCK 但有独立 POMO：elapsed · POMO
 *   · 都没有：极简态（只留一个可点的图标，别占地方）
 *   · 超过 pomodoroMinutes 阈值：加 `is-overdue` class（**只变样式，不停止计时**）
 *   · 忘关警告触发：加 `is-forgotten` class
 *
 * 三类状态只在【切换结构】时重建 DOM（mode 跟踪，与上游 triggerMode 同款），
 * 其余每秒只更新文本 / class，避免每秒整块重排。
 *
 * class 约定（主会话接 CSS 用）：
 *   根元素            .nautilus-log-statusbar
 *   子元素            .nautilus-log-statusbar-title / -elapsed / -pomo / -separator
 *   状态 class         is-active · is-pomodoro · is-overdue · is-forgotten
 *
 * 时长统一走 timingCore.formatElapsed()（实跑确认收毫秒、返回 "m:ss" / "h:mm:ss"）。
 * 每次刷新用 Date.now() 作“当前时刻”：即使 runtime 不 publish，秒针照走。
 */

import { setIcon } from 'obsidian';
import type { ExecViewContext, TimingEntry, TimingSnapshot } from './timing-contract';

/** 状态栏标题的硬性字符上限。状态栏空间极小，光靠 CSS ellipsis 不够——文本本身
 *  就得截短，否则会把状态栏撑爆。截断后完整标题放进 title 属性（悬停可见）。 */
export const STATUSBAR_TITLE_MAX_LENGTH = 14;

/** vendored CJS，无声明文件。接口照 timing-core.js 的【实际】返回钉住：
 *  formatElapsed 收毫秒（number）返回 "m:ss" / "h:mm:ss"（已实跑核对）。 */
interface TimingCoreModule {
  formatElapsed(milliseconds: number): string;
  isForgottenClock(entry: TimingEntry, now: Date, thresholdMinutes: number): boolean;
  isStandalonePomodoroOverdue(
    state: { startedAt?: unknown } | null | undefined,
    now: Date,
    thresholdMinutes: number,
  ): boolean;
  taskTitle(string: string): string;
}

const timingCore = require('./vendor/timing-core') as TimingCoreModule;

type StatusMode = 'active' | 'pomodoro' | 'idle';

/** TimingEntry.start 可能是 Date 也可能是 epoch 毫秒，统一成毫秒。 */
function entryStartMs(start: Date | number | null | undefined): number | null {
  if (start == null) return null;
  const ms = start instanceof Date ? start.getTime() : Number(start);
  return Number.isFinite(ms) ? ms : null;
}

function truncateTitle(title: string, maxLength = STATUSBAR_TITLE_MAX_LENGTH): string {
  const normalized = String(title || '').replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength)}…`;
}

export interface StatusBarHandle {
  destroy(): void;
}

export function renderTimingStatusBar(
  el: HTMLElement,             // plugin.addStatusBarItem() 给的元素
  ctx: ExecViewContext,        // 从 './timing-contract' 引
  onClick: (ev: MouseEvent) => void,   // 点击回调（主会话接成“打开侧栏”；带修饰键时改走定位）
): StatusBarHandle {
  el.classList.add('nautilus-log-statusbar');

  let destroyed = false;
  let latest: TimingSnapshot = ctx.runtime.getSnapshot();
  let mode: StatusMode | null = null;
  let intervalId: number | null = null;
  let titleEl: HTMLElement | null = null;
  let elapsedEl: HTMLElement | null = null;
  let pomoLabelEl: HTMLElement | null = null;

  const render = () => {
    if (destroyed) return;
    const now = Date.now();
    const focused = latest.activeWork?.focused ?? null;
    const standalone = focused
      ? null
      : (latest.standalonePomodoro as { startedAt?: unknown } | null | undefined) ?? null;

    /* ── 独立 POMO：elapsed · POMO ─────────────────────────────────── */
    if (standalone) {
      const elapsed = timingCore.formatElapsed(now - Number(standalone.startedAt));
      const overdue = timingCore.isStandalonePomodoroOverdue(
        standalone,
        new Date(now),
        ctx.pomodoroMinutes,
      );
      if (mode !== 'pomodoro') {
        el.empty();
        elapsedEl = el.createEl('span', { cls: 'nautilus-log-statusbar-elapsed' });
        el.createEl('span', { cls: 'nautilus-log-statusbar-separator', text: '·' });
        pomoLabelEl = el.createEl('span', { cls: 'nautilus-log-statusbar-pomo', text: 'POMO' });
        mode = 'pomodoro';
      }
      if (elapsedEl) elapsedEl.setText(elapsed);
      if (pomoLabelEl) pomoLabelEl.setText('POMO');
      el.classList.add('is-active', 'is-pomodoro');
      el.classList.remove('is-forgotten');
      el.classList.toggle('is-overdue', overdue);
      return;
    }

    /* ── 任务 CLOCK 在跑：标题（截断）+ 已用时长 ────────────────────── */
    if (focused) {
      const startMs = entryStartMs(focused.start);
      const elapsed = startMs === null ? '0:00' : timingCore.formatElapsed(now - startMs);
      const pomodoro = latest.pomodoro as { startedAt?: unknown } | null | undefined;
      const pomodoroElapsed = pomodoro ? now - Number(pomodoro.startedAt) : 0;
      const overdue = ctx.pomodoroMinutes > 0 && pomodoroElapsed >= ctx.pomodoroMinutes * 60000;
      const forgotten = timingCore.isForgottenClock(focused, new Date(now), ctx.forgottenTimerMinutes);
      const title = focused.title || timingCore.taskTitle(String(focused.taskString || '')) || '(untitled)';
      const truncated = truncateTitle(title);
      if (mode !== 'active') {
        el.empty();
        titleEl = el.createEl('span', { cls: 'nautilus-log-statusbar-title' });
        el.createEl('span', { cls: 'nautilus-log-statusbar-separator', text: '·' });
        elapsedEl = el.createEl('span', { cls: 'nautilus-log-statusbar-elapsed' });
        mode = 'active';
      }
      if (titleEl) {
        titleEl.setText(truncated);
        titleEl.title = title;   // 完整标题进悬停提示
      }
      if (elapsedEl) elapsedEl.setText(elapsed);
      el.classList.add('is-active');
      el.classList.remove('is-pomodoro');
      el.classList.toggle('is-overdue', overdue);
      el.classList.toggle('is-forgotten', forgotten);
      return;
    }

    /* ── 空闲：极简态，只留一个可点的图标 ───────────────────────────── */
    if (mode !== 'idle') {
      el.empty();
      setIcon(el, 'timer');
      mode = 'idle';
    }
    el.classList.remove('is-active', 'is-pomodoro', 'is-overdue', 'is-forgotten');
  };

  // 订阅即【立刻收到一次当前快照】（contract 钉死）。destroy() 必须退订。
  const unsubscribe = ctx.runtime.subscribe((snapshot) => {
    latest = snapshot;
    render();
  });
  render();

  intervalId = window.setInterval(render, 1000);
  el.addEventListener('click', onClick);

  return {
    destroy(): void {
      destroyed = true;
      if (intervalId !== null) {
        window.clearInterval(intervalId);
        intervalId = null;
      }
      unsubscribe();
      el.removeEventListener('click', onClick);
      el.classList.remove('is-active', 'is-pomodoro', 'is-overdue', 'is-forgotten');
      el.empty();
    },
  };
}
