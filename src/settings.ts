/*
 * Settings tab for Nautilus Logger.  Mirrors the 11 settings pinned in
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
  /** P1-046：状态栏点击三态的悬停说明。文案必须与 main.ts 的分支一一对应。 */
  statusBarHint: string;
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
    statusBarHint: 'Click: open the Nautilus Logger sidebar · Alt-click: locate today\u2019s plan in the editor · Shift-click: locate it in the right sidebar',
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
    statusBarHint: '点击：打开 Nautilus Logger 侧栏 · ⌥ 点击：在编辑区定位今天的计划 · ⇧ 点击：定位到右侧栏',
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
// 上游列表是 [15, 20, 25, 30, 45, 50, 60, 90] —— 端点 15/90。
// 🔴 曾误写成 max: 180，与本节注释「量程必须与上游列表端点一致」自相矛盾
//    （认证审计 E1-020 抓到）。滑块 step 5 是有意的超集（上游是离散选项）。
export const POMODORO_SLIDER = { min: 15, max: 90, step: 5 } as const;

/* ── E1-026 · 设置面板自己的双语表 ────────────────────────────────────────────
 * 上游 index.js:290-346 是**两张完整的 zh/en 文案表**（18 组 label/desc）。
 * 本移植此前除 `workdayEndDesc` 外整页硬编码英文 —— 中文用户切到 zh 后，
 * 渲染文案变中文了、设置页仍然全英文（认证审计 E1-026；上一轮补的
 * 「6 处双语化」修的是 LOCAL_COPY 那批**渲染**文案，没碰这里）。
 * 文案尽量直取上游同一条；本移植独有的项（描述长度的量程、次日提示）自拟。 */
export interface SettingsCopy {
  language: string; languageDesc: string;
  start: string; startDesc: string;
  end: string;
  descLength: string; descLengthDesc(min: number, max: number): string;
  duration: string; durationDesc: string;
  urgent: string; urgentDesc: string;
  stampCompletion: string; stampCompletionDesc: string;
  tracking: string; trackingDesc: string;
  sidebar: string; sidebarDesc: string;
  pomodoro: string; pomodoroDesc(min: number, max: number): string;
  recentRetention: string; recentRetentionDesc: string;
  forgottenTimer: string; forgottenTimerDesc: string;
}

