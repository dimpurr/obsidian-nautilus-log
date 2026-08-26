# 现实怪癖登记表

> **这是一个棘轮,不是雷达。** 它**发现不了**新怪癖 —— 它保证**已发现的永远丢不掉**。
>
> 每一条都是一次「测试全绿、真机是坏的」的事故。每一条都必须有一个**钉住它的测试**;
> `scripts/audit-detectors.mjs` 的第 6 号检测器会机械校验这个链接,断了就红。
>
> 🔴 **新踩到一次就加一条,不许只在 commit message 里提一句。** 加条目时同步补钉子测试。

## 为什么不做「夹具 API 面 vs 真实 API 面」的 diff

拿它对账过下面 6 起真实事故:**只抓得到 1 起边缘的 + 1 起本来就会大声抛异常的。**

原因是这类 bug 的形态不是「方法不存在」,而是「**方法在、语义 / 时序 / 值形状不对**」——
API 面是语法概念,这些差异全在语义层。更糟的是它会给出「我们的 mock 与 API 一致」这个
绿灯,恰恰让真正危险的那几类继续溜过去。**假保障比没保障更危险。**

⇒ 共同形态一句话:**危险的从来不是「夹具少给了什么」(会炸),是「夹具多给了什么」(会静默)。**

---

## RQ-1 · 真实环境有 canvas,测试环境没有

- **现实**:Obsidian 跑在 Electron 里,`createElement('canvas').getContext('2d')` 拿得到,
  引擎的 `truncateTextToWidth` 按**像素**测量(`measureText().width`)。
- **测试环境**:Node / jsdom 拿不到,引擎退到 `fallbackTextWidth` 按**字符数**算。
- **踩过的坑**:`descLength` 的语义是「字符数」(上游 15–30),被直接当成 `maxWidth` 传进按像素
  测量的函数 → 真机上 `22` 被当成 22 **像素**,正文被截没,只剩 `· ... 30m`。
  **本地完全复现不出来**,因为没有 canvas 的环境恰好走了正确的那条路。
- **钉住它的测试**:`test/parser.test.js` → `有 canvas 的环境下也不许把正文截没`
- **代价**:该测试必须自己装一个假 canvas,不能依赖环境。

## RQ-2 · Daily Notes 配置常常只有 `folder`,没有 `format`

- **现实**:用户没改过日期格式时,Obsidian **不写** `format` 这个键。实测配置就是 `{"folder": "Daily/_Daily"}`。
- **夹具的诱惑**:随手写 `{format: 'YYYY-MM-DD', folder: '...'}` —— 两个键齐全,看着更「完整」。
- **踩过的坑**:定位代码要求 `opts.format` 存在,于是侧栏报「No Daily Notes plugin config found」,
  而用户明明配置好了。修法:**拿到 folder 或 format 之一就算配置有效**。
- **钉住它的测试**:`test/sidebar.test.js` → `daily-notes.json 只有 folder、没有 format`
- **待补**:`primeDailyNotesConfig` 的 `.obsidian/daily-notes.json` 直读兜底路径仍无直接覆盖
  (现有测试走的是 `internalPlugins` 那条),见 audit §5。

## RQ-3 · 用户几乎总开着今天的笔记

- **现实**:写回目标文件**正被编辑器打开**是常态,不是例外。此时必须走 `editor` API,
  走 `vault.process()` 会和编辑器状态打架。
- **夹具的诱惑**:`iterateAllLeaves(){}` 写成空实现 —— 于是**永远**走 `vault.process` 分支,
  editor 分支一行都没被测过。
- **踩过的坑**:editor 分支把新行写成 `内容\n` 追加在锚点**行尾**,产出
  `- [ ] 任务 20m    - LOGBOOK::` 这种脏行。正确是 `\n内容`。藏了很久。
- **钉住它的测试**:`test/timing-writeback.test.js` → `笔记开着编辑器时 Clock In`
- **代价**:editor 分支需要一份独立夹具(`makeVaultWithEditor`),它的 `process` 故意抛错,
  确保测试真的走了 editor 那条路。

## RQ-4 · 插件 onload 时 vault 索引还没建完

- **现实**:`app.vault.getMarkdownFiles()` 在 `onload` 时返回**空数组**。索引好了才有内容,
  信号是 `workspace.onLayoutReady`。
- **夹具的诱惑**:mock 的 `getMarkdownFiles()` 立即返回全部文件 —— 「反正数据都在」。
- **踩过的坑(两连)**:
  1. 同步内容缓存在 `onload` 预热 ⇒ 永远 0 条 ⇒ 执行层永远报「今天没有 Nautilus Log」。
  2. 上一条修好后:`initialize()` 仍在 `onload` 内发起,早于预热 ⇒ `initialEntries` 恒空 ⇒
     runtime 的两件**一次性**修复(`reconcileLegacyOverlap` / `closeDoneClocks`)空转,
     遗留的 running CLOCK 永远不会被自动关闭。**修复引入的新时序 bug。**
