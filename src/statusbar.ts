/*
 * statusbar.ts — 状态栏常驻块（B · 状态栏常驻块）。
 *
 * 执行层最核心的价值是「我现在有没有在计时、计了多久」——必须不打开任何东西
 * 就看得见。上游 topbar 是两层：常驻 trigger 与点开的 popover；这里实现常驻那层，
 * 落到 Obsidian 的状态栏（plugin.addStatusBarItem() 给的元素）。popover 那层由主
 * 会话把 onClick 接成「打开侧栏」。
 *
 * 显示语义（对照 src/vendor/timing-topbar.js 的 renderTrigger）：
 *   · 有任务 CLOCK 在跑：任务标题（截断）+ 已用时长 + 并发任务数（认证审计 T3-003）
 *   · 无任务 CLOCK 但有独立 POMO：elapsed · POMO（+ 常驻停止按钮，认证审计 T3-020）
 *   · 都没有：极简态（只留一个可点的图标，别占地方）
 *   · 超过 pomodoroMinutes 阈值：加 `is-overdue` class（**只变样式，不停止计时**）
 *   · 忘关警告触发：加 `is-forgotten` class
 *   · 任何一态都常驻 capacity token（今日剩余百分比，认证审计 T3-011/012/019）
 *
 * 三类状态只在【切换结构】时重建 DOM（mode 跟踪，与上游 triggerMode 同款），
 * 其余每秒只更新文本 / class，避免每秒整块重排。
 *
 * class 约定（主会话接 CSS 用）：
 *   根元素            .nautilus-log-statusbar
 *   子元素            .nautilus-log-statusbar-title / -elapsed / -pomo / -separator
 *   状态 class         is-active · is-pomodoro · is-overdue · is-forgotten
 *   上游类名（styles.css 里已有规则，认证审计 T3-011/003/020 要求发射）：
 *     .nautilus-log-timing__capacity-token / __capacity-value / __capacity-separator
 *     .nautilus-log-timing__trigger-separator / __mode-separator / __threads
 *     .nautilus-log-timing__pomodoro-close
 *
 * 时长统一走 timingCore.formatElapsed()（实跑确认收毫秒、返回 "m:ss" / "h:mm:ss"）。
 * 每次刷新用 Date.now() 作“当前时刻”：即使 runtime 不 publish，秒针照走。
 *
 * 🔴 入参是【取值函数】而不是值快照（认证审计 T3-034）：上游每次 renderTrigger
 *    都现读 settings；本移植若持有 execContext() 生成的值快照，改
 *    pomodoroMinutes / forgottenTimerMinutes / language 后状态栏会一直用旧阈值。
 *    为了不打断既有调用方，函数同时接受值与取值函数。
 */

import { setIcon } from 'obsidian';
import { stripStateTokens } from './parser';
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
  executionCopy(language: string): {
    actions: { openPanel: string; openPanelHint: string; stopPomodoro: string };
    trigger: { thread: string; threads: string; check: string };
  };
  capacitySummary(execution: unknown, language: string): {
    planned: { value: string; label: string };
    status: { value: string; label: string; warning: boolean };
    left: { value: string; label: string };
  };
}

const timingCore = require('./vendor/timing-core') as TimingCoreModule;

type StatusMode = 'active' | 'pomodoro' | 'idle';

/** 状态栏可以接受值，也可以接受取值函数（见文件头 T3-034）。 */
export type ExecContextSource = ExecViewContext | (() => ExecViewContext);

/** 点击提示：点在 capacity token 上时直落 Plan 视图（认证审计 T3-019）。
 *  主会话把它接到侧栏的初始视图上；忽略这个参数时行为与之前逐字一致。 */
export interface StatusBarClickHint {
  view?: 'plan';
}

