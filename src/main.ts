/*
 * Nautilus Logger for Obsidian — plugin entry point.
 *
 * Stage one: register the ```nautilus code-block processor, render a text-only
 * capacity bar, expose the settings tab and a command.  Obsidian has no
 * rdr/pull, so each block re-renders when its note changes (metadataCache
 * "changed") and on a per-minute tick (nowMinutes moves, so Overload moves).
 */

import { Notice, Plugin, MarkdownRenderChild, MarkdownRenderer, TFile, type Editor, type Menu, type MarkdownFileInfo, type MarkdownView, type MarkdownPostProcessorContext } from 'obsidian';
import { parsePlan, taskDescription } from './parser';
import { renderCompactOverview, renderOverflowPanel, renderWarningPanel } from './compact';
import { renderSpiral } from './spiral';
import { renderCapacityHeader } from './header';
import { renderChartControls, collapsedStorageFromApp, type ChartControlState } from './controls';
import { resolveDayState } from './daystate';
import { NAUTILUS_VIEW_TYPE, NautilusSidebarView, resolveDailyNoteInfo, primeDailyNotesConfig } from './sidebar';
import {
  initTimingObsidian, diagnoseTiming, timingCacheReady, bumpProgress,
  hasDoneAtAnchor, doneAtStamp, setDailyNoteRefreshCallback, disposeTimingObsidian,
} from './timing-obsidian';

// 这两个纯函数按「单一正则真源」迁到了 timing-obsidian.ts（自动打戳与手动命令
// 共用同一份 DONE_AT 语法）。保持本模块的导出面不变 —— timing-commands.test.js
// 从 main.ts 取它们。
export { hasDoneAtAnchor, doneAtStamp };
import { renderTimingStatusBar } from './statusbar';
import type { ExecViewContext, TimingRuntime, TimingSnapshot } from './timing-contract';
import { createTimingRuntime } from './vendor/timing-runtime';
import { parseBlockConfig, applyOverrides, extractPlanBody } from './blockconfig';
import TEST_NOTE from '../docs/test-note.md';
import { NautilusLogSettingTab, localCopy, commandCopy, type LocalCopy } from './settings';
import { DEFAULT_SETTINGS, type NautilusSettings, type LogCore } from './contract';

const logCore = require('./vendor/log-core') as unknown as LogCore;

function nowMinutes(): number {
  const date = new Date();
  return date.getHours() * 60 + date.getMinutes();
}

/** 无法识别的配置键警告。P1-8：tooltip 走双语表，不再硬编码英文。
 *  🔴 抽成导出的纯 DOM 函数是为了**可测**：main.ts 历史上零覆盖，
 *     而「文案恒为英文」这类回归只有真渲染一遍才抓得住（audit §5 / §P1-8）。 */
export function renderConfigWarning(
  root: HTMLElement,
  unknown: { key: string; value?: string }[],
  copy: LocalCopy,
): void {
  const warn = root.createDiv({ cls: 'nautilus-log-config-warning' });
  warn.setText('⚠ ' + unknown.map((u) => (u.value ? `${u.key}: ${u.value}` : u.key)).join(' · '));
  warn.title = copy.unknownConfig;
}

/** 块里一条计划都没有时的空态：给可照抄的写法 + 诊断行。P1-8 同上。 */
export function renderBlockEmptyState(root: HTMLElement, copy: LocalCopy, diag: string): void {
  const hint = root.createDiv({ cls: 'nautilus-log-empty' });
  hint.createDiv().setText(copy.blockEmptyHeading);
  hint.createEl('pre').setText(copy.blockEmptySample);
  hint.createDiv({ cls: 'nautilus-log-empty-note' }).setText(copy.blockEmptyNote);
  hint.createDiv({ cls: 'nautilus-log-diag' }).setText(diag);
}

/** One ```nautilus block. Owns its DOM node and its listeners, and cleans
 *  every one of them up on unload. */
