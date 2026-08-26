/*
 * exec-panel.ts — Nautilus Log 执行层面板（E · 执行层面板 · 三视图）。
 *
 * 把上游 timing-topbar 的 popover 三视图（Timing / Plan / Review）做成
 * Obsidian 侧栏里的常驻面板。数据【全部】来自 ctx.runtime.getSnapshot()，
 * 不自己读文件、不自己算 —— 一切语义照 src/vendor/timing-core.js 的实现。
 *
 * 视图与数据对应（ref/guide.md §Execution Layer 的语义，别自己发明）：
 *   Timing  ← snapshot.activeWork.focused / .recent
 *   Plan    ← snapshot.planSnapshot.tasks（projectPlan 产出的未完成直接子任务）
 *   Review  ← snapshot.dailyReview（buildDailyReview 产出的 summary + rows）
 *
 * 订阅：subscribe 即刻收到一次当前快照；之后每次推送都重渲染当前视图。
 * 与上游一致，用 timingCore.executionStructureKey(snapshot, view) 判断是否需要
 * 整棵重建：只有结构变化（revision / status / notice）才重建；纯时钟走动
 * （runtime 每秒只改 now）只就地更新计时文字 —— 否则每秒重建会掉焦点、丢确认态。
 *
 * 🔴 destroy() 必须退订，否则面板销毁后还在被 runtime 重渲染（泄漏）。
 * 🔴 忘关计时器【只警告、绝不自动停止或删除 CLOCK】（上游硬立场）。
 * 🔴 同一时刻只允许一个任务 CLOCK 在跑：切换任务 = runtime.startTask() 内部
 *    先关旧再开新，面板不自己调度。
 *
 * 上游基线：404KSG/roam-nautilus-log @ 7bf19a1d
 */

import type { ExecViewContext, TimingSnapshot, TimingEntry } from './timing-contract';
import { stripStateTokens } from './parser';

/** vendored timing-core 的 CJS 面 —— 手动钉住本项目用到的函数签名。
 *  （照类型猜返回值在本项目栽过两次跟头，这里逐条实跑核对过。） */
interface TimingCore {
  executionCopy(language: string): {
    tabs: { timing: string; plan: string; review: string };
    identity: { locate: string; views: string; panel: string };
    actions: {
      clockIn: string; clockOut: string; complete: string;
      deleteClock: string; confirmDelete: string; openPanel: string;
      startPomodoro: string; stopPomodoro: string;
    };
    plan: { scheduled: string; unscheduled: string; today: string };
    timing: { timing: string; actual: string; planned: string; remaining: string; recent: string; left: string; check: string };
    review: {
      summary: string; completed: string; compared: string; actual: string;
      planned: string; variance: string; live: string; paused: string;
      notTracked: string; notStarted: string;
    };
    empty: { noActive: string; noLog: string; noPlanTasks: string; noReviewTasks: string };
    capacity: { label: string; available: string; remaining: string; overload: string; noSlot: string };
  };
  formatElapsed(milliseconds: number): string;
  compactMinutes(minutes: number): string;
  plannedMinutes(string: string, fallback?: number): number;
  durationMetadata(args: {
    taskUid?: string; plannedMinutes?: number; entries?: TimingEntry[];
    now?: Date; language?: string;
  }): { primaryLabel: string; detailLabel: string; actualMinutes: number; plannedMinutes: number };
  isForgottenClock(entry: TimingEntry, now: Date, thresholdMinutes: number): boolean;
  executionStructureKey(snapshot: TimingSnapshot, view: string): string;
  /** `d50%` 进度 token（0-100）。见 PORTING-DECISIONS.md §D3 的「多填 progress」修正。 */
  taskProgress(string: string): number;
  /** 容量三段摘要（Planned · Over/Free · Left%）。上游 topbar 三 tab 常驻，
   *  本移植此前【零调用方】—— 见 §7「引擎导出面」检测器与 audit §P1-2。 */
  capacitySummary(execution: unknown, language: string): {
    planned: { value: string; label: string };
    status: { value: string; label: string; warning: boolean };
    left: { value: string; label: string };
  };
}

const timingCore = require('./vendor/timing-core') as unknown as TimingCore;

type ViewName = 'timing' | 'plan' | 'review';

/** planSnapshot.tasks 里的一条未完成直接子任务（projectPlan 的产出）。 */
interface PlanTask {
  uid: string;
  string: string;
  title: string;
  plannedMinutes: number;
  remainingMinutes: number;
  progress: number;
  /** 仅 execution.scheduledTasks 的行有：当天排定区间（自 00:00 起的分钟数）。 */
  start?: number;
  end?: number;
}

