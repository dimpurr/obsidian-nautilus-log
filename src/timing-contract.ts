/*
 * 执行层运行时契约 —— 面板 / 状态栏 / POMO 共同依赖的形状。
 *
 * 全部照 src/vendor/timing-runtime.js 的【实际】返回抄写（已实跑核对）。
 * 🔴 不要照猜：本项目已两次因「照类型声明猜返回值」栽跟头
 *    （parseDurationToken 返回对象、capacityMetrics 收解构对象且错传时静默变 0）。
 */

/** 一条 CLOCK 记录。running=true 表示尚未闭合。 */
export interface TimingEntry {
  start: Date | number;
  end?: Date | number | null;
  running: boolean;
  minutes?: number;
  clockUid?: string;
  taskUid?: string;
  taskString?: string;
  title?: string;
  status?: string;
  pageTitle?: string;
}

/** 当前聚焦的任务与最近完成项（Timing 视图用）。 */
export interface ActiveWork {
  focused: TimingEntry | null;
  recent: TimingEntry[];
  items: TimingEntry[];
  count: number;
  windowMinutes: number;
}

/** 计划 vs 实际（Review 视图用）。结构由 tsc 从 buildDailyReview 的实际返回推出，
 *  非猜测：初版把它写成 `[k:string]: unknown`，接线时被 TypeScript 当场纠正。 */
export interface DailyReview {
  summary: {
    totalCount: number;
    completedCount: number;
    comparedCount: number;
    plannedMinutes: number;
    actualMinutes: number;
    varianceMinutes: number;
  };
  rows: unknown[];
}

/** runtime.subscribe 推送的快照。**revision 变化即表示有更新**。 */
export interface TimingSnapshot {
  revision: number;
  status: 'loading' | 'ready' | 'disabled' | string;
  notice: string;
  planSnapshot: { plan?: { uid?: string }; [k: string]: unknown } | null;
  entries: TimingEntry[];
  dailyReview: DailyReview;
  activeWork: ActiveWork;
  /** 任务 CLOCK 关联的番茄钟状态；无则 null。 */
  pomodoro: unknown | null;
  /** 独立正计时番茄钟（不写任何块）；无则 null。 */
  standalonePomodoro: unknown | null;
  now: Date;
}

/** createTimingRuntime 的完整公开面（逐条对照 vendor 第 515-537 行）。 */
export interface TimingRuntime {
  /** ⚠️ 返回的是【首个快照】，不是 void —— 初版契约写成 void，
   *  接线时 tsc 直接顶回来。别照猜。 */
  initialize(): Promise<TimingSnapshot>;
  refresh(): Promise<TimingSnapshot> | TimingSnapshot;
  requestRefresh(): void;
  startTask(taskUid: string, taskString?: string): Promise<unknown>;
  stopTask(): Promise<unknown>;
  completeTask(taskUid?: string): Promise<unknown>;
  /** ⚠️ 收 taskUid —— 不传会报 "Only the current Timing CLOCK can be deleted."
   *  （vendor/timing-runtime.js:422 实际签名；初版契约漏了这个参数）。 */
  deleteCurrentClock(taskUid?: string): Promise<unknown>;
  startStandalonePomodoro(): Promise<unknown> | unknown;
  stopStandalonePomodoro(): Promise<unknown> | unknown;
  /** 上游 HEAD 起支持 { sidebar }：true 送右侧栏，false/省略 = 主编辑区。 */
  locate(options?: { sidebar?: boolean }): Promise<unknown> | unknown;
  openTask(taskUid: string, opts?: { sidebar?: boolean }): Promise<unknown> | unknown;
  disable(): void;
  destroy(): void;
  getSnapshot(): TimingSnapshot;
  /** 订阅即【立刻收到一次当前快照】，返回退订函数。 */
  subscribe(listener: (s: TimingSnapshot) => void): () => void;
  isDestroyed(): boolean;
}

/** 面板/状态栏共用的渲染入参。 */
export interface ExecViewContext {
  runtime: TimingRuntime;
  language: 'en' | 'zh';
  /** 番茄钟阈值（分钟）。到点只改变提示，**不停止工作**。 */
  pomodoroMinutes: number;
  /** 忘关计时器警告阈值；0 = 关闭。**只警告，绝不自动停止或删除 CLOCK**。 */
  forgottenTimerMinutes: number;
  /** Recent 保留时长；0 = 关闭。 */
  recentRetentionMinutes: number;
  /** 未标时长的任务的兜底分钟数（Roam 键 `todo-duration`，见 §D7 的键名映射）。
   *  🔴 只增不改：省略时面板退回 15（= DEFAULT_SETTINGS.todoDuration），
   *  行为与本字段引入前逐字一致，既有调用方不受影响。
   *  面板此前把 15 写死在代码里，改过设置的用户拿不到自己的值（audit §P1-2 邻项）。 */
  todoDuration?: number;
}