/** 代码块语言别名。改这里即可，围栏正则由它派生 —— 只有一处真源。 */
const BLOCK_LANGS = ['nautilus', 'naut'] as const;
const FENCE_OPEN_RE = new RegExp(`^\\s*\`\`\`+\\s*(?:${BLOCK_LANGS.join('|')})\\s*$`);
const FENCE_CLOSE_RE = /^\s*```+\s*$/;

/** 🔴 导出是为了**可测**：这个类是代码块渲染的全部，历史上零覆盖
 *  （认证审计 V1「把 locateInText 改成 return null，320 条测试一条不红」）。
 *  test/block-render.test.js bundle 的就是它本体。 */
export class NautilusLogView extends MarkdownRenderChild {
  private timer: number | null = null;
  private metadataListener: ((file: TFile) => void) | null = null;

  /** C2-075/085：紧凑面板折叠态的宿主。代码块每分钟 tick 重渲染、`<details>`
   *  整个重建，展开/收起必须存进这里、重渲染时经 options.state 读回 —— 否则
   *  用户手动展开的面板 60 秒后自己合上。键：overview / schedule。 */
  private compactOpen = new Map<string, boolean>();

  constructor(
    containerEl: HTMLElement,
    private plugin: NautilusLogPlugin,
    private sourcePath: string,
    private source: string,
    private ctx: MarkdownPostProcessorContext,
  ) {
    super(containerEl);
  }

  onload(): void {
    // 🔴 不能在这里直接 render：此刻 containerEl 还没挂进文档，
    //    ctx.getSectionInfo() 会一路返回 null（实测 7/7 块全 null），
    //    计划正文完全取不到 => 图全空。延到挂载之后再取。
    this.scheduleRender();
    this.metadataListener = (file) => {
      if (file.path !== this.sourcePath) return;
      // 🔴 先失效缓存再重渲染，否则会拿改动前的正文画图。
      this.plugin.fileCache.delete(this.sourcePath);
      void this.render();
    };
    this.plugin.app.metadataCache.on('changed', this.metadataListener);
    this.timer = window.setInterval(() => this.render(), 60_000);
  }

  onunload(): void {
    this.sectionRetryCancelled = true;
    this.spiral?.destroy();
    this.spiral = null;
    this.controls?.destroy();
    this.controls = null;
    this.stopPlaybackClock();
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
    if (this.metadataListener) {
      this.plugin.app.metadataCache.off('changed', this.metadataListener);
      this.metadataListener = null;
    }
  }

  /** getSectionInfo 依赖元素已在文档中。onload 时通常还没挂上，
   *  这里按帧重试若干次；仍拿不到就走 fallback（读文件自行定位本块）。 */
  private scheduleRender(attempt = 0): void {
    if (this.ctx.getSectionInfo(this.containerEl) || attempt >= 12) {
      void this.render();
      return;
    }
    window.requestAnimationFrame(() => {
      if (this.sectionRetryCancelled) return;
      this.scheduleRender(attempt + 1);
    });
  }

  /** fallback：getSectionInfo 始终为 null 时，直接读文件、按「第 N 个内容相同的
   *  nautilus 块」定位自己。N 取自本块在文档中已渲染的同源块序号。 */
  private locateInText(text: string): { text: string; lineEnd: number } | null {
    const lines = text.split(/\r?\n/);
    const ends: { body: string; lineEnd: number }[] = [];
    for (let i = 0; i < lines.length; i += 1) {
      if (!FENCE_OPEN_RE.test(lines[i])) continue;
      let j = i + 1;
      const body: string[] = [];
      while (j < lines.length && !FENCE_CLOSE_RE.test(lines[j])) { body.push(lines[j]); j += 1; }
      ends.push({ body: body.join('\n'), lineEnd: j });
      i = j;
    }
    if (ends.length === 0) return null;
    const src = this.source.replace(/\s+$/, '');
    const same = ends.filter((e) => e.body.replace(/\s+$/, '') === src);
    const pool = same.length > 0 ? same : ends;
    // 同源块可能有多个（例如多个空块）=> 用本块的出现次序消歧。
    // 🔴 次序必须在【同源块】这个索引空间里数，不能在【全部块】里数：
    //    两个空间不一致时会取错块（实测：笔记有 4 个空块，场景 4 是全局第 4 个
    //    但只是第 3 个空块，按全局序号取就落到了最后一个空块＝场景 7 的位置）。
    //    dataset 里同时带上 sourcePath —— 多篇笔记同时打开时不能互相干扰。
    const doc = this.containerEl.ownerDocument;
    const key = `${this.sourcePath}\u0000${src}`;
    const peers = Array.from(
      doc.querySelectorAll<HTMLElement>('.nautilus-log-block'),
    ).filter((e) => e.dataset.nlKey === key);
    const ordinal = Math.max(0, peers.indexOf(this.containerEl));
    const pick = pool[Math.min(ordinal, pool.length - 1)];
    return { text, lineEnd: pick.lineEnd };
  }

  private sectionRetryCancelled = false;
  private spiral: { destroy(): void } | null = null;
  private controls: { destroy(): void } | null = null;
  /** 图表控制状态。回放/显示已完成是【纯视觉】的，不写回 Markdown。 */
  private chartState: ChartControlState = { showDone: true, collapsed: false, playback: null };
  /** 回放时钟。归 view 所有 —— controls 每次状态变化都会被重建，
   *  定时器放在那里会变成清不掉的孤儿（见 controls.ts 的注释）。 */
  private playbackTimer: number | null = null;

  private stopPlaybackClock(): void {
    if (this.playbackTimer !== null) {
      window.clearInterval(this.playbackTimer);
      this.playbackTimer = null;
    }
  }

  /** 状态里有 playback 就保证时钟在跑，没有就保证停掉。幂等，可反复调。 */
  private syncPlaybackClock(startMinutes: number, endMinutes: number): void {
    if (this.chartState.playback === null) { this.stopPlaybackClock(); return; }
    if (this.playbackTimer !== null) return;            // 已在跑，别重复起
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

  /** 缓存命中则同步返回（PDF 导出走这条）；未命中返回 null，由调用方补一次异步。 */
  private locateCached(): { text: string; lineEnd: number } | null {
    const cached = this.plugin.fileCache.get(this.sourcePath);
    return cached ? this.locateInText(cached) : null;
  }

  async render(): Promise<void> {
    const el = this.containerEl;
    el.empty();
    el.addClass('nautilus-log-block');
    // 消歧用的键：同一篇笔记 + 同样的块内容才算同源。必须在定位之前写好。
    el.dataset.nlKey = `${this.sourcePath}\u0000${this.source.replace(/\s+$/, '')}`;

    // ── 方案 5 ──────────────────────────────────────────────────────────
    // 代码块内容 = 当天配置覆盖（YAML 风格）；计划正文 = 块【之后】到第一个
    // 空白行为止的兄弟行。这样任务始终是可编辑的原生 markdown，也进全局索引。
    const overrides = parseBlockConfig(this.source);
    const settings = applyOverrides(this.plugin.settings, overrides);

    let src: { text: string; lineEnd: number } | null = this.ctx.getSectionInfo(this.containerEl);
    let via = 'section';
    if (!src) { src = this.locateCached(); via = 'cache'; }
    if (!src) {
      // 缓存冷：异步读一次，写入缓存后重渲染。下次（含 PDF 导出）就走同步路径了。
      const text = await this.plugin.primeCache(this.sourcePath);
      if (text) { src = this.locateInText(text); via = 'file'; }
    }
    let planBody = '';
    let lineOffset = 0;
    if (src) {
      const extracted = extractPlanBody(src.text, src.lineEnd);
      planBody = extracted.body;
      lineOffset = extracted.startLine;
    }
    const section = src;
    // 诊断：getSectionInfo 官方文档明写「很多情况下返回 null」，而计划正文完全
    // 依赖它。没有这条，"图是空的" 会有十几种可能原因，无法区分。
    const diag = section
      ? `via ${via} ✓ blockEnd ${section.lineEnd} of ${section.text.split('\n').length} lines · plan ${planBody.split('\n').filter((l) => l.trim()).length} lines from ${lineOffset}`
      : '✗ both getSectionInfo() and file fallback failed';

    // P1-8：这四处空态/警告文案引擎的 uiCopy 里没有对应 key（已枚举），走本地双语表。
    const local = localCopy(settings.language);
    const schedule = logCore.normalizeScheduleSettings({
      startHour: settings.workdayStartHour,
      endHour: settings.workdayEndHour,
    });
    const plan = parsePlan(planBody, { sourcePath: this.sourcePath, settings, lineOffset });
    // 🔴 容量的"从哪一刻算"取决于这篇笔记是哪一天：
    //    看昨天 => 从当天【终点】算（＝那天原本的完整容量，"还剩多少"没有意义）
    //    看明天 => 从当天【起点】算
    //    看今天 => 从此刻算
    // 🔴 认证审计 L1-063：回放时的「此刻」必须是**回放帧**，不是真实时钟。
    //    上游 component.cljs:1456 把 `now-time-atom` 直接 reset 成 simulated-minute，
    //    :1836 再以它作 `:nowMinutes` 喂 timelineDayState —— 于是 elapsedThrough /
    //    scheduleFrom / capacityFrom 三者全都随帧走。
    //    本移植原先只把帧喂给 `renderSpiral(..., {playbackMinute})`，dayState 仍吃
    //    真实时钟 ⇒ 流逝斜纹冻在真实 now、跑在针**前面**，弹性任务也不随帧重排
    //    （回放动画只剩针在动）。
    const playbackMinute = this.chartState.playback?.minute ?? null;
    const dayState = resolveDayState({
      sourcePath: this.sourcePath,
      startMinutes: schedule.startMinutes,
      endMinutes: schedule.endMinutes,
      nowMinutes: playbackMinute ?? nowMinutes(),
      playback: playbackMinute !== null,
    });
    const capacityBase = logCore.calculateCapacity({
      startMinutes: schedule.startMinutes,
      endMinutes: schedule.endMinutes,
      nowMinutes: dayState.capacityFromMinutes,
      fixedEvents: plan.events,
      allFixedEvents: plan.events,
      pendingTasks: plan.tasks,
    });

    // 🔴 P0-5：上游把【排程起点】与【容量起点】分成【两次独立调用】：
    //    `scheduleTasks(nowMinutes = scheduleFrom)` 决定楔形画在盘上哪儿
    //    （component.cljs:729 的 fill-day），
    //    `calculateCapacity(nowMinutes = capacityFrom)` 只管数字（:1852）。
    //    本移植原先只调后者、把它内部的 scheduledTasks 直接拿去画 —— 于是
    //    看过去的日子时 capacityFrom = 当天终点，拿它起排一个都排不下，
    //    弹性任务全落 overflow。overflow 仍以 calculateCapacity 为准
    //    （上游 fill-day 的 docstring 原话："overflow is returned separately
    //    by calculate-capacity"）。
    const scheduled = logCore.scheduleTasks({
      startMinutes: schedule.startMinutes,
      endMinutes: schedule.endMinutes,
      nowMinutes: dayState.scheduleFromMinutes,
      tasks: plan.tasks,
      fixedEvents: plan.events,
    });
    const capacity = { ...capacityBase, scheduledTasks: scheduled.scheduledTasks };

    const root = el.createDiv({ cls: 'nautilus-log' });

    // 无法识别的配置键：报出来，不静默吞掉（否则用户敲错一个词会以为插件坏了）
    if (overrides.unknown.length > 0) renderConfigWarning(root, overrides.unknown, local);

    // 计划为空：给出可照抄的写法，而不是渲染一张空盘让人猜
    if (plan.events.length === 0 && plan.tasks.length === 0) {
      renderBlockEmptyState(root, local, diag);
      return;
    }


    // 解析到了行、但排不出任何需求/事件 => 一定有问题，明说，别渲染一张空盘让人猜
    if (capacity.demandMinutes === 0 && capacity.totalFixedMinutes === 0) {
      const d = root.createDiv({ cls: 'nautilus-log-diag' });
      d.setText(`⚠ nothing scheduled — ${diag} · events ${plan.events.length} · tasks ${plan.tasks.length} · malformed ${plan.malformed.length}`);
    }

    renderCapacityHeader(root, capacity, settings, dayState.capacityFromMinutes);
    // 紧凑概览（窄容器时才由 CSS 显出来）。canonical 摘要在折叠头里，body 只有
    // Available/Events + 图例 —— 照上游 5464e9d 之后的行为，不重复。
    renderCompactOverview(root, capacity, settings, dayState.capacityFromMinutes,
      logCore.uiCopy(settings.language) as never, { state: { key: "overview", states: this.compactOpen } });


    // 螺旋图。几何全部来自 vendor 的 log-core（spiralCellInnerHour /
    // hourlyGridSegments / placeLabelTracks 等），这里只负责把它挂上 DOM。
    // 控制按钮栏（眼睛 / 播放 / 折叠）。它只改视觉状态，不碰 Markdown。
    this.controls?.destroy();
    this.controls = renderChartControls(
      root,
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
        // 🔴 非今天时把 now 置为起点 => 回放"没有可回放区间"从而不启动。
        //    眼睛与折叠保留（看历史时收起图 / 切换已完成显示仍然合理），
        //    只有"回放今天到现在"对非今天没有意义。
        nowMinutes: dayState.interactive ? nowMinutes() : schedule.startMinutes,
      },
      `${this.sourcePath}:${lineOffset}`,
      // 折叠态走 Obsidian 官方 device-local 存储（注入，不在 controls 里摸全局）。
      collapsedStorageFromApp(this.plugin.app),
    );

    if (this.chartState.collapsed) {
      this.spiral?.destroy();
      this.spiral = null;
      return;   // 折叠：只藏图，容量指标和计划文本仍然可见
    }

    const chart = root.createDiv({ cls: 'nautilus-log-chart' });
    try {
      // 🔴 上一次的 hover 监听必须先拆，否则每次重渲染（每分钟 tick + 文件改动）
      //    都会再挂一层，很快就累积成泄漏。
      this.spiral?.destroy();
      this.spiral = renderSpiral(chart, plan, capacity, settings, nowMinutes(), {
        showDone: this.chartState.showDone,
        playbackMinute,
        dayState,
        // C2-075：把紧凑日程清单的折叠态交给 renderSpiral（宿主 Map 跨 tick 存活）。
        compactState: this.compactOpen,
        // P0-4：把执行层的 CLOCK 记录喂进去，已完成任务才画得出【实际】耗时。
        clockEntries: this.plugin.timingRuntime?.getSnapshot?.()?.entries ?? [],
        // 点击任务切片 → +10% 进度。走 timing-obsidian 的乐观锁写回；
        // 失败（行被外部改过 / 定位歧义）当场提示，不静默。
        onProgressClick: (uid) => {
          void bumpProgress(uid, 10, new Date()).catch((err: unknown) => {
            new Notice(err instanceof Error ? err.message : String(err));
          });
        },
      });
    } catch (err) {
      // 图挂了不该带走整个块 —— 容量数字比图更重要，必须还能看见。
      chart.remove();
      const warn = root.createDiv({ cls: 'nautilus-log-chart-error' });
      warn.setText('⚠ chart failed to render (capacity figures above are still valid)');
      console.error('[Nautilus Logger] renderSpiral failed', err);
    }


    // 溢出面板：可折叠 + 「总时长 · 条数」（上游是 <details>，本移植原先是
    // 不可折叠的 div 且丢了 unplacedMinutes 总计）。标题仍走 MarkdownRenderer，
    // 这样 [[链接]] / #标签 是活的。
    // 🔴 项目符号必须留在 DOM 层，不能进 markdown 字符串 —— 行首的 `· ` 会被
    //    Markdown 当成列表标记吃掉（实测 `· Nautilus Logger 插件完善 30m`
    //    渲染成 `· ... 30m`）。renderOverflowPanel 内部已经这么处理。
    renderOverflowPanel(root, capacity, logCore.uiCopy(settings.language) as never,
      (host, task) => {
        const md = `${taskDescription(task.string, settings.descLength)} ${logCore.formatDuration(task.duration)}`;
        MarkdownRenderer.render(this.plugin.app, md, host, this.sourcePath, this)
          .catch(() => { host.setText(md); });
      });

    // 排期警告（跨午夜 / 起止时间相同）。parser 现在会把 warningCode 带出来。
    renderWarningPanel(root, plan, logCore.uiCopy(settings.language) as never);
  }
}

/* ───────────────────────── P1-6 · 命令与块右键菜单 ─────────────────────────
 * 上游 `src/timing-commands.js:44-70` 注册命令面板 3 条 + `blockContextMenu` 2 条
 * （带 display-conditional）。本移植此前【一条都没有】——「在正文里对某一行直接
 * Clock in/out」没有任何入口（audit §P1-6）。
 *
 * 挂载面重排（PORTING-DECISIONS.md §5）：
 *   `extensionAPI.ui.commandPalette` → `Plugin.addCommand`
 *   `roamAlphaAPI.ui.blockContextMenu` → `workspace.on('editor-menu')`
 *
 * 🔴 决策全部抽成下面这些**纯函数**再由壳调用。main.ts 历史上零覆盖，而
 *    test/locate.test.js 是「复刻算法再测复刻件」的假覆盖（audit §5）——
 *    这里的测试 bundle 的是 main.ts 本体，不是复刻件。
 */

const timingCore = require('./vendor/timing-core') as {
  taskStatus(string: string): string | null;
};

/** 任务 uid 的形态是 `filepath:line`（0-based 行号，与
 *  timing-obsidian.ts `splitUid` 逐字对齐）。见 PORTING-DECISIONS.md §1。 */
export function uidForLine(sourcePath: string, line: number): string {
  return `${sourcePath}:${line}`;
}

/** 编辑器里某一行的任务状态。
 *  🔴 状态语法归 vendor 所有（`timing-core.taskStatus` 认的是 `{{TODO}}`），
 *     这里只做 markdown → Roam 形态的归一，与 timing-obsidian 的
 *     `normalizeTaskString` 同一套规则（那个函数没有导出，且 vendor 邻接层
 *     一个字都不许改，所以只能在这里重述这一条桥接）。
 *  §D1：本移植要求**显式** `- [ ]` / `- [x]`，裸行不算任务。 */
export function editorTaskStatus(line: string): string | null {
  if (typeof line !== 'string') return null;
  const m = /^\s*[-*+]\s+\[(.)\]\s*(.*)$/.exec(line);
  if (!m) return null;
  return timingCore.taskStatus(`${/[xX]/.test(m[1]) ? '{{DONE}}' : '{{TODO}}'} ${m[2]}`);
}

/** 今天主计划里的全部任务 uid。 */
export function planTaskUids(snapshot: TimingSnapshot | null): string[] {
  const tasks = (snapshot?.planSnapshot as { tasks?: { uid?: unknown }[] } | null | undefined)?.tasks;
  if (!Array.isArray(tasks)) return [];
  return tasks.map((t) => (typeof t?.uid === 'string' ? t.uid : '')).filter(Boolean);
}

/** 当前 Timing Line 聚焦的任务 uid；没有则 null。 */
export function focusedTaskUid(snapshot: TimingSnapshot | null): string | null {
  const uid = snapshot?.activeWork?.focused?.taskUid;
  return typeof uid === 'string' && uid ? uid : null;
}

/* ── §D8 · `dHH:MM` 完成锚点 ─────────────────────────────────────────────────
 * 🔴 P1「契约漏洞 2」/ P1-068：语法的**唯一权威**是 parser.ts:89 的
 *    `DONE_AT_RE = /(?:^|\s)d(\d{1,2})(?::(\d{1,2}))?(?=\s|$)/i`
 *    —— **分钟可省**（`d14` 合法）、**大小写不敏感**（`D14:30` 合法）。
 *    `hasDoneAtAnchor` / `doneAtStamp` 已迁到 timing-obsidian.ts（自动打戳
 *    与手动命令共用同一份正则，避免再抄一份漂移）。`completeWithTimestamp`
 *    留在本模块：它翻转 checkbox + 追加锚点，是手动命令专属的语义。 */
/** 勾选当前行并追加完成锚点。返回新行；不该改动时返回 `null`
 *  （非任务行 / 已有锚点 —— 见 P1-070：静默不动是有意的）。 */
export function completeWithTimestamp(line: string, stamp: string): string | null {
  if (typeof line !== 'string') return null;
  if (hasDoneAtAnchor(line)) return null;                 // 已有锚点，不重复追加
  let next = line;
  if (/^\s*[-*+]\s*\[ \]/.test(next)) {
    next = next.replace(/^(\s*[-*+]\s*)\[ \]/, '$1[x]');    // 未勾选 => 勾上
  } else if (!/^\s*[-*+]\s*\[[xX]\]/.test(next)) {
    return null;                                          // 不是任务行，不动
  }
  return `${next.replace(/\s+$/, '')} ${stamp}`;
}

export type TimingMenuAction = 'clock-in' | 'clock-out';

export interface TimingMenuContext {
  /** 右键所在行的原始 markdown。 */
  line: string;
  /** 该行的 uid（`filepath:line`）。 */
  uid: string;
  /** 执行层总开关 + runtime 是否真的在跑。**关闭时一个菜单项都不许出现**。 */
  enabled: boolean;
  focusedTaskUid: string | null;
  planTaskUids: string[];
}

/** 右键菜单该显示哪几项 —— 上游 display-conditional 的等价物。
 *  上游：Clock in ⇔ 该块是未完成 TODO；Clock out ⇔ 该块正是当前 Timing Line。
 *  本移植多要求一条「必须在今天的主计划里」：我们的 vendor
 *  （timing-runtime.js:403-406）在 startTask 里就是这么校验的，
 *  不加这条会给出一个点了必然报错的菜单项。 */
export function timingMenuActions(ctx: TimingMenuContext): TimingMenuAction[] {
  if (!ctx.enabled) return [];
  const actions: TimingMenuAction[] = [];
  if (editorTaskStatus(ctx.line) === 'TODO' && ctx.planTaskUids.includes(ctx.uid)) {
    actions.push('clock-in');
  }
  if (ctx.focusedTaskUid && ctx.focusedTaskUid === ctx.uid) actions.push('clock-out');
  return actions;
}

/** 「Focus current block」的前置校验，照抄上游 timing-commands.js:34-38 的两条判据：
 *  没有可用的块 → needTodo；块存在但不是未完成 TODO → onlyTodo。 */
export function focusCurrentBlockError(line: string): 'needTodo' | 'onlyTodo' | null {
  const status = editorTaskStatus(line);
  if (status === null) return 'needTodo';
  if (status !== 'TODO') return 'onlyTodo';
  return null;
}

/** Roam kebab 键 → 本移植 camelCase 字段。
 *  🔴 vendor 里每出现一个新的 `settings.get('...')` 字面量，这里必须有对应条目。
 *  枚举命令：`grep -no "settings.get('[a-z-]*')" src/vendor/*.js`
 *  见 PORTING-DECISIONS.md §D7 与 §7 的「键名空间」检测器。 */