/** planSnapshot.execution —— vendored runtime 的 executionProjection 产出。
 *  🔴 本移植此前【从未读取】这一支，Plan 的分节与容量条因此整个丢失（audit §P1-2）。 */
interface ExecutionProjection {
  scheduledTasks?: PlanTask[];
  overflowTasks?: PlanTask[];
}

/** buildDailyReview 的一行（照实际返回抄写；contract 故意留了 unknown 面）。 */
interface ReviewRow {
  uid: string;
  title: string;
  plannedMinutes: number;
  status: string | null;
  state: string;
  actualMinutes: number;
  varianceMinutes: number | null;
}

interface ReviewSummary {
  totalCount: number;
  completedCount: number;
  comparedCount: number;
  plannedMinutes: number;
  actualMinutes: number;
  varianceMinutes: number;
}

interface DailyReviewData {
  summary: ReviewSummary;
  rows: ReviewRow[];
}

const EMPTY_REVIEW: DailyReviewData = {
  summary: {
    totalCount: 0, completedCount: 0, comparedCount: 0,
    plannedMinutes: 0, actualMinutes: 0, varianceMinutes: 0,
  },
  rows: [],
};

function toMs(value: Date | number | null | undefined): number {
  if (value instanceof Date) return value.getTime();
  return Number(value) || 0;
}

/* ── `dHH:MM` 完成锚点剥离（认证审计 T1-022 / G1-089）───────────────────────
 *  上游 `taskTitle` 只剥 TODO 与时长 token，**不剥** `dHH:MM` / `d50%`；
 *  Plan/Review 行之所以干净，是因为它们走 `resolveTaskInstance`
 *  （timing-core.js:325 先 `removeTaskState` 再 `taskTitle`）。
 *  Timing 视图的行标题直接用 `entry.title` ⇒ 用户会看到「写周报 d11:20」。
 *  `removeTaskState` 上游没导出，这里在适配层复刻同一顺序。
 *  🔴 正则逐字对齐 vendor/timing-core.js:16-17，也与 src/parser.ts:88-89 一致。 */

/** 面板可以接受值，也可以接受取值函数。见 §T3-034：`execContext()` 生成的是
 *  值快照，持有它 ⇒ 改 language / 阈值后面板一直用旧值直到重建。 */
export type ExecContextSource = ExecViewContext | (() => ExecViewContext);

/** 面板的「视图态」—— 数据之外、用户手动摆出来的那部分（认证审计 T3-034）。
 *  侧栏重建面板时必须带过去，否则每次设置变更都把用户踢回 Timing 视图、
 *  并把 Unscheduled 分节重新收起。 */
export interface ExecPanelViewState {
  view: ViewName;
  unscheduledExpanded: boolean;
}

export interface ExecPanelHandle {
  destroy(): void;
  /** 强制重渲（设置变更后用它，而不是销毁重建 —— 见 T3-034）。 */
  refresh(): void;
  /** 交给侧栏，在不得不重建时把视图态搬过去。 */
  getViewState(): ExecPanelViewState;
}

