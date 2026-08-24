/*
 * Nautilus Log for Obsidian — plugin entry point.
 *
 * Stage one: register the ```nautilus code-block processor, render a text-only
 * capacity bar, expose the settings tab and a command.  Obsidian has no
 * rdr/pull, so each block re-renders when its note changes (metadataCache
 * "changed") and on a per-minute tick (nowMinutes moves, so Overload moves).
 */

import { Plugin, MarkdownRenderChild, MarkdownRenderer, TFile, type Editor, type MarkdownPostProcessorContext } from 'obsidian';
import { parsePlan, taskDescription } from './parser';
import { renderSpiral } from './spiral';
import { renderCapacityHeader } from './header';
import { renderChartControls, type ChartControlState } from './controls';
import { NAUTILUS_VIEW_TYPE, NautilusSidebarView } from './sidebar';
import { initTimingObsidian } from './timing-obsidian';
import { renderTimingStatusBar } from './statusbar';
import type { ExecViewContext, TimingRuntime } from './timing-contract';
import { createTimingRuntime } from './vendor/timing-runtime';
import { parseBlockConfig, applyOverrides, extractPlanBody } from './blockconfig';
import TEST_NOTE from '../docs/test-note.md';
import { NautilusLogSettingTab } from './settings';
import { DEFAULT_SETTINGS, type NautilusSettings, type LogCore } from './contract';

const logCore = require('./vendor/log-core') as unknown as LogCore;

function nowMinutes(): number {
  const date = new Date();
  return date.getHours() * 60 + date.getMinutes();
}

/** One ```nautilus block. Owns its DOM node and its listeners, and cleans
 *  every one of them up on unload. */