export const SETTINGS_COPY: { en: SettingsCopy; zh: SettingsCopy } = {
  en: {
    language: 'Language',
    languageDesc: 'Select the interface language. Settings apply immediately; command names and the ribbon tooltip update after reloading Obsidian.',
    start: 'Chart Start Time',
    startDesc: 'Choose any whole-hour start from 00:00 to 23:00. Defaults to 05:00.',
    end: 'Chart End Time',
    descLength: 'Legend Max Length',
    descLengthDesc: (min, max) => `Maximum label length (${min}–${max}); long text is measured and truncated to fit. Defaults to 22.`,
    duration: 'Default Todo Duration',
    durationDesc: 'Default minutes for an untimed flexible task (5–60). Defaults to 15.',
    urgent: 'Urgent Trigger Word',
    urgentDesc: 'Keyword that colors a task urgent red (no spaces, for example urgent). Empty disables.',
    stampCompletion: 'Stamp completion time',
    stampCompletionDesc: 'When enabled, checking a task inside today’s Nautilus Log plan appends its completion time (e.g. d14:31); unchecking removes the stamp. Only lines inside today’s plan are affected. Default: off.',
    tracking: 'Execution Layer · Advanced',
    trackingDesc: 'Optional. Turn your plan into action with focus, CLOCK timing, task switching, one-click completion, and daily Review. Enable to reveal execution settings; disabled by default.',
    sidebar: 'Keep Timing Line first in right sidebar',
    sidebarDesc: 'After Clock In or a task switch, open or move the Timing Line to the top of the right sidebar.',
    pomodoro: 'Pomodoro Threshold',
    pomodoroDesc: (min, max) => `Turn the live elapsed value red after this many continuous focus minutes (${min}–${max}). Switching tasks keeps the same cycle and never stops time automatically. It cannot be switched off.`,
    recentRetention: 'Recent Retention (minutes)',
    recentRetentionDesc: 'Keep a Clocked Out or switched task in Recent for this many minutes. Enter 0 to disable Recent.',
    forgottenTimer: 'Forgotten Timer Warning (minutes)',
    forgottenTimerDesc: 'Warn when one CLOCK has kept running for this many minutes. Enter 0 to disable; the warning never stops or deletes time automatically.',
  },
  zh: {
    language: '语言 / Language',
    languageDesc: '选择界面语言。设置项立即生效；命令名与 ribbon 图标提示需重载 Obsidian 后更新。',
    start: '图表开始时间',
    startDesc: '选择计划日的开始整点（00:00–23:00）。默认 05:00。',
    end: '图表结束时间',
    descLength: '最大图例长度',
    descLengthDesc: (min, max) => `图表外部标签的最大长度（${min}–${max}），超出的文本会根据可用宽度截断。默认 22。`,
    duration: '默认待办时长',
    durationDesc: '没有写时长的弹性任务默认占用的分钟数（5–60）。默认 15。',
    urgent: '紧急触发词',
    urgentDesc: '使任务显示为紧急红色的关键词（不可包含空格，例如：重要）。留空则关闭。',
    stampCompletion: '记录完成时间',
    stampCompletionDesc: '开启后，勾选今天 Nautilus Log 计划里的任务会自动追加完成时间（如 d14:31）；取消勾选则移除。只影响今天计划块内的任务行。默认关闭。',
    tracking: '执行层 · 进阶',
    trackingDesc: '可选功能。将计划转化为行动：支持任务聚焦、CLOCK 计时、多任务切换、一键完成和每日复盘。启用后会在下方显示执行设置；默认关闭。',
    sidebar: '计时任务置顶到右侧边栏',
    sidebarDesc: 'Clock In 或切换任务时，将当前 Timing Line 打开或移动到右侧边栏顶部。',
    pomodoro: '番茄钟阈值',
    pomodoroDesc: (min, max) => `连续聚焦达到该分钟数（${min}–${max}）后，计时变红但不会自动停止。任务切换不会重置，且无法关闭。`,
    recentRetention: 'Recent 保留时间（分钟）',
    recentRetentionDesc: 'Clock Out 或切换任务后，该任务在 Recent 中保留的分钟数。填写 0 可关闭 Recent。',
    forgottenTimer: '遗忘计时提醒（分钟）',
    forgottenTimerDesc: '单条 CLOCK 连续运行达到该时长后显示警告。填写 0 可关闭提醒；不会自动停止或删除计时。',
  },
};

export function settingsCopy(language: string): SettingsCopy {
  return language === 'zh' ? SETTINGS_COPY.zh : SETTINGS_COPY.en;
}

/* ── 命令面板命令名 + ribbon tooltip 的双语表 ────────────────────────────────
 * 上游没有命令名文案表：Obsidian 的 addCommand 是命令面板的挂载面（§5），
 * 名字只能本移植自拟。此前把它们硬编码成「斜杠拼中英」——
 * 每个用户同时看到两种语言，根本不是 i18n；且命令面板已把命令归属在插件名下，
 * 名字里再重复「Nautilus Logger」官方 review 会打回。
 *
 * 文案纪律：
 *  · 命令名不再带插件名；sentence case（只首字母与专有名词大写 —— Timing Line /
 *    Primary Plan 是本插件的概念名，保持大写）。
 *  · ribbon tooltip 例外：图标孤悬在侧栏、没有「归属插件」的上下文，
 *    所以它保留插件名（`Open Nautilus Logger` / `打开 Nautilus Logger`）。
 *  · 命令名只在 onload 注册时取一次，用户改语言后要重载插件才生效 ——
 *    见 SETTINGS_COPY.languageDesc 的说明（D2），不做动态重注册。 */
export interface CommandCopy {
  openSidebar: string;
  diagnoseExecutionLayer: string;
  completeWithTimestamp: string;
  createTestNote: string;
  openSettings: string;
  focusCurrentBlock: string;
  clockOutTimingLine: string;
  locatePrimaryPlan: string;
  /** ribbon 图标的 hover tooltip（addRibbonIcon 的第二个参数）。 */
  ribbonOpen: string;
}

