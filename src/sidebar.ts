/*
 * sidebar.ts — the Nautilus Logger sidebar view (P · 侧栏视图壳).
 *
 * Puts the spiral into the right sidebar so today's plate is visible without
 * opening the Daily Note.  This file only *hosts* the chart — the geometry is
 * entirely reused from `renderSpiral` (src/spiral.ts), the capacity header from
 * `renderCapacityHeader` (src/header.ts), the block grammar from `parsePlan`
 * (src/parser.ts), and the block/fence boundary logic from
 * `parseBlockConfig` / `applyOverrides` / `extractPlanBody` (src/blockconfig.ts).
 *
 * The "Primary Plan" concept maps to the upstream guide (§Execution Layer):
 * today's Daily Note, and within it the FIRST ```nautilus code block — its
 * YAML-style content is the per-day config override, and the plan body is the
 * sibling markdown after that block (extracted by `extractPlanBody`, never by
 * hand-written boundary logic).
 *
 * Upstream baseline: 404KSG/roam-nautilus-log @ 7bf19a1d
 */

import { ItemView, TFile, type App, type WorkspaceLeaf } from 'obsidian';
import { renderSpiral, type SpiralHandle } from './spiral';
import { renderCapacityHeader, enableContainerQueries } from './header';
import { renderChartControls, type ChartControlState } from './controls';
import { renderCompactOverview, renderOverflowPanel, renderWarningPanel } from './compact';
import { parsePlan } from './parser';
import { parseBlockConfig, applyOverrides, extractPlanBody } from './blockconfig';
import type { Capacity, NautilusSettings } from './contract';
import { renderExecPanel } from './exec-panel';
import { resolveDayState } from './daystate';
import { renderPomoControl } from './pomo';
import type { ExecViewContext } from './timing-contract';
import { localCopy } from './settings';

const logCore = require('./vendor/log-core') as {
  uiCopy(language: string): unknown;
  calculateCapacity(args: {
    startMinutes: number;
    endMinutes: number;
    nowMinutes: number;
    fixedEvents?: { uid: string; string: string; start: number; end: number; meeting: true; done: boolean }[];
    allFixedEvents?: { uid: string; string: string; start: number; end: number; meeting: true; done: boolean }[];
    pendingTasks?: { uid: string; string: string; duration: number; done: boolean; doneAt?: number; progress?: number; urgent?: boolean }[];
  }): Capacity;
  normalizeScheduleSettings(args: { startHour: number; endHour: number }): {
    startMinutes: number;
    endMinutes: number;
  };
  /** 认证审计 L2-127：紧凑阈值必须来自引擎，不能在这里再写一次 520。 */
  isCompactChartWidth(width: number): boolean;
};

export const NAUTILUS_VIEW_TYPE = 'nautilus-logger-view';

/* ------------------------------------------------------------------ */
/* Today's Daily Note resolution                                       */
/* ------------------------------------------------------------------ */

/** 代码块语言别名。与 main.ts 的 BLOCK_LANGS 保持一致，围栏正则由它派生。 */
const FENCE_OPEN_RE = /^\s*```+\s*(?:nautilus|naut)\s*$/;
const FENCE_CLOSE_RE = /^\s*```+\s*$/;

/** The Daily Notes plugin's own config, when it is enabled. */
interface DailyNotesOptions { format?: string; folder?: string }

interface DailyNoteInfo {
  path: string;
  /** true when the built-in Daily Notes plugin is configured; false when we
   *  fell back to a bare `YYYY-MM-DD.md` in the vault root. */
  viaPlugin: boolean;
}

function readDailyNotesOptions(app: App): DailyNotesOptions | null {
  // 路径一：内部插件实例（用户改过设置后才有 options）。
  const dn = (app as unknown as {
    internalPlugins?: { plugins?: Record<string, { instance?: { options?: DailyNotesOptions } }> };
  }).internalPlugins?.plugins?.['daily-notes'];
  const opts = dn?.instance?.options;
  if (opts && (opts.folder || opts.format)) {
    return { format: opts.format, folder: opts.folder };
  }
  // 路径二：.obsidian/daily-notes.json 的缓存（由 primeDailyNotesConfig 预读）。
  // 🔴 这条是必须的 —— 实测某 vault 的配置只落在该文件里（folder: "Daily/_Daily"），
  //    路径一拿到空 => 退回根目录 => 报「找不到今日笔记」，而笔记就在那儿。
  return cachedDailyNotesOptions;
}

