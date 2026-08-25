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
| 本移植版本 | `v1.0.0+` |
| 已知欠账 | [`parity-audit-2026-08-25.md`](parity-audit-2026-08-25.md) |

---

## 0. 怎么用这份文档重做移植

1. 读上游 `docs/guide.md` 建立特性全景。
2. 读本文档 §1（概念映射）—— 这决定了整个数据层怎么写。
3. 把上游 `src/{log-core,timing-core,timing-runtime,timing-topbar}.js` **原样 vendor**（§2 纪律）。
4. 按 §3 实现数据层（上游 `timing-roam.js` 的 17 个函数的 Obsidian 版）。
5. 按 §4 逐条落实偏离决策。
6. 按 §5 重排挂载面。
7. 按 §6 决定超集特性要不要一起做。
8. 按 §7 建立防复发检测器。

---

## 1. 概念映射（能一一对应的部分）

| Roam 概念 | Obsidian 对应 | 实现位置 | 备注 |
|---|---|---|---|
| Daily Note page | Daily Notes 插件配置的今日笔记 | `sidebar.ts resolveDailyNoteInfo` | 🔴 配置可能**只有 `folder` 没有 `format`**（用户没改日期格式时 Obsidian 不写这个键），两者有其一即视为有效配置 |
| block uid（不透明标识符） | `filepath:line` | `timing-obsidian.ts splitUid` | 引擎里 uid 只作不透明标识符使用，实测仅 5 处，全部不解释内容 |
| block tree（父子关系天然存在） | **按缩进还原** | `timing-obsidian.ts readPrimaryPlan` | 父 = 往前最近的一行缩进更小的非空行；找不到则为计划块本身。🔴 见 §D5 |
| `{{[[TODO]]}}` / `{{[[DONE]]}}` | `- [ ]` / `- [x]` | `timing-obsidian.ts normalizeTaskString` | 单向归一：喂给引擎前转成 Roam 形态；写回时转回 markdown |
| block children（LOGBOOK 抽屉） | 缩进的子行 | `timing-obsidian.ts createRunningClock` | 首次 Clock In 时自动建 `- LOGBOOK::`，缩进 = 任务缩进 + 4 |
| CLOCK 行 | 逐字相同的文本行 | 引擎的 `parseClockLine` / `formatClockLine` 原样可用 | Org-mode 格式，跨生态兼容 |
| Roam 右侧栏 | `workspace.getRightLeaf()` | `timing-obsidian.ts openTaskInRightSidebar` | |
| Toast | `new Notice()` | `timing-obsidian.ts showToast` | |
| 图数据库同步可查 | ❌ **无对应** | 见 §D6 | Obsidian vault API 全异步，引擎却同步调 —— 必须自建同步缓存 |

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

## 3. 数据层契约（上游 `timing-roam.js` 的 17 个函数）

`timing-runtime.js` 从数据层 import 固定的 17 个函数，实现它们即可让 runtime + topbar 直接跑：

```
readAllEntries · readEntriesForTaskUids · readBlockString · readPrimaryPlan ·
createRunningClock · closeClock · deleteClock · updateGraphBlock · completeTask ·
openTaskInMainWindow · openTaskInRightSidebar · frontBlockInRightSidebar ·
openPrimaryPlan · warmRightSidebarWindowCache · legacyLogbookIsRunning · showToast
```

对应实现全在 `src/timing-obsidian.ts`。

🔴 **签名会随上游变**。`openPrimaryPlan(planUid)` 在上游 `d807ea4` 变成 `(planUid, { sidebar })` —— 升级时必须核对这 17 个函数的调用签名，否则新参数被静默丢弃（不报错、不炸测试）。

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
| **实现** | `main.ts` 的 `renderTimingStatusBar` 回调 · `exec-panel.ts` 的 identity 按钮 |

### §D3 top bar 整体并入右侧栏

| | |
|---|---|
| **上游** | 一个常驻 top bar trigger，点开是 Timing / Plan / Review 的 popover。插入点靠 `querySelector('.rm-find-or-create-wrapper')` 扒 Roam 内部 DOM |
| **本移植** | 不做独立 top bar。三视图直接渲染进右侧栏面板；只在状态栏留一个计时 token |
| **为什么** | 用户决策（2026-08-24）：「top bar 那个因为有交互，我觉得一起丢进侧栏里面好」。且 Obsidian 有正经的 `registerView` / `addStatusBarItem` API，不需要扒 DOM |
| **🔴 已知代价** | 上游 `timing-topbar.js`（879 行、零 Roam 耦合）因此**未被 import**，功能是手写重实现的。审计确认因此丢失：Plan 的 Scheduled/Unscheduled 分节与折叠、每行的预计区间 meta、三 tab 常驻 capacity strip。详见 audit §P1-2 |
| **正确做法（欠账）** | 应当**复用 vendored `timing-topbar.js`**，只替换它的挂载点，而不是手写重实现。这是本移植最大的单一遗漏来源 |