const SETTINGS_KEY_MAP: Record<string, keyof NautilusSettings> = {
  'language': 'language',
  'workday-start': 'workdayStartHour',
  'workday-end': 'workdayEndHour',
  'todo-duration': 'todoDuration',
  'timing-line-sidebar': 'timingLineSidebar',
  'pomodoro-minutes': 'pomodoroMinutes',
  'recent-retention-minutes': 'recentRetentionMinutes',
  'forgotten-timer-minutes': 'forgottenTimerMinutes',
  // 本移植自有设置：没有 vendor 字面量会问它，但映射表保持「每个 camel 字段
  // 都能被 kebab 键触达」的全覆盖 —— 漏一个就是静默失效（见 §D7 与检测器 4）。
  'stamp-completion-time': 'stampCompletionTime',
};

/** 交给 vendored runtime 的 extensionAPI.settings shim。
 *  🔴 抽成导出的纯工厂是为了可测（§D7 的 kebab→camel 映射表 + T2-098 的
 *  广播语义都是此前零覆盖的宿主细节）；startExecutionLayer 只在接线。
 *
 *  🔴 认证审计 T2-098：runtime 内部状态【写盘】走 `set` —— 番茄钟状态一
 *  改变它就全量 `refreshSidebars()` + 把每篇打开的 markdown previewMode
 *  rerender(true) + `timingRuntime.refresh()`（saveSettings → §S12 广播链）。
 *  那是「设置变更立即重绘」的代价，只该为【用户改设置】付；runtime 内部
 *  写盘也走它 = 每次番茄钟起/停/到点都把整个工作区重绘一遍（重入/性能放大）。
 *  所以这里只 `persist()`（写盘，不广播）：runtime 自己的 `refresh()`→
 *  `publish()` 会把新快照推给订阅方（状态栏/面板），UI 不缺这一路。
 *  「落盘」必须保留 —— 否则重启后：番茄钟持久态、standalone 状态全部丢失
 *  （runtime 启动时靠 settings.get(POMODORO_STATE_KEY) 恢复）。 */