/** 预读 .obsidian/daily-notes.json。
 *  🔴 必须在首次渲染【之前】await 一次 —— 早先做成"渲染时异步读、下次 tick 生效"，
 *     用户看到的第一屏永远是错的，而 tick 是 60 秒一次。 */
export async function primeDailyNotesConfig(app: App): Promise<void> {
  try {
    const vault = app.vault as unknown as {
      configDir?: string;
      adapter?: { read?(p: string): Promise<string>; exists?(p: string): Promise<boolean> };
    };
    const dir = vault.configDir || '.obsidian';
    const path = `${dir}/daily-notes.json`;
    if (vault.adapter?.exists && !(await vault.adapter.exists(path))) return;
    const text = await vault.adapter?.read?.(path);
    if (!text) return;
    const parsed = JSON.parse(text) as DailyNotesOptions;
    if (parsed && (parsed.folder || parsed.format)) {
      cachedDailyNotesOptions = { format: parsed.format, folder: parsed.folder };
    }
  } catch { /* 没有该文件是正常的 */ }
}

/** daily-notes.json 的解析结果缓存（adapter.read 异步，同步路径拿不到）。 */
let cachedDailyNotesOptions: DailyNotesOptions | null = null;

/** 用 moment 渲染 Daily Notes 的 format；没有 moment 时退化为 YYYY-MM-DD。
 *  (Obsidian 恒有 window.moment；退化路径只是给测试/无 DOM 环境的兜底。) */
function formatDate(format: string): string {
  const w = window as unknown as {
    moment?: (inp?: unknown) => { format(f: string): string };
  };
  if (w.moment && typeof w.moment === 'function') {
    try { return w.moment().format(format); } catch { /* fall through */ }
  }
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 解析今天的 Daily Note 路径。优先用内置 Daily Notes 插件的 format/folder；
 *  读不到就退回根目录的 `YYYY-MM-DD.md`，并把 viaPlugin 置 false 供 UI 提示。 */
export function resolveDailyNoteInfo(app: App): DailyNoteInfo {
  const opts = readDailyNotesOptions(app);
  // 🔴 只要拿到 folder 或 format 之一就算配置有效。
  //    早先写成 `if (opts && opts.format)`，而 Obsidian 在用户【没改过日期格式】时
  //    根本不写 format 键 —— daily-notes.json 里只有 {"folder": "Daily/_Daily"}。
  //    结果 folder 被一起丢掉、退回根目录，报「找不到今日笔记」，而笔记就在那儿。
  if (opts && (opts.folder || opts.format)) {
    const folder = opts.folder || '';
    const dateStr = formatDate(opts.format || 'YYYY-MM-DD');   // format 缺省即 Obsidian 默认
    return { path: folder ? `${folder}/${dateStr}.md` : `${dateStr}.md`, viaPlugin: true };
  }
  const dateStr = formatDate('YYYY-MM-DD');
  return { path: `${dateStr}.md`, viaPlugin: false };
}

/** 找出文本里【第一个】nautilus 代码块，返回块内配置源码 + 闭围栏的行号。
 *  行号是给 extractPlanBody 用的（计划正文在闭围栏之后）。 */
function findFirstNautilusBlock(text: string): { config: string; lineEnd: number } | null {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    if (!FENCE_OPEN_RE.test(lines[i])) continue;
    const config: string[] = [];
    let j = i + 1;
    while (j < lines.length && !FENCE_CLOSE_RE.test(lines[j])) { config.push(lines[j]); j += 1; }
    if (j >= lines.length) return null;   // 未闭合的围栏：不算一个合法块
    return { config: config.join('\n'), lineEnd: j };
  }
  return null;
}

interface DailyNotePlan {
  path: string;
  /** 第一个 nautilus 块的块内配置（YAML 风格，喂给 parseBlockConfig）。 */
  config: string;
  body: string;
  /** 计划正文在文件中的起始行号（0 起），uid 用真实行号。 */
  lineOffset: number;
}

/** 读取今天的 Daily Note，取【第一个】nautilus 块的计划正文。
 *  文件不存在、无 nautilus 块、或围栏未闭合 => null（不编造空盘）。 */
