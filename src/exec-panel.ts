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

export function renderExecPanel(container: HTMLElement, ctx: ExecViewContext): { destroy(): void } {
  const runtime = ctx.runtime;
  const language = ctx.language;
  const copy = () => timingCore.executionCopy(language);

  let destroyed = false;
  let view: ViewName = 'timing';
  let state: TimingSnapshot = runtime.getSnapshot();
  let lastStructureKey: string | null = null;
  let unsubscribe: (() => void) | null = null;
  let deleteConfirmation: { clockUid: string; button: HTMLButtonElement; timer: number } | null = null;

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
    const threshold = Number(ctx.forgottenTimerMinutes) || 0;
    if (threshold <= 0) return false;
    return timingCore.isForgottenClock(entry, state.now, threshold);
  };

  /** 从一条 CLOCK 条目还原成 plan 行形状（上游 activeTask）。 */
  const activeTask = (entry: TimingEntry): PlanTask => ({
    uid: entry.taskUid || '',
    string: entry.taskString || '',
    title: entry.title || '(untitled)',
    plannedMinutes: timingCore.plannedMinutes(entry.taskString || '', 15),
    remainingMinutes: 0,
    progress: 0,
  });

  const signedMinutes = (minutes: number): string => {
    const value = Number(minutes) || 0;
    if (value === 0) return '0m';
    return `${value > 0 ? '+' : '−'}${timingCore.compactMinutes(Math.abs(value))}`;
  };

  /* ─────────────────────────── 行 / 视图构建 ─────────────────────────── */

  const taskRow = (list: HTMLElement, task: PlanTask, opts: { recent?: boolean; entry?: TimingEntry | null } = {}): HTMLElement => {
    const text = copy();
    const focusedEntry = state.activeWork?.focused || null;
    const focused = !!focusedEntry && focusedEntry.taskUid === task.uid;
    const recent = !!opts.recent;
    const entry = opts.entry || null;

    const row = list.createDiv({ cls: 'nautilus-log-exec-row' });
    row.dataset.taskUid = task.uid;
    if (focused) row.classList.add('is-focused');
    const forgotten = focused && focusedEntry ? isForgotten(focusedEntry) : false;
    if (forgotten) row.classList.add('is-forgotten');

    const copyEl = row.createDiv({ cls: 'nautilus-log-exec-row-copy' });
    const title = copyEl.createEl('button', { cls: 'nautilus-log-exec-row-title', text: task.title });
    title.type = 'button';
    title.title = task.title;
    title.addEventListener('click', (event: MouseEvent) => {
      runAction(() => runtime.openTask(task.uid, { sidebar: event.shiftKey }));
    });

    const duration = timingCore.durationMetadata({
      taskUid: task.uid,
      plannedMinutes: task.plannedMinutes,
      entries: state.entries,
      now: state.now,
      language,
    });

    const timingText = focused && focusedEntry
      ? `${text.timing.timing} ${timingCore.formatElapsed(state.now.getTime() - toMs(focusedEntry.start))} · ${duration.detailLabel}`
      : '';

    let metaText = duration.detailLabel; // 普通 plan 行：Planned/Actual（上游默认分支）
    if (focused) {
      metaText = `${forgotten ? `${text.timing.check} · ` : ''}${timingText}`;
    } else if (recent && entry?.end) {
      const recentRemaining = Math.max(0, Math.ceil(
        (Number(state.activeWork?.windowMinutes || 0) * 60000 - (state.now.getTime() - toMs(entry.end))) / 60000,
      ));
      metaText = `${text.timing.recent} · ${timingCore.compactMinutes(recentRemaining)} ${text.timing.left} · ${duration.detailLabel}`;
    }

    copyEl.createDiv({
      cls: `nautilus-log-exec-row-meta${focused ? ' is-live' : ''}${forgotten ? ' is-warning' : ''}`,
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
    const title = heading.createEl('button', { cls: 'nautilus-log-exec-review-title', text: task.title });
    title.type = 'button';
    title.title = task.title;
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
      tasks.forEach((task) => taskRow(list, task));
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

  const render = (next: TimingSnapshot, force = false): void => {
    state = next;
    if (destroyed) return;
    const key = timingCore.executionStructureKey(state, view);
    if (!force && lastStructureKey !== null && key === lastStructureKey) {
      updateLiveElapsed();
      return;
    }
    lastStructureKey = key;
    container.empty();
    renderHeader();
    renderNotice();
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
        language,
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
      language,
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
