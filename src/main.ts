/*
 * Nautilus Log for Obsidian — plugin entry point.
 *
 * Stage one: register the ```nautilus code-block processor, render a text-only
 * capacity bar, expose the settings tab and a command.  Obsidian has no
 * rdr/pull, so each block re-renders when its note changes (metadataCache
 * "changed") and on a per-minute tick (nowMinutes moves, so Overload moves).
 */

import { Plugin, MarkdownRenderChild, MarkdownRenderer, TFile, type MarkdownPostProcessorContext } from 'obsidian';
import { parsePlan, taskDescription } from './parser';
import { renderSpiral } from './spiral';
import { parseBlockConfig, applyOverrides, extractPlanBody } from './blockconfig';
import { NautilusLogSettingTab } from './settings';
import { DEFAULT_SETTINGS, type NautilusSettings, type LogCore } from './contract';

const logCore = require('./vendor/log-core') as unknown as LogCore;

function nowMinutes(): number {
  const date = new Date();
  return date.getHours() * 60 + date.getMinutes();
}

/** One ```nautilus block. Owns its DOM node and its listeners, and cleans
 *  every one of them up on unload. */
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
      if (file.path === this.sourcePath) this.render();
    };
    this.plugin.app.metadataCache.on('changed', this.metadataListener);
    this.timer = window.setInterval(() => this.render(), 60_000);
  }

  onunload(): void {
    this.sectionRetryCancelled = true;
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
  private async locateByFile(): Promise<{ text: string; lineEnd: number } | null> {
    const file = this.plugin.app.vault.getAbstractFileByPath(this.sourcePath);
    if (!(file instanceof TFile)) return null;
    const text = await this.plugin.app.vault.cachedRead(file);
    const lines = text.split(/\r?\n/);
    const ends: { body: string; lineEnd: number }[] = [];
    for (let i = 0; i < lines.length; i += 1) {
      if (!/^\s*```+\s*nautilus\s*$/.test(lines[i])) continue;
      let j = i + 1;
      const body: string[] = [];
      while (j < lines.length && !/^\s*```+\s*$/.test(lines[j])) { body.push(lines[j]); j += 1; }
      ends.push({ body: body.join('\n'), lineEnd: j });
      i = j;
    }
    if (ends.length === 0) return null;
    const src = this.source.replace(/\s+$/, '');
    const same = ends.filter((e) => e.body.replace(/\s+$/, '') === src);
    const pool = same.length > 0 ? same : ends;
    // 同源块可能有多个（例如都是空块）=> 用本块在 DOM 中的出现次序消歧
    const rendered = Array.from(
      this.containerEl.ownerDocument.querySelectorAll('.nautilus-log-block'),
    );
    const ordinal = Math.max(0, rendered.indexOf(this.containerEl));
    const pick = pool[Math.min(ordinal, pool.length - 1)];
    return { text, lineEnd: pick.lineEnd };
  }

  private sectionRetryCancelled = false;

  async render(): Promise<void> {
    const el = this.containerEl;
    el.empty();
    el.addClass('nautilus-log-block');

    // ── 方案 5 ──────────────────────────────────────────────────────────
    // 代码块内容 = 当天配置覆盖（YAML 风格）；计划正文 = 块【之后】到第一个
    // 空白行为止的兄弟行。这样任务始终是可编辑的原生 markdown，也进全局索引。
    const overrides = parseBlockConfig(this.source);
    const settings = applyOverrides(this.plugin.settings, overrides);

    let src: { text: string; lineEnd: number } | null = this.ctx.getSectionInfo(this.containerEl);
    let via = 'section';
    if (!src) { src = await this.locateByFile(); via = 'file'; }
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

    const line = root.createDiv({ cls: 'nautilus-log-line' });
    line.setText([
      `${copy.demand} ${logCore.formatDuration(capacity.demandMinutes)}`,
      `${copy.available} ${logCore.formatDuration(capacity.availableMinutes)}`,
      `${copy.events} ${logCore.formatDuration(capacity.fixedMinutes)}`,
      `${copy.remaining} ${logCore.formatDuration(capacity.slackMinutes)}`,
    ].join(' · '));

    // 螺旋图。几何全部来自 vendor 的 log-core（spiralCellInnerHour /
    // hourlyGridSegments / placeLabelTracks 等），这里只负责把它挂上 DOM。
    const chart = root.createDiv({ cls: 'nautilus-log-chart' });
    try {
      renderSpiral(chart, plan, capacity, settings, nowMinutes());
    } catch (err) {
      // 图挂了不该带走整个块 —— 容量数字比图更重要，必须还能看见。
      chart.remove();
      const warn = root.createDiv({ cls: 'nautilus-log-chart-error' });
      warn.setText('⚠ chart failed to render (capacity figures above are still valid)');
      console.error('[Nautilus Log] renderSpiral failed', err);
    }

    if (capacity.overloadMinutes > 0) {
      const overload = root.createDiv({ cls: 'nautilus-log-overload' });
      overload.setText(`⚠ ${copy.overload} ${logCore.formatDuration(capacity.overloadMinutes)}`);
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

  async onload(): Promise<void> {
    await this.loadSettings();

    this.registerMarkdownCodeBlockProcessor('nautilus', (source, el, ctx: MarkdownPostProcessorContext) => {
      ctx.addChild(new NautilusLogView(el, this, ctx.sourcePath, source, ctx));
    });

    this.addSettingTab(new NautilusLogSettingTab(this.app, this));

    this.addCommand({
      id: 'open-nautilus-settings',
      name: 'Open Nautilus Log settings',
      callback: () => {
        (this.app as unknown as { setting: { open(): void } }).setting.open();
      },
    });
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}