export function buildExecutionSettingsShim(host: {
  /** 每次调用现读，避免捕获到被整体替换的 settings 对象。 */
  getSettings(): NautilusSettings;
  runtimeState: Record<string, unknown>;
  persist(): Promise<void>;
}): { get(k: string): unknown; set(k: string, v: unknown): Promise<void> } {
  return {
    get: (k: string) => {
      // 🔴 vendor 问的是 Roam 的 kebab 键，我们的字段是 camelCase。
      //    直接透传 => 全部 undefined => 静默落引擎硬编码兜底。
      //    而兜底值恰好等于 DEFAULT_SETTINGS，所以默认配置下行为正确、
      //    只有改过设置的用户会撞上，测试必绿 —— 见 PORTING-DECISIONS.md §D7。
      const settings = host.getSettings() as unknown as Record<string, unknown>;
      const mapped = SETTINGS_KEY_MAP[k];
      if (mapped) return settings[mapped];
      const own = settings[k];
      // 第三层兜底：`POMODORO_STATE_KEY` 这类变量键不在映射表里，靠它落到
      // runtimeState（见 §D7）。
      return own !== undefined ? own : host.runtimeState[k];
    },
    set: async (k: string, v: unknown) => {
      host.runtimeState[k] = v;
      await host.persist();
    },
  };
}