export function renderExecPanel(
  container: HTMLElement,
  ctxSource: ExecContextSource,
  options: { viewState?: Partial<ExecPanelViewState> } = {},
): ExecPanelHandle {
  /** 🔴 每次用到都现读（T3-034）。别在这里解构成局部常量。 */
  const readCtx: () => ExecViewContext = typeof ctxSource === 'function'
    ? (ctxSource as () => ExecViewContext)
    : () => ctxSource as ExecViewContext;
  const runtime = readCtx().runtime;
  const language = (): string => readCtx().language;
  const copy = () => timingCore.executionCopy(language());

  let destroyed = false;
  let view: ViewName = options.viewState?.view || 'timing';
  let state: TimingSnapshot = runtime.getSnapshot();
  let lastStructureKey: string | null = null;
  let unsubscribe: (() => void) | null = null;
  let deleteConfirmation: { clockUid: string; button: HTMLButtonElement; timer: number } | null = null;
  /** Plan 的 Unscheduled 分节是否展开（上游默认收起，只显示计数）。 */
  let unscheduledExpanded = options.viewState?.unscheduledExpanded ?? false;

  container.addClass('nautilus-log-exec-panel');

  const clearDeleteConfirmation = () => {
    if (!deleteConfirmation) return;
    window.clearTimeout(deleteConfirmation.timer);
    const button = deleteConfirmation.button;
    button.classList.remove('is-confirming');
    button.setText(copy().actions.deleteClock);
    button.title = copy().actions.deleteClock;
    button.setAttribute('aria-label', copy().actions.deleteClock);
    deleteConfirmation = null;
  };

  const runAction = (action: () => unknown): void => {
    try {
      void Promise.resolve(action()).catch((error) => {
        console.error('[Nautilus Log] execution panel action failed', error);
      });
    } catch (error) {
      console.error('[Nautilus Log] execution panel action failed', error);
    }
  };

  /** ctx.forgottenTimerMinutes > 0 且当前 CLOCK 已跑超过阈值才算忘关。 */
  const isForgotten = (entry: TimingEntry): boolean => {
    const threshold = Number(readCtx().forgottenTimerMinutes) || 0;
    if (threshold <= 0) return false;
    return timingCore.isForgottenClock(entry, state.now, threshold);
  };

  /** 未标时长的任务用哪个兜底：设置里的 todo-duration。
   *  🔴 上游同名代码读 `settings.get('todo-duration')`（timing-topbar.js:331）；
   *  本移植此前硬编码 15 —— 恰好等于 DEFAULT_SETTINGS，所以只有改过设置的
   *  用户会撞上、测试必绿。这正是 PORTING-DECISIONS.md §D7 描述的静默模式。 */
  const todoDuration = (): number => Number(readCtx().todoDuration) || 15;

  /** 从一条 CLOCK 条目还原成 plan 行形状（上游 activeTask）。 */
  const activeTask = (entry: TimingEntry): PlanTask => {
    const planned = timingCore.plannedMinutes(entry.taskString || '', todoDuration());
    const progress = timingCore.taskProgress(entry.taskString || '');
    return {
      uid: entry.taskUid || '',
      string: entry.taskString || '',
      // T1-022：entry.title 走的是 taskTitle()，`dHH:MM` 还留在里面。
      title: stripStateTokens(entry.title) || '(untitled)',
      plannedMinutes: planned,
      // 🔴 此前这里硬填 progress: 0 / remainingMinutes: 0，于是「在计时的任务」
      //    进度恒 0、剩余恒 0，与 Plan 行（走 resolveTaskInstance）自相矛盾。
      //    语义照 vendor/timing-core.js:351-352（contract.ts:40 声明的 0-100 折减）。
      progress,
      remainingMinutes: Math.max(0, Math.round(planned * (1 - progress / 100))),
    };
  };

  const signedMinutes = (minutes: number): string => {
    const value = Number(minutes) || 0;
    if (value === 0) return '0m';
    return `${value > 0 ? '+' : '−'}${timingCore.compactMinutes(Math.abs(value))}`;
  };

  /* ─────────────────────────── 行 / 视图构建 ─────────────────────────── */

  /** 分钟数 → HH:MM（上游 timing-topbar.js:282-286 formatPlanClock 的等价实现）。 */
  const formatPlanClock = (minutes: number | undefined): string => {
    const safe = Math.max(0, Math.min(1440, Math.round(Number(minutes) || 0)));
    if (safe === 1440) return '24:00';
    return `${String(Math.floor(safe / 60)).padStart(2, '0')}:${String(safe % 60).padStart(2, '0')}`;
  };

  type RowOpts = {
    recent?: boolean;
    entry?: TimingEntry | null;
    /** '' | 'scheduled' | 'unscheduled' —— 上游 taskRow 的 planState（timing-topbar.js:186-234）。 */
    planState?: '' | 'scheduled' | 'unscheduled';
  };

  const taskRow = (list: HTMLElement, task: PlanTask, opts: RowOpts = {}): HTMLElement => {
    const text = copy();
    const focusedEntry = state.activeWork?.focused || null;
    const focused = !!focusedEntry && focusedEntry.taskUid === task.uid;
    const recent = !!opts.recent;
    const entry = opts.entry || null;

    const planState = opts.planState || '';

    const row = list.createDiv({ cls: 'nautilus-log-exec-row' });
    row.dataset.taskUid = task.uid;
    // 机器可读面（沿用 data-task-uid / data-review-live-actual 的既有做法）：
    // 把折减前后的分钟数落到行上，进度语义（contract.ts:40）因此可被直接断言，
    // 不必等某个视图恰好把它渲染成文字。
    row.dataset.plannedMinutes = String(task.plannedMinutes);
    row.dataset.remainingMinutes = String(Math.max(0, Number(task.remainingMinutes) || 0));
    if (planState) row.classList.add(`is-${planState}`);
    if (focused) row.classList.add('is-focused');
    const forgotten = focused && focusedEntry ? isForgotten(focusedEntry) : false;
    if (forgotten) row.classList.add('is-forgotten');

    const copyEl = row.createDiv({ cls: 'nautilus-log-exec-row-copy' });
    // T1-022 / G1-089：Plan 行来自 resolveTaskInstance（已干净），Timing 行来自
    // activeTask（已在那里剥过）；这里再过一次是幂等的最后一道闸。
    const displayTitle = stripStateTokens(task.title) || '(untitled)';
    const title = copyEl.createEl('button', { cls: 'nautilus-log-exec-row-title', text: displayTitle });
    title.type = 'button';
    title.title = displayTitle;
    title.addEventListener('click', (event: MouseEvent) => {
      runAction(() => runtime.openTask(task.uid, { sidebar: event.shiftKey }));
    });

    const duration = timingCore.durationMetadata({
      taskUid: task.uid,
      plannedMinutes: task.plannedMinutes,
      entries: state.entries,
      now: state.now,
      language: language(),
    });

    const timingText = focused && focusedEntry
      ? `${text.timing.timing} ${timingCore.formatElapsed(state.now.getTime() - toMs(focusedEntry.start))} · ${duration.detailLabel}`
      : '';

    // Remaining/Planned 段：进度折减后还剩多少 vs 计划多少（上游 planDurationText）。
    const remainingPlanMinutes = Math.max(0, Number(task.remainingMinutes) || 0);
    const planDurationText = remainingPlanMinutes > 0 && remainingPlanMinutes < task.plannedMinutes
      ? `${text.timing.remaining} ${timingCore.compactMinutes(remainingPlanMinutes)} · ${text.timing.planned} ${timingCore.compactMinutes(task.plannedMinutes)}`
      : `${text.timing.planned} ${timingCore.compactMinutes(task.plannedMinutes)}`;

    let metaText = duration.detailLabel; // 普通 plan 行：Planned/Actual（上游默认分支）
    // 🔴 上游分支顺序：planState 优先于 focused（timing-topbar.js:221-231）。
    //    Plan 视图里在计时的任务显示的是【排定区间】，不是秒表 —— 别调换。
    if (planState === 'scheduled') {
      metaText = `${text.plan.today} ${formatPlanClock(task.start)}–${formatPlanClock(task.end)} · ${planDurationText}`;
    } else if (planState === 'unscheduled') {
      metaText = `${text.plan.unscheduled} · ${planDurationText}`;
    } else if (focused) {
      metaText = `${forgotten ? `${text.timing.check} · ` : ''}${timingText}`;
    } else if (recent && entry?.end) {
      const recentRemaining = Math.max(0, Math.ceil(
        (Number(state.activeWork?.windowMinutes || 0) * 60000 - (state.now.getTime() - toMs(entry.end))) / 60000,
      ));
      metaText = `${text.timing.recent} · ${timingCore.compactMinutes(recentRemaining)} ${text.timing.left} · ${duration.detailLabel}`;
    }

    // is-live 只给「秒表在走」的那一行 —— Plan 分节里的行是静态区间文字，
    // 打上 is-live 会被 updateLiveElapsed 每秒覆写成秒表（上游 liveMeta 同款守卫）。
    const liveMeta = focused && !planState;
    copyEl.createDiv({
      cls: `nautilus-log-exec-row-meta${liveMeta ? ' is-live' : ''}${forgotten ? ' is-warning' : ''}`,
    }).setText(metaText);

    const actions = row.createDiv({ cls: 'nautilus-log-exec-row-actions' });
    const timingAction = actions.createEl('button', {
      cls: 'nautilus-log-exec-action',
      text: focused ? text.actions.clockOut : text.actions.clockIn,
    });
    timingAction.type = 'button';
    timingAction.title = focused ? text.actions.clockOut : text.actions.clockIn;
    timingAction.addEventListener('click', () => {
      runAction(() => (focused ? runtime.stopTask() : runtime.startTask(task.uid)));
    });
    timingAction.disabled = state.status === 'working';

    const completeAction = actions.createEl('button', {
      cls: 'nautilus-log-exec-action is-complete',
      text: text.actions.complete,
    });
    completeAction.type = 'button';
    completeAction.title = text.actions.complete;
    completeAction.addEventListener('click', () => {
      runAction(() => runtime.completeTask(task.uid));
    });
    completeAction.disabled = state.status === 'working';

    if (focused) {
      const deleteAction = actions.createEl('button', {
        cls: 'nautilus-log-exec-action is-delete-clock',
        text: text.actions.deleteClock,
      });
      deleteAction.type = 'button';
      deleteAction.title = text.actions.deleteClock;
      deleteAction.addEventListener('click', () => {
        const clockUid = state.activeWork?.focused?.clockUid;
        if (!clockUid) return;
        if (deleteConfirmation && deleteConfirmation.clockUid === clockUid) {
          clearDeleteConfirmation();
          deleteAction.disabled = true;
          // 🔴 契约把 deleteCurrentClock 标成无参，但 vendor 运行时与上游实现
          //    都要求传 taskUid（否则抛 "Only the current Timing CLOCK…"）。
          //    按实际实现调，分歧见交差报告。
          runAction(() => (runtime.deleteCurrentClock as (taskUid: string) => Promise<unknown>)(task.uid));
          return;
        }
        clearDeleteConfirmation();
        deleteAction.classList.add('is-confirming');
        deleteAction.setText(text.actions.confirmDelete);
        deleteAction.title = text.actions.confirmDelete;
        deleteAction.setAttribute('aria-label', text.actions.confirmDelete);
        deleteConfirmation = {
          clockUid,
          button: deleteAction,
          timer: window.setTimeout(() => clearDeleteConfirmation(), 2500),
        };
      });
      deleteAction.disabled = state.status === 'working';
    }
    return row;
  };

  const reviewSummary = (list: HTMLElement, summary: ReviewSummary): HTMLElement => {
    const text = copy().review;
    const section = list.createDiv({ cls: 'nautilus-log-exec-review-summary' });
    section.setAttribute('aria-label', text.summary);

    const counts = section.createDiv({ cls: 'nautilus-log-exec-review-counts' });
    const completed = counts.createDiv({ cls: 'nautilus-log-exec-review-count' });
    completed.appendChild(document.createTextNode(`${text.completed} `));
    completed.createEl('strong', { text: `${summary.completedCount || 0}/${summary.totalCount || 0}` });
    const compared = counts.createDiv({ cls: 'nautilus-log-exec-review-count' });
    compared.appendChild(document.createTextNode(`${text.compared} `));
    compared.createEl('strong', { text: String(summary.comparedCount || 0) });

    const totals = section.createDiv({ cls: 'nautilus-log-exec-review-totals' });
    const metric = (label: string, value: string, className = ''): void => {
      const item = totals.createDiv({ cls: `nautilus-log-exec-review-total${className ? ` ${className}` : ''}` });
      item.appendChild(document.createTextNode(`${label} `));
      item.createEl('strong', { text: value });
    };
    const variance = Number(summary.varianceMinutes) || 0;
    const comparable = Number(summary.comparedCount) > 0;
    metric(text.planned, comparable ? timingCore.compactMinutes(summary.plannedMinutes || 0) : '—');
    metric(text.actual, comparable ? timingCore.compactMinutes(summary.actualMinutes || 0) : '—');
    metric(text.variance, comparable ? signedMinutes(variance) : '—', comparable && variance > 0 ? 'is-over' : '');
    return section;
  };

  const reviewRow = (list: HTMLElement, task: ReviewRow): HTMLElement => {
    const text = copy().review;
    const stateLabels: Record<string, string> = {
      compared: text.compared,
      live: text.live,
      paused: text.paused,
      'not-tracked': text.notTracked,
      'not-started': text.notStarted,
    };
    const row = list.createDiv({ cls: `nautilus-log-exec-review-row is-${task.state}` });
    row.dataset.taskUid = task.uid;

    const heading = row.createDiv({ cls: 'nautilus-log-exec-review-row-heading' });
    const displayTitle = stripStateTokens(task.title) || '(untitled)';   // T1-022
    const title = heading.createEl('button', { cls: 'nautilus-log-exec-review-title', text: displayTitle });
    title.type = 'button';
    title.title = displayTitle;
    title.addEventListener('click', (event: MouseEvent) => {
      runAction(() => runtime.openTask(task.uid, { sidebar: event.shiftKey }));
    });
    heading.createEl('span', {
      cls: 'nautilus-log-exec-review-state',
      text: stateLabels[task.state] || task.state,
    });

    const metrics = row.createDiv({ cls: 'nautilus-log-exec-review-row-metrics' });
    metrics.createEl('span', {
      cls: 'nautilus-log-exec-review-planned',
      text: `${text.planned} ${timingCore.compactMinutes(task.plannedMinutes)}`,
    });
    const actualLabel = task.state === 'not-tracked' || task.state === 'not-started'
      ? `${text.actual} —`
      : `${text.actual} ${timingCore.compactMinutes(task.actualMinutes)}`;
    const actual = metrics.createEl('span', { cls: 'nautilus-log-exec-review-actual', text: actualLabel });
    if (task.state === 'live') actual.dataset.reviewLiveActual = task.uid;
    if (task.state === 'compared') {
      metrics.createEl('span', {
        cls: `nautilus-log-exec-review-variance${task.varianceMinutes && task.varianceMinutes > 0 ? ' is-over' : ''}`,
        text: signedMinutes(Number(task.varianceMinutes) || 0),
      });
    }
    return row;
  };

  /** 分节标题：`标签 · N`。可折叠的那节渲染成 button（上游 planSectionHeader，
   *  timing-topbar.js:306-320）。 */
  const planSectionHeader = (
    section: HTMLElement,
    { label, count, collapsible = false, expanded = true }:
      { label: string; count: number; collapsible?: boolean; expanded?: boolean },
  ): HTMLElement => {
    const cls = `nautilus-log-exec-plan-heading${collapsible ? ' is-collapsible' : ''}`;
    const header = collapsible
      ? section.createEl('button', { cls })
      : section.createDiv({ cls });
    if (collapsible) {
      (header as HTMLButtonElement).type = 'button';
      header.setAttribute('aria-expanded', String(expanded));
      // 🔴 折叠箭头必须是独立的 aria-hidden 图标，不能拼进标签文本 ——
      //    否则屏幕阅读器会把「▾」念出来（上游同样是独立图标 + aria-expanded
      //    才是状态的可访问载体）。
      header.createEl('span', {
        cls: 'nautilus-log-exec-plan-arrow',
        text: expanded ? '▾' : '▸',
      }).setAttribute('aria-hidden', 'true');
    }
    header.createEl('span', {
      cls: 'nautilus-log-exec-plan-label',
      text: `${label} · ${count}`,
    });
    return header;
  };

  /** 三个 tab 常驻的容量条（上游 timing-topbar.js:288-304 capacityStrip）。
   *  数据全部来自 timingCore.capacitySummary —— 别自己算，见文件头注释。 */
  const renderCapacity = (): void => {
    const execution = (state.planSnapshot?.execution || null) as ExecutionProjection | null;
    if (!execution) return;
    const summary = timingCore.capacitySummary(execution, language());
    const strip = container.createDiv({ cls: 'nautilus-log-exec-capacity' });
    strip.setAttribute('aria-label', copy().capacity.label);
    const metric = strip.createDiv({ cls: 'nautilus-log-exec-capacity-metric' });
    const part = (piece: { value: string; label: string }, warning = false): void => {
      const node = metric.createEl('span', {
        cls: `nautilus-log-exec-capacity-part${warning ? ' is-warning' : ''}`,
      });
      node.createEl('strong', { text: piece.value });
      node.appendChild(document.createTextNode(` ${piece.label}`));
    };
    part(summary.planned);
    metric.appendChild(document.createTextNode(' · '));
    part(summary.status, summary.status.warning);
    metric.appendChild(document.createTextNode(' · '));
    part(summary.left);
  };

  const renderList = (): void => {
    const text = copy();
    const list = container.createDiv({ cls: 'nautilus-log-exec-list' });

    if (view === 'timing') {
      const focused = state.activeWork?.focused || null;
      const recent = state.activeWork?.recent || [];
      if (focused) {
        if (isForgotten(focused)) {
          // 🔴 忘关计时器：只警告。绝不自动 stopTask / deleteCurrentClock。
          list.createDiv({ cls: 'nautilus-log-exec-forgotten' })
            .setText(`${text.timing.check}: ${activeTask(focused).title}`);
        }
        taskRow(list, activeTask(focused), { entry: focused });
      }
      recent.forEach((entry) => {
        taskRow(list, activeTask(entry), { recent: true, entry });
      });
      if (!focused && recent.length === 0) {
        list.createDiv({ cls: 'nautilus-log-exec-empty' }).setText(text.empty.noActive);
      }
    } else if (view === 'plan') {
      const plan = (state.planSnapshot || {}) as { plan?: { uid?: string } | null; tasks?: PlanTask[] };
      const tasks = plan.tasks || [];
      list.classList.add('is-plan');
      // 🔴 planSnapshot.execution 是 vendored runtime 早就产出的 scheduled/overflow
      //    分组，本移植此前从未读取，Plan 因而只有一张平铺列表（audit §P1-2）。
      //    execution 缺席（没有计划/旧快照）时退回平铺 —— 与上游 else 分支一致。
      const execution = (state.planSnapshot?.execution || null) as ExecutionProjection | null;
      const scheduled = execution?.scheduledTasks || [];
      const unscheduled = execution?.overflowTasks || [];
      if (tasks.length > 0 && execution) {
        const scheduledSection = list.createDiv({ cls: 'nautilus-log-exec-plan-section is-scheduled' });
        planSectionHeader(scheduledSection, { label: text.plan.scheduled, count: scheduled.length });
        scheduled.forEach((task) => taskRow(scheduledSection, task, { planState: 'scheduled' }));

        if (unscheduled.length > 0) {
          const unscheduledSection = list.createDiv({ cls: 'nautilus-log-exec-plan-section is-unscheduled' });
          const disclosure = planSectionHeader(unscheduledSection, {
            label: text.plan.unscheduled,
            count: unscheduled.length,
            collapsible: true,
            expanded: unscheduledExpanded,
          });
          disclosure.addEventListener('click', () => {
            unscheduledExpanded = !unscheduledExpanded;
            render(state, true);
          });
          if (unscheduledExpanded) {
            unscheduled.forEach((task) => taskRow(unscheduledSection, task, { planState: 'unscheduled' }));
          }
        }
      } else {
        tasks.forEach((task) => taskRow(list, task));
      }
      if (!state.planSnapshot?.plan) {
        list.createDiv({ cls: 'nautilus-log-exec-empty' }).setText(text.empty.noLog);
      } else if (tasks.length === 0) {
        list.createDiv({ cls: 'nautilus-log-exec-empty' }).setText(text.empty.noPlanTasks);
      }
    } else {
      const review = (state.dailyReview || {}) as Partial<DailyReviewData>;
      const rows = review.rows || [];
      list.classList.add('is-review');
      if (state.planSnapshot?.plan && rows.length > 0) {
        reviewSummary(list, review.summary || EMPTY_REVIEW.summary);
      }
      rows.forEach((task) => reviewRow(list, task));
      if (!state.planSnapshot?.plan) {
        list.createDiv({ cls: 'nautilus-log-exec-empty' }).setText(text.empty.noLog);
      } else if (rows.length === 0) {
        list.createDiv({ cls: 'nautilus-log-exec-empty' }).setText(text.empty.noReviewTasks);
      }
    }
  };

  /* ─────────────────────────── 壳：头部 + 通知 ─────────────────────────── */

  const renderHeader = (): void => {
    const text = copy();
    const header = container.createDiv({ cls: 'nautilus-log-exec-header' });

    const identity = header.createEl('button', { cls: 'nautilus-log-exec-identity', text: text.identity.locate });
    identity.type = 'button';
    identity.setAttribute('aria-label', text.identity.locate);
    // 修饰键手势（上游 7850e58 / d807ea4）：普通点击不变，
    // Alt/Option-click 在主编辑区定位，Shift-click 送右侧栏。
    // 🔴 底层 openTaskInRightSidebar 早就有，之前只是没接线。
    identity.title = `${text.identity.locate} · ⌥ / ⇧`;
    identity.addEventListener('click', (ev: MouseEvent) => {
      // ⌥ 与普通点击在这里【本来就同义】（都是主编辑区定位）——
      // title 写着「⌥ / ⇧」是为了让用户知道 ⇧ 有别的行为，不是说 ⌥ 另有语义。
      // 状态栏那边不同：普通点击是「打开侧栏」，所以 ⌥ 在那里才有区分意义（§D2）。
      runAction(() => runtime.locate({ sidebar: ev.shiftKey }));
    });

    header.createEl('span', { cls: 'nautilus-log-exec-header-divider' }).setAttribute('aria-hidden', 'true');

    const tabs = header.createDiv({ cls: 'nautilus-log-exec-tabs' });
    tabs.setAttribute('role', 'tablist');
    tabs.setAttribute('aria-label', text.identity.views);
    (['timing', 'plan', 'review'] as const).forEach((name) => {
      const tab = tabs.createEl('button', {
        cls: `nautilus-log-exec-tab${view === name ? ' is-active' : ''}`,
        text: text.tabs[name],
      });
      tab.type = 'button';
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-selected', String(view === name));
      tab.addEventListener('click', () => {
        if (view === name) return;
        view = name;
        clearDeleteConfirmation();
        render(state, true);
      });
    });
  };

  const renderNotice = (): void => {
    if (!state.notice) return;
    const notice = container.createDiv({ cls: 'nautilus-log-exec-notice' });
    notice.setAttribute('role', 'status');
    notice.setText(state.notice);
  };

  /* ─────────────────────────── 渲染 / 就地刷新 ─────────────────────────── */

  /** 写回期间只同步按钮可用性，不重建行（上游 syncActionAvailability，
   *  timing-topbar.js:449-454）。 */
  const syncActionAvailability = (): void => {
    const disabled = state.status === 'working';
    container.querySelectorAll('.nautilus-log-exec-row-actions button')
      .forEach((button) => { (button as HTMLButtonElement).disabled = disabled; });
  };

  const render = (next: TimingSnapshot, force = false): void => {
    state = next;
    if (destroyed) return;
    // 🔴 认证审计 T3-032：本移植的结构键含 status，`working` 一到就整表重建
    //    ⇒ 写回期间列表闪烁，并且【已武装的删除确认按钮变成孤儿节点】
    //    （2.5s 后 clearDeleteConfirmation 操作的是已脱离文档的按钮）。
    //    上游在这一帧只置灰按钮 + 就地刷新计时，等确认后的刷新再渲染新数据。
    if (!force && state.status === 'working' && lastStructureKey !== null) {
      syncActionAvailability();
      updateLiveElapsed();
      return;
    }
    const key = timingCore.executionStructureKey(state, view);
    if (!force && lastStructureKey !== null && key === lastStructureKey) {
      updateLiveElapsed();
      return;
    }
    lastStructureKey = key;
    container.empty();
    renderHeader();
    renderNotice();
    renderCapacity();   // 三个 tab 都有（上游 popover 同款位置）
    renderList();
  };

  /** 结构没变时的低成本刷新：只更新计时文字（与上游 updateLiveElapsed 一致）。 */
  const updateLiveElapsed = (): void => {
    if (view === 'plan') return;
    const focused = state.activeWork?.focused || null;
    if (!focused) return;

    if (view === 'review') {
      const actual = container.querySelector('.nautilus-log-exec-review-actual[data-review-live-actual]') as HTMLElement | null;
      if (!actual) return;
      const review = (state.dailyReview || {}) as Partial<DailyReviewData>;
      const row = (review.rows || []).find((candidate) => candidate.uid === focused.taskUid) || activeTask(focused);
      const duration = timingCore.durationMetadata({
        taskUid: focused.taskUid,
        plannedMinutes: row.plannedMinutes,
        entries: state.entries,
        now: state.now,
        language: language(),
      });
      actual.textContent = `${copy().review.actual} ${timingCore.compactMinutes(duration.actualMinutes)}`;
      return;
    }

    const row = container.querySelector('.nautilus-log-exec-row.is-focused') as HTMLElement | null;
    if (!row) return;
    const meta = row.querySelector('.nautilus-log-exec-row-meta.is-live') as HTMLElement | null;
    if (!meta) return;
    const task = activeTask(focused);
    const duration = timingCore.durationMetadata({
      taskUid: task.uid,
      plannedMinutes: task.plannedMinutes,
      entries: state.entries,
      now: state.now,
      language: language(),
    });
    const forgotten = isForgotten(focused);
    row.classList.toggle('is-forgotten', forgotten);
    meta.classList.toggle('is-warning', forgotten);
    const text = copy().timing;
    meta.textContent = `${forgotten ? `${text.check} · ` : ''}${text.timing} ${timingCore.formatElapsed(state.now.getTime() - toMs(focused.start))} · ${duration.detailLabel}`;
  };

  /* ─────────────────────────── 订阅 / 销毁 ─────────────────────────── */

  unsubscribe = runtime.subscribe((next) => { render(next); });

  return {
    /** 设置变更后用它 —— ctx 是取值函数，force 重渲即拿到新语言 / 新阈值，
     *  而 view / unscheduledExpanded 原地保留（认证审计 T3-034）。 */
    refresh() {
      if (destroyed) return;
      render(runtime.getSnapshot(), true);
    },
    getViewState(): ExecPanelViewState {
      return { view, unscheduledExpanded };
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      if (unsubscribe) {
        const off = unsubscribe;
        unsubscribe = null;
        off();
      }
      clearDeleteConfirmation();
      container.empty();
    },
  };
}
