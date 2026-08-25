# 特性覆盖审计 · 2026-08-25

对照 `404KSG/roam-nautilus-log`。9 路并行审计，主会话逐条复核。

- 移植基线：上游 `7bf19a1d`；审计时上游 HEAD `86b97c0`（基线后 13 个 commit）
- 被审版本：`v1.0.0` / `589375e`，214 测试全绿
- worker 原始产物：`~/scratch/nautilus-audit/{A,B,C,D,E,F,G,H,I,J}-*.md`

> ⚠️ **本报告只收录主会话亲自验证过的条目。** worker 报了但我没能复现或归类有误的，集中在 §6，不进结论。

---

## 1. 为什么「每次一问就发现新遗漏」

不是运气不好，是**六个系统性漏斗**，每个都会静默漏特性 —— 不报错、不炸测试。

| # | 漏斗 | 本次暴露的实例 |
|---|---|---|
| L1 | **手写重实现零耦合的 vendor 代码** | `timing-topbar.js` 857 行 vendor 了，**import 点 = 0**；拆成 `exec-panel/pomo/statusbar` 手写 |
| L2 | **跨语言键名空间错位** | Roam kebab `workday-start` ↔ 我的 camelCase `workdayStartHour`；兜底值恰好等于默认值 ⇒ 完全静默 |
| L3 | **只接引擎主路径，不接可选入参** | `historicalDoneSlice` 不传 `actualDuration`/`lastClockEnd` ⇒ 整条 actual 分支恒死 |
| L4 | **解析器只产出自己用得到的字段** | `progress` / `warningCode` 在类型里声明了、从不填 ⇒ 引擎对应分支恒不触发 |
| L5 | **CSS / i18n 整份搬、代码逐个写** | 孤儿 class 与孤儿文案 = 一张现成的欠账清单（本次最高信号的检测器） |
| L6 | **基线之后上游继续改** | 13 个 commit，含 4 条我仍带着的 bug |

⭐ **L5 是可自动化的**：`styles.css` 里有规则、代码零发射的 class，和文案表里有 key、渲染路径不可达的字符串，都能一条 CI 规则钉住。见 §7。

---

## 2. P0 · 数据正确性 / 静默失效

### P0-1 执行层的 4 项设置从来没生效过 🔴

`main.ts:474-485` 的 `extensionAPI` shim 原样拿 key 查 `this.settings`，而 vendored runtime 问的是 Roam 的 kebab 键。

| runtime 查（`vendor/timing-runtime.js`） | 我的字段（`contract.ts`） | 命中 | 实际生效值 |
|---|---|---|---|
| `'workday-start'` :29 | `workdayStartHour` | ✗ | `?? 5` → **恒 05:00** |
| `'workday-end'` :30 | `workdayEndHour` | ✗ | `?? 21` → **恒 21:00** |
| `'todo-duration'` :165,177 | `todoDuration` | ✗ | `\|\| 15` |
| `'recent-retention-minutes'` :190 | `recentRetentionMinutes` | ✗ | `?? 45` |
| `'timing-line-sidebar'` :357,463 | `timingLineSidebar` | ✗ | `undefined !== false` → **恒 true，关不掉** |

**为什么一直没被发现**：那 4 个兜底值 `5 / 21 / 15 / 45` **正好等于 `DEFAULT_SETTINGS`**（`contract.ts:75-83`）。默认配置下行为完全正确，只有改过设置的用户会撞上 —— 测试必绿。

**实际影响**：`data.json` 里 workday 是 6–18，执行层一直按 5–21 算容量与排程。侧栏头部看着对，是因为它走 `this.settings` 直读、不过这个 shim。

**修**：shim 里加一张 kebab→camel 映射表，并在 `contract.ts` 用类型把两侧钉死。

### P0-2 冷启动失明 —— 我自己的修复引入的 🔴

`main.ts:391` 在 `onload` 内同步 `startExecutionLayer()` → `main.ts:487 initialize()`；而缓存预热在 `timing-obsidian.ts:145` 挂 `onLayoutReady`，**必晚于 onload**。

⇒ `initialize()` 拿到的 `initialEntries` 恒为 `[]`，而 `vendor/timing-runtime.js:457-458` 的两件**一次性**修复空转：

- `reconcileLegacyOverlap` —— 修重叠的 running CLOCK
- `closeDoneClocks` —— 关掉已完成任务上还开着的表

