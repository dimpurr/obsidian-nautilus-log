/*
 * Settings tab for Nautilus Log.  Mirrors the 6 base settings pinned in
 * src/contract.ts (the execution-layer settings are stage three).
 */

import { App, PluginSettingTab, Setting } from 'obsidian';
import type NautilusLogPlugin from './main';
import type { NautilusSettings } from './contract';

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
  }
}