async function findDailyNotePlan(app: App, path: string): Promise<DailyNotePlan | null> {
  const file = app.vault.getAbstractFileByPath(path);
  if (!(file instanceof TFile)) return null;
  const text = await app.vault.cachedRead(file);
  const block = findFirstNautilusBlock(text);
  if (!block) return null;
  const { body, startLine } = extractPlanBody(text, block.lineEnd);
  return { path, config: block.config, body, lineOffset: startLine };
}

/** 解析今天的 Primary Plan：今日 Daily Note 里【第一个】nautilus 代码块。
 *  对应上游的 Primary Plan 概念（guide §Execution Layer）。 */
export async function resolvePrimaryPlan(
  app: App,
  settings: NautilusSettings, // 保留签名，路径解析本身不依赖设置
): Promise<{ path: string; body: string; lineOffset: number } | null> {
  const info = resolveDailyNoteInfo(app);
  const plan = await findDailyNotePlan(app, info.path);
  if (!plan) return null;
  return { path: plan.path, body: plan.body, lineOffset: plan.lineOffset };
}

/* ------------------------------------------------------------------ */
/* The sidebar view                                                    */
/* ------------------------------------------------------------------ */

function nowMinutes(): number {
  const date = new Date();
  return date.getHours() * 60 + date.getMinutes();
}

export class NautilusSidebarView extends ItemView {
  private timer: number | null = null;
  private metadataListener: ((file: TFile) => void) | null = null;
  private spiral: SpiralHandle | null = null;
  /** 当前 Primary Plan 文件。null 表示还没解析到（没有今日笔记）。 */
  private primaryPath: string | null = null;

  private exec: { destroy(): void } | null = null;
  private pomo: { destroy(): void } | null = null;

  /** C2-075/085：紧凑面板折叠态的宿主。侧栏每分钟 tick 重渲染、`<details>`
   *  整个重建，展开/收起必须存进这里、重渲染时经 options.state 读回 —— 否则
   *  用户手动展开的面板 60 秒后自己合上。键：overview / schedule。 */
  private compactOpen = new Map<string, boolean>();

  /* ---- 认证审计 C2-058：侧栏此前完全没有控制栏（眼睛/播放/折叠）。 ----
   * 图表状态得有个宿主，`main.ts` 的 view 有 `chartState`，侧栏没有 ——
   * 这里补一份同构的。它是【纯视觉】状态，不写回 Markdown。 */
  private controls: { destroy(): void } | null = null;
  private chartState: ChartControlState = { showDone: true, collapsed: false, playback: null };
  /** 回放时钟归 view 所有 —— 见 controls.ts 里关于孤儿定时器的注释。 */
  private playbackTimer: number | null = null;
  /** 认证审计 L2-127：跟随宽度变化的观察者（上游 `observe-compact-width!`）。 */
  private resizeObserver: { disconnect(): void } | null = null;
  /** 上一次渲染时的紧凑判定；只有它翻转才重排，避免 observer 自激。 */
  private lastCompact: boolean | null = null;