后果：昨天遗留的 running CLOCK 重启后不会自动关闭，此后 Clock In 可能写出第二条并行的 running CLOCK，且 reconcile 已过、不会再补。

**修**：把 `startExecutionLayer()` 也移进 `onLayoutReady`，或让 `initialize()` 等预热 Promise。

### P0-3 CLOCK 写回从「精确定位」退化成「模糊匹配」 🔴

| | 上游 | MINE |
|---|---|---|
| 定位方式 | 读 `entry.clockUid` 指定的那**一个** block（`timing-roam.js:368`） | `findClockIndexByStart`（`timing-obsidian.ts:294`）**从第 0 行线性扫**，取首个起始分钟匹配者 |
| 判别维度 | uid | 仅「同文件 + 同起始分钟」，不校验抽屉归属、不校验任务子树 |

调用点：`closeClock:542,545,558` · `deleteClock:572` · `updateGraphBlock:588` · `createRunningClock:516`。

`entry.clockUid` 我其实构造了（`buildEntry`），只是没拿来定位。同文件两条起始分钟相同的 running CLOCK 就会认错 —— **而这恰恰就是 `reconcileLegacyOverlap` 要修的场景**，最需要精确时最容易撞车，撞车后文件已被改坏才抛错。

分钟截断本身是必要的（CLOCK 行只到分钟），问题是缺第二维判别。

### P0-4 已完成任务的「实际耗时」整条分支恒死 🔴

`spiral.ts:1135` 调 `historicalDoneSlice` 时只传 `{done, doneAt, duration, defaultDuration}`，**从不传 `actualDuration` / `lastClockEnd`** ⇒ 引擎里 `hasActual` 恒 false。

后果两条：
1. 已完成任务的切片长度**永远是估计值**，即使有完整 CLOCK 记录 —— Review 的 Actual 与盘上对不上。
2. **没打 `dHH:MM` 锚点但打过卡的任务，在盘上直接不画。**

上游用 `completedTaskClockSummary` 喂这两个值（`component.cljs:679-693`），并有 `done-at ← last-clock-end` 兜底。该函数在我的 vendor 里**存在且可用，零调用点**。

> 佐证：`main.ts:407-421` 那条 `complete-with-timestamp` 命令，本质就是为绕行这个坑加的。而执行层面板的 `Complete task` 按钮不打锚点 ⇒ **用它勾掉的任务会从盘上消失**。

### P0-5 看历史日期时弹性任务全部落进 overflow 🔴

`daystate.ts` 正确地区分了 `scheduleFromMinutes`（排程起点）与 `capacityFromMinutes`（容量起点），但 `main.ts:228` 只把后者喂给 `calculateCapacity`，而 `scheduleFromMinutes` **在 `daystate.ts` 之外零引用**。

看过去的日子时 `capacityFrom` = 当天终点 ⇒ 引擎内部 `scheduleTasks` 用同一个 nowMinutes 起排 ⇒ 排不下任何东西 ⇒ 全进 overflow。上游两个值是分开用的（`component.cljs:1837` vs `:1856`）。

---

## 3. P1 · 用户可见特性缺失

### P1-1 盘上标签显示原始 markdown 🔴（你的截图里可见）

`spiral.ts:1105 / 1117 / 1144` 都用 `e.string` / `t.string` —— **未清洗的整行**。清洗函数 `taskDescription()`（`parser.ts:97`）只在 `main.ts:331` 的溢出面板用了。

⇒ 引线标签显示 `- [x] 办理 EE 路由器 final bil…` 而不是 `办理 EE 路由器 final bill`。上游有 `parse-URLs` + `parse-rest` 清洗链（`component.cljs:638-665`），切片只用清洗后的 `:description`。

### P1-2 `timing-topbar.js` 整个模块没接（857 行）🔴

vendored、零 Roam 耦合、**import 点 = 0**。手写重实现后确认丢掉的：

| 上游 topbar | 我的重写 |
|---|---|
| Plan 分「Scheduled / 可折叠 Unscheduled」两节 + 每节计数（`timing-topbar.js:536-570`） | 平铺 `tasks.forEach`（`exec-panel.ts:370`） |
| 每行 meta：`Today HH:MM–HH:MM · Remaining/Planned` | 无 |
| 三 tab 常驻 capacity strip（`capacitySummary` 零调用） | 无 |
| Alt-click 主界面定位 / Shift-click 送右侧栏 | 只有「打开侧栏」一种手势 |
| 快捷键提示 popover | 无 |