/* ── 设置版本戳 + 一次性迁移（认证审计 E1-039 / E1-040）────────────────────────
 * 上游 index.js:197-204 / :275-286 有两条版本化迁移（`product-defaults-version`
 * = "timing-v1"、`language-default-version` = "en-v1"）。本移植此前**整类没有**
 * 这个机制（`grep -rni "migrat|defaults-version|schemaVersion"` 零命中）。
 *
 * 🔴 有意偏离：**只建机制，不照抄那两条迁移**。理由：
 *   · `prefix-str` 在本移植里根本不存在（Roam 组件前缀，无对应物）。
 *   · `workday-end === 24 → 21` 修的是上游自己历史上写坏的默认值；本移植的
 *     DEFAULT_SETTINGS 从来就是 21，而 24 在本移植的滑块上是**合法选择**
 *     （setLimits(1,24,1)）—— 照抄会静默毁掉用户主动选的「到 24:00」。
 *   · `initializeLanguage` 的「首次强制写 en」同理：本移植默认已是 en，
 *     强写只会把老用户主动选的 zh 抹掉。
 *   它**仍然必要**的那一半是「非 en/zh 一律重置」这条**净化**——与版本戳无关，
 *   每次 load 都该做，见 sanitizeSettings。
 */

/** 当前设置结构版本。数据里的 `_settingsVersion` 落后于它时按表补跑迁移。 */
export const SETTINGS_VERSION = 1;

export interface SettingsMigration {
  /** 跑完这条之后数据处于哪个版本。表按 `to` 升序执行。 */
  to: number;
  migrate(data: Record<string, unknown>): void;
}

/** 一次性迁移表。**现在是空的，这是有意的**（理由见上）。
 *  以后要修某个历史上写坏的值，就往这里加一条并把 SETTINGS_VERSION +1。 */
export const SETTINGS_MIGRATIONS: SettingsMigration[] = [];

/** 按版本戳补跑迁移。返回新数据与是否真的动过（动过才值得回写磁盘）。 */
export function migrateSettingsData(
  data: Record<string, unknown>,
  fromVersion: number,
): { data: Record<string, unknown>; version: number; changed: boolean } {
  const next = { ...data };
  let version = Number.isFinite(fromVersion) ? Number(fromVersion) : 0;
  let changed = false;
  for (const step of [...SETTINGS_MIGRATIONS].sort((a, b) => a.to - b.to)) {
    if (step.to <= version) continue;
    step.migrate(next);
    version = step.to;
    changed = true;
  }
  if (version !== SETTINGS_VERSION) { version = SETTINGS_VERSION; changed = true; }
  return { data: next, version, changed };
}

/** 非法值净化 —— 上游 initializeLanguage 里【与版本戳无关】的那一条：
 *  语言不是 `en`/`zh` 一律重置为 `en`。
 *  🔴 必须做：`loadSettings` 的 `Object.assign` 会把 data.json 里任何脏值
 *     （手改、旧版本、同步冲突）原样带进 `execContext().language` 喂给 vendor。
 *     `localCopy()` 会静默落 en，vendor 不会。 */
export function sanitizeSettings(settings: NautilusSettings): NautilusSettings {
  const out = { ...settings };
  if (out.language !== 'en' && out.language !== 'zh') out.language = 'en';
  return out;
}

export default class NautilusLogPlugin extends Plugin {
  settings: NautilusSettings = { ...DEFAULT_SETTINGS };

  /** 文件正文缓存。PDF 导出是独立渲染上下文：getSectionInfo() 必然 null，
   *  而读文件兜底是异步的、导出流程不等它 => 导出的 PDF 会是空计划。
   *  缓存让兜底在缓存命中时变成【同步】，导出因而拿得到计划。 */
  readonly fileCache = new Map<string, string>();

  async primeCache(path: string): Promise<string | null> {
    const f = this.app.vault.getAbstractFileByPath(path);
    if (!(f instanceof TFile)) return null;
    const text = await this.app.vault.cachedRead(f);
    this.fileCache.set(path, text);
    return text;
  }

