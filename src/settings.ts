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

/* ── P1-8 · 用户可见文案的本地双语表 ─────────────────────────────────────────
 * 引擎的 `logCore.uiCopy(language)` 只覆盖它自己渲染的那部分（capacity /
 * allocation / legend / controls / panels / tooltips / warnings）——
 * 已实测枚举，**没有**空态提示、配置警告、右键菜单这些「移植层自己发明的」文案
 * （它们在上游对应的是 Roam 侧不同的挂载面，见 PORTING-DECISIONS.md §5）。
 * 所以这些只能走本地双语常量。
 *
 * 🔴 为什么放在 settings.ts：本移植不允许新建 src 文件承载它，而 main.ts 与
 *    sidebar.ts 都要用 —— main.ts 已经 import 了 sidebar.ts，反向 import 会成环。
 *    settings.ts 是两者共同的下游（它对 main 只有 `import type`，运行时无边），
 *    且本来就是用户可见英文串最集中的地方。
 * 见 docs/parity-audit-2026-08-25.md §P1-8。 */
export interface LocalCopy {
  unknownConfig: string;
  blockEmptyHeading: string;
  blockEmptySample: string;
  blockEmptyNote: string;
  sidebarEmptyHeading: string;
  sidebarLooking(path: string): string;
  sidebarNoConfig(path: string): string;
  clockIn: string;
  clockOut: string;
  needTodo: string;
  onlyTodo: string;
}

export const LOCAL_COPY: { en: LocalCopy; zh: LocalCopy } = {
  en: {
    /** ```nautilus 块内出现无法识别的配置键时的 tooltip（main.ts）。 */
    unknownConfig: 'Unrecognised setting. Supported: start, end, default-duration, legend-length, urgent, language',
    /** 块解析不出任何计划时的空态（main.ts）。 */
    blockEmptyHeading: 'Nautilus Log — write the plan directly below this block:',
    blockEmptySample: '05:00-06:00 Morning routine\n- [ ] Write project brief 45m\n- [ ] Review notes 30m',
    blockEmptyNote: 'The plan ends at the first blank line. The block itself holds per-day overrides, e.g. `end: 02:00`.',
    /** 侧栏找不到今天的计划时的空态（sidebar.ts）。 */
    sidebarEmptyHeading: 'Nautilus Log — no plan for today',
    sidebarLooking: (path: string) => `Looking in ${path} for a \`\`\`nautilus block.\nWrite today's plan in that Daily Note.`,
    sidebarNoConfig: (path: string) => `No Daily Notes plugin config found; falling back to ${path}.\nConfigure the core Daily Notes plugin (format/folder) or create this file.`,
    /** P1-6 编辑器右键菜单项与命令失败提示。 */
    clockIn: 'Clock in',
    clockOut: 'Clock out',
    needTodo: 'Focus an unfinished TODO block before starting timing.',
    onlyTodo: 'Only an unfinished TODO can own the Timing Line.',
  },
  zh: {
    unknownConfig: '无法识别的配置项。支持：start、end、default-duration、legend-length、urgent、language',
    blockEmptyHeading: 'Nautilus Log — 请把计划直接写在这个块的下方：',
    blockEmptySample: '05:00-06:00 晨间例程\n- [ ] 写项目简报 45m\n- [ ] 复习笔记 30m',
    blockEmptyNote: '计划到第一个空行为止。块【内】写当天的配置覆盖，例如 `end: 02:00`。',
    sidebarEmptyHeading: 'Nautilus Log — 今天还没有计划',
    sidebarLooking: (path: string) => `正在 ${path} 里找 \`\`\`nautilus 块。\n请把今天的计划写进那篇日记。`,
    sidebarNoConfig: (path: string) => `没找到 Daily Notes 插件配置，回退到 ${path}。\n请配置核心「日记」插件（日期格式/文件夹），或直接创建这个文件。`,
    clockIn: '开始计时',
    clockOut: '结束计时',
    needTodo: '请先把光标放在一条未完成的任务行上。',
    onlyTodo: '只有未完成的任务才能占用 Timing Line。',
  },
};

export function localCopy(language: string): LocalCopy {
  return language === 'zh' ? LOCAL_COPY.zh : LOCAL_COPY.en;
}

