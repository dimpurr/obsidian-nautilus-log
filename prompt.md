# 任务：分档处置遗留欠账 —— compact 路

你的工作目录是 `/Users/dimpurr/scratch/naut-tri/compact`（隔离 git worktree，分支 `t/compact`）。所有命令在那里跑。
项目：Obsidian 插件 obsidian-nautilus-log（从 Roam 插件移植）。
上游副本：`/Users/dimpurr/scratch/nautilus-upstream`（`src/component.cljs` 是它的 cljs 渲染壳）。

## 先读（都是绝对路径）
1. `/Users/dimpurr/scratch/naut-tri/RUBRIC.md` —— **四档判据，最重要**
2. `/Users/dimpurr/scratch/naut-recert/recert-*.md` —— 复审产物，STILL-OPEN 条目在里面
3. `docs/PORTING-DECISIONS.md` —— 移植决策台账（**已登记为有意偏离的不算欠账**）

## 你负责哪些条目
从 6 份复审产物里挑出**所有** STILL-OPEN 条目中，**修法落在你这些文件里**的：

`src/compact.ts` · `src/controls.ts` · `src/sidebar.ts` · `src/header.ts` · `styles.css` · 对应 test

典型条目：C2-022/034/076/097/112 · S1-004/018/032 · L2-134

⚠️ 别的 worker 在并行改其它文件。**越界必冲突。**
⚠️ 🔴 `src/vendor/` 一个字都不许改（与上游逐字节相同，改了就无法对账）。

## 你要做的
对挑出来的每一条：**先去 HEAD 核实是否真的还在**（复审产物有误报），再按 RUBRIC 分档，
① 和 ④ 直接修，② 和 ③ 只写结论不改代码。

## 硬性要求
- ① 的每条改动都要配回归测试，并且**实测「把修复回退掉，测试会变红」**
  （临时还原 → 跑测试 → 确认变红 → 恢复）。报告里逐条写明。没做这步的视为未完成。
- 跑 `UPSTREAM_DIR=/Users/dimpurr/scratch/nautilus-upstream npm test`，必须全绿（基线 425）。
  `npx tsc --noEmit -p tsconfig.json --skipLibCheck` 无新增错误。
- 「未找到」不等于「不存在」：否定断言写「未找到（已查：<实际查过的文件/正则>）」。
- **不要 commit、不要 push。**
- 报告写进 `/Users/dimpurr/scratch/naut-tri/report-compact.md`：一张表 `| 原ID | 档 | 处置 | 证据 file:line |`，
  外加 ② ③ 两档的**待登记条文草稿**（主会话会抄进台账）。