  async onload(): Promise<void> {
    await this.loadSettings();
    // 命令名 + ribbon tooltip 在注册时定死（见 settings.ts COMMAND_COPY 的注释）：
    // 用户改语言后要重载插件才生效，设置项描述里已写明，不做动态重注册。
    const cmd = commandCopy(this.settings.language);

    // 两个都认：`nautilus` 是全名，`naut` 是好记的短写。
    // 🔴 新增别名时必须同步改 locateByFile() 的围栏正则，否则兜底定位不到该块。
    for (const lang of BLOCK_LANGS) {
      this.registerMarkdownCodeBlockProcessor(lang, (source, el, ctx: MarkdownPostProcessorContext) => {
        ctx.addChild(new NautilusLogView(el, this, ctx.sourcePath, source, ctx));
      });
    }

    // 执行层数据适配器：vendored 的 timing-runtime 通过它读写 vault。
    // 🔴 必须在任何执行层功能之前初始化，否则 getApp() 会抛「未初始化」。
    // 🔴 必须把日记定位【注入】给执行层适配器，否则它会走自己那份兜底逻辑
    //    （只认根目录 YYYY-MM-DD.md）=> 面板永远说「今天没有 Nautilus Log」，
    //    而侧栏这边明明已经能找到。同一个定位规则只允许有一份实现。
    void primeDailyNotesConfig(this.app);
    initTimingObsidian({
      app: this.app,
      notify: (msg: string) => { new Notice(msg); },
      dailyNotePath: () => resolveDailyNoteInfo(this.app).path,
      // 自动完成时间戳：每次触发现读，settings 对象可能被整体替换（§D7 同款）。
      shouldStampCompletion: () => this.settings.stampCompletionTime,
    });

    // 右侧栏视图 —— 不打开笔记也能看今天的盘。共用 renderSpiral。
    this.registerView(NAUTILUS_VIEW_TYPE, (leaf) => new NautilusSidebarView(
      leaf, this.settings, () => (this.timingRuntime ? this.execContext() : null)));
    this.addRibbonIcon('compass', cmd.ribbonOpen, () => { void this.activateSidebar(); });
    this.addCommand({
      id: 'open-sidebar',
      name: cmd.openSidebar,
      callback: () => { void this.activateSidebar(); },
    });

    // 执行层：总开关打开才起 runtime + 状态栏。
    // 🔴 关闭时【一个定时器/订阅都不许起】—— 上游默认也是关的，
    //    关着还跑就等于用户明确说不要、我们还在后台烧。
    // 🔴🔴 必须等 onLayoutReady，不能在 onload 里直接起：
    //    initTimingObsidian 的同步内容缓存也是等 onLayoutReady 才预热的
    //    （§D6），而 runtime.initialize() 会立刻 readAllEntries()。抢跑的话
    //    initialEntries 恒为空 => reconcileLegacyOverlap / closeDoneClocks
    //    这两件【一次性】修复空转，遗留的 running CLOCK 永远不会被自动关闭。
    //    见 PORTING-DECISIONS.md §D6 与 audit §P0-2。
    this.app.workspace.onLayoutReady(() => {
      if (!this.settings.actualTimeTracking) return;
      // 🔴 onLayoutReady 只保证「布局好了」，预热本身还是异步的 —— 必须 await。
      void timingCacheReady().then(() => {
        if (!this.settings.actualTimeTracking || this.timingRuntime) return;
        this.startExecutionLayer();
        // 🔴 执行层现在是【延后】启动的，而侧栏很可能在这之前就已经恢复并渲染完
        //    ——那一刻 getExecContext() 还返回 null，执行区就空着，而且此后
        //    再没有任何东西会叫醒它。必须在这里主动刷一次。
        //    （这条是 P0-2 修复引入的连锁问题，真机复验时才暴露。）
        if (this.timingRuntime) this.refreshSidebars();
      });
    });

    // 执行层链路诊断 —— 面板说「今天没有 Nautilus Log」时按这条命令看到底断在哪。
    this.addCommand({
      id: 'diagnose-execution-layer',
      name: cmd.diagnoseExecutionLayer,
      callback: () => { new Notice(`[Nautilus Logger] ${diagnoseTiming()}`, 15000); },
    });

    this.registerTimingCommands();

    this.addSettingTab(new NautilusLogSettingTab(this.app, this));

    // 勾选当前行并追加 `dHH:MM` 完成锚点。
    // 🔴 默认【不绑快捷键】—— 由用户在 设置 → 快捷键 自行指定。
    // 为什么需要它：Roam 侧有 Todo Trigger 自动打时间戳，Obsidian 没有；
    // 而没有锚点的已完成任务在盘上画不出来（引擎拒绝编造历史）。
    this.addCommand({
      id: 'complete-with-timestamp',
      name: cmd.completeWithTimestamp,
      editorCallback: (editor: Editor) => {
        const cursor = editor.getCursor();
        const next = completeWithTimestamp(editor.getLine(cursor.line), doneAtStamp(new Date()));
        if (next === null) return;
        editor.setLine(cursor.line, next);
      },
    });

    this.addCommand({
      id: 'create-test-note',
      name: cmd.createTestNote,
      callback: async () => {
        const base = 'Nautilus Logger 测试';
        let path = `${base}.md`;
        // 已存在就加序号，绝不覆盖用户已有的笔记
        for (let n = 2; this.app.vault.getAbstractFileByPath(path); n += 1) {
          path = `${base} ${n}.md`;
        }
        const file = await this.app.vault.create(path, TEST_NOTE);
        await this.app.workspace.getLeaf(false).openFile(file);
      },
    });

    this.addCommand({
      id: 'open-nautilus-settings',
      name: cmd.openSettings,
      callback: () => {
        (this.app as unknown as { setting: { open(): void } }).setting.open();
      },
    });
  }

  /** 执行层 runtime，且总开关确实是开的。任何执行层入口都必须过这道闸：
   *  🔴 总开关关闭时命令面板与右键菜单里**一个入口都不许出现**。 */
  private liveRuntime(): TimingRuntime | null {
    if (!this.settings.actualTimeTracking) return null;
    return this.timingRuntime;
  }

  /** 上游 timing-commands.js:20-27 的 `run()`：任何失败都变成一条 toast，
   *  绝不让 promise rejection 冒到控制台之外。 */
  private runTimingAction(action: () => Promise<unknown> | unknown): void {
    const fail = (error: unknown) => {
      console.error('[Nautilus Logger] timing command failed', error);
      new Notice(`[Nautilus Logger] ${(error as Error)?.message || 'could not complete that action.'}`);
    };
    try {
      Promise.resolve(action()).catch(fail);
    } catch (error) {
      fail(error);
    }
  }