### §D4 渲染载体：Roam renderer block → 代码块

| | |
|---|---|
| **上游** | `{{[[roam/render]]:((uid)) 22 15 5 "" 21}}` —— 设置被烘焙成**位置参数**写进块文本；改设置会回写重写所有已存在的块 |
| **本移植** | ` ```nautilus ` 或 ` ```naut ` 代码块。块**内**是 YAML 风格的当天配置覆盖；计划正文在块**下方**，到首个空行为止 |
| **为什么这样切** | 判据：「Obsidian 代码块可以吞掉自己的源码，只有当它装的是*查询/配置*而不是*数据*时」。计划正文是数据，必须留在块外保持可编辑、可被其它插件索引 |
| **为什么不扫兄弟列表** | 边界零歧义。代价是不进 Tasks 插件的全局索引（B 方案留后手，一期不做） |
| **别名** | `naut` 是短写。🔴 新增别名必须同步改 `main.ts` 的 `BLOCK_LANGS` 与 `locateByFile()` 的围栏正则，否则兜底定位失效 |

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
| **🔴 时序陷阱** | 预热**必须等 `workspace.onLayoutReady`**。插件 `onload` 时 vault 还没索引完，`getMarkdownFiles()` 返回空数组 ⇒ 缓存永远 0 条 ⇒ 执行层永远报「今天没有 Nautilus Log」 |
| **🔴 连锁陷阱** | 上一条修好后引入了新问题：`initialize()` 也在 `onload` 内发起，早于预热 ⇒ `initialEntries` 恒空 ⇒ runtime 的两件**一次性**修复（`reconcileLegacyOverlap` / `closeDoneClocks`）空转。**启动执行层也必须等 onLayoutReady**（audit §P0-2） |
| **兜底** | `cachedLines()` 未命中时顺手 `primeFile()`，下一次 refresh 就能命中 |

### §D7 设置键名空间

| | |
|---|---|
| **上游** | Roam `extensionAPI.settings` 用 **kebab-case**：`workday-start` / `todo-duration` / `recent-retention-minutes` / `timing-line-sidebar` |
| **本移植** | `NautilusSettings` 用 **camelCase**（`workdayStartHour` …） |
| **🔴 必须有映射表** | 喂给 vendored runtime 的 `extensionAPI` shim **必须做 kebab→camel 转换**。直接透传会让所有 `settings.get()` 返回 `undefined` |
| **为什么会静默** | 引擎的兜底值 `?? 5 / ?? 21 / \|\| 15 / ?? 45` **恰好等于 `DEFAULT_SETTINGS`** ⇒ 默认配置下行为完全正确，只有改过设置的用户会撞上，测试必绿。审计 §P0-1 |

### §D8 完成时刻锚点 `dHH:MM`

| | |
|---|---|
| **上游** | 靠 Roam 生态的 Todo Trigger 插件自动打完成时间戳 |
| **本移植** | Obsidian 没有对应生态。**自行发明** `dHH:MM` token（`d13:45`），并提供命令「勾选并打完成时间戳」 |
| **为什么需要** | 没有锚点的已完成任务在盘上画不出来 —— 引擎的明确立场是 "does not invent history" |
| **默认不绑快捷键** | 由用户在 设置 → 快捷键 自行指定 |
| **🔴 已知泄漏** | 引擎的 `taskTitle()` 不认识这个 token（它是我们发明的），会把 `d14:30` 留在标题里。`parser.ts` 那条路剥了，执行层那条路没剥。审计记录在案 |

### §D9 写回策略：双路径

| | |
|---|---|
| **上游** | Roam API 单一路径 |
| **本移植** | 文件**没被编辑器打开** → `vault.process()` 原子读改写；**被打开** → `editor` API（对齐 Tasks 插件的做法） |
| **为什么** | 现实中用户几乎总开着今天的笔记。只走 `vault.process` 会和编辑器状态打架 |
| **🔴 血的教训** | editor 分支曾把新行写成 `内容\n` 追加在锚点**行尾**，产出 `- [ ] 任务 20m    - LOGBOOK::` 脏行。正确是 `\n内容`，与 `applyChange` 的 `splice(idx + 1, 0, next)` 语义对齐 |
| **乐观锁** | 写回按**内容**定位而非行号（`expected` / `locateLine`），行漂移不影响、内容变了则拒写 |

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

