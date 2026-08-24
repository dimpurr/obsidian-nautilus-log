/*
 * Nautilus Log for Obsidian — plugin entry point.
 *
 * Stage one: register the ```nautilus code-block processor, render a text-only
 * capacity bar, expose the settings tab and a command.  Obsidian has no
 * rdr/pull, so each block re-renders when its note changes (metadataCache
 * "changed") and on a per-minute tick (nowMinutes moves, so Overload moves).
 */

import { Plugin, MarkdownRenderChild, TFile, type MarkdownPostProcessorContext } from 'obsidian';
import { parsePlan, taskDescription } from './parser';
import { renderSpiral } from './spiral';
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
  ) {
    super(containerEl);
  }

  onload(): void {
    this.render();
    this.metadataListener = (file) => {
      if (file.path === this.sourcePath) this.render();
    };
    this.plugin.app.metadataCache.on('changed', this.metadataListener);
    this.timer = window.setInterval(() => this.render(), 60_000);
  }

  onunload(): void {
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
    if (this.metadataListener) {
      this.plugin.app.metadataCache.off('changed', this.metadataListener);
      this.metadataListener = null;
    }
  }

  render(): void {
    const el = this.containerEl;
    el.empty();

    const settings = this.plugin.settings;
    const copy = logCore.uiCopy(settings.language).capacity;
    const panelCopy = logCore.uiCopy(settings.language).panels;
    const schedule = logCore.normalizeScheduleSettings({
      startHour: settings.workdayStartHour,
      endHour: settings.workdayEndHour,
    });
    const plan = parsePlan(this.source, { sourcePath: this.sourcePath, settings });
    const capacity = logCore.calculateCapacity({
      startMinutes: schedule.startMinutes,
      endMinutes: schedule.endMinutes,
      nowMinutes: nowMinutes(),
      fixedEvents: plan.events,
      allFixedEvents: plan.events,
      pendingTasks: plan.tasks,
    });

    const root = el.createDiv({ cls: 'nautilus-log' });

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
      for (const task of capacity.overflowTasks) {
        const row = box.createDiv({ cls: 'nautilus-log-overflow-item' });
        row.setText(`· ${taskDescription(task.string, settings.descLength)} ${logCore.formatDuration(task.duration)}`);
      }
    }
  }
}

export default class NautilusLogPlugin extends Plugin {
  settings: NautilusSettings = { ...DEFAULT_SETTINGS };

  async onload(): Promise<void> {
    await this.loadSettings();

    this.registerMarkdownCodeBlockProcessor('nautilus', (source, el, ctx: MarkdownPostProcessorContext) => {
      ctx.addChild(new NautilusLogView(el, this, ctx.sourcePath, source));
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
