/*
 * Code-block parser for Nautilus Logger on Obsidian.
 *
 * Turns the self-contained ```nautilus block into a ParsedPlan (see
 * src/contract.ts).  Time and duration tokens are NOT parsed here — they are
 * delegated to the vendored engine so the parser can never drift from the
 * engine's own token grammar.
 *
 * Block grammar (line order = priority, never sorted):
 *   - a line carrying a clock range  -> FixedEvent (meeting: true)
 *   - a `- [ ]` / `- [x]` list item  -> FlexTask, optional `45m` / `1h30m`
 *   - anything else non-empty        -> ParsedPlan.malformed (never dropped)
 */

import type {
  ParsedPlan,
  FixedEvent,
  FlexTask,
  PlanWarning,
  LineId,
  DayMinutes,
  NautilusSettings,
} from './contract';

/** The small slice of the vendored engine this parser touches. The runtime
 *  return shapes are the engine's own (parseDurationToken yields an object,
 *  not a bare number), so they are typed here rather than via the contract's
 *  looser LogCore seam. */
const logCore = require('./vendor/log-core') as unknown as {
  parseDurationToken(args: {
    text?: string;
    fallback?: number;
  }): { minutes: number; token: string; cleanedText: string };
  parseTimeRangeToken(args: {
    text?: string;
    windowStartMinutes?: number;
    windowEndMinutes?: number;
  }): {
    start: number;
    end: number;
    token: string;
    cleanedText: string;
    /** '' | 'sameTime'（本版引擎唯一会发的码，见 contract.ts PlanWarning）。 */
    warningCode: string;
  } | null;
  /** 引擎自带的 i18n 文案表；告警文案从这里取，不另写一份（audit §P1-8）。 */
  uiCopy(language: string): Record<string, Record<string, string>>;
  normalizeScheduleSettings(args: {
    startHour: number;
    endHour: number;
  }): { startMinutes: number; endMinutes: number };
  /** ⚠️ 默认用 canvas 按【像素】测量（measureText），不是字符数。
   *  把字符数当 maxWidth 传进去会把正文几乎全截掉、只剩 "…"。
   *  要按字符/显示宽度截断必须显式传 measure。 */
  truncateTextToWidth(args: {
    text: string;
    maxWidth: number;
    font?: string;
    measure?: (candidate: string) => number;
  }): string;
};

const CHECKBOX_RE = /^[-*+]\s*\[( |x|X)\]\s*/;
/** 显示用的宽松列表标记 / 复选框（认证审计 L1-031：紧凑列表此前用自己的一套
 *  正则，比这里多认 `[/]` `[-]` 两种 Obsidian 自定义状态）。合并到一处后
 *  两条路的「标记剥离」宽度必须取【并集】，否则紧凑列表会退化。
 *  ⚠️ 只用于显示清洗（stripTaskTokens），**不参与** parsePlan 的分类判定 ——
 *  分类仍走 CHECKBOX_RE，行为一个字不变。 */
const DISPLAY_LIST_MARKER_RE = /^\s*[-*+]\s*/;
const DISPLAY_CHECKBOX_RE = /^\[[^\]]?\]\s*/;
/* ────────────────────────────────────────────────────────────────────────────
 * `d…` token 家族：优先级与互斥（audit §P1-3 / §P1-8，锚点语义见 §D8）
 *
 * 两个 token 都以 `d` 开头，靠【尾部】区分，互斥性由引擎
 * `vendor/timing-core.js:16-17` 的两条正则天然保证。本文件【逐字抄这两条】，
 * 而不是自创写法 —— 解析侧与引擎侧对同一行文本必须给出同一个答案：
 *
 *   进度      PROGRESS_RE   /(?:^|\s)d(\d{1,3})%(?=\s|$)/i    —— 必须以 % 收尾
 *   完成锚点  DONE_AT_RE    /(?:^|\s)d(\d{1,2})(?::(\d{1,2}))?(?=\s|$)/i
 *                                                             —— 后面不能是 %
 *
 * 由此得到的判定（每条都有对应回归测试）：
 *   · `d50%` / `d10%` 只可能是进度：锚点侧的 `(?=\s|$)` 撞上 `%` 直接失败，
 *     绝不会被读成「10 点整」。⇐ 这是本次改动最大的误判风险，先想清楚再写。
 *   · `d18` / `d18:30` 只可能是锚点：进度侧强制要求 `%`。`d18` 视作整点 18:00
 *     （上游 `component.cljs:604` 的 `d(\d{1,2}(?::\d{1,2})?)` 同样接受）。
 *   · 时长 token（`30m` / `1h30m`）以【数字】开头且要求前面是空白，
 *     而 `d18` 的 `18` 前面是 `d` ⇒ 两族不相交，剥离顺序无关。
 *   · 非法值（`d99:99`、小时 > 23、分钟 > 59）一律丢弃，不当锚点也不报错 ——
 *     与 `timing-core.js doneTime()` 的取舍一致。
 * ──────────────────────────────────────────────────────────────────────────── */