export const COMMAND_COPY: { en: CommandCopy; zh: CommandCopy } = {
  en: {
    openSidebar: 'Open sidebar',
    diagnoseExecutionLayer: 'Diagnose execution layer',
    completeWithTimestamp: 'Complete task with timestamp',
    createTestNote: 'Create test note',
    openSettings: 'Open settings',
    focusCurrentBlock: 'Focus current block on the Timing Line',
    clockOutTimingLine: 'Clock out Timing Line',
    locatePrimaryPlan: 'Locate Primary Plan',
    ribbonOpen: 'Open Nautilus Logger',
  },
  zh: {
    openSidebar: '打开侧栏',
    diagnoseExecutionLayer: '诊断执行层',
    completeWithTimestamp: '勾选任务并记录完成时间',
    createTestNote: '创建测试笔记',
    openSettings: '打开设置',
    focusCurrentBlock: '将当前行聚焦到 Timing Line',
    clockOutTimingLine: '结束当前计时',
    locatePrimaryPlan: '定位今天的主计划',
    ribbonOpen: '打开 Nautilus Logger',
  },
};

export function commandCopy(language: string): CommandCopy {
  return language === 'zh' ? COMMAND_COPY.zh : COMMAND_COPY.en;
}

/** 上游 index.js:355-363 `updateExecutionMinutes` 的等价物 —— E1-021/E1-022：
 *  这两项在上游是**无上限的自由整数输入**（`type:"input"`），本移植原先是
 *  `setLimits(0, 1440, 15)` 的滑块 ⇒ 20 / 25 / 40 分钟这类值**不可达**。
 *  语义逐条照抄：空串 = 用户正在删，忽略（返回 null）；非有限数退回默认；
 *  否则 `max(0, round(x))`，**不设上限**。 */