/* ── P1-8 · 滑块量程（导出以便回归测试直接钉住）────────────────────────────
 * 上游是离散下拉列表，本移植用滑块 —— 量程必须与上游列表的**端点**一致，
 * 否则用户能选到上游选不到的值。上游列表见 index.js:494 / :412。 */

/** 上游 `desc-length` 的列表是 [14,16,…,28]（index.js:494）。
 *  🔴 本移植曾写死下界 15、上界 30 —— 两端都与上游不符（audit §P1-8）。
 *  滑块用 step 1 是有意的超集：离散列表在滑块上没有对应物，
 *  而端点一致就保证了「上游能选的这里都能选、上游选不到的这里也选不到」。 */
export const DESC_LENGTH_SLIDER = { min: 14, max: 28, step: 1 } as const;

/** 上游 `pomodoro-minutes` 的列表是 [15,20,25,30,45,50,60,90]（index.js:412），
 *  **没有 0** —— guide §Settings 也只给 Recent Retention / Forgotten Timer 标了
 *  `0 disables`。所以下界必须是 15，不能是 0：
 *  滑块允许 0 而 `clampMinutes(…, false)` 又把 0 退回 45，
 *  用户拖到 0 保存后回来看见 45，UI 文案与实现自相矛盾（audit §P1-8）。 */
export const POMODORO_SLIDER = { min: 15, max: 180, step: 5 } as const;

/** 结束整点的显示标签。上游 index.js:376-380：结束 ≤ 开始（且不是 24）时
 *  追加「· 次日 / · next day」，否则用户无从知道 21→2 是跨午夜。 */
export function workdayEndLabel(endHour: number, startHour: number, language: string): string {
  const label = `${String(endHour).padStart(2, '0')}:00`;
  if (Number(endHour) <= Number(startHour) && Number(endHour) !== 24) {
    return `${label} · ${language === 'zh' ? '次日' : 'next day'}`;
  }
  return label;
}

/** 结束整点那一项的完整描述。把 `workdayEndLabel` 的结果嵌进去，
 *  这样「· 次日」在滑块界面上也看得见。 */
export function workdayEndDesc(
  settings: Pick<NautilusSettings, 'workdayEndHour' | 'workdayStartHour' | 'language'>,
): string {
  const label = workdayEndLabel(settings.workdayEndHour, settings.workdayStartHour, settings.language);
  return settings.language === 'zh'
    ? `一天的结束整点（1–24）。当前 ${label}。结束 ≤ 开始表示次日，例如 21 → 2。`
    : `Hour (1–24) the day ends. Currently ${label}. End <= start means the next day, e.g. 21 → 2.`;
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

    // 上游把「· 次日」直接写进结束整点的**选项标签**（index.js:376-380）。
    // 滑块没有选项标签，所以把它放进 desc 并在每次 onChange 后重画整页 ——
    // 否则用户拖到 02:00 只看见一个 "2"，完全看不出这是跨午夜（audit §P1-8）。
    const endSetting = new Setting(containerEl)
      .setName('Workday end hour')
      .setDesc(workdayEndDesc(this.plugin.settings));
    endSetting.addSlider((slider) => slider
      .setLimits(1, 24, 1)
      .setValue(this.plugin.settings.workdayEndHour)
      .setDynamicTooltip()
      .onChange(async (value) => {
        this.plugin.settings.workdayEndHour = value;
        await this.plugin.saveSettings();
        endSetting.setDesc(workdayEndDesc(this.plugin.settings));
      }));

    new Setting(containerEl)
      .setName('Description length')
      .setDesc(`Maximum glyphs for a task description before truncation (${DESC_LENGTH_SLIDER.min}–${DESC_LENGTH_SLIDER.max}). Default 22.`)
      .addSlider((slider) => slider
        .setLimits(DESC_LENGTH_SLIDER.min, DESC_LENGTH_SLIDER.max, DESC_LENGTH_SLIDER.step)
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
          // 🔴 已打开的侧栏必须一并刷新，否则用户开了开关却什么也没发生，
          //    要关掉侧栏再打开才出现 —— 看起来就像开关坏了。
          this.plugin.refreshSidebars();
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
        .setDesc(`Pomodoro threshold (${POMODORO_SLIDER.min}–${POMODORO_SLIDER.max} min). Hitting it only changes the hint — it never stops work. It cannot be switched off.`)
        .addSlider((slider) => slider
          .setLimits(POMODORO_SLIDER.min, POMODORO_SLIDER.max, POMODORO_SLIDER.step)
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