- **钉住它的测试**:`test/timing-writeback.test.js` → `RQ-4 预热必须等 onLayoutReady`
- **代价**:夹具要能模拟「索引未就绪」这个中间态(`makeLateIndexVault`),
  并且断言的是「**布局就绪前不许 resolve**」这个契约本身 ——
  ⚠️ 断言「之后读得到」是**不够**的:`cachedLines()` 的自愈逻辑会把 bug 掩盖掉。

## RQ-5 · CSSOM 静默丢弃自定义属性的属性式赋值

- **现实**:`el.style['--pb-delay'] = '1.5s'` 在真实 `CSSStyleDeclaration` 上**静默无效** ——
  不报错,读回来是空字符串。**只能** `style.setProperty('--pb-delay', v)`。
- **夹具的诱惑**:mock 的 `style` 是普通对象,任何赋值都「成功」。
- **踩过的坑**:回放动画的逐片延迟恒为 0,点播放按钮盘上不动,而测试永远绿。
- **钉住它的测试**:`test/spiral.test.js` → `P1-5② 每个切片带 --pb-delay`
- **代价**:夹具的 `style` 换成 **Proxy,`--` 前缀赋值静默丢弃** —— 让它**比现实更严格**。
  这是本表里唯一一条「主动把夹具做窄」的,也是最该推广的做法。

## RQ-6 · 真实 document 同时有 `createElementNS` 与 `createElement`

- **现实**:两个都有,且 `createElement('canvas').getContext` 一定存在(见 RQ-1)。
- **夹具的诱惑**:只给用得到的那个。spiral 的 shim 早期只有 `createElementNS`。
- **踩过的坑**:接紧凑列表(走 `createElement`)时整片 spiral 测试直接抛
  `document.createElement is not a function`。
- **钉住它的测试**:`test/spiral.test.js` → `RQ-6 documentShim 覆盖真实 document 的必需面`
- ⚠️ **这一类是良性的**:夹具比现实**窄**会大声炸,当场就发现,成本低。
  收录它只是为了对比 —— 真正的杀手是 RQ-2 / RQ-4 / RQ-5 那种「夹具比现实**宽**」。

## RQ-7 · 用户会改 Daily Notes 的日期格式

- **现实**:Daily Notes 插件的 `format` 是用户可配的(`DD-MM-YYYY`、带子目录 token…)。
  `moment().format(fmt)` **要看参数**。
- **夹具的诱惑**:为了让「今天」确定,把 mock 写成 `format: () => "2026-08-24"` ——
  **不看参数**。于是「把用户配置的格式整个丢掉」这种实现也能全绿。
- **踩过的坑**:变异实验实测 —— 把 `sidebar.ts` 的 `formatDate(opts.format || 'YYYY-MM-DD')`
  改成丢弃用户配置,318 个测试**一个都不红**。非默认格式的用户会看到
  「今天没有 Nautilus Log」,而笔记就在那儿。**与 RQ-2 是一对**:一个是格式键缺席、
  一个是格式键存在但被忽略。
- **钉住它的测试**:`test/sidebar.test.js` → `RQ-7 Daily Notes 配了非默认日期格式时`
- **代价**:mock 要按真实 `moment` 的语义实现最小 token 集(`YYYY`/`MM`/`DD`),
  而不是返回定值。

## RQ-8 · jsdom 的布局尺寸恒为 0

- **现实**:浏览器里 `getBoundingClientRect()` 与 `offsetWidth/Height` 有真实值,
  浮层定位要减去宿主偏移、要按视口翻面、要留安全边距。
- **测试环境**:jsdom **不做布局**,上述全部返回 0。
- **踩过的坑**:引擎的翻面与安全边距分支在 tooltip 这条路上**一次都没执行过**;
  宿主相对定位那两行删掉也不红(变异实测)。
  ⚠️ **形态比 RQ-1 更隐蔽**:分支进对了,只是喂进去的数据是退化值 ——
  「代码跑到了」不等于「行为被验证了」。
- **钉住它的测试**:`test/tooltip.test.js` → `RQ-8 定位必须减去宿主偏移`
- **代价**:断言要写成**相对**的(同一次 hover、两个只有原点不同的宿主,
  结果必须相同),而不是去断言引擎算出的具体数值 —— 后者会把测试和引擎的
  内部公式焊死。

---

## 加新条目的规矩

1. **只在真机(或用户)确认过的事故之后加**。推测出来的「现实可能会…」不入表 —— 表会烂掉。
2. 必须同时提供钉子测试,并**验证过「回退实现后它会挂」**。没验证过的钉子不算钉子。
3. 条目里要写清**夹具的诱惑**是什么 —— 下一个人会犯的正是同一个「看着更完整」的错。
4. 表**只许变长**。某条不再成立(比如 Obsidian 改了行为)时,不是删掉,而是标注
   「已失效 + 何时何据」—— 证伪本身值得留着,防后人再踩。