  /** P1-6：上游的 3 条命令面板项 + 2 条块右键菜单项。
   *  见 PORTING-DECISIONS.md §5 与 docs/parity-audit-2026-08-25.md §P1-6。 */
  private registerTimingCommands(): void {
    // 命令名按当前语言取（用户改语言后需重载插件才生效，见 COMMAND_COPY 注释）。
    const cmd = commandCopy(this.settings.language);
    // 1/3 Focus current block —— 把光标所在行送上 Timing Line。
    this.addCommand({
      id: 'focus-current-block',
      name: cmd.focusCurrentBlock,
      editorCheckCallback: (checking: boolean, editor: Editor, info: MarkdownView | MarkdownFileInfo) => {
        const runtime = this.liveRuntime();
        const path = info?.file?.path;
        if (!runtime || !path) return false;
        if (checking) return true;
        const lineNo = editor.getCursor().line;
        const line = editor.getLine(lineNo);
        const problem = focusCurrentBlockError(line);
        if (problem) {
          new Notice(`[Nautilus Logger] ${localCopy(this.settings.language)[problem]}`);
          return true;
        }
        this.runTimingAction(() => runtime.startTask(uidForLine(path, lineNo), line));
        return true;
      },
    });

    // 2/3 Clock out Timing Line.
    this.addCommand({
      id: 'clock-out-timing-line',
      name: cmd.clockOutTimingLine,
      checkCallback: (checking: boolean) => {
        const runtime = this.liveRuntime();
        if (!runtime) return false;
        if (!checking) this.runTimingAction(() => runtime.stopTask());
        return true;
      },
    });

    // 3/3 Locate Primary Plan.
    this.addCommand({
      id: 'locate-primary-plan',
      name: cmd.locatePrimaryPlan,
      checkCallback: (checking: boolean) => {
        const runtime = this.liveRuntime();
        if (!runtime) return false;
        if (!checking) this.runTimingAction(() => runtime.locate());
        return true;
      },
    });

    // 块右键菜单。Roam 的 blockContextMenu 在 Obsidian 的等价挂载面是
    // editor-menu；条件显示由 timingMenuActions 这个纯函数决定。
    this.registerEvent(this.app.workspace.on(
      'editor-menu',
      (menu: Menu, editor: Editor, info: MarkdownView | MarkdownFileInfo) => {
        const runtime = this.liveRuntime();
        const path = info?.file?.path;
        if (!runtime || !path) return;
        const lineNo = editor.getCursor().line;
        const snapshot = runtime.getSnapshot();
        const uid = uidForLine(path, lineNo);
        const actions = timingMenuActions({
          line: editor.getLine(lineNo),
          uid,
          enabled: true,
          focusedTaskUid: focusedTaskUid(snapshot),
          planTaskUids: planTaskUids(snapshot),
        });
        if (actions.length === 0) return;
        const copy = localCopy(this.settings.language);
        for (const action of actions) {
          menu.addItem((item) => item
            .setTitle(action === 'clock-in' ? copy.clockIn : copy.clockOut)
            .setIcon(action === 'clock-in' ? 'play' : 'square')
            .onClick(() => {
              this.runTimingAction(() => (action === 'clock-in'
                ? runtime.startTask(uid, editor.getLine(lineNo))
                : runtime.stopTask()));
            }));
        }
      },
    ));
  }

  /** 打开（或聚焦）右侧栏视图。已存在就复用，不重复开。 */
  /** 执行层运行时 + 状态栏。总开关关闭时保持 null，不占任何资源。 */
  timingRuntime: TimingRuntime | null = null;
  private statusBar: { destroy(): void } | null = null;
  /** runtime 的内部状态（番茄钟等）。与用户设置分开存，避免污染 NautilusSettings。 */
  runtimeState: Record<string, unknown> = {};

  execContext(): ExecViewContext {
    return {
      runtime: this.timingRuntime as TimingRuntime,
      language: this.settings.language,
      pomodoroMinutes: this.settings.pomodoroMinutes,
      forgottenTimerMinutes: this.settings.forgottenTimerMinutes,
      recentRetentionMinutes: this.settings.recentRetentionMinutes,
      // 执行层面板的兜底时长。缺了它 exec-panel 会退回硬编码 15。
      todoDuration: this.settings.todoDuration,
    };
  }

  /** 主开关的唯一入口 —— 上游 index.js:245-268 `setTrackingEnabled` 的等价物。
   *  🔴 认证审计 E1-016：**开失败必须把设置回滚成 false**。
   *     原先只 `console.error` + 拆掉运行时，开关却停在「开」⇒ 用户看到一个
   *     开着但毫无效果的开关，下次启动继续尝试、继续失败。
   *  🔴 E1-017/E1-059：关的时候走 `stopExecutionLayer({closeActive:true})`
   *     ⇒ `runtime.disable()`（关掉所有在跑的 CLOCK + 清番茄钟持久态）。
   *  返回**最终**的开关值（可能与入参不同）。 */
  async setTrackingEnabled(enabled: boolean): Promise<boolean> {
    this.settings.actualTimeTracking = enabled;
    await this.saveSettings();
    if (enabled && !this.startExecutionLayer()) {
      this.settings.actualTimeTracking = false;           // 回滚
      await this.saveSettings();
      new Notice('[Nautilus Logger] 执行层启动失败，已关闭「实际用时」开关。详见 console。');
    }
    if (!enabled) this.stopExecutionLayer({ closeActive: true });
    this.refreshSidebars();
    return this.settings.actualTimeTracking;
  }

  /** 返回 `false` 表示没起来（调用方据此回滚设置，见 setTrackingEnabled）。 */
  startExecutionLayer(): boolean {
    if (this.timingRuntime) return true;
    try {
      this.timingRuntime = createTimingRuntime({
        // 🔴 runtime 需要 get 和 set 两个 —— 它用 settings.set 持久化番茄钟状态
        //    （POMODORO_STATE_KEY / STANDALONE_POMODORO_STATE_KEY）。
        //    只给 get 时 Clock Out 会抛 "settings.set is not a function"。
        //    这些是 runtime 的内部状态键，不属于 NautilusSettings，单独存一份。
        extensionAPI: {
          // 🔴 拿去重放用的 shim 在 buildExecutionSettingsShim（§D7 + T2-098），
          //    这里只接线：settings 现读、runtimeState 是本插件的、写盘不广播。
          settings: buildExecutionSettingsShim({
            getSettings: () => this.settings,
            runtimeState: this.runtimeState,
            persist: () => this.persist(),
          }),
        },
      }) as unknown as TimingRuntime;
      // 🔴 今日日记一变就立刻 requestRefresh —— 执行层从「轮询」变「事件驱动」。
      //    vendor 的轮询间隔（15s / 上游 HEAD 起 5min）对「用户手动改日记」太钝，
      //    而上游兜底用的 Roam PullWatch 桥本移植明确不移植（台账 §D11）。
      //    stopExecutionLayer / disposeTimingObsidian 会把它摘掉 —— 执行层
      //    关闭或插件卸载后一个事件钩子都不留。
      setDailyNoteRefreshCallback(() => { void this.timingRuntime?.requestRefresh?.(); });
      // 🔴 必须 await + catch：initialize() 是异步的，`void` 会让 rejection
      //    逃出上面那个 try/catch —— 状态栏已经挂上、runtime 却永停 'loading'，
      //    没有 ticker、用户零提示（认证审计 T2-019 / E1-054）。
      // 🔴 initialize() 是异步的，失败发生在 setTrackingEnabled 早已返回之后
      //    —— 所以回滚也必须在这里再做一次（E1-016 的异步那一半）。
      void this.timingRuntime.initialize().catch((err: unknown) => {
        console.error('[Nautilus Logger] 执行层初始化失败', err);
        new Notice('[Nautilus Logger] 执行层初始化失败，已停用。详见 console。');
        this.stopExecutionLayer();
        this.settings.actualTimeTracking = false;
        void this.saveSettings();
      });
      const el = this.addStatusBarItem();
      // 状态栏点击三态（见 PORTING-DECISIONS.md §D2）：
      //   普通点击 → 打开侧栏（Obsidian 这边最有用的默认）
      //   ⌥ Alt-click → 在主编辑区定位今天的计划
      //   ⇧ Shift-click → 把计划送右侧栏
      // 🔴 认证审计 P1-046：三态此前**只存在于这条注释里**，元素上没有任何
      //    title/aria —— 用户无从发现，也无从核对。文案由下面这个回调**同源**
      //    地描述它自己的三个分支，改行为不改文案会被 block-render 测试抓住。
      // title 由 statusbar.ts 独占渲染（它每次 render 都会重写）——
      // 这里只把宿主才知道的「普通点击开侧栏 + ⌥/⇧」三态交给它。
      // 见 PORTING-DECISIONS.md §D2。
      // 🔴 第二参传【取值函数】而不是值 —— 状态栏每次 render 现读设置，
      //    否则改了番茄钟阈值/语言要重启执行层才生效（认证审计 T3-034）。
      this.statusBar = renderTimingStatusBar(el, () => this.execContext(), (ev: MouseEvent) => {
        if (ev.altKey || ev.shiftKey) {
          const rt = this.timingRuntime;
          if (rt) { void Promise.resolve(rt.locate({ sidebar: ev.shiftKey })).catch(() => { /* 已由 runtime notice 报出 */ }); }
          return;
        }
        void this.activateSidebar();
      }, () => localCopy(this.settings.language).statusBarHint);
      return true;
    } catch (err) {
      // 执行层起不来不该带走整个插件 —— 规划与可视化必须还能用。
      console.error('[Nautilus Logger] execution layer failed to start', err);
      this.stopExecutionLayer();
      return false;
    }
  }