对应文案 `plan.scheduled` / `plan.unscheduled` / `plan.today` / `identity.panel` / `actions.openPanel` / `trigger.*` 全部在文案表里空放 —— C 轴从 i18n 方向独立指向了同一处。

⚠️ 注意 `planSnapshot.execution`（vendor 已产出 scheduled/overflow 分组）**从未被读取**。

### P1-3 `d50%` 进度整条链路缺失 🔴

三段全无：
1. 解析 `d50%`（`parser.ts` 零 progress 产出，`contract.ts:40` 声明了没人填）
2. 网点叠层渲染（`spiral.ts:1111,1150` 的 `progress` **硬编码 0**）
3. 点击切片 +10%、满 100% 自动 TODO→DONE 并补 `dHH:MM`（`component.cljs:874,895→517-541`）

引擎侧是支持的：`vendor/timing-core.js:251-269` 认 `d50%` 折算 `remainingMinutes`，`log-core.js:612` 也读 progress。**两条路分裂**：容量按满额算，执行层按折减算。

### P1-4 紧凑模式没有任何替代内容 🔴

`spiral.ts:1243` 只加个 class 就 `return`。上游紧凑时切换成两个 `<details>`：

- `compact-event-list`（`component.cljs:1221`）—— `Schedule · N items` + 圆点 / `HH:MM–HH:MM` / 标题
- `compact-overview`（`component.cljs:1638`）—— 折叠概览

CSS 已整份搬来（28 条 `nautilus-log-compact-*` 规则），**代码发射点 0**。

⇒ **侧栏里读不出任何精确时间**：紧凑模式又同时关掉了 hover tooltip。

### P1-5 回放逐片动画彻底失效（双重断链）🔴

1. `playback-active` 类上游加在 `<svg>`（`component.cljs:1320`），我加在**按钮上**（`controls.ts:265`）。而 `styles.css:778-780` 的选择器要求它在 `.nautilus-log-slice` 的祖先上。
2. `--pb-delay` 自定义属性**从不设置**，`styles.css:783` 的 `animation-delay` 恒为 0。

⇒ 点播放按钮只有按钮自己变个样，盘上不会逐片亮起。

### P1-6 命令 / 右键菜单整体缺失 🔴

上游 `timing-commands.js:44-70` 注册了命令面板 3 条（Focus current block / Clock out Timing Line / Locate Primary Plan）+ 块右键菜单 2 条（Clock in / Clock out，带条件显示）。

MINE：`grep -rn "editor-menu|file-menu|new Menu|registerEvent" src/` **零命中**。

⇒ **「在正文里对某一行直接 Clock in/out」没有任何入口**，必须绕到侧栏面板找那一行。Obsidian 的等价挂载点是 `workspace.on('editor-menu')`。

### P1-7 右栏打开会劫持主编辑器光标 🟠

`openTaskLeaf(uid,'right')`（`timing-obsidian.ts:726-737`）在 `rightLeaf.openFile()` 之后调 `revealLine`，而 `revealLine`（`:712-716`）取的是 `workspace.getActiveLeaf()` 的 editor —— **不是刚打开那个 leaf**。

`getRightLeaf(false).openFile()` 不设 active ⇒ 光标跳的是用户当前主笔记，行号还属于另一个文件。而 `startTask` 默认带侧栏意图（`timing-runtime.js:357`），**每次 Clock In 都触发一次**，60ms 后再重放一遍。

> 未实机验证，但代码路径清晰。

### P1-8 其余缺失（已核实）

