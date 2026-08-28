# Nautilus Logger for Obsidian

[English](./README.md) · **简体中文**

> **让每一分钟都有所作为。**

[Obsidian](https://obsidian.md/) 上的可视化日程规划插件。Nautilus Logger 将一篇笔记转化为灵动的螺旋日程表：固定事件钉在时间上不动，弹性任务自然流进剩余时间，超载情况一目了然、绝不从视野中消失。


![Nautilus Logger — spiral day planner with explicit time capacity](https://raw.githubusercontent.com/dimpurr/obsidian-nautilus-logger/main/docs/assets/overview.png)

## 项目来源

本项目移植自一个特定项目：

> ### 🧭 [**Nautilus Log for Roam Research**](https://github.com/404KSG/roam-nautilus-log)（作者：[404KSG](https://github.com/404KSG)）
>
> 不是「灵感来自」——而是**完整移植**。它的调度与容量计算引擎
> （`log-core.js`、`timing-core.js`、`timing-runtime.js`、`timing-topbar.js`）
> 在本仓库的 [`src/vendor/`](src/vendor/) 目录下**逐字节未作任何修改**。你在这里看到的每一次排程决策、每一个容量数值、每一种 CLOCK 格式，全部源自那里的设计。
>
> 本项目所做的是构建一个 Obsidian **适配器**：相同的核心引擎，由 Markdown 文件驱动，而非 Roam 的图数据库。

该项目本身承袭自更早的工作，这些前作在[致谢](#致谢)中单独列出——但它们是**上游的先祖**，而非本移植的直接源头。

> ⚠️ **状态：暂未上架 Obsidian 官方社区插件市场。**
> 参见[安装指南](#安装指南)了解当前的安装方法。

> **想要贡献或重新移植？** 请先阅读 [`docs/PORTING-DECISIONS.md`](docs/PORTING-DECISIONS.md) ——
> 它是本移植所有有意偏离上游之处的唯一真理来源，其编写目的即在于：仅凭*上游代码 + 该文档*就足以从零完整重现本移植。

## 安装指南

> 暂未上架官方社区插件市场。目前提供三种安装方式——
> **如果需要自动接收更新，推荐使用 BRAT。**

### 方式 1 — BRAT（推荐，自动更新）

1. 从 Obsidian 社区插件市场安装 [**BRAT**](https://github.com/TfTHacker/obsidian42-brat)。
2. 进入 BRAT 设置 → **Add Beta plugin** → 粘贴：
   ```
   dimpurr/obsidian-nautilus-logger
   ```
3. 在「已安装插件」中启用 **Nautilus Logger**。

BRAT 会自动追踪本仓库的 GitHub Releases 并为你更新插件。

### 方式 2 — 手动安装

1. 从 [最新 Release](https://github.com/dimpurr/obsidian-nautilus-logger/releases/latest) 下载 `main.js`、`manifest.json` 与 `styles.css`。
2. 创建文件夹 `<你的库目录>/.obsidian/plugins/nautilus-logger/`。
3. 将上述三个文件放进该目录。
4. 重启 Obsidian（或执行 **重新加载且不保存** 命令），然后在社区插件中启用插件。

### 方式 3 — 单行命令（macOS / Linux）

在**你的笔记库根目录**下运行：

```bash
mkdir -p .obsidian/plugins/nautilus-logger && cd .obsidian/plugins/nautilus-logger && \
  curl -LO https://github.com/dimpurr/obsidian-nautilus-logger/releases/latest/download/main.js && \
  curl -LO https://github.com/dimpurr/obsidian-nautilus-logger/releases/latest/download/manifest.json && \
  curl -LO https://github.com/dimpurr/obsidian-nautilus-logger/releases/latest/download/styles.css
```

随后重新加载 Obsidian 并启用插件。

### 快速上手

启用插件后，在命令面板中运行 **"Create Nautilus Logger test note"**（或中文界面的 **"创建测试笔记"**）命令——它会生成一份示例笔记，方便你立刻体验螺旋盘。或者直接在今天的日记（Daily Note）中添加以下内容：

````markdown
```naut
start: 8:30
```
- 09:00-10:00 晨会
- [ ] 撰写报告 90m
- [ ] 回复邮件 30m
````

### 更新插件

- **BRAT**：自动更新。
- **手动 / 单行命令**：重新下载上述三个文件覆盖，然后执行 **重新加载且不保存**。

## 核心特性

- **计划贴合时间**：直观查看已计划需求（Planned）、可安排时间（Available）、固定事件（Events）、剩余容量（Remaining），以及今天排不下的工作。
- **透明灵活的调度，告别黑盒**：固定事件钉在预定时刻；未完成的任务按书写顺序依次流向空档。
- **完全贴合你的作息**：支持从任意整点开始一天；当计划属于晚睡或通宵作息时，可自然跨越午夜延续到次日。
- **实用的每日复盘**：无需离开日常笔记，即可直接对比预计时长（Planned）与实际耗时（Actual）。

排程算法是确定性的：固定事件优先锁定对应的时间段，随后完整的任务从当前时刻起填入适合的空档。放不下的任务会出现在**今日放不下**（Today won't fit）面板中，绝不会被静默忽略。

## 计划格式

不同于 Roam 原版由组件读取其子块的做法，本移植将计划**作为普通 Markdown 保留在代码块下方**，因为 Obsidian 的代码块与正文是同级兄弟关系。代码块本身用于存放当天的配置覆盖：

````markdown
```nautilus
end: 02:00
```
05:00-06:00 晨间例程
- [ ] 撰写项目简报 45m
- [ ] 复习笔记 30m
11:45-12:30 午餐
- [ ] 回复邮件
````

围栏代码块内部存放**当天的配置覆盖**（留空则完全沿用全局设置）；计划正文本身位于代码块**下方**，作为普通 Markdown 文本存在，因此支持自由编辑、拖拽换序，并且能被 Tasks 和 Dataview 插件正常索引。计划内容**止于第一个空白行**。代码块标识支持 ```` ```nautilus ```` 以及简短别名 ```` ```naut ````。

- **时间范围将该行固定在特定时间段** — 如 `12:30-14:00`、`9 to 10:45`。无论是否带有复选框均有效，因此 `- [ ] 09:00-10:00 晨会` 是一个依然可以勾选完成的固定事件。
- **单个开始时刻同样会固定该行** — 如 `- [ ] 09:00 撰写简报 30m` 会排在 09:00–09:30。如果未标注时长，则使用设置中的默认待办时长。单独的裸数字*不会*被识别为时刻（如 `阅读第 9 章` 仍然是弹性任务）；需写为 `9:00` 或 `9am` 来表示具体时刻。
- **未勾选且没有具体时刻的任务为弹性任务** — 它会自然流向当前剩余的可用空档。
- **行序即优先级**。调整行的上下顺序，排程表会即时同步调整。
- 时长支持 `30m`、`30min`、`1h` 与 `1h30m` 等格式。
- **紧急任务显示为红色**。在设置中配置**紧急触发词**（Urgent trigger，留空则关闭）；若弹性任务标题中包含该独立关键词（以空格分隔），则会绘制为红色而非蓝色。固定事件保持自身的事件颜色不变。

### 已完成事项

已完成的任务需要明确的**完成时刻**才能被绘制在盘面上——排程引擎拒绝凭空捏造未告知的历史记录。将其写为带有 `d` 前缀的时间锚点：

```markdown
- [x] 学术阅读 40m d11:20
```

该任务会渲染为 10:40–11:20 的暗色历史切片。如果不写时间锚点，任务依然算作已完成（不再占用今日容量），但无法在螺旋盘上绘制具体切片。

无需手动输入时间锚点，你可以使用命令 **勾选任务并记录完成时间**（Complete task with timestamp），它会自动勾选当前行并追加当前时间戳。该命令**默认未绑定快捷键**——如有需要，可在「设置 → 快捷键」中自行绑定。

### 书写风格

固定事件也推荐写成列表项形式，以便与任务在视觉上保持对齐：

```markdown
- 08:30-09:30 晨间例程
- [ ] 撰写简报 45m
```

不带列表标记的纯文本行（`08:30-09:30 晨间例程`）虽然也能被正常解析，但与列表项混用时在阅读模式下缩进可能不够整齐。

## 执行层

可选的**执行层**用于记录计划的实际执行情况。该功能**默认关闭**：在设置面板中开启**实际时间追踪**（Actual time tracking）之前，相关的 4 项子设置会保持隐藏。

开启后，今天日记中的第一个 ```nautilus 代码块即成为**主计划**（Primary Plan），执行面板提供三个视图：

| 视图 | 用途 |
| --- | --- |
| Timing | 当前正在计时的 Timing Line 与最近完成/切换的任务 |
| Plan | 主计划中未完成的直接子任务 |
| Review | 今天的计划预计耗时（Planned）与实际耗时（Actual）对比 |

实际耗时会以 Org 风格的 CLOCK 记录形式写回任务下方的 `LOGBOOK::` 抽屉中：

```markdown
- [ ] 撰写报告 45m
    - LOGBOOK::
        - CLOCK: [2026-08-24 Mon 10:00]--[2026-08-24 Mon 10:18] => 0:18
```

- **只有未完成的任务才能占用 Timing Line**，且同一时刻只能运行一个 CLOCK 计时——切换任务会在同一瞬间闭合上一个任务的 CLOCK 并开启新任务的计时。
- 开启**计时任务置顶到右侧边栏**（Timing line in sidebar）后，开始计时（Clock In）还会将正在进行的任务展示在右侧边栏顶部。
- **Recent** 保留最近 45 分钟内结束计时的任务（可在设置中配置 Recent 保留时间；设为 `0` 则关闭）。
- **番茄钟阈值**（Pomodoro threshold，默认 45 分钟）达到后仅改变计时状态的视觉指示——**绝不会自动中断工作**。在没有任务 CLOCK 运行时，执行面板顶部可开启独立的正计时 POMO：它不向笔记写入任何内容，也不影响 Actual、Planned、Review 或螺旋盘；一旦开启具体任务的 CLOCK 计时，独立番茄钟会自动清除（CLOCK 始终拥有最高优先级）。
- **遗忘计时提醒**（Forgotten timer warning，默认 120 分钟）会在单条 CLOCK 连续运行达到该时长时发出警告。它仅作提示，绝不会自动停止或删除计时记录；设为 `0` 则关闭。
- 实际时间（Actual）不会被截断在计划时长（Planned）之内。若没有明确的完成时间锚点（`dHH:MM`）或实际结束时刻，Nautilus Logger 绝不凭空捏造历史。

### 状态栏计时器

启用执行层后，Obsidian 底部状态栏会常驻一个计时指示器。它会显示当前正在计时的任务标题及已用时长（独立番茄钟则显示为 `已用时长 · POMO`），并在超出番茄钟或遗忘计时阈值后变为警告状态。

它同时也是**修饰键手势唯一挂载的地方**（上游原版将手势挂在顶部导航栏，本移植没有顶部栏）：

| 点击方式 | 操作 |
|---|---|
| 普通点击 | 打开右侧栏 |
| **⌥ / Alt + 点击** | 在主编辑区定位今天的主计划 |
| **⇧ / Shift + 点击** | 将主计划定位并展示在右侧栏 |

执行面板顶部的 **定位主 Nautilus**（Locate Primary Nautilus）按钮同样支持 ⇧ 修饰键（送至右侧栏）；在该按钮上，普通点击本身即代表「在主编辑区定位」，因此 ⌥ 为其同义操作。

## 查看其他日期

螺旋图表展示的不一定必须是今天。如果笔记的文件路径中包含 `YYYY-MM-DD` 格式的日期（日记的常见命名方式），该日期就会成为图表的「显示日」；若无法识别日期则退回为今天。

| 显示日 | 行为 |
|---|---|
| **今天** | 显示指示当前时刻的红针；任务从**此刻**起向后排程；容量指标计算今天*剩余*的时间 |
| **过去** | **不显示红针**；已流逝的斜纹阴影铺满整天；任务从**当天起点**开始排程；容量指标按**全天**计算；关闭「相对当前时刻」的交互功能（眼睛、回放） |
| **未来** | 不显示红针且**完全不绘制斜纹阴影**——明天尚未开始，因此不存在「已流逝」的时间；其余表现与过去一致 |

这三种情况的处理规则完全源自上游引擎的 `timelineDayState`；本移植仅负责向引擎告知*该笔记对应哪一天*。

## 故障排查

执行层调用链包含四个独立的可能故障点（注入路径 / 文件存在性 / 同步缓存命中 / 围栏正则匹配）。遇到问题时无需盲目猜测，可直接在命令面板中运行 **诊断执行层**（Diagnose execution layer）命令：它会以单条通知弹窗的形式报告链路中各个环节的诊断结果。

## 与 Roam 原版的差异

| | Roam 原版 | 本移植 |
|---|---|---|
| 组件形式 | `{{[[roam/render]]:((uid))}}` | ` ```nautilus ` 代码块 |
| 计划来源 | 子块（child blocks） | 代码块下方的 Markdown（块内放每日配置覆盖） |
| 任务标识 | `:block/uid` | `filepath:line` |
| 响应式更新 | `roam.datascript.reactive` | `metadataCache` 事件 |
| 渲染器 | ClojureScript / Reagent (SCI) | TypeScript / SVG |
| 面板挂载 | 抓取 DOM 的 Roam 顶栏 | Obsidian 右侧栏 ItemView（`nautilus-logger-view`） |
| iCal 日历订阅 | 上游在第 3 代中废弃 | 暂无计划 |

调度与容量计算引擎完全沿用自 Roam 原版，**未作任何修改**。

## 致谢

**本移植的直接源头是 [404KSG/roam-nautilus-log](https://github.com/404KSG/roam-nautilus-log)**
——详见[项目来源](#项目来源)。以下列出的是*该上游项目*承袭的发展脉络。将它们列于此处是因为 MIT 许可证与核心设计理念均沿此脉络传承，但本移植并未直接取用它们的代码。

- **[roam-depot-render-template](https://github.com/8bitgentleman/roam-depot-render-template)**
  （作者：[Matt Vogel](https://github.com/8bitgentleman)）——整个系列所沿用的 Roam 插件脚手架，亦是本项目所保留的 MIT 许可证中署名的版权所有者。
- **[Nautilus](https://github.com/tombarys/roam-depot-nautilus)**
  （作者：[Tomáš Baránek](https://github.com/tombarys)）——螺旋日程规划的原始概念。螺旋盘绝非单纯的视觉装饰：其向内收窄的盘圈如实映照出人在一天之中创造性能量的逐渐递减。
- **[Nautilus Enhanced](https://github.com/hopeserena/nautilus-enhanced)**
  （作者：[hopeserena](https://github.com/hopeserena)）——消除了定时器内存泄漏，加入了双语设置面板、贝塞尔曲线连接线以及中日韩字符排版优化。
- 🧭 **[Nautilus Log](https://github.com/404KSG/roam-nautilus-log)**
  （作者：[404KSG](https://github.com/404KSG)）——**本项目的直接移植来源。**
  它将螺旋盘真正转变为强大的日程规划器：引入了容量模型（已计划 Planned / 可安排 Available / 超载 Overload / 无合适空档 No fitting slot）、带有 `LOGBOOK::` / `CLOCK:` 追踪的可选执行层、预计与实际耗时复盘对比、跨午夜图表窗口以及完整的自动化测试套件。其核心引擎在本项目中原封不动运行。
- **[Roam Logbook](https://github.com/forrestchang/roam-logbook)**
  （作者：[forrestchang](https://github.com/forrestchang)）——上游设计兼容性 CLOCK 计时追踪时汲取灵感的来源。

时间分配理念受到 [YNAB Method](https://www.ynab.com/the-four-rules/) 的启发。Nautilus Logger 与 YNAB 无关联。

以原始 MIT 许可证发布，未作改动。