/* ── `dHH:MM` 完成锚点剥离（认证审计 T1-022 / G1-089） ─────────────────────
 *  上游 `removeTaskState` 剥 TODO / dHH:MM / d50%，但它**没有导出**，
 *  而 `taskTitle` 只剥 TODO 与时长 token ⇒ `写稿 d14:30` 会原样进状态栏。
 *  Plan/Review 行不漏是因为它们走 `resolveTaskInstance`（先 removeTaskState
 *  再 taskTitle）。这里在适配层复刻同样的顺序。
 *  🔴 正则逐字对齐 vendor/timing-core.js:16-17，也与 src/parser.ts:88-89 一致。 */

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
  el: HTMLElement,                     // plugin.addStatusBarItem() 给的元素
  ctxSource: ExecContextSource,        // 值或取值函数（见文件头 T3-034）
  onClick: (ev: MouseEvent, hint?: StatusBarClickHint) => void,
  /** 宿主补充的提示文案（§D2 的修饰键三态）。宿主知道普通点击接的是什么，
   *  状态栏不知道 —— 所以由宿主给，而不是在这里硬编码。 */
  hostHint?: () => string,
): StatusBarHandle {
  el.classList.add('nautilus-log-statusbar');
  // 🔴 同时带上上游的 trigger 类：styles.css 里 `.is-forgotten` 那一族规则
  //    （忘关提示的橙色底 + 图标显隐）全挂在 `.nautilus-log-timing__trigger` 上。
  //    只加 `is-forgotten` 而不带这个类，规则一条都不会命中 —— 提示画不出来。
  //    与 §D3 的一贯做法一致：发射上游类名，而不是改 CSS 选择器。
  el.classList.add('nautilus-log-timing__trigger');

  /** 每次 render 现读 —— 设置改了立刻生效，不必重启执行层（T3-034）。 */
  const readCtx: () => ExecViewContext = typeof ctxSource === 'function'
    ? (ctxSource as () => ExecViewContext)
    : () => ctxSource as ExecViewContext;

  const runtime = readCtx().runtime;

  let destroyed = false;
  let latest: TimingSnapshot = runtime.getSnapshot();
  let mode: StatusMode | null = null;
  let intervalId: number | null = null;
  let titleEl: HTMLElement | null = null;
  let elapsedEl: HTMLElement | null = null;
  let pomoLabelEl: HTMLElement | null = null;
  let threadsEl: HTMLElement | null = null;
  let capacitySeparatorEl: HTMLElement | null = null;
  let capacityTokenEl: HTMLElement | null = null;
  let capacityValueEl: HTMLElement | null = null;

  /** 上游 `ui()`：每次渲染现读语言（T3-034）。文案表缺失时给英文兜底。 */
  const copy = (): ReturnType<TimingCoreModule['executionCopy']> => {
    try {
      return timingCore.executionCopy(readCtx().language);
    } catch {
      return {
        actions: { openPanel: 'Open panel', openPanelHint: '', stopPomodoro: 'Stop standalone POMO' },
        trigger: { thread: 'thread', threads: 'threads', check: 'Check CLOCK' },
      };
    }
  };

  /* ── 常驻停止 POMO 按钮（认证审计 T3-020）───────────────────────────────
   *  上游把它放在 trigger 旁的【常驻层】，不在 popover 里；本移植此前只在侧栏
   *  面板 (pomo.ts) 里有 ⇒ 停 POMO 必须先开侧栏。这里补上常驻入口。 */
  // 忘关计时器的橙色提示图标。默认 `display:none`，由 `.is-forgotten` 打开
  //  （styles.css:943/960）。上游 timing-topbar.js:701 的等价物。
  const forgottenSignalEl = document.createElement('span');
  forgottenSignalEl.className = 'nautilus-log-timing__forgotten-signal';
  forgottenSignalEl.setAttribute('aria-hidden', 'true');
  // 🔴 图标走 CSS `::before`，不写 textContent —— 上游用的是 Blueprint 图标字体
  //    （无文本节点）。写成 textContent 会让状态栏在 idle 态也带上 '⚠' 字符，
  //    污染「idle 无文本」这条断言，也会被读屏当成内容读出来。

  const pomoCloseEl = document.createElement('button');
  pomoCloseEl.type = 'button';
  pomoCloseEl.className = 'nautilus-log-timing__pomodoro-close';
  pomoCloseEl.hidden = true;
  setIcon(pomoCloseEl, 'x');
  const onPomoClose = (ev: MouseEvent): void => {
    ev.preventDefault();
    ev.stopPropagation();
    try {
      void Promise.resolve(runtime.stopStandalonePomodoro()).catch((error: unknown) => {
        console.error('[Nautilus Logger] stopStandalonePomodoro failed', error);
      });
    } catch (error) {
      console.error('[Nautilus Logger] stopStandalonePomodoro failed', error);
    }
  };
  pomoCloseEl.addEventListener('click', onPomoClose);

  /* ── 容量 token（认证审计 T3-011/012）──────────────────────────────────
   *  上游 triggerNodes() 在每种 mode 的节点后面固定挂 separator + token，
   *  没有容量摘要时两者都 hidden。这里逐条照搬，类名沿用上游的那一族。 */
  const appendCapacityNodes = (): void => {
    capacitySeparatorEl = el.createEl('span', {
      cls: 'nautilus-log-timing__trigger-separator nautilus-log-timing__capacity-separator',
    });
    capacitySeparatorEl.setAttribute('aria-hidden', 'true');
    capacitySeparatorEl.hidden = true;
    capacityTokenEl = el.createEl('span', { cls: 'nautilus-log-timing__capacity-token' });
    capacityTokenEl.hidden = true;
    capacityValueEl = capacityTokenEl.createEl('span', { cls: 'nautilus-log-timing__capacity-value' });
  };

  /** 结构重建：清空 → 由调用方填 mode 专属节点 → 容量 token → 停 POMO 按钮。 */
  const rebuild = (fill: () => void): void => {
    el.empty();
    titleEl = elapsedEl = pomoLabelEl = threadsEl = null;
    fill();
    appendCapacityNodes();
    el.appendChild(forgottenSignalEl);
    el.appendChild(pomoCloseEl);
  };

  /** capacitySummary 按 execution 对象 + language 缓存（上游 T3-098 同款）。
   *  上游做缓存是因为 trigger 每秒重算；本移植状态栏同样每秒 render ⇒ 需要。 */
  let cachedExecution: unknown = undefined;
  let cachedLanguage: string | null = null;
  let cachedSummary: ReturnType<TimingCoreModule['capacitySummary']> | null = null;
  const currentCapacitySummary = (): ReturnType<TimingCoreModule['capacitySummary']> | null => {
    const execution = (latest.planSnapshot as { execution?: unknown } | null)?.execution;
    if (!execution) return null;
    const language = readCtx().language;
    if (execution !== cachedExecution || language !== cachedLanguage) {
      cachedExecution = execution;
      cachedLanguage = language;
      try {
        cachedSummary = timingCore.capacitySummary(execution, language);
      } catch {
        cachedSummary = null;
      }
    }
    return cachedSummary;
  };

  /** 上游 updateTriggerCapacity：填 token 文本 + 全文 title，并把摘要拼进 aria-label。 */
  const updateCapacity = (baseLabel: string): void => {
    // 🔴 无障碍名必须把 §D2 的修饰键三态也带上 —— 只有明眼人能看到 title，
    //    屏幕阅读器用户拿到的是 aria-label（认证审计 P1-046 + T3-013）。
    const gestures = hostHint?.();
    const ariaLabel = [baseLabel, gestures].filter(Boolean).join(', ');
    const summary = currentCapacitySummary();
    if (!summary || !capacitySeparatorEl || !capacityTokenEl || !capacityValueEl) {
      if (capacitySeparatorEl) capacitySeparatorEl.hidden = true;
      if (capacityTokenEl) capacityTokenEl.hidden = true;
      el.setAttribute('aria-label', ariaLabel);
      return;
    }
    const summaryText =
      `${summary.planned.value} ${summary.planned.label}`
      + ` · ${summary.status.value} ${summary.status.label}`
      + ` · ${summary.left.value} ${summary.left.label}`;
    capacitySeparatorEl.hidden = false;
    capacityTokenEl.hidden = false;
    capacityTokenEl.classList.remove('is-warning');
    capacityValueEl.setText(summary.left.value);
    capacityTokenEl.title = summaryText;   // T3-012：token 的 title = 三段全文
    el.setAttribute('aria-label', `${ariaLabel}, ${summaryText}`);
  };

  const render = () => {
    if (destroyed) return;
    const ctx = readCtx();
    const text = copy();
    const now = Date.now();
    const focused = latest.activeWork?.focused ?? null;
    const standalone = focused
      ? null
      : (latest.standalonePomodoro as { startedAt?: unknown } | null | undefined) ?? null;

    // T3-013 / T3-021 / P1-102：三态提示文案 —— 本移植的常驻层没有 topbar，
    // 提示挂在状态栏自身的 aria-description + title 上。
    el.setAttribute('aria-description', text.actions.openPanelHint);
    // 🔴 title 由【状态栏】独占 —— main.ts 那边也曾写一次，被这里覆盖掉
    //    （两路 agent 并行时的集成冲突）。合并成一条：引擎自带的
    //    `openPanelHint` + §D2 的修饰键三态。三态只写在代码注释里没用，
    //    用户看不见（认证审计 P1-046）。
    const hint = hostHint?.();
    el.title = [text.actions.openPanelHint, hint].filter(Boolean).join('\n');

    /* ── 独立 POMO：elapsed · POMO ─────────────────────────────────── */
    if (standalone) {
      const elapsed = timingCore.formatElapsed(now - Number(standalone.startedAt));
      const overdue = timingCore.isStandalonePomodoroOverdue(
        standalone,
        new Date(now),
        ctx.pomodoroMinutes,
      );
      if (mode !== 'pomodoro') {
        rebuild(() => {
          elapsedEl = el.createEl('span', { cls: 'nautilus-log-statusbar-elapsed' });
          el.createEl('span', { cls: 'nautilus-log-statusbar-separator', text: '·' });
          pomoLabelEl = el.createEl('span', { cls: 'nautilus-log-statusbar-pomo', text: 'POMO' });
        });
        mode = 'pomodoro';
      }
      if (elapsedEl) elapsedEl.setText(elapsed);
      if (pomoLabelEl) pomoLabelEl.setText('POMO');
      pomoCloseEl.hidden = false;
      pomoCloseEl.title = text.actions.stopPomodoro;
      pomoCloseEl.setAttribute('aria-label', text.actions.stopPomodoro);
      el.classList.add('is-active', 'is-pomodoro');
      el.classList.remove('is-forgotten');
      el.classList.toggle('is-overdue', overdue);
      updateCapacity(`${elapsed}, POMO`);
      return;
    }

    /* ── 任务 CLOCK 在跑：标题（截断）+ 已用时长 + 并发数 ─────────────── */
    if (focused) {
      const startMs = entryStartMs(focused.start);
      const elapsed = startMs === null ? '0:00' : timingCore.formatElapsed(now - startMs);
      const pomodoro = latest.pomodoro as { startedAt?: unknown } | null | undefined;
      const pomodoroElapsed = pomodoro ? now - Number(pomodoro.startedAt) : 0;
      const overdue = ctx.pomodoroMinutes > 0 && pomodoroElapsed >= ctx.pomodoroMinutes * 60000;
      const forgotten = timingCore.isForgottenClock(focused, new Date(now), ctx.forgottenTimerMinutes);
      // T1-022：taskTitle 不剥 `dHH:MM`，Plan/Review 之所以不漏是先过 removeTaskState。
      const title = stripStateTokens(
        focused.title || timingCore.taskTitle(String(focused.taskString || '')),
      ) || '(untitled)';
      const truncated = truncateTitle(title);
      // T3-003：并发任务数「N thread(s)」，单复数按 count===1 切（上游 :718）。
      const count = Number(latest.activeWork?.count) || 0;
      const threads = `${count} ${count === 1 ? text.trigger.thread : text.trigger.threads}`;
      if (mode !== 'active') {
        rebuild(() => {
          titleEl = el.createEl('span', { cls: 'nautilus-log-statusbar-title' });
          el.createEl('span', { cls: 'nautilus-log-statusbar-separator', text: '·' });
          elapsedEl = el.createEl('span', { cls: 'nautilus-log-statusbar-elapsed' });
          const modeSeparator = el.createEl('span', {
            cls: 'nautilus-log-timing__trigger-separator nautilus-log-timing__mode-separator',
          });
          modeSeparator.setAttribute('aria-hidden', 'true');
          threadsEl = el.createEl('span', { cls: 'nautilus-log-timing__threads' });
        });
        mode = 'active';
      }
      if (titleEl) {
        titleEl.setText(truncated);
        titleEl.title = title;   // 完整标题进悬停提示
      }
      if (elapsedEl) elapsedEl.setText(elapsed);
      if (threadsEl) threadsEl.setText(threads);
      pomoCloseEl.hidden = true;
      el.classList.add('is-active');
      el.classList.remove('is-pomodoro');
      el.classList.toggle('is-overdue', overdue);
      el.classList.toggle('is-forgotten', forgotten);
      updateCapacity(`${forgotten ? `${text.trigger.check}, ` : ''}${elapsed}, ${threads}`);
      return;
    }

    /* ── 空闲：极简态，只留一个可点的图标 ───────────────────────────── */
    if (mode !== 'idle') {
      rebuild(() => { setIcon(el, 'timer'); });
      mode = 'idle';
    }
    pomoCloseEl.hidden = true;
    el.classList.remove('is-active', 'is-pomodoro', 'is-overdue', 'is-forgotten');
    updateCapacity(text.actions.openPanel);
  };

  /* ── 可访问性（认证审计 T3-013）────────────────────────────────────────
   *  上游 trigger 是个带完整 aria 的 button；Obsidian 的状态栏项是 div，
   *  所以显式给出 role/tabindex，并把键盘激活接到同一个 onClick 上 ——
   *  只写 role="button" 而不接键盘比不写更糟。 */
  el.setAttribute('role', 'button');
  el.setAttribute('tabindex', '0');

  const handleClick = (ev: MouseEvent): void => {
    const target = ev.target as Element | null;
    if (target && typeof target.closest === 'function') {
      // 停 POMO 按钮自己处理，别顺手把侧栏也打开。
      if (target.closest('.nautilus-log-timing__pomodoro-close')) return;
      // T3-019：点在 capacity token 上 => 直落 Plan 视图。
      if (target.closest('.nautilus-log-timing__capacity-token')) {
        onClick(ev, { view: 'plan' });
        return;
      }
    }
    onClick(ev);
  };

  const handleKeyDown = (ev: KeyboardEvent): void => {
    if (ev.key !== 'Enter' && ev.key !== ' ') return;
    ev.preventDefault();
    onClick(new MouseEvent('click', { altKey: ev.altKey, shiftKey: ev.shiftKey }));
  };

  // 订阅即【立刻收到一次当前快照】（contract 钉死）。destroy() 必须退订。
  const unsubscribe = runtime.subscribe((snapshot) => {
    latest = snapshot;
    render();
  });
  render();

  intervalId = window.setInterval(render, 1000);
  el.addEventListener('click', handleClick);
  el.addEventListener('keydown', handleKeyDown);

  return {
    destroy(): void {
      destroyed = true;
      if (intervalId !== null) {
        window.clearInterval(intervalId);
        intervalId = null;
      }
      unsubscribe();
      el.removeEventListener('click', handleClick);
      el.removeEventListener('keydown', handleKeyDown);
      pomoCloseEl.removeEventListener('click', onPomoClose);
      el.classList.remove('is-active', 'is-pomodoro', 'is-overdue', 'is-forgotten');
      el.empty();
    },
  };
}