const PROGRESS_RE = /(?:^|\s)d(\d{1,3})%(?=\s|$)/i;
const DONE_AT_RE = /(?:^|\s)d(\d{1,2})(?::(\d{1,2}))?(?=\s|$)/i;
/** 剥离用的全局版本。用 ' ' 而不是 '' 替换（对齐 timing-core.js removeTaskState），
 *  否则 `写 d18 报告` 会被粘成 `写报告`。 */
const PROGRESS_STRIP_RE = new RegExp(PROGRESS_RE.source, 'gi');
const DONE_AT_STRIP_RE = new RegExp(DONE_AT_RE.source, 'gi');
const DONE_RE = /\[x\]/i;

/** `d50%` → 50。没有 token 返回 0（＝引擎 taskProgress 的缺省）。
 *  上限 100：`d150%` 夹到 100，与 `timing-core.js taskProgress()` 一致。 */
function parseProgress(text: string): number {
  const match = PROGRESS_RE.exec(text);
  if (!match) return 0;
  return Math.min(100, Math.max(0, Number(match[1]) || 0));
}

/** `d18:21` → 1101；`d18` → 1080（整点）。非法/缺失 → null。 */
function parseDoneAt(text: string): number | null {
  const match = DONE_AT_RE.exec(text);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2] ?? 0);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  if (hour > 23 || minute > 59) return null;
  return hour * 60 + minute;
}

/* ────────────────────────────────────────────────────────────────────────────
 * 点击盘面切片 +10% 进度 —— 语义对齐上游 component.cljs:518-545
 * `update-block-progress`。竞品（rival/src/parser.ts `bumpProgressInLine`）
 * 与上游同语义，两边无冲突。
 *
 *   · 已有 dNN%：
 *       N+10 == 100 → 勾选任务（- [ ]→- [x]）、去掉 dNN%、追加 `dHH:MM` 锚点
 *       N+10 > 100  → 去掉 dNN%（回到无进度，不改勾选状态）
 *       否则         → 写成 `d(N+10)%`
 *   · 没有 dNN%：追加 ` d10%`，同时取消勾选（- [x]→- [ ]）并剥掉已有的
 *     `dHH:MM` 锚点（＝把一件已完成的事重新打开）。
 *
 * ⚠️ 正则用本移植的收紧版 PROGRESS_RE（`%` 后必须是空白/行尾），不用上游/竞品
 *    的宽松版 `(\sd)(\d{1,3})(%)` —— 解析与写回对同一行必须给出同一个答案
 *    （`d50%foo` 解析为无进度，写回就不该当它有进度）。
 * ──────────────────────────────────────────────────────────────────────────── */

/** `minutes → "HH:MM"`。与上游 `minutes->time`（component.cljs:410）同形。
 *  🔴 仓库里这是第三份本地副本（spiral.ts:312 / compact.ts:71 各有一份）：
 *  上游没导出它，跨模块共用要新建 util，本轮不动那个范围。 */
function minutesToTime(minutes: number): string {
  const h = Math.floor((minutes / 60) % 24);
  const m = minutes % 60;
  return (h < 10 ? "0" + h : String(h)) + ":" + (m < 10 ? "0" + m : String(m));
}

