/*
 * sidebar.ts — the Nautilus Log sidebar view (P · 侧栏视图壳).
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
import { renderCapacityHeader } from './header';
import { parsePlan } from './parser';
import { parseBlockConfig, applyOverrides, extractPlanBody } from './blockconfig';
import type { Capacity, NautilusSettings } from './contract';
import { renderExecPanel } from './exec-panel';
import { renderPomoControl } from './pomo';
import type { ExecViewContext } from './timing-contract';

const logCore = require('./vendor/log-core') as {
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
};

export const NAUTILUS_VIEW_TYPE = 'nautilus-log-view';

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
  const dn = (app as unknown as {
    internalPlugins?: { plugins?: Record<string, { instance?: { options?: DailyNotesOptions } }> };
  }).internalPlugins?.plugins?.['daily-notes'];
  const opts = dn?.instance?.options;
  if (!opts) return null;
  return { format: opts.format, folder: opts.folder };
}

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
function resolveDailyNoteInfo(app: App): DailyNoteInfo {
  const opts = readDailyNotesOptions(app);
  if (opts && opts.format) {
    const folder = opts.folder || '';
    const dateStr = formatDate(opts.format);
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

  constructor(
    leaf: WorkspaceLeaf,
    private settings: NautilusSettings,
    /** 执行层上下文提供者。返回 null 表示总开关关闭 —— 此时不渲染任何执行层 UI。 */
    private getExecContext: (() => ExecViewContext | null) = () => null,
  ) {
    super(leaf);
  }

  getViewType(): string { return NAUTILUS_VIEW_TYPE; }
  getDisplayText(): string { return 'Nautilus Log'; }
  getIcon(): string { return 'compass'; }

  async onOpen(): Promise<void> {
    this.contentEl.addClass('nautilus-log-sidebar');
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
  }

  /** 执行层区域。总开关关闭时什么都不渲染（也就不起任何订阅/定时器）。 */
  private renderExecutionArea(): void {
    this.exec?.destroy(); this.exec = null;
    this.pomo?.destroy(); this.pomo = null;
    const ctx = this.getExecContext();
    if (!ctx || !ctx.runtime) return;
    const host = this.contentEl.createDiv({ cls: 'nautilus-log-exec-area' });
    try {
      this.pomo = renderPomoControl(host.createDiv({ cls: 'nautilus-log-pomo-slot' }), ctx);
      this.exec = renderExecPanel(host.createDiv({ cls: 'nautilus-log-exec-slot' }), ctx);
    } catch (err) {
      // 执行层挂了不该带走螺旋图 —— 规划视图必须还在。
      console.error('[Nautilus Log] execution panel failed', err);
      host.remove();
    }
  }

  async onClose(): Promise<void> {
    // 🔴 五个都得清，一个都不许漏：interval、事件监听、spiral、执行面板、POMO。
    this.exec?.destroy(); this.exec = null;
    this.pomo?.destroy(); this.pomo = null;
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
  }

  private disposeSpiral(): void {
    this.spiral?.destroy();
    this.spiral = null;
  }

  private async render(): Promise<void> {
    const el = this.contentEl;
    el.empty();

    const info = resolveDailyNoteInfo(this.app);
    const plan = await findDailyNotePlan(this.app, info.path);

    // 🔴 拿不到就【明说】，不静默渲染一张空盘 —— 否则会让人以为插件坏了，
    //    实际是数据没取到（本项目在这个坑上吃过亏）。
    if (!plan) {
      this.primaryPath = null;
      this.disposeSpiral();
      const hint = el.createDiv({ cls: 'nautilus-log-sidebar-empty' });
      hint.createDiv({ cls: 'nautilus-log-sidebar-empty-heading' })
        .setText('Nautilus Log — no plan for today');
      const sub = hint.createDiv({ cls: 'nautilus-log-sidebar-empty-note' });
      sub.setText(
        info.viaPlugin
          ? `Looking in ${info.path} for a \`\`\`nautilus block.\nWrite today's plan in that Daily Note.`
          : `No Daily Notes plugin config found; falling back to ${info.path}.\nConfigure the core Daily Notes plugin (format/folder) or create this file.`,
      );
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

    const root = el.createDiv({ cls: 'nautilus-log' });

    if (capacity.demandMinutes === 0 && capacity.totalFixedMinutes === 0) {
      const d = root.createDiv({ cls: 'nautilus-log-diag' });
      d.setText(`⚠ nothing scheduled — events ${parsed.events.length} · tasks ${parsed.tasks.length} · malformed ${parsed.malformed.length}`);
    }

    renderCapacityHeader(root, capacity, settings, nowMinutes());

    const chart = root.createDiv({ cls: 'nautilus-log-chart' });
    try {
      // 上一次的 hover 监听必须先拆，否则每次重渲染（每分钟 tick + 文件改动）
      //    都会再挂一层，很快就累积成泄漏。
      this.disposeSpiral();
      this.spiral = renderSpiral(chart, parsed, capacity, settings, nowMinutes());
    } catch (err) {
      chart.remove();
      const warn = root.createDiv({ cls: 'nautilus-log-chart-error' });
      warn.setText('⚠ chart failed to render (capacity figures above are still valid)');
      console.error('[Nautilus Log] sidebar renderSpiral failed', err);
    }
  }
}