/** 代码块语言别名。改这里即可，围栏正则由它派生 —— 只有一处真源。 */
const BLOCK_LANGS = ['nautilus', 'naut'] as const;
const FENCE_OPEN_RE = new RegExp(`^\\s*\`\`\`+\\s*(?:${BLOCK_LANGS.join('|')})\\s*$`);
const FENCE_CLOSE_RE = /^\s*```+\s*$/;

class NautilusLogView extends MarkdownRenderChild {
  private timer: number | null = null;
  private metadataListener: ((file: TFile) => void) | null = null;

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

    const copy = logCore.uiCopy(settings.language).capacity;
    const panelCopy = logCore.uiCopy(settings.language).panels;
    const schedule = logCore.normalizeScheduleSettings({
      startHour: settings.workdayStartHour,
      endHour: settings.workdayEndHour,
    });
    const plan = parsePlan(planBody, { sourcePath: this.sourcePath, settings, lineOffset });
    const capacity = logCore.calculateCapacity({
      startMinutes: schedule.startMinutes,
      endMinutes: schedule.endMinutes,
      nowMinutes: nowMinutes(),
      fixedEvents: plan.events,
      allFixedEvents: plan.events,
      pendingTasks: plan.tasks,
    });

    const root = el.createDiv({ cls: 'nautilus-log' });

    // 无法识别的配置键：报出来，不静默吞掉（否则用户敲错一个词会以为插件坏了）
    if (overrides.unknown.length > 0) {
      const warn = root.createDiv({ cls: 'nautilus-log-config-warning' });
      warn.setText('⚠ ' + overrides.unknown
        .map((u) => (u.value ? `${u.key}: ${u.value}` : u.key)).join(' · '));
      warn.title = 'Unrecognised setting. Supported: start, end, default-duration, legend-length, urgent, language';
    }

    // 计划为空：给出可照抄的写法，而不是渲染一张空盘让人猜
    if (plan.events.length === 0 && plan.tasks.length === 0) {
      const hint = root.createDiv({ cls: 'nautilus-log-empty' });
      hint.createDiv().setText('Nautilus Log — write the plan directly below this block:');
      const pre = hint.createEl('pre');
      pre.setText('05:00-06:00 Morning routine\n- [ ] Write project brief 45m\n- [ ] Review notes 30m');
      hint.createDiv({ cls: 'nautilus-log-empty-note' })
        .setText('The plan ends at the first blank line. The block itself holds per-day overrides, e.g. `end: 02:00`.');
      hint.createDiv({ cls: 'nautilus-log-diag' }).setText(diag);
      return;
    }


    // 解析到了行、但排不出任何需求/事件 => 一定有问题，明说，别渲染一张空盘让人猜
    if (capacity.demandMinutes === 0 && capacity.totalFixedMinutes === 0) {
      const d = root.createDiv({ cls: 'nautilus-log-diag' });
      d.setText(`⚠ nothing scheduled — ${diag} · events ${plan.events.length} · tasks ${plan.tasks.length} · malformed ${plan.malformed.length}`);
    }

    renderCapacityHeader(root, capacity, settings, nowMinutes());


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
        nowMinutes: nowMinutes(),
      },
      `${this.sourcePath}:${lineOffset}`,
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
        playbackMinute: this.chartState.playback?.minute ?? null,
      });
    } catch (err) {
      // 图挂了不该带走整个块 —— 容量数字比图更重要，必须还能看见。
      chart.remove();
      const warn = root.createDiv({ cls: 'nautilus-log-chart-error' });
      warn.setText('⚠ chart failed to render (capacity figures above are still valid)');
      console.error('[Nautilus Log] renderSpiral failed', err);
    }


    if (capacity.overflowTasks.length > 0) {
      const box = root.createDiv({ cls: 'nautilus-log-overflow' });
      box.createDiv({ cls: 'nautilus-log-overflow-heading' })
        .setText(`▼ ${panelCopy.overflow}`);
      // 方案 9：用 MarkdownRenderer 渲染，这样溢出任务里的 [[链接]] / #标签 是活的。
      // 先例：Tasks 插件的查询结果同样走 MarkdownRenderer.render()。
      // ⚠️ 它是异步的；渲染失败退回纯文本，不能让一个坏链接吃掉整个列表。
      for (const task of capacity.overflowTasks) {
        const row = box.createDiv({ cls: 'nautilus-log-overflow-item' });
        const md = `· ${taskDescription(task.string, settings.descLength)} ${logCore.formatDuration(task.duration)}`;
        MarkdownRenderer.render(this.plugin.app, md, row, this.sourcePath, this)
          .catch(() => { row.setText(md); });
      }
    }
  }
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

    // 两个都认：`nautilus` 是全名，`naut` 是好记的短写。
    // 🔴 新增别名时必须同步改 locateByFile() 的围栏正则，否则兜底定位不到该块。
    for (const lang of BLOCK_LANGS) {
      this.registerMarkdownCodeBlockProcessor(lang, (source, el, ctx: MarkdownPostProcessorContext) => {
        ctx.addChild(new NautilusLogView(el, this, ctx.sourcePath, source, ctx));
      });
    }

    // 执行层数据适配器：vendored 的 timing-runtime 通过它读写 vault。
    // 🔴 必须在任何执行层功能之前初始化，否则 getApp() 会抛「未初始化」。
    initTimingObsidian({ app: this.app });

    // 右侧栏视图 —— 不打开笔记也能看今天的盘。共用 renderSpiral。
    this.registerView(NAUTILUS_VIEW_TYPE, (leaf) => new NautilusSidebarView(leaf, this.settings));
    this.addRibbonIcon('compass', 'Open Nautilus Log', () => { void this.activateSidebar(); });
    this.addCommand({
      id: 'open-sidebar',
      name: 'Open Nautilus Log sidebar / 打开侧栏',
      callback: () => { void this.activateSidebar(); },
    });

    // 执行层：总开关打开才起 runtime + 状态栏。
    // 🔴 关闭时【一个定时器/订阅都不许起】—— 上游默认也是关的，
    //    关着还跑就等于用户明确说不要、我们还在后台烧。
    if (this.settings.actualTimeTracking) this.startExecutionLayer();

    this.addSettingTab(new NautilusLogSettingTab(this.app, this));

    // 勾选当前行并追加 `dHH:MM` 完成锚点。
    // 🔴 默认【不绑快捷键】—— 由用户在 设置 → 快捷键 自行指定。
    // 为什么需要它：Roam 侧有 Todo Trigger 自动打时间戳，Obsidian 没有；
    // 而没有锚点的已完成任务在盘上画不出来（引擎拒绝编造历史）。
    this.addCommand({
      id: 'complete-with-timestamp',
      name: 'Complete task with timestamp / 勾选并打完成时间戳',
      editorCallback: (editor: Editor) => {
        const cursor = editor.getCursor();
        const line = editor.getLine(cursor.line);
        const now = new Date();
        const stamp = `d${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
        if (/(?:^|\s)d\d{1,2}:\d{2}(?=\s|$)/.test(line)) return;   // 已有锚点，不重复追加
        let next = line;
        if (/^\s*[-*+]\s*\[ \]/.test(next)) {
          next = next.replace(/^(\s*[-*+]\s*)\[ \]/, '$1[x]');      // 未勾选 => 勾上
        } else if (!/^\s*[-*+]\s*\[[xX]\]/.test(next)) {
          return;                                                    // 不是任务行，不动
        }
        editor.setLine(cursor.line, `${next.replace(/\s+$/, '')} ${stamp}`);
      },
    });

    this.addCommand({
      id: 'create-test-note',
      name: 'Create Nautilus Log test note / 创建 Nautilus Log 测试笔记',
      callback: async () => {
        const base = 'Nautilus Log 测试';
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
      name: 'Open Nautilus Log settings',
      callback: () => {
        (this.app as unknown as { setting: { open(): void } }).setting.open();
      },
    });
  }

  /** 打开（或聚焦）右侧栏视图。已存在就复用，不重复开。 */
  /** 执行层运行时 + 状态栏。总开关关闭时保持 null，不占任何资源。 */
  timingRuntime: TimingRuntime | null = null;
  private statusBar: { destroy(): void } | null = null;

  execContext(): ExecViewContext {
    return {
      runtime: this.timingRuntime as TimingRuntime,
      language: this.settings.language,
      pomodoroMinutes: this.settings.pomodoroMinutes,
      forgottenTimerMinutes: this.settings.forgottenTimerMinutes,
      recentRetentionMinutes: this.settings.recentRetentionMinutes,
    };
  }

  startExecutionLayer(): void {
    if (this.timingRuntime) return;
    try {
      this.timingRuntime = createTimingRuntime({
        extensionAPI: { settings: { get: (k: string) => (this.settings as unknown as Record<string, unknown>)[k] } },
      }) as unknown as TimingRuntime;
      void this.timingRuntime.initialize();
      const el = this.addStatusBarItem();
      this.statusBar = renderTimingStatusBar(el, this.execContext(), () => { void this.activateSidebar(); });
    } catch (err) {
      // 执行层起不来不该带走整个插件 —— 规划与可视化必须还能用。
      console.error('[Nautilus Log] execution layer failed to start', err);
      this.stopExecutionLayer();
    }
  }

  onunload(): void {
    this.stopExecutionLayer();
  }

  stopExecutionLayer(): void {
    this.statusBar?.destroy();
    this.statusBar = null;
    try { this.timingRuntime?.destroy(); } catch { /* ignore */ }
    this.timingRuntime = null;
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
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}