| 项 | 证据 |
|---|---|
| HTML 颜色图例（Urgent/Event/Task 色点） | `styles.css:220-259` 有规则，零 DOM 生产者 |
| 排期警告面板（跨午夜 / 非法时间段） | `warningCode` 在 `parser.ts:144,156,197` 被全部丢弃 |
| 溢出面板不可折叠、无「总时长 · 条数」 | 上游是 `<details>` + `unplacedMinutes` 汇总 |
| 盘心第一行（页名 / 日期）恒为空串 | — |
| 设置变更不广播重绘 | 上游 `index.js:152-165` dispatch 事件；我 `main.ts:535` 只写盘，要等 60s tick |
| tooltip 三处几何偏差 | radius 传内圈 50 而非外径≈158；不传 `preferred` ⇒ 恒 `right`，左半盘会盖住盘面；缺 `getScreenCTM` 换算 |
| 6 处用户可见文案硬编码英文 | `main.ts:241,247,249,251` · `sidebar.ts:315,318-320`，`language='zh'` 时仍是英文 |
| `d18`（无分钟）完成锚点认不出 | `parser.ts:63` vs `component.cljs:604` |
| 紧急触发词裸子串匹配、不去空格 | `parser.ts:236` vs `component.cljs:625`；上游 `index.js:349` 显式 `replace(/\s/g,"")` |
| `taskTitle()` 没剥 `dHH:MM` | 实跑 `{{DONE}} Write report 30m d14:30` → 标题 `"Write report d14:30"` |

---

## 4. 上游漂移（基线 `7bf19a1d` → `86b97c0`，13 commits）

**这一类不是我漏移植，是上游后来改的** —— 以前完全没人盯这条线。

### 我仍带着的 bug

| # | 内容 | 证据 |
|---|---|---|
| U-1 | CLOCK entry 冻结了 clock-in 那一刻的 title/status/plannedMinutes；任务改名或改时长后 Timing/Review 显示旧值。上游改为每次 refresh 用 live `reviewTasks` 覆写 | 上游 `timing-runtime.js:207-216`；我的 vendor **无此段**（已亲验 diff） |
| U-2 | clock-in 守卫从 `readBlockString`+`taskStatus` 改成查 `snapshot.planSnapshot.tasks` | `timing-runtime.js:403-406` |
| U-3 | `completeTask` 放宽为只在 `status==='DONE'` 时拒绝 | 我 `timing-obsidian.ts:603-606` 硬性 `!== 'TODO'` 就抛错，`- [/]` 这类标记会失败 |

### 新特性

| # | 内容 | 对我的影响 |
|---|---|---|
| U-4 | **TODO 标记变可选** —— `projectDirectTasks` 的过滤器去掉了 `taskStatus(row.string) && !parseTimeRangeMinutes(...)`，裸行也能当弹性任务 | 我的 `parser.ts:254` 判成 malformed。**已亲验两边 filter 差异** |
| U-5 | Alt-click 定位 / Shift-click 右侧栏 —— **唯一破坏适配层签名的改动**：`openPrimaryPlan(planUid)` → `(planUid, {sidebar})` | 我 `timing-obsidian.ts:765` 仍是单参 |
| U-6 | Plan 实时刷新（新文件 `plan-watch.js` 281 行 + runtime 新参 `watchPlan`） | 依赖 Roam Pull Watch，无 Obsidian 等价物；建议只保留参数口子 |
| U-7 | 快捷键 tooltip 样式族 `.nautilus-log-timing__shortcut-tooltip` | 代码与样式两端一致缺失 |
| U-8 | 引用任务 = 每日实例模型（`resolveTaskInstance` 等 7 个新函数） | Roam 块引用语义，Obsidian 无对应 —— **建议不拉** |

---

## 5. 测试为什么没拦住

| 问题 | 证据 |
|---|---|
| **`main.ts` 全部 538 行零覆盖** | 5 条命令、`NautilusLogView.render()` 的三级定位逻辑、`onload/onunload`、`activateSidebar`、`startExecutionLayer` 全部无测试 |
| 🔴 **`test/locate.test.js` 是假覆盖** | 文件头写明「复刻 main.ts 里 locateInText 的算法」，然后测这份**复刻件**；全文没有 bundle 过 `main.ts`。实现漂移了测试照样绿 |
| `timing-obsidian.ts` 12 个函数零覆盖 | 含 `completeTask`（真正写 checkbox 的那个）、全部导航五件套、`diagnoseTiming` |
| `primeDailyNotesConfig` 的 JSON 兜底路径零覆盖 | 而这正是历史事故 #2 撞的那条路；`sidebar.test.js:263` 的回归测试走的是**另一条** `internalPlugins` 路径 |
| P0-1~P0-5 全部无测试 | — |

**共同模式**（历史四次事故 + 本次）：**测试夹具比现实「更完整 / 更同步 / 更理想」**。jsdom 有 canvas、Daily Notes 配置两个键齐全、`iterateAllLeaves` 是空实现、`getMarkdownFiles()` 立即可用 —— 每一条都让真机独有的失败路径无法复现。