/** `- [ ]` → `- [x]`。与 completeTask（timing-obsidian.ts）同一形：锚在行首
 *  列表标记上、方括号里恰好一个字符，`[[wiki 链接]]` 之类不会被误伤。 */
function checkTask(line: string): string {
  return line.replace(/^(\s*[-*+]\s+)\[.\]/, "$1[x]");
}

/** `- [x]` / `- [X]` → `- [ ]`。其它非 x 标记（`- [/]` 进行中等）已是未完成，不碰。 */
function uncheckTask(line: string): string {
  return line.replace(/^(\s*[-*+]\s+)\[[xX]\]/, "$1[ ]");
}

/** 给任务行的进度 +increment（宿主默认 +10），返回新行。nowMinutes 用于
 *  100% 分支的完成锚点（`minutesToTime(nowMinutes)`）。 */
export function bumpProgressInLine(line: string, increment: number, nowMinutes: number): string {
  const match = PROGRESS_RE.exec(line);
  if (match) {
    const p = Number(match[1]) + increment;
    // 🔴 用【切片】而不是 `replace(match[0], …)` 来移除 token：match[0] 的
    //    `(?:^|\s)` 前缀可能不是字符（行首 `^` 是零宽），replace 会把「前导
    //    空格 + token」一起换掉、给行首凭空加一个空格。切片只拿掉 token 本身。
    const before = line.slice(0, match.index);
    const after = line.slice(match.index + match[0].length);
    if (p === 100) {
      return checkTask(before + after) + ` d${minutesToTime(nowMinutes)}`;
    }
    if (p > 100) {
      return before + after;
    }
    // 保留 match[0] 的 `^` / `\s` 形态：行首 token 不带前导空格，行中带。
    const lead = /^\s/.test(match[0]) ? " " : "";
    return before + lead + `d${p}%` + after;
  }
  // 没有进度：追加 ` d10%`、取消勾选、剥掉完成锚点。
  // 🔴 只把【前导缩进】留出来再整体折叠空白 —— 直接 `.replace(/\s+/g,' ')`
  //    会把嵌套任务的缩进也吃掉，任务掉出它所属的子树。
  const indent = /^\s*/.exec(line)?.[0] ?? "";
  const rest = line.slice(indent.length) + ` d${increment}%`;
  return indent + uncheckTask(rest)
    .replace(DONE_AT_STRIP_RE, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** 紧急触发词的匹配器（audit §P1-8：此前是裸 `includes` 子串匹配）。
 *
 *  🔴 为什么不是 `\b`：JS 的 `\b` 定义在 ASCII `\w`（[A-Za-z0-9_]）上。
 *     触发词是中文时（`紧急`），`急` 不是 `\w` ⇒ `\b急\b` 的边界判定整个翻转，
 *     `紧急处理` 反而会命中、`写周报 紧急` 反而不命中 —— 比裸子串还糟。
 *
 *  ⇒ 语义抄上游 `component.cljs:625-627 get-color-pattern`：用【空白或行首尾】
 *     做分隔符。这条规则与文字系统无关，中英文同时成立：
 *       英文 trigger=`urgent`：`urgent 写周报` ✓ / `urgently` ✗ / `nonurgent` ✗
 *       中文 trigger=`紧急`  ：`写周报 紧急` ✓ / `紧急处理`（连写）✗
 *     代价：中文用户必须把触发词当成独立 token 写（前后留空格，或写成 `#紧急`
 *     单独一段）—— 这正是上游的语义，不做超集。
 *
 *  🔴 本移植【不用上游的 lookbehind】`(?<=^|\s)` —— 社区插件审核指南
 *     「Mobile Considerations」明令 Avoid lookbehind，而 manifest.json 声明
 *     `isDesktopOnly: false`。lookahead `(?=$|\s)` 保留（移动端同样支持）；
 *     前界改用【消费式前缀】`(?:^|\s)`（见 PORTING-DECISIONS.md §D8c）。
 *     该正则只被 `.test()` 消费（parsePlan 的 urgent 判定），消费式前缀的
 *     布尔结果与 lookbehind 完全等价。
 *
 *  偏离上游二处：① 前界去 lookbehind（见上）；② 对触发词做正则转义 ——
 *  上游把设置值直接塞进 re-pattern，触发词含 `(` / `+` 时会抛异常连带整个
 *  渲染挂掉；转义只影响这类病态输入。 */
const urgentMatcherCache = new Map<string, RegExp>();
/** 导出供测试钉「不含 lookbehind」—— 审核的机械检查正是扫 `(?<=`。
 *  本函数不被任何渲染路径直接 import（parsePlan 内部用它），导出只为可测。 */
export function urgentMatcher(trigger: string): RegExp {
  let re = urgentMatcherCache.get(trigger);
  if (!re) {
    const escaped = trigger.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    re = new RegExp(`(?:^|\\s)${escaped}(?=$|\\s)`);
    urgentMatcherCache.set(trigger, re);
  }
  return re;
}

/** 读设置里的触发词。🔴 上游 `index.js:349` 在【写入时】就 `replace(/\s/g,"")`，
 *  因为触发词必须是单个 token；本移植的设置页没有这道清洗，于是在【读取时】
 *  补上，两处语义对齐（audit §P1-8）。 */
function normalizeTrigger(raw: string | undefined): string {
  return String(raw ?? '').replace(/\s/g, '');
}

/** Options the parser needs beyond the block text itself. */
export interface ParseOptions {
  /** Vault-relative path of the containing note; forms the uid prefix. */
  sourcePath: string;
  /** Resolved plugin settings (window + todoDuration + language-aware copy). */
  settings: NautilusSettings;
  /** 计划正文在文件中的起始行号（0 起）。方案 5 下计划来自代码块【之后】的
   *  兄弟行，uid 必须用真实行号，否则跨块会撞 uid、点击定位也会跳错行。 */
  lineOffset?: number;
}

/** Strip the checkbox marker and any duration token from a raw task line,
 *  truncate the remainder to `descLength` glyphs for display. */
/** 按【显示宽度】计宽：CJK / 全角字符算 2，其余算 1。
 *  与 truncateTextToWidth 默认的 canvas 像素测量区分开 —— descLength 是字符数。 */
function displayWidth(text: string): number {
  let w = 0;
  for (const ch of Array.from(String(text ?? ''))) {
    const c = ch.codePointAt(0) || 0;
    w += (c >= 0x1100 && (
      c <= 0x115f || c === 0x2329 || c === 0x232a ||
      (c >= 0x2e80 && c <= 0xa4cf && c !== 0x303f) ||
      (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xfe30 && c <= 0xfe6f) || (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6) || (c >= 0x20000 && c <= 0x3fffd)
    )) ? 2 : 1;
  }
  return w;
}

/** 一行原文 → 纯标题（**不截断**）。全仓唯一的「标题清洗」实现。
 *
 *  认证审计 L1-031 🔴：此前有两份实现 ——
 *    · 这里（`taskDescription`）**不剥时间区间** ⇒ 螺旋图例 / 溢出面板显示
 *      `08:30-09:30 起床`，而上游 `component.cljs:698` 的 `:description`
 *      来自 `parse-time-range` 的 `:cleaned-str`，显示的是 `起床`；
 *    · `compact.ts` 自写了一条 `TIME_RANGE_RE` 把它剥掉了 ⇒ 紧凑列表对、盘上错。
 *  两处不一致本身就是症状，故统一到这一处，并且**用引擎自己的 cleanedText**
 *  剥区间，永不与引擎的 token 文法漂移（引擎认 `9-10` / `9am-10am` / `–` / `to`，
 *  自写正则一条都覆盖不到）。
 *
 *  认证审计 P1-068（契约漏洞 2）：`dHH:MM` 的分钟可省 + 大小写不敏感，
 *  剥离一律走 `DONE_AT_STRIP_RE`（＝解析用正则的同源 `gi` 版），
 *  所以 `d14` 能解析就一定能剥掉，不会再出现「解析了却剥不掉」。
 *
 *  ⚠️ 紧凑列表要显示时间段，但那是它**单独的 `<time>` 列**（`compact.ts`
 *  的 `minutesToTime(start)–minutesToTime(end)`），来自已解析的分钟数，
 *  不是标题里的原文 token —— 与上游「标题栏不含区间、时间列单独显示」一致。 */
/** 只剥【状态 token】(`dHH:MM` 完成锚点与 `dNN%` 进度)，不碰列表标记/时长/时间段。
 *  执行层拿到的 `entry.title` / `task.title` 已经过引擎的 `taskTitle()`，
 *  只剩这两种是我们自己发明、引擎不认识的 token（见 PORTING-DECISIONS.md §D8）。
 *  🔴 这是全仓**唯一**一份实现 —— 曾经 statusbar.ts 与 exec-panel.ts 各抄了一份，
 *  三处逐字节对齐全靠人盯，是明摆着的 DRY 违规。 */
export function stripStateTokens(value: string | null | undefined): string {
  return String(value ?? '')
    .replace(DONE_AT_STRIP_RE, ' ')
    .replace(PROGRESS_STRIP_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function stripTaskTokens(line: string): string {
  // 先剥标记：`- [ ] ` / `- ` / `[x] `。放在最前面，后面的 token 剥离才不受影响。
  let text = String(line ?? '')
    .replace(DISPLAY_LIST_MARKER_RE, '')
    .replace(DISPLAY_CHECKBOX_RE, '');
  // 时间区间 → 交给引擎（L1-031）。没有区间时 parseTimeRangeToken 返回 null，
  // 此时保持原文不动。
  const range = logCore.parseTimeRangeToken({ text });
  if (range) text = range.cleanedText;
  // 时长 token → 同样交给引擎。
  text = logCore.parseDurationToken({ text }).cleanedText;
  const description = text
    // 先剥进度再剥锚点：`d50%` 的 `%` 让锚点正则失配，顺序其实无关，
    // 但两条都必须剥 —— 少剥一条就会像 §D8 记的那样把 token 漏进图例。
    .replace(PROGRESS_STRIP_RE, ' ')
    .replace(DONE_AT_STRIP_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return description;
}

export function taskDescription(line: string, descLength: number): string {
  const description = stripTaskTokens(line);
  // 🔴🔴 不能直接把 descLength 交给 truncateTextToWidth。
  //    它默认用 canvas 按【像素】测量（measureText().width），
  //    而 descLength 语义是【字符数】（上游 15-30）=> 22 会被当成 22 像素，
  //    约两个字符宽，正文几乎全被截掉，界面上只剩一个 "…"。
  //    spiral.ts 是换算过的：legendLenLimit * (FONT_SIZE / RECT_WIDTH_COEF)，
  //    所以图例正常、这里却全是省略号。
  //    ⚠️ 该 bug 在 jsdom 下【永远复现不出】—— 没有 canvas 就退化成按字符计宽。
  //    这里显式传入按显示宽度计的 measure：CJK/全角算 2，其余算 1。
  const width = Number(descLength);
  if (!Number.isFinite(width) || width <= 0) return description;
  return logCore.truncateTextToWidth({
    text: description,
    maxWidth: width,
    measure: displayWidth,
  });
}

/** 认证审计 L1-042：上游 `log-core.js:222` `resolveRendererSettings` 里有
 *  `runtime.language === 'zh' ? 'zh' : 'en'` 这道归一化，本移植没有 ——
 *  `data.json` 被手改成 `language: "de"` 时会把 `"de"` 直接喂 `uiCopy`，
 *  而引擎的 `uiCopy` 对未知语言退【中文】、本移植的 `LOCAL_COPY` 退英文，
 *  两边口径当场分叉（同一块里一半中文一半英文）。归一化后未知语言一律 `'en'`。 */
export function normalizeLanguage(language: unknown): 'en' | 'zh' {
  return language === 'zh' ? 'zh' : 'en';
}

/** 解析层产出的告警。比 `contract.ts` 的 `PlanWarning` 多一个 `text`：
 *  认证审计 C2-107 —— 警告面板左栏上游显示的是**任务标题**
 *  （`component.cljs:1699` 的 `(:description event)`），而本移植的 parser
 *  从不产 `text`，`compact.ts describeWarning` 的 `warning.text` 分支是死路，
 *  左栏恒为 `L12` 这样的行号。
 *  ⚠️ `contract.ts` 归别的工作线所有，本轮没改；等它给 `PlanWarning` 补上
 *  `text?: string` 之后这个本地类型就可以删掉（见报告）。 */
export type PlanWarningWithText = PlanWarning & { text?: string };

function lineUid(sourcePath: string, lineIndex: number): LineId {
  return `${sourcePath}:${lineIndex}`;
}


/** 单个时刻 token（不是区间）：`09:00` / `9:30` / `9am` / `9 pm`。
 *  🔴 故意【不】接受裸数字（`9`）—— 那和「第 9 章」「9 个」无法区分，会把普通
 *  任务误判成固定事件。必须带冒号或 am/pm 才算表达了时刻意图。
 *  与引擎 clockTokenMinutes 的可接受集合保持一致（它未导出，无法直接复用）。 */
const START_TIME_RE = /(?:^|\s)(\d{1,2}:\d{1,2}(?:\s*(?:am|pm))?|\d{1,2}\s*(?:am|pm))(?=\s|$)/i;

/** `09:00` + 30m => 合成区间字符串交给引擎解析。
 *  自己算分钟数会与引擎的 am/pm、跨午夜对齐逻辑漂移，所以只负责【找 token】，
 *  解释与窗口对齐一律回交 parseTimeRangeToken。 */
function pinnedRange(
  text: string,
  durationMinutes: number,
  startMinutes: number,
  endMinutes: number,
): { start: number; end: number; warningCode: string } | null {
  const token = START_TIME_RE.exec(text)?.[1];
  if (!token) return null;
  // 🔴 probe 是【合成】的零长区间 `09:00-09:00`，引擎必然回 warningCode
  // 'sameTime' —— 那是我们自己造的探针，不是用户写的东西。绝不能上报，
  // 否则每个「只写开始时刻」的钉住事件都会莫名其妙冒一条告警（audit §P1-8）。
  const probe = logCore.parseTimeRangeToken({
    text: `${token}-${token}`,
    windowStartMinutes: startMinutes,
    windowEndMinutes: endMinutes,
  });
  if (!probe) return null;
  const h = Math.floor(probe.start / 60);
  const m = probe.start % 60;
  const endTotal = probe.start + Math.max(1, durationMinutes);
  const eh = Math.floor(endTotal / 60) % 24;
  const em = endTotal % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  // 这一次的区间由「用户写的时刻 + 用户写的时长」合成，它的 warningCode
  // 反映的是用户输入，所以【要】带出去。
  const range = logCore.parseTimeRangeToken({
    text: `${pad(h)}:${pad(m)}-${pad(eh)}:${pad(em)}`,
    windowStartMinutes: startMinutes,
    windowEndMinutes: endMinutes,
  });
  return range
    ? { start: range.start, end: range.end, warningCode: range.warningCode || '' }
    : null;
}

export function parsePlan(source: string, options: ParseOptions): ParsedPlan {
  const { sourcePath, settings } = options;
  const lineOffset = options.lineOffset ?? 0;
  const schedule = logCore.normalizeScheduleSettings({
    startHour: settings.workdayStartHour,
    endHour: settings.workdayEndHour,
  });

  const events: FixedEvent[] = [];
  const tasks: FlexTask[] = [];
  const malformed: ParsedPlan['malformed'] = [];
  const warnings: PlanWarningWithText[] = [];
  const lines = source.split('\n');

  // 告警文案一律取引擎自己的 i18n 表（audit §P1-8），别在本移植里再写一份 ——
  // 上游 component.cljs:578-583 就是这么把 warningCode 换成文案的。
  // 语言先归一（认证审计 L1-042）。
  const warningCopy = (logCore.uiCopy(normalizeLanguage(settings.language)) || {}).warnings || {};
  /** 认证审计 C2-103：上游的警告面板吃的是 `text-events`，
   *  而 `text-events` 只装【未完成】的待办与事件（`component.cljs:1890`）——
   *  已经勾掉的行不再报排期问题。本移植此前对【所有】解析到的行都报，
   *  于是昨天勾完的会议还在刷「起止时间不能相同」。
   *  认证审计 C2-107：左栏带上标题（＝上游 `(:description event)`）。 */
  const pushWarning = (code: string, line: number, uid: LineId, lineText: string) => {
    if (!code) return;
    if (DONE_RE.test(lineText)) return;
    warnings.push({
      line, uid, code,
      message: warningCopy[code] || code,
      text: stripTaskTokens(lineText),
    });
  };

  // 计划正文的【顶层缩进】：以第一条非空行为准。比它更深的行是【子项】，
  // 不参与排程 —— 与上游一致（上游只 pull 直接子块，嵌套块连读都不读）。
  //
  // 为什么这样设计（上游没写，但从行为能反推）：
  //  · 双重计入：`写周报 60m` 下挂 `收集数据 20m` + `画图 20m`，
  //    平铺会算成 100m，而真实需求是 60m。上游直接规避了这个问题。
  //  · 优先级＝行序：平铺列表的顺序无歧义，树没有（深度优先还是广度优先？）。
  //  · 子项是「怎么做」，父项才是「排什么」——可调度的单位是父项。
  let baseIndent: number | null = null;
  for (const raw of lines) {
    if (raw.trim()) { baseIndent = raw.length - raw.trimStart().length; break; }
  }

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    const text = raw.trim();
    if (!text) continue;
    const indent = raw.length - raw.trimStart().length;
    if (baseIndent !== null && indent > baseIndent) continue;   // 子项：跳过
    const uid = lineUid(sourcePath, lineOffset + index);

    const range = logCore.parseTimeRangeToken({
      text,
      windowStartMinutes: schedule.startMinutes,
      windowEndMinutes: schedule.endMinutes,
    });
    if (range) {
      events.push({
        uid,
        string: text,
        start: range.start as DayMinutes,
        end: range.end as DayMinutes,
        meeting: true,
        done: DONE_RE.test(text),
      });
      pushWarning(range.warningCode || '', index, uid, text);
      continue;
    }

    if (CHECKBOX_RE.test(text)) {
      const duration = logCore.parseDurationToken({
        text,
        fallback: settings.todoDuration,
      });
      // 只写了开始时刻（`- [ ] 09:00 写周报 30m`）=> 视为钉死的事件。
      // 写了时刻就是表达「这件事就在这个点」，没写时长则用默认时长。
      const pinned = pinnedRange(text, duration.minutes, schedule.startMinutes, schedule.endMinutes);
      if (pinned) {
        events.push({
          uid,
          string: text,
          start: pinned.start as DayMinutes,
          end: pinned.end as DayMinutes,
          meeting: true,
          done: DONE_RE.test(text),
        });
        pushWarning(pinned.warningCode, index, uid, text);
        continue;
      }
      const anchorMinutes = parseDoneAt(text);
      // 紧急触发词：命中则只改颜色，【不改排程顺序】（上游明确语义）。
      // 🔴 此前设置项存在但 parser 从不产出 urgent 字段 => 设置永远不生效。
      const trigger = normalizeTrigger(settings.urgentTrigger);
      const urgent = trigger.length > 0 && urgentMatcher(trigger).test(text);
      // 进度：duration 保持【原始估计】不动，只把 progress 交给引擎，
      // 由 remainingDuration() 折减剩余时长（见 contract.ts FlexTask.progress）。
      const progress = parseProgress(text);
      tasks.push({
        uid,
        string: text,
        duration: duration.minutes,
        done: DONE_RE.test(text),
        ...(progress > 0 ? { progress } : {}),
        ...(urgent ? { urgent: true } : {}),
        ...(anchorMinutes !== null ? { doneAt: anchorMinutes as DayMinutes } : {}),
      });
      continue;
    }

    malformed.push({ line: index, text, reason: 'Unrecognized line format' });
  }

  return { events, tasks, malformed, warnings };
}