  // 🔴 contentEl 下必须是【两个固定容器】，而不是让 render() 直接 empty(contentEl)。
  //    否则每分钟 tick 的重渲染会连执行区 DOM 一起抹掉，而 renderExecutionArea()
  //    只在 onOpen 调过一次 => 侧栏开满一分钟后按钮栏永久消失（实测踩到）。
  //    分开之后：规划区随时重画，执行区保持挂载、不丢 tab/番茄钟的临时状态。
  private planHost: HTMLElement | null = null;
  private execHost: HTMLElement | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    private settings: NautilusSettings,
    /** 执行层上下文提供者。返回 null 表示总开关关闭 —— 此时不渲染任何执行层 UI。 */
    private getExecContext: (() => ExecViewContext | null) = () => null,
  ) {
    super(leaf);
  }

  getViewType(): string { return NAUTILUS_VIEW_TYPE; }
  getDisplayText(): string { return 'Nautilus Logger'; }
  getIcon(): string { return 'compass'; }

  async onOpen(): Promise<void> {
    this.contentEl.addClass('nautilus-log-sidebar');
    this.ensureHosts();
    await primeDailyNotesConfig(this.app);   // 🔴 必须在首次 render 之前
    await this.render();
    this.renderExecutionArea();

    // 只监听元数据变化：变的是当前 Primary Plan 文件才重渲染。
    // 若还没取到 Primary（没有今日笔记），任何文件变动都重试一次 —— 这样用户
    // 新建/补上今日笔记后侧栏能自己活过来，而不是永远停在空态。
    this.metadataListener = (file) => {
      if (this.primaryPath === null || file.path === this.primaryPath) {
        void this.render();
      }
    };
    this.app.metadataCache.on('changed', this.metadataListener);

    // 每分钟 tick 一次 —— 当前时刻会变，盘上的流逝区与指针必须跟着走。
    this.timer = window.setInterval(() => void this.render(), 60_000);

    this.observeCompactWidth();
  }

  /* ------------------------------------------------------------------ */
  /* 认证审计 L2-127 · 跟随宽度变化                                       */
  /* ------------------------------------------------------------------ */

  /**
   * 上游 `component.cljs:1739-1757 observe-compact-width!` 用 ResizeObserver
   * 持续跟随容器宽度，并在**转入紧凑**时清空 hover 状态。本移植原先只在渲染
   * 那一刻算一次 `isCompactChartWidth`（`spiral.ts:1326`）—— 拖窄侧栏或分屏
   * 不会重排，得等下一次 60 秒 tick 或文件改动才生效。
   *
   * 只有紧凑判定**翻转**时才重渲染：ResizeObserver 的回调本身会被重渲染再次
   * 触发，无条件重画就是一个自激循环。hover 状态由 `renderSpiral` 持有，
   * 重建 spiral 即清空，与上游 `(reset! hover-info-state nil)` 等价。
   */
  private observeCompactWidth(): void {
    const Ctor = (window as unknown as {
      ResizeObserver?: new (cb: () => void) => { observe(el: Element): void; disconnect(): void };
    }).ResizeObserver;
    if (!Ctor || !this.planHost) return;   // jsdom / 老 webview 上没有就退化成原行为
    const observer = new Ctor(() => {
      const host = this.planHost;
      if (!host) return;
      const compact = logCore.isCompactChartWidth(host.clientWidth || 0);
      if (compact === this.lastCompact) return;
      this.lastCompact = compact;
      void this.render();
    });
    observer.observe(this.planHost);
    this.resizeObserver = observer;
  }

  private stopPlaybackClock(): void {
    if (this.playbackTimer !== null) {
      window.clearInterval(this.playbackTimer);
      this.playbackTimer = null;
    }
  }

  /** 状态里有 playback 就保证时钟在跑，没有就保证停掉。幂等，可反复调。
   *  与 `main.ts` 的 syncPlaybackClock 同构 —— 推进不能放进 controls.ts。 */
  private syncPlaybackClock(startMinutes: number, endMinutes: number): void {
    if (this.chartState.playback === null) { this.stopPlaybackClock(); return; }
    if (this.playbackTimer !== null) return;
    const end = Math.max(startMinutes, Math.min(nowMinutes(), endMinutes));
    const step = Math.max(1, Math.round((end - startMinutes) / 60));
    this.playbackTimer = window.setInterval(() => {
      const cur = this.chartState.playback;
      if (cur === null) { this.stopPlaybackClock(); return; }
      const next = Math.min(end, cur.minute + step);
      this.chartState = { ...this.chartState, playback: { minute: next } };
      if (next >= end) {
        this.stopPlaybackClock();
        this.chartState = { ...this.chartState, playback: null };
      }
      void this.render();
    }, 120);
  }

  /** 执行层区域。总开关关闭时什么都不渲染（也就不起任何订阅/定时器）。 */
  /** 供外部（设置页切换总开关时）主动刷新执行区。 */
  refreshExecutionArea(): void { this.renderExecutionArea(); }

  /** 建立（或补建）两个固定容器，顺序固定：规划区在上，执行区在下。 */
  private ensureHosts(): void {
    if (!this.planHost || !this.planHost.isConnected) {
      this.planHost = this.contentEl.createDiv({ cls: 'nautilus-log-plan-host' });
    }
    if (!this.execHost || !this.execHost.isConnected) {
      this.execHost = this.contentEl.createDiv({ cls: 'nautilus-log-exec-host' });
    }
  }

  private renderExecutionArea(): void {
    this.ensureHosts();
    this.exec?.destroy(); this.exec = null;
    this.pomo?.destroy(); this.pomo = null;
    this.execHost!.empty();
    const ctx = this.getExecContext();
    if (!ctx || !ctx.runtime) return;
    const host = this.execHost!.createDiv({ cls: 'nautilus-log-exec-area' });
    try {
      this.pomo = renderPomoControl(host.createDiv({ cls: 'nautilus-log-pomo-slot' }), ctx);
      this.exec = renderExecPanel(host.createDiv({ cls: 'nautilus-log-exec-slot' }), ctx);
    } catch (err) {
      // 执行层挂了不该带走螺旋图 —— 规划视图必须还在。
      console.error('[Nautilus Logger] execution panel failed', err);
      host.remove();
    }
  }

  async onClose(): Promise<void> {
    // 🔴 八个都得清，一个都不许漏：interval、事件监听、spiral、执行面板、
    //    POMO、控制栏、回放时钟、ResizeObserver。
    this.exec?.destroy(); this.exec = null;
    this.pomo?.destroy(); this.pomo = null;
    this.controls?.destroy(); this.controls = null;
    this.stopPlaybackClock();
    this.resizeObserver?.disconnect(); this.resizeObserver = null;
    this.lastCompact = null;
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
    if (this.metadataListener) {
      this.app.metadataCache.off('changed', this.metadataListener);
      this.metadataListener = null;
    }
    this.spiral?.destroy();
    this.spiral = null;
    this.primaryPath = null;
    this.planHost = null;
    this.execHost = null;
  }

  private disposeSpiral(): void {
    this.spiral?.destroy();
    this.spiral = null;
  }

  private async render(): Promise<void> {
    this.ensureHosts();
    const el = this.planHost!;
    el.empty();

    const info = resolveDailyNoteInfo(this.app);
    const plan = await findDailyNotePlan(this.app, info.path);

    // 🔴 拿不到就【明说】，不静默渲染一张空盘 —— 否则会让人以为插件坏了，
    //    实际是数据没取到（本项目在这个坑上吃过亏）。
    if (!plan) {
      this.primaryPath = null;
      this.disposeSpiral();
      // P1-8：空态文案走本地双语表 —— 之前恒为英文，language='zh' 也不变。
      const copy = localCopy(this.settings.language);
      const hint = el.createDiv({ cls: 'nautilus-log-sidebar-empty' });
      hint.createDiv({ cls: 'nautilus-log-sidebar-empty-heading' })
        .setText(copy.sidebarEmptyHeading);
      const sub = hint.createDiv({ cls: 'nautilus-log-sidebar-empty-note' });
      sub.setText(info.viaPlugin ? copy.sidebarLooking(info.path) : copy.sidebarNoConfig(info.path));
      return;
    }

    this.primaryPath = plan.path;
    // 块内配置叠加到全局设置上（start/end/duration/language…），与 main.ts 一致。
    const settings = applyOverrides(this.settings, parseBlockConfig(plan.config));
    const schedule = logCore.normalizeScheduleSettings({
      startHour: settings.workdayStartHour,
      endHour: settings.workdayEndHour,
    });
    const parsed = parsePlan(plan.body, {
      sourcePath: plan.path,
      settings,
      lineOffset: plan.lineOffset,
    });
    const capacity = logCore.calculateCapacity({
      startMinutes: schedule.startMinutes,
      endMinutes: schedule.endMinutes,
      nowMinutes: nowMinutes(),
      fixedEvents: parsed.events,
      allFixedEvents: parsed.events,
      pendingTasks: parsed.tasks,
    });

    // 上游 `component.cljs:1870-1890` 的骨架：
    //   container > (collapsed ? controls : shell > [header, compact, content])
    // 认证审计 C2-056/057 + S1-003/005：这三个类名本移植此前一个都没发射过，
    // 于是块根布局、控制栏 hover 浮现、折叠态浮出全族 CSS 都是死规则。
    const root = el.createDiv({ cls: 'nautilus-log' });
    enableContainerQueries(root);   // => `nautilus-log-container`

    if (capacity.demandMinutes === 0 && capacity.totalFixedMinutes === 0) {
      const d = root.createDiv({ cls: 'nautilus-log-diag' });
      d.setText(`⚠ nothing scheduled — events ${parsed.events.length} · tasks ${parsed.tasks.length} · malformed ${parsed.malformed.length}`);
    }

    // 认证审计 C2-024：折叠后上游只剩一排按钮 —— 头部与紧凑概览都不渲染。
    if (this.chartState.collapsed) {
      this.disposeSpiral();
      this.mountControls(root, settings, schedule);
      return;
    }

    const shell = root.createDiv({ cls: 'nautilus-log-shell' });
    renderCapacityHeader(shell, capacity, settings, nowMinutes());
    // 认证审计 C2-058 + C2-023：控制栏挂进 header-actions 列（controls.ts 自己
    // 找挂载点）。必须在 renderCapacityHeader 之后，那一列才存在。
    this.mountControls(root, settings, schedule);
    // 🔴 侧栏几乎总是落在 @container (max-width:520px) 里，那套规则会把完整
    //    头部藏起来、改显紧凑概览。只接 main.ts 不接这里 => 侧栏什么都没有。
    const uiCopy = logCore.uiCopy(settings.language) as never;
    renderCompactOverview(shell, capacity, settings, nowMinutes(), uiCopy,
      { state: { key: "overview", states: this.compactOpen } });

    const content = shell.createDiv({ cls: 'nautilus-log-content' });

    const chart = content.createDiv({ cls: 'nautilus-log-chart' });
    try {
      // 上一次的 hover 监听必须先拆，否则每次重渲染（每分钟 tick + 文件改动）
      //    都会再挂一层，很快就累积成泄漏。
      this.disposeSpiral();
      // 侧栏总是看今天，但仍显式解析 —— 万一 Primary Plan 落在别的日期
      // （例如跨午夜窗口把昨天的计划算作 today），也能走对分支。
      this.spiral = renderSpiral(chart, parsed, capacity, settings, nowMinutes(), {
        // 认证审计 C2-058：控制栏的两个视觉开关必须真的接到图上，
        //   否则按钮点了没反应。只用 renderSpiral 的现有 options。
        showDone: this.chartState.showDone,
        playbackMinute: this.chartState.playback?.minute ?? null,
        // C2-075：把紧凑日程清单的折叠态交给 renderSpiral（宿主 Map 跨 tick 存活）。
        compactState: this.compactOpen,
        // P0-4：同 main.ts —— 侧栏也要拿到 CLOCK 记录。
        clockEntries: this.getExecContext()?.runtime?.getSnapshot?.()?.entries ?? [],
        dayState: resolveDayState({
          sourcePath: plan.path,
          startMinutes: schedule.startMinutes,
          endMinutes: schedule.endMinutes,
          nowMinutes: nowMinutes(),
        }),
      });
    } catch (err) {
      chart.remove();
      const warn = content.createDiv({ cls: 'nautilus-log-chart-error' });
      warn.setText('⚠ chart failed to render (capacity figures above are still valid)');
      console.error('[Nautilus Logger] sidebar renderSpiral failed', err);
    }

    // 🔴 认证审计 C2-101：溢出/警告面板必须排在**图之后**（上游
    //    `component.cljs:1889-1890` 的 `nautilus-log-content` 内是
    //    visual → overflow → warning）。侧栏原先把它俩画在图之前。
    renderOverflowPanel(content, capacity, uiCopy);
    renderWarningPanel(content, parsed, uiCopy);
  }

  /**
   * 认证审计 C2-058：挂上眼睛/播放/折叠三个按钮。
   *
   * `container` 恒为块根（带 `nautilus-log-container`）—— controls.ts 需要它
   * 来切 `nautilus-log-collapsed`，并在展开态自己找到 header-actions 列。
   * 存储键传裸的「块身份」，命名空间前缀由 controls.ts 加（C2-054）。
   */
  private mountControls(
    container: HTMLElement,
    settings: NautilusSettings,
    schedule: { startMinutes: number; endMinutes: number },
  ): void {
    this.controls?.destroy();
    this.controls = renderChartControls(
      container,
      this.chartState,
      {
        onChange: (next) => {
          this.chartState = next;
          this.syncPlaybackClock(schedule.startMinutes, schedule.endMinutes);
          void this.render();
        },
      },
      settings,
      {
        workdayStartMinutes: schedule.startMinutes,
        workdayEndMinutes: schedule.endMinutes,
        nowMinutes: nowMinutes(),   // 侧栏恒看今天，回放区间总是有意义的
      },
      // 侧栏的「块」就是当天的 Primary Plan；同一篇笔记的折叠态跟着它走。
      `${this.primaryPath ?? 'primary'}:sidebar`,
    );
  }
}