---

## 6. worker 报了但我改判 / 验伪的

§4 收口的产出，**不进结论**：

| 断言 | 判定 |
|---|---|
| `metric--warning` / `metric-percent--warning` 永远不可达（B 轴） | ❌ **验伪**。引擎 `log-core.js:1004` 在 overload/fragmented 时确实发 `tone:'warning'`，`header.ts:311,329` 确实渲染 `metrics.status`。worker 只看到 `header.ts:238` 那个「拿不到 metrics 时的兜底对象」硬编码 neutral |
| 「裸行不能当弹性任务」是移植遗漏（D 轴 1.2） | ⚠️ **改判**。已亲验两边 filter：这是**基线之后**上游才去掉的条件 ⇒ 归入 §4 上游漂移 U-4，不是我漏移植 |
| `tooltips.available` / `availableNow` 是孤儿文案（C 轴） | ✅ worker **自己更正了** —— 查证发现 `spiral.ts:1217` 已接上（我刚做完），主动剔除。没有顺着 prompt 编 |
| `warmRightSidebarWindowCache` 是空壳 | ✅ 属实但**无影响**：返回形状与上游「API 不可用」分支一致，runtime 用 `void` 丢弃 |
| `formatCapacitySummary` 未调用 | ✅ 属实且**有意**：上游它就硬编码中文无 i18n，`header.ts:317` / `contract.ts:162` 有注释说明 |
| `resolveBlockReferences` 未调用 | ✅ 属实但**上游自己也是死代码**（worker 在上游侧 rg 验证过） |

---

## 7. 防复发：把这次的检测器固化成 CI

这次最高信号的三个检测器**全是机械的**，应该变成脚本而不是靠人记：

| 检测器 | 规则 | 这次抓到 |
|---|---|---|
| **孤儿 CSS** | `styles.css` 里的每个 `.nautilus-log-*` 类，代码里必须有发射点，否则失败 | compact 列表族 17 类、图例 6 类、警告面板 2 类 |
| **孤儿文案** | `UI_COPY` / `EXECUTION_COPY` 的每个叶子 key，必须有可达引用 | 26 个 key，直接指向 topbar 未接 |
| **引擎导出面** | `src/vendor/*.js` 的每个 `module.exports` 符号，必须可达（直接或经已挂上的 vendor 链） | `availableSlotGroups` · `completedTaskClockSummary` · `capacitySummary` · `taskProgress` · `createTimingTopbar` |
| **键名空间** | vendor 里所有 `settings.get('...')` 的字面量，必须在 shim 映射表里有条目 | P0-1 的 5 个键 |
| **上游漂移** | 定期 `git log <baseline>..HEAD`，vendor 文件行数差异告警 | 13 commits / +224 行 |

外加一条纪律：**不要手写重实现零 Roam 耦合的 vendor 模块**。`timing-topbar.js` 本可直接接。

---

## 附：审计方法

`find-skills` 搜了 6 组关键词，生态里**没有**「上游实现 ↔ 移植版」对账的 skill（最接近的 `requirements-traceability` 驱动源是需求文档不是参考实现，`feature-audit` 只查用户可达性）。本次自建 9 轴，每轴对应一次真实事故：

| 轴 | 检测什么 | 源自哪次事故 |
|---|---|---|
| A | 引擎导出但零调用的符号 | `availableSlotGroups` 空放 |
| B | CSS 有规则、代码零发射的类 | `.nautilus-log-available-slot` 空放 |
| C | 文案表有 key、渲染不可达 | `tooltips.available` 空放 |
| D | 以上游用户文档为唯一驱动源逐条对账 | status bar / 小面板 |
| E | 设置 / 命令 / 挂载面 | top bar 漏挂 |
| F | 调用了但数据形状让引擎行为被架空 | 嵌套 `parentUid` 拍平 |
| G | 基线之后上游改了什么 | 新增轴 |
| H | 测试夹具比现实更理想的地方 | jsdom canvas / `{folder}` / 空 `iterateAllLeaves` |
| I | 适配层 17 函数逐条语义对账 | 同 F |
| J | cljs 薄壳逐条对到 TS 重写层 | 重写必然丢分支 |

按 `agent-dispatch-sop`：prompt 内写死「未找到 ≠ 不存在」；收口按 §4「worker 自述不是证据」逐条亲验，产出见 §6。
