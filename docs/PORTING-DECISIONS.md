# 移植决策台账 · Roam → Obsidian

> **这份文档的契约**：`上游仓库` + `本文档` + 足够的人力/agent = **可以从零把这个移植重做一遍**，且结果与现在等价。
>
> 因此凡是「读上游代码推不出来」的东西，都必须在这里。包括但不限于：概念映射、有意的偏离、挂载面重排、超集特性、以及**为什么**。
>
> 🔴 **维护铁律**：任何一次「上游是 A、我们做成 B」的动作，**先在这里登记再写代码**。代码注释里引用条目号（如 `见 PORTING-DECISIONS.md §D1`），别把理由散落在注释里 —— 散落的理由等于没有。

**当前状态**

| | |
|---|---|
| 上游 | [`404KSG/roam-nautilus-log`](https://github.com/404KSG/roam-nautilus-log) |
| vendor 基线 | `86b97c0`（2026-08-25 升级，原基线 `7bf19a1d`） |
| 本移植版本 | `0.1.0+` |
| 已知欠账 | [`parity-audit-2026-08-25.md`](parity-audit-2026-08-25.md) |

---

## 0. 怎么用这份文档重做移植

1. 读上游 `docs/guide.md` 建立特性全景。
2. 读本文档 §1（概念映射）—— 这决定了整个数据层怎么写。
3. 把上游 `src/{log-core,timing-core,timing-runtime,timing-topbar}.js` **原样 vendor**（§2 纪律）。
4. 按 §3 实现数据层（上游 `timing-roam.js` 的 16 个函数的 Obsidian 版）。
5. 按 §4 逐条落实偏离决策。
6. 按 §5 重排挂载面。
7. 按 §6 决定超集特性要不要一起做。
8. 按 §7 建立防复发检测器。

---

## 1. 概念映射（能一一对应的部分）

| Roam 概念 | Obsidian 对应 | 实现位置 | 备注 |
|---|---|---|---|
| Daily Note page | Daily Notes 插件配置的今日笔记 | `sidebar.ts resolveDailyNoteInfo` | 🔴 配置可能**只有 `folder` 没有 `format`**（用户没改日期格式时 Obsidian 不写这个键），两者有其一即视为有效配置 |
| （同上，第二条路） | 🔴 **执行层不走 `resolveDailyNoteInfo`** | `timing-obsidian.ts dailyNotePath()` | 走 `internalPlugins.getPluginById('daily-notes').instance.getDailyNote()`，失败才退到仓库根的 `YYYY-MM-DD.md`。**两条路在「daily-notes 内置插件被禁用 + 用户配了 folder」时会得出不同结果**：侧栏找得到计划、执行层找不到。重做移植时这两处必须一起看（认证审计 P1-011） |
| block uid（不透明标识符） | `filepath:line` | `timing-obsidian.ts splitUid` | 引擎里 uid 只作不透明标识符使用，实测仅 5 处，全部不解释内容。🔴 **`line` 是 0 起**（与 `editor` 行号同基准）；`path` 用 **`lastIndexOf(':')`** 切 —— 所以**文件名里含冒号会被切错**（`a:b.md`、Windows 风格路径）。两条都推不出来（认证审计 P1-013） |
| block tree（父子关系天然存在） | **按缩进还原** | `timing-obsidian.ts readPrimaryPlan` | 父 = 往前最近的一行缩进更小的非空行；找不到则为计划块本身。🔴 见 §D5 |
| （缩进单位） | 🔴 **space 与 tab 各计 1** | `timing-obsidian.ts leadingSpaces()` | 不做 tab 宽度归一 ⇒ 「1 个 tab」严格小于「2 个空格」，用 tab 缩进的笔记层级会被错误还原。而**写回新行一律用空格**（`' '.repeat(...)`）。重做移植的人几乎必然做成「tab = 4」，那与现实现不等价（认证审计 P1-016） |
| `{{[[TODO]]}}` / `{{[[DONE]]}}` | `- [ ]` / `- [x]` | `timing-obsidian.ts normalizeTaskString` | 单向归一：喂给引擎前转成 Roam 形态；写回时转回 markdown。实测比这行字宽：**`-` / `*` / `+` 三种 marker 都认**；`[…]` 里**任何含 `x`/`X` 的字符**都算 DONE；非 checkbox 行剥掉 marker 原样返回。🔴 推论：Tasks 插件的 `- [/]`、`- [>]` 等自定义状态会被判成 **TODO**（不含 x），而不是被忽略 —— 与 Obsidian 生态的常见约定冲突（认证审计 P1-017/018） |
| block children（LOGBOOK 抽屉） | 缩进的子行 | `timing-obsidian.ts createRunningClock` | 首次 Clock In 时自动建 `- LOGBOOK::`，缩进 = 任务缩进 + 4。抽屉行的识别正则是 **`/^:?LOGBOOK:{1,2}$/i`**（剥掉列表 marker 之后）—— 同时接受 `LOGBOOK:`、`LOGBOOK::`、`:LOGBOOK:`，且大小写不敏感（认证审计 P1-021） |
| CLOCK 行 | 逐字相同的文本行 | 引擎的 `parseClockLine` / `formatClockLine` 可用，但**先剥列表 marker 再喂**（`parseClockLineFromLine`），不是「原样」 | Org-mode 格式，跨生态兼容 |
| （新 CLOCK 行的形状） | 🔴 **从「上一条 CLOCK」继承缩进与列表 marker** | `timing-obsidian.ts createRunningClock` | 锚点 = 抽屉下最后一条 CLOCK，**复用它的缩进与 marker**；抽屉下一条 CLOCK 都没有时才用 `drawerIndent + 4` 与 `'- '`。这条推不出来，且直接决定写回结果的形状（认证审计 P1-020） |
| Roam 右侧栏 | `workspace.getRightLeaf()` | `timing-obsidian.ts openTaskInRightSidebar` | |
| Toast | `new Notice()` | `timing-obsidian.ts showToast` | |
| 图数据库同步可查 | ❌ **无对应** | 见 §D6 | Obsidian vault API 全异步，引擎却同步调 —— 必须自建同步缓存 |

### 1.1 🔴 块内配置的完整语法（上游零线索）

上游把设置烘焙成 renderer 的**位置参数**（§D4），所以这一整套语法**从上游代码里一个字都推不出来**，而它又是用户每天要敲的东西。实现在 `src/blockconfig.ts`。

**解析规则**（`parseBlockConfig`）：

- 每行 `key: value`，**第一个 `:` 之前**是 key（所以 value 里可以再有冒号，`start: 09:00` 成立）。
- key **小写归一**（`Start` / `START` 都认），前后空白剥掉。
- 空行跳过；**`#` 开头整行是注释**（YAML 风格）。
- 一行里没有 `:` ⇒ 整行进 `unknown`。
- **空块完全合法**，语义是「全用全局设置」—— 这是常见写法，不是错误。
- 🔴 **未知键不吞掉**：进 `unknown[]` 并**原样报给 UI**（⚠ 警告），而不是静默忽略。这是有意的：静默忽略会让打错的键看起来「生效了」。

**识别的键与别名**（每组内部完全等价）：

| 归一到 | 别名 |
|---|---|
| `workdayStartHour` | `start` · `start-time` · `workday-start` |
| `workdayEndHour` | `end` · `end-time` · `workday-end` |
| `todoDuration` | `default-duration` · `todo-duration` |
| `descLength` | `legend-length` · `desc-length` |
| `urgentTrigger` | `urgent` · `urgent-trigger` |
| `language` | `language` · `lang` |

**取值规则**：

- 小时（`parseHour`）：`5` / `05:00` / `5:30` 都认，但**分钟被丢弃（向下取整到小时）**；范围 0–24，越界 ⇒ 进 `unknown`。
- `language` 只认字面量 `en` / `zh`，其它值 ⇒ 进 `unknown`。
- `urgent` **不做任何校验**，原样取字符串（空串 = 关闭）。
- **数值键有量程校验，越界＝拒收 + 上报，不静默夹取**（`blockconfig.ts`）。
  > ⚠️ **订正（2026-08-26）**：本条原写「数值键没有任何范围钳制…块内 `default-duration: 99999`
  > 是唯一能绕过钳制的入口」—— **该入口已于同日关闭**（认证审计 L1-039 / L1-040）。
  量程取的是**本移植 UI 自身的端点**（`descLength` 14–28 / `todoDuration` 5–60），
  **不是**引擎 `boundedInteger` 的 `[15,30]` —— 引擎那个自己就与上游下拉列表 `[14…28]` 不一致
  （14 可选却被夹到 22），本移植的滑块允许 14。
  越界走「上报」而不是静默夹取，与本节「未知键不吞掉」同哲学。
  🔴 **改量程时必须同步三处**：`blockconfig.ts` 的校验、`settings.ts` 的滑块、`contract.ts` 的行内注释。

**围栏与正文边界**：

- 围栏正则要求语言标识**独占一行、行尾无其它字符**：<code>^\s*```+\s*(?:nautilus|naut)\s*$</code>。
- **未闭合的围栏不算合法块**。
- 正文边界：从围栏结束行往下，**先跳过所有空行**，再收集到**第一个空行**为止（`extractPlanBody`）。⇒ 「止于首个空行」只对**结尾**成立，**开头不成立** —— 块与计划之间多敲几个回车不会失效（认证审计 P1-043）。
- **侧栏与执行层只认笔记里的第一个** nautilus 块；而代码块渲染器是**每块各自渲染各自下方的正文**。⇒ 一篇笔记里放多个块时，两侧语义不同（认证审计 P1-059）。

### 1.2 🔴 `dHH:MM` 完成锚点的精确语法

`d` 前缀的完成时刻锚点是本移植发明的（§D8）。它的正则**三处互不一致**，这是已知的实现分歧，重做移植时应当**统一成一份**：

| 用途 | 位置 | 正则 | 分钟 | 大小写 |
|---|---|---|---|---|
| 解析（读） | `parser.ts` `DONE_AT_RE` | `/(?:^\|\s)d(\d{1,2})(?::(\d{1,2}))?(?=\s\|$)/i` | **可省**（`d14` 合法） | **不敏感**（`D14:30` 合法） |
| 从标题里剥离 | `compact.ts` | `/\s*\bd\d{1,2}:\d{2}\b/g` | **必须有** | **敏感** |
| 命令的去重判断 | `main.ts` | `/(?:^\|\s)d\d{1,2}:\d{2}(?=\s\|$)/` | **必须有** | **敏感** |

⇒ 已知后果：写成 `d14` 的行**会被解析成锚点**，但**不会被剥离**（标题里留着 `d14`），而且命令还会**再追加一个** `d14:30`（认证审计 P1-068）。

一律以**空白或行首/行尾**分隔（同 §D8c 的理由）。

### 1.3 `src/contract.ts` —— 跨模块钉死的类型契约

台账此前完全没有提到这个文件，但它是本移植特有的结构：`NautilusSettings` / `DEFAULT_SETTINGS` / `ParsedPlan` / `CapacityMetric` 等**跨模块共享的形状**全部集中在 `src/contract.ts`，其它模块只 import 类型，不各自重新声明。

🔴 **冲突处理规则**（与 `CLAUDE.md` 一致）：契约与实际实现分歧时，**按实际实现改契约、并把分歧报上来**，不许反过来「按契约把实现改掉」——契约是描述，不是命令。

⚠️ 当前已知的**注释侧**错误（`contract.ts` 由源码 agent 负责，不在本文件的可改范围内，登记在此待修）：

| 位置 | 现状 | 应为 |
|---|---|---|
| `NautilusSettings` 上方注释 | 「8 base + 5 execution」= 13 | 实际 **11** 个字段（6 base + 5 execution）；§D12 的 11 项是对的 |
| `descLength` 行内注释 | `// 15..30` | **`14..28`**（`settings.ts` 的 `DESC_LENGTH_SLIDER`，端点与上游列表对齐） |
| `pomodoroMinutes` 行内注释 | `// 0 = off` | **关不掉**。滑块量程 `POMODORO_SLIDER = {min:15, max:90}`，UI 到不了 0；设置描述自己写的就是 "It cannot be switched off."（认证审计 G1-K05） |

---

## 2. vendor 纪律

`src/vendor/` 下的文件从上游**原样搬来，零修改**。这条纪律是整个移植可维护性的基石：

- ✅ 可以随时 `diff` 对账，知道自己落后上游多少
- ✅ 可以直接跑上游自己的测试当验收（`test/vendor/` 里两份就是，只改了 require 路径）
- 🔴 **一旦手改 vendor，以上两条全部失效**，且再也说不清本地是哪个版本

**推论：所有偏离一律实现在适配层。** 不喂某个数据、不接某条线、在边界上过滤 —— 都行；改 vendor 不行。

**升级流程**
```bash
git -C <upstream> log --oneline <当前基线>..HEAD     # 看漂移
cp <upstream>/src/{log-core,timing-core,timing-runtime,timing-topbar}.js src/vendor/
cp <upstream>/extension.css src/vendor/upstream-extension.css
# 上游测试跟随（只有这两份不依赖 Roam 构建产物）
for f in log-core timing-core; do
  sed "s#require('../src/$f')#require('../../src/vendor/$f')#" <upstream>/test/$f.test.js > test/vendor/$f.test.js
done
npm test
```
升级后**必须更新本文档顶部的基线 commit**。

---

## 3. 数据层契约（上游 `timing-roam.js` 的 16 个函数）

`timing-runtime.js` 从数据层 import 固定的 **16** 个函数（⚠️ 本节曾写「17 个」，与下面自己列的名单数不上 —— 名单一直是对的，数字错了；认证审计 P1-030），实现它们即可让 runtime + topbar 直接跑：

```
readAllEntries · readEntriesForTaskUids · readBlockString · readPrimaryPlan ·
createRunningClock · closeClock · deleteClock · updateGraphBlock · completeTask ·
openTaskInMainWindow · openTaskInRightSidebar · frontBlockInRightSidebar ·
openPrimaryPlan · warmRightSidebarWindowCache · legacyLogbookIsRunning · showToast
```

对应实现全在 `src/timing-obsidian.ts`。

🔴 **「16 个」只是 runtime 那条线**。上游 `timing-commands.js` 还额外 import 了 **`getFocusedBlockUid`**。本移植的三条执行层命令是**自己重写**的（`main.ts registerTimingCommands`，靠 `editor.getCursor()` 直接拿行号），所以不需要它；但如果重做移植时想**原样复用上游的 `timing-commands.js`**，就得再实现这一个 —— 只按「固定 16 个」实现会卡住（认证审计 P1-034）。

🔴 **签名会随上游变**。`openPrimaryPlan(planUid)` 在上游 `d807ea4` 变成 `(planUid, { sidebar })` —— 升级时必须核对这 16 个函数的调用签名，否则新参数被静默丢弃（不报错、不炸测试）。⚠️ §7 曾把这条写成「第 6 号检测器」，但**那个检测器从来没有实现过**；实际的第 6 号是怪癖钉子。见 §7 的订正。

---

## 4. 偏离决策

### §D1 ⛔ 不跟随「TODO 标记可选」

| | |
|---|---|
| **上游** | HEAD 起 `projectDirectTasks` 的过滤器清空（原本有 `taskStatus(row.string) && !parseTimeRangeMinutes(...)`），计划块的**任何非时间段直接子行**都成为弹性任务，状态取 `explicitStatus \|\| sourceStatus \|\| 'TODO'` |
| **本移植** | 必须有显式 `- [ ]` / `- [x]`，或者是时间段 |
| **为什么** | 本移植的「计划块」= 代码块之后到**首个空行**的连续行。Obsidian 日记里随手写 bullet 极常见，隐式成任务会凭空吃掉容量、且用户毫无察觉 |
| **实现** | `timing-obsidian.ts readPrimaryPlan` 的 `planRows` 过滤 —— **不喂给引擎**，vendor 零修改 |
| **锚点测试** | `test/timing-writeback.test.js` 的 3 条 `D1 …`（回退后会挂） |
| **代价** | 比上游多敲 4 个字符。备注写在空行之后即可，不受影响 |
| **重新评估的触发条件** | 如果将来「计划块」的边界规则改成显式围栏（不再靠空行），这条的理由就消失了，应重新讨论 |

### §D2 修饰键手势的挂载面换成状态栏 + 侧栏按钮

| | |
|---|---|
| **上游** | 挂在 topbar trigger 上：⌥ Alt-click 主界面定位、⇧ Shift-click 送右侧栏 |
| **本移植** | 本移植没有独立 top bar（见 §D3）。手势挂在**状态栏计时 token** 与**侧栏 `Locate Primary Nautilus` 按钮**上，两处都支持 |
| **状态栏三态** | 普通点击 → 打开侧栏（Obsidian 这边最有用的默认，上游没有这个动作）· ⌥ → 主编辑区定位 · ⇧ → 送右侧栏 |
| **侧栏按钮只有两态** | ⚠️ 订正：`exec-panel.ts` 的 identity 按钮**普通点击本来就是「主编辑区定位」**，所以 ⌥ 与普通点击**同义**，只有 ⇧ 有区分。按钮 `title` 写「⌥ / ⇧」是为了让用户知道 ⇧ 另有行为，不是承诺 ⌥ 另有语义 —— 代码注释已就地澄清（认证审计 P1-046） |
| **实现** | `main.ts` 的 `renderTimingStatusBar` 回调 · `exec-panel.ts` 的 identity 按钮 |
| **状态栏三态提示** | ✅ 已接（2026-08-26 收口，认证审计 P1-047）。提示挂在状态栏自身的 `aria-description` + `title` 上：`statusbar.ts:263-269` 把 `EXECUTION_COPY.actions.openPanelHint` 与 §D2 修饰键三态合并成一条（`aria-description` + `title`）。已不再是孤儿文案、也不是欠账。⚠️ 上游的 `openPanelHint` 那套落在 topbar 死代码里（§D3），故文案来源仍是引擎、挂载点是状态栏 |

### §D3 top bar 整体并入右侧栏

| | |
|---|---|
| **上游** | 一个常驻 top bar trigger，点开是 Timing / Plan / Review 的 popover。插入点靠 `querySelector('.rm-find-or-create-wrapper')` 扒 Roam 内部 DOM |
| **本移植** | 不做独立 top bar。三视图直接渲染进右侧栏面板；只在状态栏留一个计时 token |
| **为什么** | 用户决策（2026-08-24）：「top bar 那个因为有交互，我觉得一起丢进侧栏里面好」。且 Obsidian 有正经的 `registerView` / `addStatusBarItem` API，不需要扒 DOM |
| **🔴 已知代价** | 上游 `timing-topbar.js`（879 行）因此**未被 import**，功能是手写重实现的。审计确认因此丢失：Plan 的 Scheduled/Unscheduled 分节与折叠、每行的预计区间 meta、三 tab 常驻 capacity strip。详见 audit §P1-2。**这三项已于 2026-08-25 补回**（`exec-panel.ts`）。⚠️ 订正：本条曾写「仍缺快捷键 popover」—— 上游 topbar 的键盘面只有「`Escape` 关闭 popover」一件事，而本移植是**常驻面板、根本没有 popover**，⇒ 这不是欠账，是**在新形态下不适用**（认证审计 P1-052） |
| ⚠️ **一处订正（2026-08-25）** | 本条曾写「零 Roam 耦合、应当直接复用」。实测**只有渲染逻辑是 Roam-free，挂载与生命周期不是**：`ensureMounted` / `placeAfterNavigation` / `syncResponsiveDensity` / `watchTopbar` 共 5 处被 `document.querySelector('.rm-topbar')` 门控（`timing-topbar.js:728,740,799,805,814`），图标还依赖 Blueprint `bp3-icon-*` 字体。复用它必须伪造一个 `.rm-topbar` 宿主，且它的形态是 `document.body` 上绝对定位的 popover —— 正是本条决策否决掉的那个挂载面。**⇒ 手写重实现在这里是合理的**，代价是必须靠 §7 的检测器盯住「重写丢了什么」，而不是靠人记。🔴 **这条保障一度不成立**：检测器 3 原先只认 CJS `module.exports = {…}`，而 `timing-topbar.js` 用 ESM `export function` ⇒ 它的导出面**完全在检测范围之外**；同时检测器 1/2 把这个**零 import 的死模块算作发射面/消费者**，凡是只被 topbar 用的 CSS 类与文案 key 都被判成「有人用」。三处已于 2026-08-26 修好（认证审计 P1-053/102），修完后欠账从 8 条暴露到 55 条 —— **死模块不是发射面** |

### §D4 渲染载体：Roam renderer block → 代码块

| | |
|---|---|
| **上游** | `{{[[roam/render]]:((uid)) 22 15 5 "" 21}}` —— 设置被烘焙成**位置参数**写进块文本；改设置会回写重写所有已存在的块 |
| **本移植** | ` ```nautilus ` 或 ` ```naut ` 代码块。块**内**是 YAML 风格的当天配置覆盖；计划正文在块**下方**，到首个空行为止 |
| **为什么这样切** | 判据：「Obsidian 代码块可以吞掉自己的源码，只有当它装的是*查询/配置*而不是*数据*时」。计划正文是数据，必须留在块外保持可编辑、可被其它插件索引 |
| **为什么不扫兄弟列表** | 边界零歧义。代价是不进 Tasks 插件的全局索引（B 方案留后手，一期不做） |
| **别名** | `naut` 是短写。🔴 **新增别名必须同步改 3 处**，见下 |
| **块内配置语法** | 完整契约见 **§1.1**（别名表 / `#` 注释 / key 小写归一 / 未知键上报 / **数值越界拒收并上报** / 正文边界）—— 上游是位置参数，这一整套零线索 |

🔴 **别名注册点实为 3 处**（⚠️ 本条曾写「`main.ts` 的 `BLOCK_LANGS` 与 `locateByFile()` 的围栏正则」—— **`locateByFile` 这个函数在仓库里根本不存在**，已查 `grep -rn locateByFile src/` 只命中那条注释本身。这与 §D3 已订正的那类错误同型；认证审计 P1-055）：

| # | 位置 | 是否自动跟随 |
|---|---|---|
| 1 | `main.ts` `BLOCK_LANGS` | 是（同文件的 `FENCE_OPEN_RE` 由它派生，`registerMarkdownCodeBlockProcessor` 也按它循环注册） |
| 2 | `sidebar.ts` `FENCE_OPEN_RE` | 🔴 **否**，硬编码的独立正则 |
| 3 | `timing-obsidian.ts` `FENCE_OPEN_RE` | 🔴 **否**，硬编码的独立正则 |

漏掉 2 或 3 的后果是**静默的**：代码块照样渲染，但侧栏与执行层认不出这个块 ⇒ 面板说「今天没有 Nautilus Logger」。

### §D5 层级靠缩进还原

| | |
|---|---|
| **上游** | Roam 每个 block 自带真实 `parentUid`，引擎的 `projectDirectTasks` 等三处靠 `row.parentUid === planUid` 只取**直接子级**（i18n 文案原文就叫 "direct-child"） |
| **本移植** | 纯文本没有父子关系，必须按缩进还原：父 = 往前最近的一行缩进更小的非空行 |
| **🔴 血的教训** | 早期把正文**拍平**（每行都填 `parentUid: planUid`），于是那个过滤器**恒为真**，嵌套子步骤全冒进 Plan/Review 面板，还被套上 15m 默认预算，而容量条（走另一条路）根本没算它们 —— 两个数字自相矛盾。**这是「调用了但数据形状让引擎行为被静默架空」这一类 bug 的样板** |
| **锚点测试** | `test/timing-writeback.test.js` 的 3 条嵌套测试 |

### §D6 引擎同步读 vs Obsidian 异步 API

| | |
|---|---|
| **问题** | 引擎在 `refresh()` 里**同步**调 `readPrimaryPlan` / `readAllEntries` / `readBlockString`，而 Obsidian vault API 全是异步 |
| **本移植** | 自建 `contentCache: Map<path, string>`，init 时预热全部 markdown，并在每次 vault 文件改动 / 每次写回后刷新 |
| **🔴 时序陷阱** | 预热**必须等 `workspace.onLayoutReady`**。插件 `onload` 时 vault 还没索引完，`getMarkdownFiles()` 返回空数组 ⇒ 缓存永远 0 条 ⇒ 执行层永远报「今天没有 Nautilus Logger」 |
| **🔴 连锁陷阱** | 上一条修好后引入了新问题：`initialize()` 也在 `onload` 内发起，早于预热 ⇒ `initialEntries` 恒空 ⇒ runtime 的两件**一次性**修复（`reconcileLegacyOverlap` / `closeDoneClocks`）空转。**启动执行层也必须等 onLayoutReady**（audit §P0-2） |
| **兜底** | `cachedLines()` 未命中时顺手 `primeFile()`，下一次 refresh 就能命中 |

### §D7 设置键名空间

| | |
|---|---|
| **上游** | Roam `extensionAPI.settings` 用 **kebab-case**：`workday-start` / `todo-duration` / `recent-retention-minutes` / `timing-line-sidebar` |
| **本移植** | `NautilusSettings` 用 **camelCase**（`workdayStartHour` …） |
| **🔴 必须有映射表** | 喂给 vendored runtime 的 `extensionAPI` shim **必须做 kebab→camel 转换**。直接透传会让所有 `settings.get()` 返回 `undefined`。表本体在 `main.ts` 的 `SETTINGS_KEY_MAP`（8 条目，全部 8/8 目标正确已在 2026-08-26 逐一核对）。§7 检测器 4 现在按【精确键名 + 字段真相】核对这张表，见其订正行（T2-119） |
| **为什么会静默** | 引擎的兜底值 `?? 5 / ?? 21 / \|\| 15 / ?? 45` **恰好等于 `DEFAULT_SETTINGS`** ⇒ 默认配置下行为完全正确，只有改过设置的用户会撞上，测试必绿。审计 §P0-1 |
| **shim 的第三层兜底** | 映射表未命中时：先查 `this.settings[k]`、再查 `this.runtimeState[k]`。后者专为 **`POMODORO_STATE_KEY` 这类变量键**而设 —— 它不是字面量，§7 的键名空间检测器**抓不到它**，只能靠这条兜底（认证审计 P1-066） |
| 🔴 **`settings.set` 必须存在** | shim 只做 `get` 是不够的：Clock Out 会写回 runtime 状态，缺 `set` 直接抛 `settings.set is not a function` |

⚠️ 数字订正：本条正文举了 4 个 kebab 键、§7 曾写「曾抓到 §D7 的 5 个键」。实测 vendor 里 `settings.get('...')` 的字面量共 **8 个**（`forgotten-timer-minutes` · `language` · `pomodoro-minutes` · `recent-retention-minutes` · `timing-line-sidebar` · `todo-duration` · `workday-end` · `workday-start`），其中需要 kebab→camel 转换的 **7 个**。「5 个」对不上任何一种数法（认证审计 P1-065）。

### §D8 完成时刻锚点 `dHH:MM`

| | |
|---|---|
| **上游** | 靠 Roam 生态的 Todo Trigger 插件自动打完成时间戳 |
| **本移植** | Obsidian 没有对应生态。**自行发明** `dHH:MM` token（`d13:45`），并提供命令「勾选并打完成时间戳」 |
| **为什么需要** | 没有锚点的已完成任务在盘上画不出来 —— 引擎的明确立场是 "does not invent history" |
| **默认不绑快捷键** | 由用户在 设置 → 快捷键 自行指定 |
| **🔴 已知泄漏** | 引擎的 `taskTitle()` 不认识这个 token（它是我们发明的），会把 `d14:30` 留在标题里。`parser.ts` 那条路剥了，执行层那条路没剥（`timing-obsidian.ts` / `statusbar.ts` 直接用 `timingCore.taskTitle`）。审计记录在案 |
| **精确语法** | 见 **§1.2** —— 三处正则不一致（分钟可省 / 大小写），`d14` 会被解析但不会被剥离 |
| **静默不动的两种情况** | 命令只对 `- [ ]` / `- [x]` 行生效；**非任务行直接 return**，**已有锚点也直接 return**。两种情况都**没有任何提示** —— 用户按了没反应（认证审计 P1-070） |

### §D8b `d50%` 进度：不预折减，把 progress 交给引擎

| | |
|---|---|
| **上游** | cljs 在解析时就把 `duration` 折减掉再 `dissoc` 掉 progress（`component.cljs:699-702, 733`）—— 引擎收到的是已折减的时长、没有 progress |
| **本移植** | `duration` 保持**原始估计**，另外带 `progress`（0–100）。引擎的 `remainingDuration()` 自己算 `round(duration * (1 - p/100))` |
| **为什么等价** | 引擎注释明确支持这条路：*"Accepting progress here makes the public seam safe for callers that pass a raw estimate instead."*（`log-core.js:606-614`）两条路的 `remainingDuration` 结果相同 |
| **为什么选这条** | 渲染进度叠层需要知道**原始估计**才能画出「已完成多少比例」。预折减会把这个信息丢掉 |
| 🔴 **契约** | **调用方绝不能自己先乘一遍** —— 会被引擎二次折减 |

### §D8c 紧急触发词：空白分隔，且不能用 `\b`

| | |
|---|---|
| **上游** | `(?<=^|\s)TAG(?=$|\s)`（`component.cljs:625`），读设置时 `replace(/\s/g,"")` 去掉触发词里的空格（`index.js:349`） |
| **本移植** | 语义同上；**前界不用 lookbehind**。社区插件审核指南（Mobile Considerations）明令 *Avoid lookbehind in regular expressions*，而 manifest.json 声明 `isDesktopOnly:false`。lookahead `(?=$|\s)` 保留（移动端同样支持），前界换成**消费式前缀** `(?:^|\s)`。该正则只被 `.test()` 消费，消费式前缀的布尔结果与 lookbehind 完全等价。去空格挪到**读取侧**（本移植的设置页没有写入侧清洗那道工序） |
| 🔴 **为什么不能用 `\b`** | JS 的 `\b` 定义在 ASCII `\w` 上，**CJK 字符不属于 `\w`** ⇒ `\b紧急\b` 在任何位置都不匹配，中文触发词会**彻底失效**（实测验证）。空白/行首尾分隔与文字系统无关，中英文同时成立 |
| **已知后果** | 中文不用空格分词，所以 `紧急处理这件事` 里的 `紧急` **不会**命中 —— 这与上游行为一致（不是本移植引入的），但中文用户需要显式空格分隔 |
| **偏离** | ① 前界去掉 lookbehind（见上「本移植」行，移动端合规）；② 额外做了**正则转义**（上游没有）。上游把设置值直塞 pattern，触发词含 `(` 或 `+` 会抛异常连带整张图渲染失败 |
| **键名** | 上游这个设置的键叫 **`color-1-trigger`**（`index.js`），本移植叫 `urgentTrigger`。🔴 它**不在** `SETTINGS_KEY_MAP` 里，也**不该**加进去 —— vendor 从不问这个键，只有本移植自己的 `parser.ts` 用它（认证审计 P1-073） |
| **渲染结果** | 命中的**弹性任务**画成红色（`spiral.ts` 的 `URGENT_FILL` / `URGENT_LEGEND`）。🔴 **固定事件的黄色优先**：`meeting` 分支排在 `urgent` 前面，事件不会被改红 |

### §D8d 合成探针产生的告警不上报

`pinnedRange()` 为了支持「只写开始时刻」（§S2）会合成一个 `09:00-09:00` 的探针区间，引擎因此会报 `sameTime` 告警。**那是我们造的，不是用户写的**，故不上报。只上报主区间与「时刻 + 时长」合成区间的告警码。

### §D9 写回策略：双路径

| | |
|---|---|
| **上游** | Roam API 单一路径 |
| **本移植** | 文件**没被编辑器打开** → `vault.process()` 原子读改写；**被打开** → `editor` API（对齐 Tasks 插件的做法） |
| **为什么** | 现实中用户几乎总开着今天的笔记。只走 `vault.process` 会和编辑器状态打架 |
| **🔴 血的教训** | editor 分支曾把新行写成 `内容\n` 追加在锚点**行尾**，产出 `- [ ] 任务 20m    - LOGBOOK::` 脏行。正确是 `\n内容`，与 `applyChange` 的 `splice(idx + 1, 0, next)` 语义对齐 |
| **乐观锁** | 写回按**内容**定位而非行号（`expected` / `locateLine`），行漂移不影响、内容变了则拒写 |
| 🔴 **乐观锁的作用域边界** | 它保护的是「**落笔期间那一行没变**」，**不保护「定位选错了人」**。定位挑错行之后 `expected` 当然匹配，锁一点防护都不构成。⇒ 真正防错写的是**定位侧**的歧义拒写（`locateClockLine` 命中多行就拒绝），不是这把锁。评估「外部并发写」风险时别把这条算成防线（认证审计 A1-194） |

### §D10 ⛔ 不移植：Roam 块引用的「每日实例」模型

| | |
|---|---|
| **上游** | HEAD 起支持 `((uid))` 引用当可复用任务：裸引用继承源 TODO/DONE、本地时长覆盖源时长、外层显式标记可重开已完成的源 |
| **本移植** | **不接线**。`resolveTaskInstance` 在不传 `references` / `readString` 时会**优雅降级到纯本地解析**，整套引用机器变成惰性代码 |
| **为什么** | Roam 块引用语义无直接对应。Obsidian 的近似物是 `![[笔记#^块id]]`，语义与生命周期都不同 |
| **可能的未来** | 「可复用任务 + 每日实例」在 Obsidian 里说得通（例行任务写在别处、每天引用一次）。但这是**新特性立项**，不是移植遗漏 |

### §D11 ⛔ 不移植：`plan-watch.js`

上游 `bc60f9b` / `2a8b525` 引入的 281 行 Roam Pull Watch 三层去重 watcher。Obsidian 无等价物；本移植用 `metadataCache.on('changed')` + 60s tick 覆盖文件变更，另**补了上游没有的**「设置变更立即广播重绘」（上游是 `index.js` 里 dispatch 自定义事件）。runtime 的 `watchPlan` 参数保留不传。

### §D12 ⛔ 不移植：`prefix-str` 设置项

Roam 专有的「组件前缀文本」，Obsidian 无对应概念。**这是上游 12 项设置里唯一有意不移植的一项**，本移植 11 项。

### §D13 ⛔ 不移植：iCal 订阅

上游第二代（`hopeserena/nautilus-enhanced`）就已砍掉，第三代没有。记在这里只是为了让读上游第一代代码的人不困惑。

### §D14 Roam 生态专属的探测与预热：降级为「形状兼容的空实现」

数据层 16 个函数里有两个在 Obsidian 侧**没有可实现的语义**。它们不是漏做，是有意做成空壳；按「台账里没有的不许自认为有意不做」的规矩登记在此（认证审计 A1-174 / A1-180）。

| 函数 | 上游做什么 | 本移植 | 为什么这样是对的 |
|---|---|---|---|
| `warmRightSidebarWindowCache()` | 读 `getWindows()` 预热右侧栏窗口缓存，带 revision 守卫 | **恒返回 `Promise.resolve({ ok: false, reason: 'unavailable' })`** —— 与上游「API 不可用」那个分支**逐字相同**，形状兼容不是杜撰 | Obsidian 的右侧栏是**单个 leaf**，没有 Roam 那种多窗口栈，无缓存可预热。✅ 已核实**确无后果**：① runtime 调用点是 `void warmRightSidebarWindowCache()`，返回值被丢弃、无 `.then`/`.catch` 消费者；② 它预热的 `knownSidebarWindows` 只服务上游 `frontBlockInRightSidebar` 的去重快路径，而本移植的 `frontBlockInRightSidebar` 根本没有那套缓存；③ 返回 resolved promise，不会 unhandled reject |
| `legacyLogbookIsRunning()` | 探测 Roam Logbook 扩展：`#roam-logbook-topbar, .rlb-topbar` DOM + `window.roamLogbookExtensionData?.running` | **恒返回 `false`** | 那两个信号是 Roam Logbook 扩展专属的，Obsidian 侧**没有任何等价的可靠探测信号**。runtime 里这个守卫为 true 时会 `showToast(…, 'danger')` **并抛错**，`initialize()` 整个失败 ⇒ 强行猜测并返回 true 就会**误伤到执行层连启动都不行**，那是比漏报严重得多的失败模式 |

🔴 **代价（必须让用户知道）**：上游那条「检测到第二个 CLOCK 写入者就拒绝启动」的安全承诺，在本移植里**不存在**。如果 vault 里还有别的插件在写 `LOGBOOK::` 抽屉（Day Planner 之类），Nautilus Logger 不会察觉。真正的兜底不在这里，而在**定位侧**：`locateClockLine` 命中多行时**歧义拒写**、`locateLine` 的内容乐观锁拒写变化过的行（注意 §D9 里那条边界 —— 锁不防「选错人」）。

---


### §D15 数据层的「保守拒写」一族

上游的写回靠 Roam block uid 精确寻址，**不存在寻址歧义**。本移植的 uid 是 `path:line`（§D5），
行会漂 ⇒ 每个写回点都要先定位、再动手。**统一取向：定位不唯一就拒写，宁可报错也不改错人。**
代价集中在「幂等性」：上游那些「再调一次静默成功」的路径，这边会抛错。

| 函数 | 本移植的收窄 | 上游行为 | 代价 | 审计 ID |
|---|---|---|---|---|
| `createRunningClock` | 开头守「仅 TODO 可开钟」；`status` 无 `\|\| 'TODO'` 兜底（守卫保证恒 TODO，兜底不可达，**不是漏抄**） | 无此守卫 | 绕过 runtime 直调数据层给非 TODO 开钟会抛错 | A1-069 / A1-083 |
| `closeClock` | 定位歧义（同文件多条同起始分钟的 running CLOCK）时抛错 | 按 `clockUid` 精确读，无歧义问题 | **重复 Clock Out 不再幂等** —— 这正是 §D9「锁不防选错人」那条边界的具体后果 | A1-096 |
| `deleteClock` | 先定位后删；找不到/歧义即拒写 | 「删完再读回确认」—— 若删错行，校验读到的仍是「删掉了」，防线失效 | 同一 entry 连删两次：第二次抛错（上游静默成功）。宿主删完即 refresh，实际触不到 | A1-108 / A1-112 |
| `updateGraphBlock` | 窄化成**只接受 CLOCK 形态**的新内容；返回 `true`；重复调用抛错 | 通用「把任意 block 文本改成 string」 | 想更新非 CLOCK 块会抛错；本移植无此诉求（唯一调用方是 `reconcileLegacyOverlap`） | A1-116 / A1-122 / A1-123 |
| `completeTask` | 只认显式 TODO（含 `- [/]` `- [-]` `- [>]` 等自定义 checkbox）；**裸文本行拒绝** | 非 DONE 一律完成 —— 裸行用前缀 `{{[[DONE]]}}` 照样勾上 | 对裸行调用会抛错。与 §D1 一致：裸行不是任务，不该凭空变成「已完成」 | A1-126 / A1-127 |

### §D16 形状兼容字段：填得下但没有真语义

vendored runtime 的数据结构里有几个字段在 Obsidian 没有对应概念。**保留字段是为了形状兼容，值不承载语义。**

| 字段 | 本移植填什么 | 上游是什么 | 有消费者吗 |
|---|---|---|---|
| `TimingEntry.pageTitle` / `PrimaryPlanSnapshot.pageTitle` | vault 相对路径 | 人类可读页标题（`"September 24, 2026"`） | 无（vendor 与宿主均不读；盘心标题另走 `data-nl-key`） |
| `plan.string` | 恒 `''` | 命中的 renderer block 的文本 | 无（vendor 只读 `plan.uid`） |

**为什么**：Obsidian 的「页面身份」就是 vault 路径 —— 它已经是 uid 的基底（§1），没有独立于路径之外
的「页标题」概念值得再爬一次。**代价**：将来若有消费方按上游语义读它们，`pageTitle` 拿到路径、
`plan.string` 拿到空串。审计 ID：A1-009 / A1-044 / A1-049 / A1-084。

### §D17 LOGBOOK 抽屉的成员判定放宽到「任意缩进后代」

| | |
|---|---|
| **上游** | `ENTRIES_QUERY` 要求 CLOCK 是 drawer 块的**直接**子级（`timing-roam.js:31-55`） |
| **本移植** | `indent > drawer.indent` 即算成员 —— 抽屉下方**任意深度**的 CLOCK 都收 |
| **为什么** | 纯文本没有父子实体，只能靠缩进近似;「直接子级」在文本里没有可靠判据。我们自己写出的 CLOCK 恒为 `drawerIndent + 4`;用户手工塞进更深层级属病态输入，**收下比丢掉更不容易丢历史** |
| **代价** | 抽屉归属口径比上游略宽。可解析性不受影响 |

审计 ID：A1-011。

### §D18 平行正则：`parser.ts` 逐字抄 vendor 的两条 `d`-token 正则

| | |
|---|---|
| **问题** | 上游**不导出** `doneTime` / `durationTokens` / `removeTaskState`（`module.exports` 里没有）。而解析侧必须与引擎对同一行文本给同一答案 ⇒ 只能抄正则 |
| **本移植** | `parser.ts` 的 `PROGRESS_RE` / `DONE_AT_RE` 与 `vendor/timing-core.js` 逐字相同 |
| 🔴 **维护风险** | 上游改正则时本移植**不会自动跟随，测试也不会红**（两套各自本地） |
| **保障** | §7 新增第 8 号检测器「平行正则漂移」：机械比对两侧 `regex source` 是否逐字一致，不一致即红 |

审计 ID：T1-127。

### §D19 Clock In 入口收窄到「今天主计划里的任务」

右键菜单的「Clock in」要求该行 uid ∈ 今天主计划的任务集。上游任何 TODO 块都能 clock in。

**为什么**：vendored `startTask` 自己就校验任务在今天主计划里、否则抛错
（`timing-runtime.js:403-406`）—— 不加这条收窄就会给出一个**点了必然报错的菜单项**。
**代价**：跨笔记 / 非计划任务不能从右键开始计时（要先把任务写进今天的日记）。审计 ID：E1-079。

### §D20 状态栏点击只开侧栏，不 toggle 收起

上游点 trigger 是 toggle popover;本移植三种入口（状态栏 token / 命令 / ribbon）调 `activateSidebar`，
侧栏已开则只 `revealLeaf` 聚焦。**为什么**：载荷面是 Obsidian 侧栏 leaf，它自带关闭按钮与工作区命令。
**代价**：想收起要用 Obsidian 原生关闭。审计 ID：T3-018。

### §D21 CLOCK 在跑时 POMO 启动按钮「保留但禁用」

上游在有任务 CLOCK 时**完全不渲染** POMO 启动按钮;本移植始终渲染，只置灰。

**为什么**：把入口整个藏掉会让用户以为「番茄钟没了」;置灰是**可见的状态宣示** ——
功能存在，只是被任务 CLOCK 暂时锁住（与 CLOCK always wins 的语义一致）。
**代价**：照上游截图核对时会觉得多了一个点不动的按钮。审计 ID：T3-030。

### §D22 浮层的类名、挂载面与数据形状都偏离上游

| | |
|---|---|
| **上游** | `.nautilus-log-hover-tooltip` + `--positioned` / `--{placement}`，portal 到 `document.body`，内容是 `title` + `meta` 两个固定字段 |
| **本移植** | `.nautilus-log-tooltip`，append 到**宿主容器**、坐标宿主相对（被 RQ-8 测试钉死），placement 存 `dataset.placement`，内容是逐行渲染的 `lines` |
| **为什么** | 不 portal 到 body ⇒ 沿用上游 `--{placement}` 类名会与「body 绝对定位」语义的样式冲突;而两边的数据形状本就不同（我们喂 `[标题, 区间, 时长]`，种类行在 `aria-label`）。纯改名零用户可见收益 |
| **代价** | `styles.css` 这一族非上游原样，对账时要记得它是「改造后的对应物」，不是遗漏 |

审计 ID：L2-122 / S1-018。

### §D23 紧凑显隐交给 CSS 容器查询，不在 JS 里判

上游用 `compact-state` 这个 JS 状态门控紧凑概览的渲染;本移植**无条件渲染**，显隐全交给
`@container (max-width:520px)`。`nautilus-log-header--compact` 同理无条件加。

**为什么**：紧凑与否由容器查询判定，不需要宿主再维护一份「是否紧凑」的 JS 布尔，
也避免与 `spiral.ts` 的 `isCompactChartWidth` 打架。
**代价**：宽容器里常驻一段 `display:none` 的 DOM（开销可忽略）;⚠️ 若将来有人把某条规则移出
`@container` 而忘了这里，会意外在宽容器生效。审计 ID：C2-022 / C2-076。

### §D24 渲染路的语言不做二次归一化

`main.ts` 渲染路的 `uiCopy(settings.language)` 不再归一化（`parser.ts` 有 `normalizeLanguage`）。

**不是疏漏，是依赖不变量的有意取舍**：`loadSettings → sanitizeSettings` 每次加载都把 language
强制成 `en`/`zh`，块级 `lang:` 覆盖也只认这两个字面量 ⇒ 渲染路永远拿不到脏值。
**重新评估触发条件**：若将来出现能绕过净化的入口，把 `normalizeLanguage` 接到渲染路当防御。
审计 ID：L2-034。

### §D25 ⛔ 明确不移植清单（逐条附上游侧证据）

🔴 判「不移植」必须能说清**为什么上游那段在上游自己也不触发，或者 Obsidian 根本没这个概念** ——
不能只写「Roam 专有」四个字。

| 项 | 上游侧证据（为什么不该移植） | 审计 ID |
|---|---|---|
| **debug 调试设施** | `debug-state-atom` 初始 `false`;开启按钮只在 renderer 块**首个位置参数**是字面量 `:debug` 时渲染 —— 而 §D4 用代码块内 YAML，**没有位置参数**这个通道;上游自注 `#FIXME remove in production later` | L2-089 / C1-107 / C2-034 |
| **`shaky` 随机抖动** | `(def shaky false) ;; beta feature` —— 常量恒 false，`shake-if` 恒返回 0，**从未触发** | C1-106 |
| **`iterate-rect-place` 第二套标签摆位** | 上游 `(or external-rect fallback-rect)` 里 `external-rect` **永不 nil**（`placeExternalLabels` 的 side-rails 分支恒返回对象）⇒ 那套螺旋搜索连同两个常量**整体不可达**。两边都不可达，等价于无差别 | C1-060 / L2-105 |
| **Roam 面包屑 / zoom 重复渲染抑制** | 六条规则全匹配 `.rm-*` 专属 DOM;上游注释明说是「Roam 会把祖先块重复渲染进面包屑」。⚠️ **审计一度把它误读成「跳过嵌入的昂贵渲染」** —— 上游根本不针对 hover preview / `![[]]` 嵌入 | S1-004 / E1-084 / G1-120 |
| **topbar 响应式密度 `data-density`** | 密度的测量面是 Roam 顶栏的搜索框（`findSearchSurface(.rm-topbar)`），Obsidian 无等价物。状态栏已用「标题截断 + idle 只留图标」覆盖了上游 density 的两档 | T3-014 |
| **「加载中」态** | 上游数据源是异步图查询，有「渲染已发生但扩展仍在 bootstrap」的窗口;本移植渲染同步吃内容缓存（§D6），唯一异步点是双冷时的一次 `primeCache`，毫秒级 | C2-112 |
| **`isDestroyed()` 探针** | 上游 `index.js` 自己也不调它（纯外部自省）;vendor 内部已用 `destroyed` 旗标守卫全部异步操作 | T2-108 |
| **`showToast` 的 `intent`/`timeout`/`id`** | Obsidian `Notice` 只有 `(message, duration?)`，无 type、无 id;唯一 `danger` 调用点挂在 §D14 判死的 `legacyLogbookIsRunning()` 之后，不可达 | A1-183/184/185 |
| **Roam 右栏窗口栈语义** | `frontBlock` 的 `deduped`/`reordered`/`skipped`/`superseded` 全是**多窗口栈**的去重/重排/竞态语义;Obsidian 右栏是**单个 leaf**，每次 `openFile` 覆盖式打开，没有可被乱序的栈 | A1-150 / A1-151 |
| **`;;` 模板菜单插入组件** | Roam 原生模板菜单;Obsidian 直接敲围栏即可，§S4 的「创建测试笔记」已覆盖插入面 | E1-087 |
| **命令面板缺失守卫** | 上游对 `extensionAPI.ui.commandPalette` 缺失抛错;Obsidian 的 `Plugin.addCommand` 无条件存在，无失败面 → N/A | E1-075 |
| **点击盘面切片 +10% 进度** | ⚠️ 这条**不是上游死代码**，是真缺口。`spiral.ts` 是刻意纯渲染的壳（不 import obsidian，平台量靠宿主注入），在只读 SVG 里埋写回路径与「盘面只读」的既有契约冲突。**代价**：调进度只能手改笔记里的 `d50%`。**重新评估触发条件**：给 `SpiralOptions` 加 `onProgressClick?(uid)` 回调并把写回接进 `timing-obsidian.ts` | C1-105 |

### §D26 设置滑块的量程不消费引擎导出的常量

「开始/结束整点」用滑块 `setLimits(0,23)` / `setLimits(1,24)`，不消费引擎的 `START_HOURS`/`END_HOURS`。
**为什么**：本移植的控件是滑块不是下拉，两个集合**端点一致**，滑块 step 1 即同一能力集合。
**代价**：端点被抄了一份，上游改量程时不会自动跟随 —— 由 §7 第 5 号检测器（vendor 逐字节比对）
在升级时提示，届时人工核对。审计 ID：L1-003 / L1-004。

### §D27 折叠态的持久化改用 Obsidian 官方 device-local 存储（不再用浏览器 `localStorage`）

| | |
|---|---|
| **上游** | `component.cljs:1417-1418` 用浏览器 `localStorage` 存折叠位（`read-collapsed-state` / `write-collapsed-state`），键 `"nautilus-log:collapsed:v1:" + block-uid` |
| **本移植** | 换成 Obsidian 官方 `app.loadLocalStorage` / `app.saveLocalStorage`（1.8.7 起，自带 vault 级命名空间）。`controls.ts` 不直接摸全局，而是让宿主**注入**一个 `CollapsedStorage` 缝（`collapsedStorageFromApp(app)` 工厂；测试注入内存实现） |
| **为什么** | 社区插件审核的 **Local Storage** Recommendation（"Persists data in localStorage … instead of the Obsidian plugin data APIs"）。折叠态是**每台设备的 UI 状态**：用 `saveData` 会跟着 Obsidian Sync 跨设备同步、且每次折叠都写一遍 `data.json` —— device-local 语义正确。设置项仍走 `loadData`/`saveData`（§1.3），不动 |
| **代价/边界** | ① **老键不迁移**：用户之前存在浏览器 `localStorage` 里的折叠位丢了就丢了（它只是 UI 折叠位；且 `saveLocalStorage` 的键空间自带 vault 前缀，老键也读不回来）。② 运行在 Obsidian **< 1.8.7** 时该 API 不存在 ⇒ 存储读写抛错，被 `readCollapsed`/`writeCollapsed` 的 try/catch 兜住 ⇒ 折叠态不持久、但图表照常渲染（既有纪律，有测试钉住）。③ 键的前缀逻辑**保留**（C2-054）：`saveLocalStorage` 自己带 vault 隔离，但我们的前缀还带**版本位**，将来迁移格式靠它 |

审计依据：社区插件库自动审核 Recommendation「Local Storage」；代码注释引用见 `src/controls.ts` 存储段 + `PROGRESS.md`。

## 5. 挂载面重排

| 上游挂载面 | 上游插入方式 | 本移植 | 位置 |
|---|---|---|---|
| renderer 组件本体 | `{{[[roam/render]]}}` 块 | 代码块处理器 | `registerMarkdownCodeBlockProcessor`（§D4） |
| top bar trigger + popover | 扒 `.rm-find-or-create-wrapper` | 右侧栏面板 | `registerView` + `addRibbonIcon`（§D3） |
| — | — | ➕ 状态栏计时 token | `addStatusBarItem`（超集，§S6） |
| 命令面板 | `extensionAPI.ui.commandPalette` | `addCommand` × **8** | ✅ 上游那 3 条（`focus-current-block` / `clock-out-timing-line` / `locate-primary-plan`）**已于 2026-08-25 补回**，在 `registerTimingCommands()` 里。⚠️ 本行曾写「× 5 · 上游 3 条尚未移植」，与 §D3 自己写的「已补回」直接矛盾（认证审计 P1-093 / G1-K07） |
| 块右键菜单 | `blockContextMenu` | ✅ **已做**：`workspace.on('editor-menu')` + `timingMenuActions` 决定条件显示，两项（Clock In / Clock Out） | ⚠️ 本行曾写「🔴 未做」（认证审计 P1-094 / G1-K07） |
| 设置面板 | Roam `extensionAPI.settings.panel` | `addSettingTab` | 本行此前漏登（§D7 / §D12） |
| `;;` 模板菜单 | Roam 原生 | 命令「创建测试笔记」 | 超集 §S4 |
| Toast | Roam toast | `new Notice()` | |

🔴 **一条推不出来的行为闸**：**总开关 `actualTimeTracking` 关闭时，执行层的命令与右键菜单一个都不许出现**。实现是 `main.ts` 的 `liveRuntime()` —— 它同时看「runtime 起没起」和「开关是不是真的开着」，任何执行层入口都必须过这道闸（`checkCallback` 返回 `false` ⇒ 命令面板里根本搜不到）。重做移植时只按「runtime 存在与否」判会漏掉一半（认证审计 P1-097）。

---

## 6. 超集（上游没有、本移植加的）

登记在此，**重做移植时可选**。

| # | 特性 | 为什么加 |
|---|---|---|
| S1 | **块内当天配置覆盖** | 上游全局设置优先、块参数只是 fallback，**改不了单天**。本移植翻转优先级：块内显式写了就赢 |
| S2 | **单开始时刻钉住** | 上游必须写完整区间 `08:30–09:30`；本移植允许只写 `start: 8:30` |
| S3 | **命令「勾选并打完成时间戳」** | 补 Roam Todo Trigger 的空缺（§D8） |
| S4 | 命令「创建测试笔记」 | 新用户零成本看到效果 |
| S5 | 命令「诊断执行层」 | 这条链有四个独立失败点（注入路径 / 文件存在 / 同步缓存命中 / 围栏正则命中），靠推断会连着猜错 —— 直接把每一环取值报出来 |
| S6 | 状态栏计时 token | Obsidian 有正经 API，顺手 |
| S7 | ` ```naut ` 短别名 | 好记 |
| S8 | 溢出列表条目可点跳转 | 走 `MarkdownRenderer` |
| S9 | 图渲染失败降级 | 图挂了不带走容量数字 |
| S10 | 跨日 `dayState` | 看昨天 = 无指针 / 斜纹铺满 / 容量算整天；看明天 = 完全不铺斜纹。⚠️ **订正**：这些**规则本身全是引擎给的** —— 上游 `log-core.js` 的 `timelineDayState({displayDate, currentDate, …})` 早就把 past/today/future 三种情况想透了（`daystate.ts` 的文件头注释也是这么写的：「一条规则都不自己发明」）。**真正的超集只有一件事：从 vault 路径里认出 `YYYY-MM-DD` 并喂进去**（`daystate.ts dateFromPath`）。本行曾把引擎的能力记成本移植的发明 —— 与 §D3 那次订正完全同型（认证审计 P1-129） |
| S11 | 写回按内容校验（乐观锁） | §D9 |
| S12 | 设置变更立即广播重绘 | §D11 |
| S13 | **图表回放**（`chartState.playback` + `controls.ts` 的播放按钮） | 从窗口起点回放到当前时刻后自动停止；纯视觉，**绝不写回 Markdown**。上游没有这个交互（认证审计 P1-132） |
| S14 | **紧凑列表 / 溢出条目**（`compact.ts`） | 窄容器（侧栏）用列表代替悬停提示；溢出条目走 `MarkdownRenderer` 可点跳转（= 原 S8 的实现载体） |
| S15 | **独立番茄钟**（`pomo.ts`） | 没有任何任务 CLOCK 在跑时，面板表头可启动一个正计时番茄钟；它不写任何块，也不影响 Actual/Planned/Review/螺旋；一旦开始任务 CLOCK 立即被清除 —— CLOCK 永远优先 |
| S16 | **勾选自动打完成时间戳**（`stampCompletionTime` 设置，默认关） | 上游没有自动行为 —— 它的 `completeTask`（timing-roam.js:533）只翻 `{{TODO}}`→`{{[[DONE]]}}`；Roam 侧打戳靠**独立的 Todo Trigger 插件**（§D8 那条 S3 注释同源）。本移植把「勾选补 `dHH:MM`、取消勾选移除」做成**可选超集**（S3 只覆盖手动命令）。🔴 **管辖范围收窄**：只对【今天 Daily Note】第一个 nautilus 块的计划正文生效（与执行层面板 `readPrimaryPlan` 同一边界），**不学竞品**对全 vault 全文件生效。触发走 `metadataCache.on('changed')` + diff 检测「checkbox 恰好翻转」的行（不是全量归一化，不给早已勾选的老任务补「现在」的时间）；写回复用 §D9 的乐观锁 `writeChange`，绝不整文件覆盖 |

📄 **用户文档覆盖**（认证审计 G1 的 L 区）：S5 / S6 / S10 一度**两份用户文档都没写**，已于 2026-08-26 补进 `README.md` 与 `docs/guide.md`。S6 尤其要紧 —— 它是 §D2 修饰键手势**唯一的挂载面**，用户不可能猜到要按修饰键。

---

## 7. 防复发检测器

这些**全是机械判定**，应该固化成 CI 而不是靠人记。可执行版本是 [`scripts/audit-detectors.mjs`](../scripts/audit-detectors.mjs)（`npm test` 会先跑它）。

⚠️ **本表此前与实现对不上**（认证审计 P1-100 / P1-107 / P1-108）：表里列的第 6 号「17 函数签名」**从来没有实现过**，而实现里的第 6 号「怪癖钉子」表里没有 —— 同时 §8 又管怪癖检查叫「检测器 §7 第 6 号」，台账内部自相矛盾。下表以**实现为准**。

| # | 检测器 | 规则 | 曾抓到 |
|---|---|---|---|
| 1 | **孤儿 CSS** | `styles.css` 里每个 `.nautilus-log-*` 类必须有代码发射点（发射面 = `src/*.ts` + **接线过的** vendor 模块，剥注释后匹配） | compact 列表族 17 类、图例 6 类、警告面板 2 类、available-slot 3 类；修掉三处假阴性后又暴露出 `nautilus-log-container/-content/-shell/-collapsed` 这 4 个**真欠账** |
| 2 | **孤儿文案** | `UI_COPY` / `EXECUTION_COPY` 每个叶子 key 必须可达（消费者同样**排除死模块**） | 26 个 key 直接指向 topbar 未接；正则修好后当场抓到真孤儿 `openPanelHint` |
| 3 | **引擎导出面** | `src/vendor/*.js` 的导出符号必须可达（CJS `module.exports` **与 ESM `export function` 都认**） | `availableSlotGroups` · `completedTaskClockSummary` · `capacitySummary` · `taskProgress` · `createTimingTopbar` |
| 4 | **键名空间** | vendor 里所有 `settings.get('...')` 字面量【精确】命中 shim 映射表 `SETTINGS_KEY_MAP`，且每个映射目标必须是 `NautilusSettings` 真实字段 | §D7 那一族（实测 8 个字面量 / 7 个需转换，见 §D7 的订正）。🔴 **2026-08-26 订正（T2-119）**：原实现只判 `main.includes("'k'")` —— 字面量出现在注释 / 别的对象里也算「已映射」，映射目标拼错了也放行。已改为按映射表精确键名 + 字段真相核对（`scripts/setting-map-check.mjs`，`test/detector-mapping.test.js` 钉住）。⚠️ 机械边界：kebab→camel 的【语义】没有第二份真相，「合法但指错的字段」（如把 `workday-start` 指到 `workdayEndHour`）查不出 —— 靠 TS `Record<string, keyof NautilusSettings>` + 升级核对。`POMODORO_STATE_KEY` 这类【变量键】根本进不了字面量集合 —— 靠 §D7 的第三层兜底 |
| 5 | **上游漂移** | 设 `UPSTREAM_DIR=<上游 clone>` 后，`src/vendor/*` 与上游同名文件**逐字节比对**；没给就明说「未检查」，不假装通过 | ⚠️ 订正：本行曾写「`git log` + 行数差异告警」，而原实现**只打印一条命令字符串，永远不会红**（认证审计 P1-106）。已改成真比对 |
| 6 | **怪癖钉子** | [`test/reality-quirks.md`](../test/reality-quirks.md) 里每条 `## RQ-n` 都必须有一行「钉住它的测试」，且那个文件真的存在、真的含那个测试名。**没有豁免** —— 怪癖表只许变长 | 断链即红 |
| 7 | **测试必须接触被测代码** | 每个 `test/*.test.js` 至少引用一次 `src/`（`require` / esbuild `entryPoints` / `readFileSync` 皆可） | 🔴 `test/locate.test.js`：**把 `main.ts` 的定位算法在测试文件里重写了一遍，然后测那份重写** —— 100% 通过，而被测代码一行都没跑到 |
| 8 | **平行正则漂移** | `src/parser.ts` 逐字抄 `src/vendor/timing-core.js` 的两条正则（`DONE_AT_RE`↔`DONE_TIME_RE`、`PROGRESS_RE`↔`PROGRESS_RE`）必须逐字一致 | 🔴 认证审计 T1-127：上游不导出 `doneTime`/`durationTokens`/`removeTaskState`，本移植只能抄正则。上游一改正则，复制件不跟着动、测试也不红 ⇒ 静默漂移。检测器把两侧 source 逐字比对，漂了直接红（`test/detector-mapping.test.js` 两条 T1-127 用例钉住） |

> 🔴 **「17 函数签名检测器」不在表里，因为它不存在。** 数据层签名的核对方式见 §3 的说明（升级时人工核对 16 个函数 + `getFocusedBlockUid`）。要么有人把它实现出来再加回本表，要么就别在文档里假装有这道保障 —— **假保障比没保障更危险**（同 §8 的结论）。

> ⭐ 前 3 个检测器之所以有效，是因为本移植**CSS 与 i18n 是整份搬的、代码是逐个写的**。两者之差就是一张现成的欠账清单。第 7 个是另一类：它不比较两份东西，只是把「测试有没有碰到产品代码」这件本该不言自明的事变成机械判定。

**baseline 纪律**：已知欠账走 [`scripts/audit-baseline.json`](../scripts/audit-baseline.json)。**新增**的孤儿让退出码非 0，存量不会；修掉一条就从 baseline 里删掉 —— **baseline 只许变短，不许变长**（脚本会把「已修好却还留在 baseline 里」的条目也报成回归）。`__why` 里每条豁免**必须给出真实理由**；给不出来的就标 🔴 真欠账，不许用「待评估」占位。

---

## 8. 测试纪律

**共同失败模式：测试夹具比现实「更完整 / 更同步 / 更理想」。** 历次事故全部属于这一类：

| 夹具的理想化 | 掩盖了什么 |
|---|---|
| jsdom 有 canvas | `truncateTextToWidth` 用 `measureText` 按**像素**测，而 `descLength` 是**字符数** —— 真机才炸 |
| Daily Notes 配置 `{format, folder}` 两键齐全 | 真实 Obsidian 在用户没改日期格式时**只给 `{folder}`** |
| `iterateAllLeaves` 空实现 | 永远走 `vault.process` 分支，而现实中几乎总走 `editor` 分支 |
| `getMarkdownFiles()` 立即可用 | 真机 `onload` 时 vault 还没索引完（§D6） |
| jsdom 的 CSSOM **静默丢弃**自定义属性 | 见 `reality-quirks.md` RQ-5 |
| `createElementNS` 与 `createElement` 在夹具里可互换 | 见 `reality-quirks.md` RQ-6 |

⚠️ 本表此前**停在 4 条**，而 `reality-quirks.md` 已有 6 条（认证审计 P1-141）。**以 `reality-quirks.md` 为准**：那份表是棘轮、只许变长，本表只是导读。

⇒ **写夹具时先问：现实里这个假设什么时候不成立？** 然后按不成立的那一面写。

### 还有一类：**测试根本没碰到被测代码**

夹具理想化是「喂进去的东西太干净」；这一类更狠 —— **被测代码压根没被加载**。`test/locate.test.js` 把 `main.ts` 的定位算法在测试文件里**重写了一遍**，然后测那份重写：断言全绿、覆盖的却是测试自己。**机械可判**，已固化成 §7 的第 7 号检测器。

### 三道防线（2026-08-26 立）

| | 是什么 | 抓什么 | 不抓什么 |
|---|---|---|---|
| **[`test/reality-quirks.md`](../test/reality-quirks.md)** | 现实怪癖登记表 + 钉子链接检查（§7 的第 6 号检测器 —— ⚠️ 此处此前与 §7 表冲突，因为那张表里列的第 6 号是个不存在的检测器，见 §7 的订正） | **棘轮**：已发现的怪癖永远丢不掉 | 发现不了新怪癖 |
| **生产自检** | 预热后缓存仍为空就 `console.warn`（`timing-obsidian.ts`）+ 命令「Diagnose execution layer」 | 真机上的**静默降级**当场出声 | 得有人看 console |
| **[`scripts/smoke.sh`](../scripts/smoke.sh)** | 装插件 → Force Reload → 读 AX 树断言 → 截图 | **跨模块的组合失效** | 细粒度行为 |

⛔ **明确不做「夹具 API 面 vs 真实 API 面 diff」。** 拿它对账过 6 起真实事故，
只抓得到 1 起边缘的 + 1 起本来就会大声抛异常的 —— 因为这类 bug 的形态不是
「方法不存在」而是「方法在、语义/时序/值形状不对」。更糟的是它会给出
「我们的 mock 与 API 一致」这个绿灯，恰恰让真正危险的几类继续溜过去。
**假保障比没保障更危险。** 完整对账见 `reality-quirks.md` 开头。

⭐ 一句话：**危险的从来不是「夹具少给了什么」（会炸），是「夹具多给了什么」（会静默）。**

---

## 9. 血统

本移植是第五代。致谢链见 [README](../README.md)。

```
8bitgentleman/roam-depot-render-template   (Matt Vogel，LICENSE 版权行的出处)
  └─ tombarys/roam-depot-nautilus          发明螺旋（外圈时间长内圈短 = 一天中衰减的精力）
       └─ hopeserena/nautilus-enhanced     净增 40 行：修内存泄漏 + 汉字排版 + 双语；砍掉 iCal
            └─ 404KSG/roam-nautilus-log    质变：容量模型 / CLOCK / POMO / Review / 跨午夜
                 └─ dimpurr/obsidian-nautilus-logger   ← 本仓库
```

MIT，版权行三代未改，本移植同样不改。