  onunload(): void {
    this.stopExecutionLayer();
    // 🔴 摘掉 timing-obsidian 的 metadataCache 监听（含今日日记刷新钩子）：
    //    插件卸载后一个事件监听都不许留在 vault 上。社区审核会查这条。
    disposeTimingObsidian();
  }

  /** 总开关切换后，让已经打开的侧栏立刻反映变化 —— 否则要关掉侧栏再开才生效。 */
  refreshSidebars(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(NAUTILUS_VIEW_TYPE)) {
      const view = leaf.view as unknown as { refreshExecutionArea?(): void };
      view?.refreshExecutionArea?.();
    }
  }

  /** 拆掉执行层。
   *  🔴 `closeActive` 区分两种场景 —— 上游 index.js:235-263 的 stopTiming：
   *    - **用户关主开关** => `disable()`：先把所有【在跑的 CLOCK 关掉】、
   *      清两套番茄钟持久态，再 destroy。不这么做就会把一条永不闭合的
   *      running CLOCK 永久留在用户笔记里（认证审计 T2-107 / E1-017 双路命中）。
   *    - **插件卸载** => 只 `destroy()`：用户没说要结束工作，下次启动还要接着算。 */
  stopExecutionLayer({ closeActive = false }: { closeActive?: boolean } = {}): void {
    this.statusBar?.destroy();
    this.statusBar = null;
    const rt = this.timingRuntime;
    this.timingRuntime = null;
    // 执行层关：摘掉今日日记刷新钩子（关闭后连一个待触发的防抖都不留）。
    setDailyNoteRefreshCallback(null);
    if (!rt) return;
    try {
      // 🔴 `disable()` 实际是**异步**的（vendor timing-runtime.js:536 走 enqueue），
      //    契约上标成 void。只用 try/catch 接不住它的 rejection ——
      //    会变成 unhandled rejection。这里显式吞掉。
      if (closeActive) void Promise.resolve(rt.disable()).catch(() => { /* 见下 */ });
      else rt.destroy();               // disable() 内部会自己 destroy
    } catch { /* 拆不干净也不能把插件带崩 */ }
  }

  async activateSidebar(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(NAUTILUS_VIEW_TYPE);
    if (existing.length > 0) {
      await this.app.workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf = this.app.workspace.getRightLeaf(false);
    if (!leaf) return;
    await leaf.setViewState({ type: NAUTILUS_VIEW_TYPE, active: true });
    await this.app.workspace.revealLeaf(leaf);
  }

  async loadSettings(): Promise<void> {
    const data = ((await this.loadData()) as Record<string, unknown> | null) || {};
    // runtime 的内部状态（番茄钟等）与用户设置同文件不同键，避免互相污染。
    this.runtimeState = (data._runtime as Record<string, unknown>) || {};
    const stamped = migrateSettingsData(
      data, typeof data._settingsVersion === 'number' ? data._settingsVersion : 0,
    );
    const merged = Object.assign({}, DEFAULT_SETTINGS, stamped.data) as Record<string, unknown>;
    // 🔴 认证审计 E1-030：data.json 里显式写的 `null` / `undefined` 必须视为【缺失】。
    //    Object.assign 只认「键存在」，把 null 原样带进来 ⇒ 手改或同步冲突写入
    //    `"descLength": null` 时，图例截断宽度变 0 / 滑块 setValue(null) / 数值键
    //    全变 null。契约里这些字段都是 number/string/boolean，null 一律回落
    //    DEFAULT_SETTINGS（上游 extensionAPI.settings 对缺失值也是 `?? default`）。
    //    只扫契约那 11 个键；`_runtime` / `_settingsVersion` 仍在下面单独剔除。
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      if (merged[key] === null || merged[key] === undefined) {
        merged[key] = (DEFAULT_SETTINGS as unknown as Record<string, unknown>)[key];
      }
    }
    // 下划线键是文件级元数据，不属于 NautilusSettings —— 别让它们渗进设置对象。
    delete merged._runtime;
    delete merged._settingsVersion;
    const before = merged.language;
    this.settings = sanitizeSettings(merged as unknown as NautilusSettings);
    // 🔴 迁移/净化过就把结果落盘，否则每次启动都要重跑一遍（且 vendor 那边
    //    仍会从磁盘读到脏值）。这里直接 saveData：onload 期间没有任何视图可广播。
    if (stamped.changed || before !== this.settings.language) await this.persist();
  }

  /** 只写盘、不广播。onload 期间用（那时还没有视图可刷）。 */
  private async persist(): Promise<void> {
    await this.saveData({
      ...this.settings,
      _runtime: this.runtimeState,
      _settingsVersion: SETTINGS_VERSION,
    });
  }

  async saveSettings(): Promise<void> {
    await this.persist();
    this.broadcastSettingsChanged();
  }

  /** 设置一改就让所有已渲染的视图立刻重画。
   *  🔴 上游 index.js:152-165 用一个自定义事件广播，component 监听后重绘；
   *     我这边没有这条线时，改完设置要【等 60 秒 tick】才看到效果（实测）。
   *  这里不引入上游的 plan-watch.js（那是 Roam Pull Watch，Obsidian 无等价物），
   *  只补上「设置变更」这一个触发时机 —— 文件变更早就有 metadataCache 在管。 */
  private broadcastSettingsChanged(): void {
    this.refreshSidebars();
    // 已打开笔记里的代码块视图：重跑一次 Markdown 后处理即可。
    for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
      const view = leaf.view as unknown as { previewMode?: { rerender?(full: boolean): void } };
      view?.previewMode?.rerender?.(true);
    }
    this.timingRuntime?.refresh?.();
  }
}