export function parseExecutionMinutes(raw: unknown, fallback: number): number | null {
  const text = String(raw ?? '').trim();
  if (text === '') return null;
  const parsed = Number(text);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.round(parsed));
}

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
    // E1-026：整页文案走双语表，不再硬编码英文。
    const copy = settingsCopy(this.plugin.settings.language);

    // 🔴 E1-009：结束整点的「· 次日」依赖【开始整点】，所以开始整点一变也要刷
    //    它的 desc。上游任一项 onChange 都整页 `panel.create` 重建（index.js:385-387）；
    //    这里只重刷受影响的那一项 —— 拖滑块时整页重建会把滑块的焦点/拖拽状态
    //    一并毁掉，是 Obsidian 侧的有意偏离（行为等价，见报告）。
    let endSetting: Setting | null = null;
    const refreshEndDesc = (): void => {
      endSetting?.setDesc(workdayEndDesc(this.plugin.settings));
    };

    new Setting(containerEl)
      .setName(copy.language)
      .setDesc(copy.languageDesc)
      .addDropdown((dropdown) => dropdown
        .addOption('en', 'English')
        .addOption('zh', '中文')
        .setValue(this.plugin.settings.language)
        .onChange(async (value) => {
          this.plugin.settings.language = value as NautilusSettings['language'];
          await this.plugin.saveSettings();
          // 🔴 E1-003：上游 index.js:456-458 语言一变立刻重建面板。整页文案都
          //    是双语的（E1-026），不重建就要关掉设置页再打开才换语言。
          this.display();
        }));

    new Setting(containerEl)
      .setName(copy.start)
      .setDesc(copy.startDesc)
      .addSlider((slider) => slider
        .setLimits(0, 23, 1)
        .setValue(this.plugin.settings.workdayStartHour)
        .setDynamicTooltip()
        .onChange(async (value) => {
          this.plugin.settings.workdayStartHour = value;
          await this.plugin.saveSettings();
          refreshEndDesc();          // E1-009
        }));

    // 上游把「· 次日」直接写进结束整点的**选项标签**（index.js:376-380）。
    // 滑块没有选项标签，所以把它放进 desc 并在每次 onChange 后重刷 ——
    // 否则用户拖到 02:00 只看见一个 "2"，完全看不出这是跨午夜（audit §P1-8）。
    endSetting = new Setting(containerEl)
      .setName(copy.end)
      .setDesc(workdayEndDesc(this.plugin.settings));
    endSetting.addSlider((slider) => slider
      .setLimits(1, 24, 1)
      .setValue(this.plugin.settings.workdayEndHour)
      .setDynamicTooltip()
      .onChange(async (value) => {
        this.plugin.settings.workdayEndHour = value;
        await this.plugin.saveSettings();
        refreshEndDesc();
      }));

    new Setting(containerEl)
      .setName(copy.descLength)
      .setDesc(copy.descLengthDesc(DESC_LENGTH_SLIDER.min, DESC_LENGTH_SLIDER.max))
      .addSlider((slider) => slider
        .setLimits(DESC_LENGTH_SLIDER.min, DESC_LENGTH_SLIDER.max, DESC_LENGTH_SLIDER.step)
        .setValue(this.plugin.settings.descLength)
        .setDynamicTooltip()
        .onChange(async (value) => {
          this.plugin.settings.descLength = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName(copy.duration)
      .setDesc(copy.durationDesc)
      .addSlider((slider) => slider
        .setLimits(5, 60, 1)
        .setValue(this.plugin.settings.todoDuration)
        .setDynamicTooltip()
        .onChange(async (value) => {
          this.plugin.settings.todoDuration = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName(copy.urgent)
      .setDesc(copy.urgentDesc)
      .addText((text) => text
        .setPlaceholder('urgent')
        .setValue(this.plugin.settings.urgentTrigger)
        .onChange(async (value) => {
          this.plugin.settings.urgentTrigger = value;
          await this.plugin.saveSettings();
        }));

    // 自动完成时间戳：常驻设置，不挂在执行层总开关下面 ——
    // metadataCache 通路不依赖 actualTimeTracking（initTimingObsidian 无条件注册）。
    new Setting(containerEl)
      .setName(copy.stampCompletion)
      .setDesc(copy.stampCompletionDesc)
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.stampCompletionTime)
        .onChange(async (value) => {
          this.plugin.settings.stampCompletionTime = value;
          await this.plugin.saveSettings();
        }));

    // ── Execution layer ──
    // Master switch. Re-render the whole page on change so the four
    // execution-layer settings below appear / disappear with it.
    new Setting(containerEl)
      .setName(copy.tracking)
      .setDesc(copy.trackingDesc)
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.actualTimeTracking)
        .onChange(async (value) => {
          // 🔴 E1-016/E1-017：开关的全部动作（存盘 → 起/拆运行时 → **开失败回滚**
          //    → 刷侧栏）都归 plugin.setTrackingEnabled 一处所有，
          //    上游 index.js:245-268 也是这么收口的。设置页只负责重画。
          await this.plugin.setTrackingEnabled(value);
          this.display();
        }));

    // The four settings below are revealed only while the master switch is on.
    if (this.plugin.settings.actualTimeTracking) {
      new Setting(containerEl)
        .setName(copy.sidebar)
        .setDesc(copy.sidebarDesc)
        .addToggle((toggle) => toggle
          .setValue(this.plugin.settings.timingLineSidebar)
          .onChange(async (value) => {
            this.plugin.settings.timingLineSidebar = value;
            await this.plugin.saveSettings();
          }));

      new Setting(containerEl)
        .setName(copy.pomodoro)
        .setDesc(copy.pomodoroDesc(POMODORO_SLIDER.min, POMODORO_SLIDER.max))
        .addSlider((slider) => slider
          .setLimits(POMODORO_SLIDER.min, POMODORO_SLIDER.max, POMODORO_SLIDER.step)
          .setValue(clampMinutes(this.plugin.settings.pomodoroMinutes, 180, 45))
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.pomodoroMinutes = clampMinutes(value, 180, 45);
            await this.plugin.saveSettings();
          }));

      // 🔴 E1-021 / E1-022：这两项上游是**自由整数输入**（无上限），
      //    原先的 `setLimits(0, 1440, 15)` 滑块让 20/25/40 分钟不可达。
      new Setting(containerEl)
        .setName(copy.recentRetention)
        .setDesc(copy.recentRetentionDesc)
        .addText((text) => text
          .setPlaceholder('45')
          .setValue(String(this.plugin.settings.recentRetentionMinutes))
          .onChange(async (value) => {
            const next = parseExecutionMinutes(value, 45);
            if (next === null) return;               // 空串：用户正在删，别抢着写
            this.plugin.settings.recentRetentionMinutes = next;
            await this.plugin.saveSettings();
          }));

      new Setting(containerEl)
        .setName(copy.forgottenTimer)
        .setDesc(copy.forgottenTimerDesc)
        .addText((text) => text
          .setPlaceholder('120')
          .setValue(String(this.plugin.settings.forgottenTimerMinutes))
          .onChange(async (value) => {
            const next = parseExecutionMinutes(value, 120);
            if (next === null) return;
            this.plugin.settings.forgottenTimerMinutes = next;
            await this.plugin.saveSettings();
          }));
    }
  }
}
