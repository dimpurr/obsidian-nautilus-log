# Nautilus Logger for Obsidian

[English](./README.md) · **简体中文**

> **让每一分钟都有活儿干。**

[Obsidian](https://obsidian.md/) 上的可视化日程规划插件。Nautilus Logger 把一篇笔记变成一张动态的螺旋日程表：固定事件钉在时间上不动，弹性任务流进剩下的时间，超载也始终看得见。

![Nautilus Logger，显示明确时间容量的螺旋日程规划器](https://raw.githubusercontent.com/dimpurr/obsidian-nautilus-logger/main/docs/assets/overview.png)

## 项目来源

这是对一个特定项目的移植：

> ### 🧭 [**Nautilus Log for Roam Research**](https://github.com/404KSG/roam-nautilus-log)（作者：[404KSG](https://github.com/404KSG)）
>
> 调度与容量计算引擎（`log-core.js`、`timing-core.js`、`timing-runtime.js`、`timing-topbar.js`）原样搬进 [`src/vendor/`](src/vendor/) 目录，**逐字节未改**。所以你在这里看到的数字由上游代码算出，而不是某个重写版本算出的。
>
> 这个项目补的是 Obsidian 这一侧：同一个引擎，只是改用 Markdown 文件来喂，而非 Roam 图。

那个项目自己也有前身，列在[致谢](#致谢)中。它们塑造了上游，因此跟上面那条线分开记录。

> ⚠️ **状态：尚未上架 Obsidian 社区插件市场。**
> 怎么装，见[安装](#安装)。

> **想贡献，或者想把它移植到别处？** 先从 [`docs/PORTING-DECISIONS.md`](docs/PORTING-DECISIONS.md) 读起。这份文档记录了本移植每一处有意偏离上游的地方，详尽到只要*上游代码 + 这份文档*就足以从零重做整个移植。

## 安装

> 还没上社区插件市场。现在有三种装法。**想要更新就选 BRAT。**

### 方式 1：BRAT（推荐，自动更新）

1. 从 Obsidian 社区插件中安装 [**BRAT**](https://github.com/TfTHacker/obsidian42-brat)。
2. BRAT 设置 → **Add Beta plugin** → 粘贴：
   ```
   dimpurr/obsidian-nautilus-logger
   ```
3. 在社区插件中启用 **Nautilus Logger**。

BRAT 会跟踪本仓库的 GitHub releases，替你更新插件。

### 方式 2：手动安装

1. 从[最新 release](https://github.com/dimpurr/obsidian-nautilus-logger/releases/latest)下载 `main.js`、`manifest.json` 和 `styles.css`。
2. 创建文件夹 `<你的笔记库>/.obsidian/plugins/nautilus-logger/`。
3. 把三个文件放进去。
4. 重启 Obsidian（或执行 **重新加载应用而不保存**），然后在社区插件中启用插件。

### 方式 3：单行命令（macOS / Linux）

在你的**笔记库文件夹**里运行：

```bash
mkdir -p .obsidian/plugins/nautilus-logger && cd .obsidian/plugins/nautilus-logger && \
  curl -LO https://github.com/dimpurr/obsidian-nautilus-logger/releases/latest/download/main.js && \
  curl -LO https://github.com/dimpurr/obsidian-nautilus-logger/releases/latest/download/manifest.json && \
  curl -LO https://github.com/dimpurr/obsidian-nautilus-logger/releases/latest/download/styles.css
```

然后重新加载 Obsidian 并启用插件。

### 快速上手

启用后，在命令面板运行 **创建测试笔记**。它会写出一份小小的示例笔记，让你在确定格式之前先看看螺旋长什么样。更快的办法是，把下面这段粘进今天的日记（Daily Note）：

````markdown
```naut
start: 8
```
- 09:00-10:00 站会
- [ ] 写报告 90m
- [ ] 回邮件 30m
````

### 更新插件

- **BRAT**：自动。
- **手动 / 单行命令**：重新下载那三个文件，然后执行 **重新加载应用而不保存**。

## 它能给你什么

- 容量数字都摆得明明白白：已计划的待办、可安排的时间、被固定事件占掉的时间、还剩的余量，以及今天放不下的工作。
- 事件保持你给它的时间。未完成的任务按你写的顺序填进空档。
- 一天可以从任意整点开始；计划真要到后半夜，就跨过午夜继续画。
- 计划对实际，就在你本来就在写的那篇笔记里。

排程是确定性的：事件先占走自己的时间段，然后完整任务从当前时刻起填进合适的空档。塞不下的任务会出现在**今日放不下**里，而不是被悄悄丢弃。

## 计划格式

Roam 原版让组件读取子块。Obsidian 的代码块没有子块、只有兄弟行，所以本移植把计划**作为普通 Markdown 放在代码块下方**。块本身放当天的配置覆盖：

````markdown
```nautilus
end: 02:00
```
05:00-06:00 晨间例程
- [ ] 写项目简报 45m
- [ ] 复习笔记 30m
11:45-12:30 午餐
- [ ] 回邮件
````

围栏块里放**当天的配置覆盖**（留空就完全用全局设置）；计划本身在块**下方**，是普通 Markdown，所以依然可以编辑、可以拖拽换序，Tasks 和 Dataview 也看得到。计划止于第一个空行。```` ```nautilus ```` 和更短的 ```` ```naut ```` 都认。

- **时间区间把这一行钉在时钟上**：`12:30-14:00`、`9 to 10:45`。带不带复选框都行，所以 `- [ ] 09:00-10:00 站会` 是仍可勾掉的固定事件。
- **单个开始时刻也能钉住它。** `- [ ] 09:00 写简报 30m` 变成 09:00–09:30。不写时长就用配置的默认值。裸数字*不会*被当成时间（`读第 9 章` 仍是弹性任务）；表示时钟时刻要写 `9:00` 或 `9am`。
- **没勾选、也没有时钟时刻的任务是弹性的。** 它流进剩下的时间。
- **行序就是优先级。** 调换行的顺序，日程就跟着变。
- 时长支持 `30m`、`30min`、`1h` 和 `1h30m`。
- **紧急任务画成红色。** 在设置里设一个**紧急触发词**（留空即关闭）；弹性任务的标题以空白分隔后命中该词，就画成红色而非蓝色。固定事件保持自己的颜色。

### 已完成事项

已完成的任务要能画出来，得有**完成时刻**。引擎不会编造没人告诉它的历史。把它写成 `d` 前缀的锚点：

```markdown
- [x] 学术阅读 40m d11:20
```

这会被画成 10:40–11:20 的一段暗色切片。没有锚点，任务仍算完成（不再消耗容量），但没法放到图上。

与其手敲锚点，不如用 **勾选任务并记录完成时间** 命令：它勾上当前行并追加当前时间。它**默认没有快捷键**。想要的话在 设置 → 快捷键 里绑一个。

### 书写风格

事件也最好写成列表项，好和任务对齐：

```markdown
- 08:30-09:30 晨间例程
- [ ] 写简报 45m
```

裸行（`08:30-09:30 晨间例程`）也能解析，但两种混在一起，渲染出来就不整齐了。

## 执行层

可选的**执行层**记录计划实际执行的情况。它**默认关闭**：设置页把四个子设置藏起来，直到你打开 **执行层 · 进阶**。

启用后，今天日记里的第一个 ```nautilus 块成为**主计划**，执行面板提供三个视图：

| 视图 | 用途 |
| --- | --- |
| Timing | 当前的 Timing Line 与最近闭合的任务 |
| Plan | 主计划中未完成的直接子任务 |
| Review | 今天 Planned 与 Actual 的对比 |

实际时间以 Org 风格的 CLOCK 行写进笔记，放在任务下方的 `LOGBOOK::` 抽屉里：

```markdown
- [ ] 写报告 45m
    - LOGBOOK::
        - CLOCK: [2026-08-24 Mon 10:00]--[2026-08-24 Mon 10:18] => 0:18
```

- **只有未完成的任务才能占用 Timing Line**，同一时刻只跑一个 CLOCK。切换任务会在同一瞬间合上上一个 CLOCK、打开下一个。
- 打开 **计时任务置顶到右侧边栏** 后，Clock In 还会把当前任务顶到右侧边栏。
- **Recent** 保留最近 45 分钟内闭合的工作（Recent 保留时间；`0` 关闭）。
- **番茄钟阈值**（45 分钟）到了只改变实时信号，不会停任何东西。没有任务 CLOCK 在跑时，可以从面板标题栏启动一个独立的正计时 POMO：它不写任何东西，也不碰 Actual、Planned、Review 或螺旋；一旦启动任务 CLOCK 它就会被清掉，因为 CLOCK 永远优先。
- **遗忘计时提醒**（120 分钟）会把一条跑这么久的 CLOCK 标出来。它只提醒，从不停止或删除 CLOCK。`0` 关闭。
- 实际时间从不会被 Planned 封顶。没有明确的完成锚点（`dHH:MM`）或实际结束时刻，Nautilus Logger 不会编造历史。

### 状态栏计时器

执行层打开后，Obsidian 状态栏里常驻一个计时 token。它显示正在计时任务的标题和已用时长（独立番茄钟则显示 `已用时长 · POMO`），超过番茄钟阈值和遗忘计时阈值后进入警告状态。

它也是**修饰键手势唯一挂载的地方**（上游把手势挂在它的顶部栏上；本移植没有顶部栏）：

| 点击 | 动作 |
|---|---|
| 普通点击 | 打开侧栏 |
| **⌥ / Alt + 点击** | 在主编辑区定位今天的主计划 |
| **⇧ / Shift + 点击** | 把主计划送进右侧栏 |

面板上的 **定位主 Nautilus** 按钮同样认 ⇧；在它上面，普通点击本来就表示「在主编辑区定位」，所以 ⌥ 与它同义。

## 查看其他日期

图表不一定画今天。如果笔记路径里含 `YYYY-MM-DD` 格式的日期（日记的常见命名），那一天就是图表的显示日；否则退回今天。

| 显示日 | 行为 |
|---|---|
| **今天** | 红针；任务从*此刻*起排布；容量只算剩下的时间 |
| **过去** | 没有红针；已流逝的斜纹铺满一整天；任务从当天起点排布；容量按**整天**算；「相对此刻」的交互（眼睛、回放）关闭 |
| **未来** | 没有红针，也**完全没有斜纹**，因为明天还没开始，什么都没流逝；其余同过去 |

三种情况的规则都来自上游引擎的 `timelineDayState`；本移植只告诉它*这篇笔记是哪一天*。

## 它会碰你 vault 里的什么

社区目录的自动审核标出了其中两条。都属实，所以这里把话说全。

**读。** 执行层开启时，插件会扫描 vault 里每一个 Markdown 文件找 `CLOCK:` 行，因为你计过时的任务可能在任何一篇笔记里。执行层关闭时，它只读当前显示的那篇。数据不会发到任何地方：这个插件里没有任何联网代码。

**写。** 写入只发生在当前显示的那篇日记的计划块内部，内容是 `LOGBOOK::` 下的 CLOCK 行、`dHH:MM` 完成锚点、`dNN%` 进度。每一次写入都先按行内容核对目标行，核对不唯一就拒绝写。

**存。** 设置存在插件自己的 `data.json` 里。图表是否折叠走 Obsidian 的 device-local 存储 API，按设备各记各的。

## 故障排查

执行层这条链有四个独立的故障点（注入路径 / 文件是否存在 / 同步缓存命中 / 围栏正则命中）。与其瞎猜，不如运行 **诊断执行层** 命令：它把这些环节各自的值合并成一条通知报给你。

## 与 Roam 原版的差异

| | Roam 原版 | 本移植 |
|---|---|---|
| 组件形式 | `{{[[roam/render]]:((uid))}}` | ` ```nautilus ` 代码块 |
| 计划来源 | 子块（child blocks） | 代码块下方的 Markdown（块内放当天的配置覆盖） |
| 任务标识 | `:block/uid` | `filepath:line` |
| 响应式更新 | `roam.datascript.reactive` | `metadataCache` 事件 |
| 渲染器 | ClojureScript / Reagent (SCI) | TypeScript / SVG |
| 面板挂载 | 抓取 DOM 的 Roam 顶栏 | Obsidian 右侧栏 ItemView（`nautilus-logger-view`） |
| iCal 订阅 | 上游第 3 代中废弃 | 暂无计划 |

调度与容量计算引擎完全沿用自 Roam 原版，**未作任何修改**。

## 致谢

**本移植的直接来源是 [404KSG/roam-nautilus-log](https://github.com/404KSG/roam-nautilus-log)**；见[项目来源](#项目来源)。下面这些都是*那个项目*承袭的谱系。把它们列在这里，是因为 MIT 许可证和这个想法都沿这条链传下来；但本移植没有直接取用它们的代码。

- **[roam-depot-render-template](https://github.com/8bitgentleman/roam-depot-render-template)**
  （作者：[Matt Vogel](https://github.com/8bitgentleman)）。整条谱系都从它的 Roam 扩展脚手架发端；它的版权行至今仍是本项目 MIT 许可证里的那一行。
- **[Nautilus](https://github.com/tombarys/roam-depot-nautilus)**
  （作者：[Tomáš Baránek](https://github.com/tombarys)）。螺旋日程规划的原始概念。螺旋不是装饰：向内收窄的盘圈，映照着一个人做创造性工作的精力在一整天里逐渐衰减。
- **[Nautilus Enhanced](https://github.com/hopeserena/nautilus-enhanced)**
  （作者：[hopeserena](https://github.com/hopeserena)）。修掉了计时器内存泄漏，加了双语设置、贝塞尔连接线和 CJK 排版修正。
- 🧭 **[Nautilus Log](https://github.com/404KSG/roam-nautilus-log)**
  （作者：[404KSG](https://github.com/404KSG)）。**本移植的来源。** 它把螺旋真正变成了规划器：容量模型（已计划 / 可安排 / 超载 / 无合适空档）、带 `LOGBOOK::` / `CLOCK:` 追踪的可选执行层、计划与实际对照的复盘、跨午夜的图表窗口，还有一整套测试。它的引擎在这里原样运行。
- **[Roam Logbook](https://github.com/forrestchang/roam-logbook)**
  （作者：[forrestchang](https://github.com/forrestchang)）。上游做兼容 CLOCK 追踪时参考的项目。

时间分配的理念受 [YNAB Method](https://www.ynab.com/the-four-rules/) 启发。Nautilus Logger 与 YNAB 无关联。

以原始 MIT 许可证发布，未作改动。
