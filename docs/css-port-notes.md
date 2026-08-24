# CSS 移植笔记 — Roam `upstream-extension.css` → Obsidian `styles.css`

基线：`src/vendor/upstream-extension.css`（上游 404KSG/roam-nautilus-log @ 7bf19a1d，1569 行 / 235 选择器）
产出：`styles.css`（230 选择器）。目标是把样式机械移植到 Obsidian，不做重设计、不加特性。

---

## 改了什么（选择器替换）

| 上游选择器 | 处数 | 改成 | 说明 |
|---|---|---|---|
| `.bp3-dark` | 11 | `.theme-dark` | Blueprint.js 深色类 → Obsidian 深色类 |
| `.roam-app.rm-dark-theme` | 3 | `.theme-dark` | 剥掉 `roam-app` 前缀 + `rm-dark-theme` → `theme-dark` |
| 合并后的重复选择器 | — | 去重 | 深色变量块 `.bp3-dark, .roam-app.rm-dark-theme` 去重为单个 `.theme-dark`；toggle 悬停块把 `.bp3-dark`×2 + `.roam-app.rm-dark-theme`×2 去重为 `.theme-dark`×2 |

替换后 `.theme-dark` 共 11 处选择器，正好等于上游 `.bp3-dark` 的 11 处，说明深色规则全数迁移、无遗漏。

## 删了什么（Roam 专有规则）

1. **Zoom / 面包屑隐藏块**（上游 75–80 行）：整块删除。它只在 Roam 的 zoom/breadcrumb 上下文里把图表藏起来（`.rm-zoom-path` / `.rm-breadcrumbs` / `[data-testid="breadcrumbs"]` / `.parent-path-wrapper` / `.rm-zoom` / `.rm-zoom-item-content.rm-zoom-collapsed-item` 前缀的 `.nautilus-log-container`）。Obsidian 没有这些上下文，规则无意义。**判断说明**：任务只点名了 `.rm-zoom`/`.rm-zoom-path`/`.rm-zoom-item-content`/`.rm-zoom-collapsed-item`/`.rm-breadcrumbs`/`.roam-app`，块里的 `[data-testid="breadcrumbs"]` 和 `.parent-path-wrapper` 未点名，但整块唯一的用途就是 Roam zoom/breadcrumb 隐藏，故整块删除（留着会在错误场景隐藏图表）。
2. **4 条 `.bp3-icon` 规则**（Blueprint 图标类）：
   - `.nautilus-log-timing__brand-icon > .bp3-icon`
   - `.nautilus-log-timing__identity .bp3-icon`
   - `.nautilus-log-timing__icon-button.is-complete .bp3-icon`
   - `.nautilus-log-timing__plan-label .bp3-icon`
   Obsidian 没有 `.bp3-icon` 元素，且零命中校验要求 `bp3-` 必须为 0，故整条规则删除（是死规则）。

删除 5 条规则 = 上游 235 − 5 = 230 选择器，恰好一致，证明除这 5 条必需删除外没有任何规则被误删。

## 颜色 → Obsidian CSS 变量

只改了 2 处「明显是文字色」的硬编码，且语义等价：
- `.nautilus-log-toggle-btn:hover` 的 `color: #333` → `var(--text-normal)`
- 深色块 `.theme-dark .nautilus-log-toggle-btn:hover` 的 `color: #fff` → `var(--text-normal)`

其余颜色一律保持原值，包括：
- 螺旋图语义色（**保持不动**）：黄=事件 `#fcc200`/`#c58a00`、蓝=任务 `#0899c8`/`#47b8df`、红=紧急 `#ea0f0f`、灰=已完成 `#77818c` 等。
- 顶层 `:root` / `.theme-dark` 的 `--nautilus-log-*` 自定义属性（本来就是主题变量体系，随 `.theme-dark` 自动切换）。

## 拿不准的地方（必须列出）

1. **`.dark` 次级深色选择器保留原样**（5 个块，如 `.dark .nautilus-log-timing__popover`）。任务只点名替换 `.bp3-dark` 与 `.rm-dark-theme`，未提 `.dark`；零命中校验也不含它。我按 1:1 保守保留。风险：若 Obsidian 主题类不是 `.dark`（标准是 `.theme-dark`，已覆盖主要逻辑），这些 `.dark` 分支实际不生效——但它们与 `.theme-dark` 分支内容重复，属无害死代码。
2. **hover-tooltip 固定深色表面保留**（`background: rgba(38,43,50,0.96)`、`color:#fff`、白边框）。这是两种主题下都故意固定的深色浮动气泡，非主题背景，改了反而可能破坏对比度，故不动。
3. **执行层 `--nl-exec-*` 令牌体系整体保留**（`.nautilus-log-timing__*` 的大量硬编码灰阶如 `#8a929f`/`#747d8a`/`#858e9b` 等）。它自带完整主题：默认值 + 独立的深色覆盖块（`--nl-exec-surface/text/muted` + 各深色子规则）。改任一灰阶都可能与该令牌体系/深色覆盖冲突。按「宁可不改」原则全部保持原值。
4. **`grep -c 'nautilus-log'` 计数：356 < 上游 368**。这不是丢规则，而是必需删除本身带走了 `nautilus-log` 类名出现次数，明细：
   - 6 处：删除的 zoom/面包屑块里 6 个 `.nautilus-log-container` 选择器；
   - 4 处：删除的 4 条 `.bp3-icon` 规则（选择器里各含 1 个 `nautilus-log` 类）；
   - 2 处：toggle 深色规则把 `.bp3-dark`×2 + `.roam-app.rm-dark-theme`×2 合并去重为 `.theme-dark`×2。
   三条必需操作合计 −12。除这些外无任何规则丢失（235−5=230 选择器可证）。若校验器严格按「≥368」判定会失败，此为本任务「删 Roam 规则」与「计数不降」两条要求之间的固有矛盾，按删除要求优先处理。

## 校验结果

- 括号配对：`OK selectors: 230`
- 零命中：`grep -E 'bp3-|rm-zoom|rm-breadcrumbs|roam-app' styles.css` → 0
- `.rm-` / `roam` / `bp3` 残留 → 0
- `.nautilus-log-*` 类名全部保留原名，未改名
