/*
 * Settings tab for Nautilus Log.  Mirrors the 11 settings pinned in
 * src/contract.ts: 6 base settings plus the 5 execution-layer settings.
 * The execution-layer items sit behind `actualTimeTracking`, the master
 * switch — while it is off they are hidden (the toggle re-renders the page).
 */

import { App, PluginSettingTab, Setting } from 'obsidian';
import type NautilusLogPlugin from './main';
import type { NautilusSettings } from './contract';

/** Clamp a numeric setting into `[1..max]`.
 *  `allowZero` 才把 0 当成合法的「关闭」值 —— 上游只有 Recent Retention 与
 *  Forgotten Timer Warning 标了 `0` disables；**Pomodoro Threshold 没有**
 *  （guide §Settings 那张表逐项写明）。所有项一律允许 0 会凭空造出上游没有的语义，
 *  而番茄钟阈值为 0 会让「到点变红」的判定在每一刻都成立。
 *  非有限 / 越界输入退回 fallback，绝不把 NaN 写进设置。 */
export function clampMinutes(
  value: unknown,
  max: number,
  fallback: number,
  allowZero = false,
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  if (value === 0) return allowZero ? 0 : fallback;
  if (value < 1 || value > max) return fallback; // negative / too large → default
  return value;
}

export class NautilusLogSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: NautilusLogPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName('Language')
      .setDesc('Display language for the capacity bar and labels.')
      .addDropdown((dropdown) => dropdown
        .addOption('en', 'English')
        .addOption('zh', '中文')
        .setValue(this.plugin.settings.language)
        .onChange(async (value) => {
          this.plugin.settings.language = value as NautilusSettings['language'];
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Workday start hour')
      .setDesc('Hour (0–23) the day starts. Default 5.')
      .addSlider((slider) => slider
        .setLimits(0, 23, 1)
        .setValue(this.plugin.settings.workdayStartHour)
        .setDynamicTooltip()
        .onChange(async (value) => {
          this.plugin.settings.workdayStartHour = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Workday end hour')
      .setDesc('Hour (1–24) the day ends. End <= start means "next day", e.g. 21 → 2.')
      .addSlider((slider) => slider
        .setLimits(1, 24, 1)
        .setValue(this.plugin.settings.workdayEndHour)
        .setDynamicTooltip()
        .onChange(async (value) => {
          this.plugin.settings.workdayEndHour = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Description length')
      .setDesc('Maximum glyphs for a task description before truncation (15–30). Default 22.')
      .addSlider((slider) => slider
        .setLimits(15, 30, 1)
        .setValue(this.plugin.settings.descLength)
        .setDynamicTooltip()
        .onChange(async (value) => {
          this.plugin.settings.descLength = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Default task duration')
      .setDesc('Minutes assumed for an untimed task (5–60). Default 15.')
      .addSlider((slider) => slider
        .setLimits(5, 60, 1)
        .setValue(this.plugin.settings.todoDuration)
        .setDynamicTooltip()
        .onChange(async (value) => {
          this.plugin.settings.todoDuration = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Urgent trigger')
      .setDesc('Optional word that flags a task as urgent (colouring only). Empty disables.')
      .addText((text) => text
        .setPlaceholder('urgent')
        .setValue(this.plugin.settings.urgentTrigger)
        .onChange(async (value) => {
          this.plugin.settings.urgentTrigger = value;
          await this.plugin.saveSettings();
        }));

    // ── Execution layer ──
    // Master switch. Re-render the whole page on change so the four
    // execution-layer settings below appear / disappear with it.
    new Setting(containerEl)
      .setName('Actual time tracking')
      .setDesc('Execution-layer master switch. When off, the execution settings below are hidden.')
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.actualTimeTracking)
        .onChange(async (value) => {
          this.plugin.settings.actualTimeTracking = value;
          await this.plugin.saveSettings();
          // 立刻生效：开则起 runtime + 状态栏，关则全部拆掉（不留定时器/订阅）。
          if (value) this.plugin.startExecutionLayer();
          else this.plugin.stopExecutionLayer();
          this.display();
        }));

    // The four settings below are revealed only while the master switch is on.
    if (this.plugin.settings.actualTimeTracking) {
      new Setting(containerEl)
        .setName('Timing line in sidebar')
        .setDesc('Clock In pins the current task to the right sidebar.')
        .addToggle((toggle) => toggle
          .setValue(this.plugin.settings.timingLineSidebar)
          .onChange(async (value) => {
            this.plugin.settings.timingLineSidebar = value;
            await this.plugin.saveSettings();
          }));

      new Setting(containerEl)
        .setName('Pomodoro minutes')
        .setDesc('Pomodoro threshold. Hitting it only changes the hint — it never stops work. 0 = off.')
        .addSlider((slider) => slider
          .setLimits(0, 180, 5)
          .setValue(clampMinutes(this.plugin.settings.pomodoroMinutes, 180, 45))
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.pomodoroMinutes = clampMinutes(value, 180, 45);
            await this.plugin.saveSettings();
          }));

      new Setting(containerEl)
        .setName('Recent retention minutes')
        .setDesc('How long Recent stays before it is dropped. 0 = off.')
        .addSlider((slider) => slider
          .setLimits(0, 1440, 15)
          .setValue(clampMinutes(this.plugin.settings.recentRetentionMinutes, 1440, 45, true))
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.recentRetentionMinutes = clampMinutes(value, 1440, 45, true);
            await this.plugin.saveSettings();
          }));

      new Setting(containerEl)
        .setName('Forgotten timer warning minutes')
        .setDesc('Warn when a timer has been left running this long. Warning only — never auto-stops or deletes a CLOCK. 0 = off.')
        .addSlider((slider) => slider
          .setLimits(0, 1440, 15)
          .setValue(clampMinutes(this.plugin.settings.forgottenTimerMinutes, 1440, 120, true))
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.forgottenTimerMinutes = clampMinutes(value, 1440, 120, true);
            await this.plugin.saveSettings();
          }));
    }
  }
}