---

## 5. 挂载面重排

| 上游挂载面 | 上游插入方式 | 本移植 | 位置 |
|---|---|---|---|
| renderer 组件本体 | `{{[[roam/render]]}}` 块 | 代码块处理器 | `registerMarkdownCodeBlockProcessor`（§D4） |
| top bar trigger + popover | 扒 `.rm-find-or-create-wrapper` | 右侧栏面板 | `registerView` + `addRibbonIcon`（§D3） |
| — | — | ➕ 状态栏计时 token | `addStatusBarItem`（超集，§S6） |
| 命令面板 | `extensionAPI.ui.commandPalette` | `addCommand` × 5 | 🔴 上游的 3 条尚未移植（audit §P1-6） |
| 块右键菜单 | `blockContextMenu` | 🔴 **未做** | 应挂 `workspace.on('editor-menu')`（audit §P1-6） |
| `;;` 模板菜单 | Roam 原生 | 命令「创建测试笔记」 | 超集 §S4 |
| Toast | Roam toast | `new Notice()` | |

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
| S10 | 跨日 `dayState` | 看昨天 = 无指针 / 斜纹铺满 / 容量算整天；看明天 = 完全不铺斜纹。上游只有「今天」的概念 |
| S11 | 写回按内容校验（乐观锁） | §D9 |
| S12 | 设置变更立即广播重绘 | §D11 |

---

## 7. 防复发检测器

这些**全是机械判定**，应该固化成 CI 而不是靠人记。理由见 audit §7。

| 检测器 | 规则 | 曾抓到 |
|---|---|---|
| **孤儿 CSS** | `styles.css` 里每个 `.nautilus-log-*` 类必须有代码发射点 | compact 列表族 17 类、图例 6 类、警告面板 2 类、available-slot 3 类 |
| **孤儿文案** | `UI_COPY` / `EXECUTION_COPY` 每个叶子 key 必须可达 | 26 个 key，直接指向 topbar 未接 |
| **引擎导出面** | `src/vendor/*.js` 每个 `module.exports` 符号必须可达 | `availableSlotGroups` · `completedTaskClockSummary` · `capacitySummary` · `taskProgress` · `createTimingTopbar` |
| **键名空间** | vendor 里所有 `settings.get('...')` 字面量必须在 shim 映射表里有条目 | §D7 的 5 个键 |
| **上游漂移** | 定期 `git log <基线>..HEAD`，vendor 行数差异告警 | 13 commits / +224 行 |
| **17 函数签名** | 数据层契约的调用签名与上游比对 | `openPrimaryPlan` 加了第二参 |

> ⭐ 这几个检测器之所以有效，是因为本移植**CSS 与 i18n 是整份搬的、代码是逐个写的**。两者之差就是一张现成的欠账清单。

---

## 8. 测试纪律

**共同失败模式：测试夹具比现实「更完整 / 更同步 / 更理想」。** 历次事故全部属于这一类：

| 夹具的理想化 | 掩盖了什么 |
|---|---|
| jsdom 有 canvas | `truncateTextToWidth` 用 `measureText` 按**像素**测，而 `descLength` 是**字符数** —— 真机才炸 |
| Daily Notes 配置 `{format, folder}` 两键齐全 | 真实 Obsidian 在用户没改日期格式时**只给 `{folder}`** |
| `iterateAllLeaves` 空实现 | 永远走 `vault.process` 分支，而现实中几乎总走 `editor` 分支 |
| `getMarkdownFiles()` 立即可用 | 真机 `onload` 时 vault 还没索引完（§D6） |

⇒ **写夹具时先问：现实里这个假设什么时候不成立？** 然后按不成立的那一面写。

---

## 9. 血统

本移植是第五代。致谢链见 [README](../README.md)。

```
8bitgentleman/roam-depot-render-template   (Matt Vogel，LICENSE 版权行的出处)
  └─ tombarys/roam-depot-nautilus          发明螺旋（外圈时间长内圈短 = 一天中衰减的精力）
       └─ hopeserena/nautilus-enhanced     净增 40 行：修内存泄漏 + 汉字排版 + 双语；砍掉 iCal
            └─ 404KSG/roam-nautilus-log    质变：容量模型 / CLOCK / POMO / Review / 跨午夜
                 └─ dimpurr/obsidian-nautilus-log   ← 本仓库
```

MIT，版权行三代未改，本移植同样不改。
