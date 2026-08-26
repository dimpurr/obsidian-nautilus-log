/*
 * block-render.test.js — ```nautilus 代码块的**渲染管线**真覆盖。
 *
 * 🔴 为什么有这份文件（认证审计 V1）：
 *    `NautilusLogView`（代码块渲染的全部）此前**零覆盖** —— 变异实测把
 *    `locateInText` 改成 `return null`（代码块永远渲染不出任何东西），
 *    320 条测试**一条都不红**。而 `test/locate.test.js` 是「在测试里重写一遍
 *    main.ts 的算法、然后测那份重写」的假覆盖（文件头自承「复刻」），
 *    实现漂移了它照样绿 —— 已删除，其两条有价值的断言（同源块序号消歧、
 *    naut 短别名）在本文件里改成打在**真实现**上。
 *
 * 这里 bundle 的是 `src/main.ts` 本体（做法同 test/timing-commands.test.js）。
 *
 * 覆盖：
 *   · 三级定位：getSectionInfo → fileCache → 读文件兜底，三条都真的能出图
 *   · 三条全失败 → 空态 + `✗ both getSectionInfo() and file fallback failed`
 *   · 同源空块的序号消歧（原 locate.test.js 的核心断言，改打真实现）
 *   · 空态 / 配置警告态 / 诊断串
 *   · 折叠态不画图、语言开关贯穿到块内文案
 *   · 🔴 L1-063 回放帧必须喂进 timelineDayState（不是真实时钟）
 */

"use strict";

const assert = require("node:assert/strict");
const { test, before, beforeEach, after } = require("node:test");
const path = require("node:path");
const esbuild = require("esbuild");
const { JSDOM } = require("jsdom");

const ROOT = path.join(__dirname, "..");
const MOCK_OBSIDIAN = path.join(__dirname, "obsidian-mock.cjs");

let M;      // src/main.ts
let dom;
const RealDate = Date;

/* ── 被测对象：main.ts 本体 ───────────────────────────────────────────── */

before(async () => {
  const result = await esbuild.build({
    entryPoints: [path.join(ROOT, "src", "main.ts")],
    bundle: true, format: "cjs", platform: "node", write: false,
    external: ["obsidian"], loader: { ".md": "text" }, logLevel: "error",
    plugins: [{
      name: "timing-roam-to-obsidian",
      setup(build) {
        build.onResolve({ filter: /(^|\/)timing-roam$/ }, () => ({
          path: path.join(ROOT, "src", "timing-obsidian.ts"),
        }));
      },
    }],
  });
  const shim = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function("module", "exports", "require", result.outputFiles[0].text)(
    shim, shim.exports, (id) => (id === "obsidian" ? require(MOCK_OBSIDIAN) : require(id)),
  );
  M = shim.exports;
});

after(() => { globalThis.Date = RealDate; });

/* ── jsdom + Obsidian 的 DOM 扩展 ─────────────────────────────────────── */

/** 🔴 时钟必须钉死：dayState 的三个起点全是 now 的函数，不钉死的话
 *  「回放帧 vs 真实时钟」这条断言会随挂钟漂移（也就永远抓不住 L1-063）。 */
const FIXED_NOW = new RealDate(2026, 7, 24, 16, 40, 0);   // 2026-08-24 16:40
const TODAY_PATH = "Journal/2026-08-24.md";

function freezeClock() {
  class FixedDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(FIXED_NOW.getTime());
      else super(...args);
    }
    static now() { return FIXED_NOW.getTime(); }
  }
  globalThis.Date = FixedDate;
}

function makeDom() {
  dom = new JSDOM("<!DOCTYPE html><body></body>", { url: "http://localhost/" });
  const H = dom.window.HTMLElement.prototype;
  H.addClass = function addClass(cls) { this.classList.add(cls); };
  H.removeClass = function removeClass(cls) { this.classList.remove(cls); };
  H.toggleClass = function toggleClass(cls, on) { this.classList.toggle(cls, !!on); };
  H.empty = function empty() { while (this.firstChild) this.removeChild(this.firstChild); };
  H.createDiv = function createDiv(opts = {}) { return this.createEl("div", opts); };
  H.createSpan = function createSpan(opts = {}) { return this.createEl("span", opts); };
  H.createEl = function createEl(tag, opts = {}) {
    const e = dom.window.document.createElement(tag);
    if (opts.cls) e.className = Array.isArray(opts.cls) ? opts.cls.join(" ") : opts.cls;
    if (opts.text) e.textContent = opts.text;
    if (opts.attr) for (const [k, v] of Object.entries(opts.attr)) e.setAttribute(k, String(v));
    this.appendChild(e);
    return e;
  };
  H.setText = function setText(t) { this.textContent = t; };
  H.detach = function detach() { this.remove(); };
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.requestAnimationFrame = (cb) => dom.window.setTimeout(cb, 0);
  freezeClock();
  return dom;
}

beforeEach(() => { makeDom(); });

/* ── 夹具 ─────────────────────────────────────────────────────────────── */

const PLAN_NOTE = [
  "# 2026-08-24",
  "",
  "```nautilus",
  "end: 21",
  "```",
  "08:00-09:00 晨会",
  "- [ ] 写项目简报 45m",
  "- [ ] 复习笔记 30m",
  "",
  "别的段落",
].join("\n");

/** 上面那篇笔记里 ``` 收尾行的 0-based 行号（getSectionInfo 的 lineEnd 语义）。 */
const PLAN_LINE_END = 4;

function makePlugin({ language = "en" } = {}) {
  return {
    settings: {
      language,
      workdayStartHour: 5,
      workdayEndHour: 21,
      descLength: 22,
      todoDuration: 15,
      urgentTrigger: "",
      actualTimeTracking: false,
      timingLineSidebar: true,
      pomodoroMinutes: 45,
      recentRetentionMinutes: 45,
      forgottenTimerMinutes: 120,
    },
    fileCache: new Map(),
    primed: [],
    primeText: null,
    async primeCache(p) {
      this.primed.push(p);
      if (this.primeText === null) return null;
      this.fileCache.set(p, this.primeText);
      return this.primeText;
    },
    timingRuntime: null,
    app: { metadataCache: { on() {}, off() {} }, workspace: { getLeavesOfType: () => [] } },
  };
}

function makeView(plugin, {
  source = "end: 21",
  sectionInfo = null,
  sourcePath = TODAY_PATH,
} = {}) {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const ctx = { sourcePath, getSectionInfo: () => sectionInfo, addChild() {} };
  const view = new M.NautilusLogView(el, plugin, sourcePath, source, ctx);
  return { el, view };
}

const diagOf = (el) => (el.querySelector(".nautilus-log-diag")?.textContent || "");

/* ── 三级定位 ─────────────────────────────────────────────────────────── */

test("① getSectionInfo 命中 → 计划正文真的被画出来（via section）", async () => {
  const plugin = makePlugin();
  const { el, view } = makeView(plugin, {
    sectionInfo: { text: PLAN_NOTE, lineEnd: PLAN_LINE_END },
  });
  await view.render();
  assert.ok(el.querySelector(".nautilus-log"), "没有渲染根节点");
  assert.equal(el.querySelector(".nautilus-log-empty"), null, "不该落空态");
  assert.ok(el.querySelector(".nautilus-log-chart svg"), "没有画出螺旋图");
  assert.match(el.textContent, /晨会|写项目简报|45|Overload|容量|Capacity|Available/i);
  assert.equal(plugin.primed.length, 0, "命中就不该再去读文件");
});

test("② getSectionInfo 为 null、缓存热 → 走 locateInText 兜底（via cache）", async () => {
  const plugin = makePlugin();
  plugin.fileCache.set(TODAY_PATH, PLAN_NOTE);
  const { el, view } = makeView(plugin);
  await view.render();
  assert.equal(el.querySelector(".nautilus-log-empty"), null,
    "🔴 缓存这条路必须真的定位到块 —— locateInText 返回 null 就会落到这里");
  assert.ok(el.querySelector(".nautilus-log-chart svg"));
  assert.equal(plugin.primed.length, 0, "缓存命中就不该再异步读文件（PDF 导出靠这条同步路径）");
});

test("③ getSectionInfo 为 null、缓存冷 → 异步读文件兜底（via file）", async () => {
  const plugin = makePlugin();
  plugin.primeText = PLAN_NOTE;
  const { el, view } = makeView(plugin);
  await view.render();
  assert.deepEqual(plugin.primed, [TODAY_PATH]);
  assert.equal(el.querySelector(".nautilus-log-empty"), null);
  assert.ok(el.querySelector(".nautilus-log-chart svg"));
});

test("🔴 三条路全断 → 空态 + 明说是定位失败，绝不渲染一张空盘让人猜", async () => {
  const plugin = makePlugin();
  plugin.primeText = "# 一篇没有 nautilus 块的笔记\n";
  const { el, view } = makeView(plugin);
  await view.render();
  assert.ok(el.querySelector(".nautilus-log-empty"), "该落空态");
  assert.match(diagOf(el), /both getSectionInfo\(\) and file fallback failed/);
  assert.equal(el.querySelector(".nautilus-log-chart"), null);
});

test("诊断串写明走的是哪一级、块结束在哪一行、计划有几行", async () => {
  const plugin = makePlugin();
  plugin.fileCache.set(TODAY_PATH, "```nautilus\n```\n");   // 有块但无计划 → 空态带 diag
  const { el, view } = makeView(plugin, { source: "" });
  await view.render();
  assert.match(diagOf(el), /via cache ✓ blockEnd 1 of \d+ lines · plan 0 lines from \d+/);
});

/* ── 同源块的序号消歧（原 locate.test.js 的核心断言，改打真实现）─────────── */

const MULTI = [
  "```nautilus",           // 0   空块 #0
  "```",                   // 1
  "- [ ] 任务A 30m",           // 2
  "",                      // 3
  "```nautilus",           // 4   带内容
  "end: 23",               // 5
  "```",                   // 6
  "- [ ] 任务B 30m",           // 7
  "",                      // 8
  "```nautilus",           // 9   空块 #1
  "```",                   // 10
  "- [ ] 任务C 30m",           // 11
  "",                      // 12
  "```naut",               // 13  空块 #2（短别名）
  "```",                   // 14
  "- [ ] 任务D 30m",           // 15
].join("\n");

test("🔴 多个同源空块：第 N 个空块必须定位到第 N 个空块（曾经按【全部块】序号取错）", async () => {
  const plugin = makePlugin();
  plugin.fileCache.set(TODAY_PATH, MULTI);
  const picked = [];
  for (let i = 0; i < 3; i += 1) {
    const { el, view } = makeView(plugin, { source: "" });
    // eslint-disable-next-line no-await-in-loop
    await view.render();
    // 取错块 = 取到别人的计划正文。三个空块后面分别跟着 A / C / D。
    picked.push(["A", "B", "C", "D"].filter((t) => el.textContent.includes(`任务${t}`)).join(""));
  }
  assert.deepEqual(picked, ["A", "C", "D"],
    "🔴 序号必须在【同源块】索引空间里数；在【全部块】里数会串到别的块的计划");
});

test("带内容的块唯一匹配，与出现次序无关", async () => {
  const plugin = makePlugin();
  plugin.fileCache.set(TODAY_PATH, MULTI);
  for (let i = 0; i < 3; i += 1) {
    const { el, view } = makeView(plugin, { source: "end: 23" });
    // eslint-disable-next-line no-await-in-loop
    await view.render();
    assert.ok(el.textContent.includes("任务B"), `第 ${i} 次取到的不是那个带内容的块`);
  }
});

test("naut 短别名的围栏也被兜底定位认得（别名注册与围栏正则同源）", async () => {
  const plugin = makePlugin();
  plugin.fileCache.set(TODAY_PATH, "```naut\nend: 23\n```\n- [ ] 任务X 1h\n");
  const { el, view } = makeView(plugin, { source: "end: 23" });
  await view.render();
  assert.equal(el.querySelector(".nautilus-log-empty"), null,
    "naut 围栏没被认出来 => 兜底定位失败 => 空态");
  assert.ok(el.textContent.includes("任务X"));
});

test("多篇笔记同时打开时互不干扰（消歧键带 sourcePath）", async () => {
  const plugin = makePlugin();
  plugin.fileCache.set(TODAY_PATH, MULTI);
  plugin.fileCache.set("Journal/2026-08-23.md", MULTI);
  const a = makeView(plugin, { source: "" });
  await a.view.render();
  const b = makeView(plugin, { source: "", sourcePath: "Journal/2026-08-23.md" });
  await b.view.render();
  // b 是【另一篇】笔记里的第 0 个空块，不能因为 a 已经渲染过就被顺延成第 1 个。
  assert.ok(a.el.textContent.includes("任务A"));
  assert.ok(b.el.textContent.includes("任务A"),
    "另一篇笔记的第 0 个空块被顺延了 => 消歧键没带 sourcePath");
});

/* ── 空态 / 警告态 / 折叠 / 语言 ───────────────────────────────────────── */

test("块定位到了但一条计划都没有 → 可照抄的空态样例", async () => {
  const plugin = makePlugin();
  const { el, view } = makeView(plugin, {
    sectionInfo: { text: "```nautilus\n```\n", lineEnd: 1 },
  });
  await view.render();
  const empty = el.querySelector(".nautilus-log-empty");
  assert.ok(empty);
  assert.ok(empty.querySelector("pre").textContent.includes("05:00-06:00"));
});

test("无法识别的配置键 → 警告条，且不静默吞掉键名", async () => {
  const plugin = makePlugin();
  const { el, view } = makeView(plugin, {
    source: "strat: 6\nend: 21",
    sectionInfo: { text: PLAN_NOTE, lineEnd: PLAN_LINE_END },
  });
  await view.render();
  const warn = el.querySelector(".nautilus-log-config-warning");
  assert.ok(warn, "无法识别的键必须报出来");
  assert.match(warn.textContent, /strat: 6/);
});

test("🔴 L1-039/040 块内 default-duration/legend-length 越界 → 上报警告且回落全局设置", async () => {
  const plugin = makePlugin();
  const { el, view } = makeView(plugin, {
    source: "default-duration: 99999\nlegend-length: 99999",
    sectionInfo: { text: PLAN_NOTE, lineEnd: PLAN_LINE_END },
  });
  await view.render();
  const warn = el.querySelector(".nautilus-log-config-warning");
  assert.ok(warn, "越界数值键必须计入 unknown 上报（不能静默吞掉）");
  assert.match(warn.textContent, /default-duration: 99999/);
  assert.match(warn.textContent, /legend-length: 99999/);
  assert.ok(el.querySelector(".nautilus-log-chart svg"),
    "回落全局设置后图必须照常渲染 —— 99999 不得直通容量/螺旋");
});

test("语言开关贯穿到块内文案（空态是 main.ts 自己的双语表）", async () => {
  const plugin = makePlugin({ language: "zh" });
  const { el, view } = makeView(plugin, {
    sectionInfo: { text: "```nautilus\n```\n", lineEnd: 1 },
  });
  await view.render();
  assert.match(el.textContent, /请把计划直接写在这个块的下方/);
});

test("折叠态只藏图，容量指标与控制栏仍在", async () => {
  const plugin = makePlugin();
  const { el, view } = makeView(plugin, {
    sectionInfo: { text: PLAN_NOTE, lineEnd: PLAN_LINE_END },
  });
  await view.render();
  assert.ok(el.querySelector(".nautilus-log-chart svg"));
  view.chartState = { ...view.chartState, collapsed: true };
  await view.render();
  assert.equal(el.querySelector(".nautilus-log-chart"), null, "折叠了还画图");
  assert.ok(el.textContent.length > 0);
});

/* ── 🔴 L1-063 · 回放帧 ────────────────────────────────────────────────── */

/** 回放中「此刻」必须是回放帧：上游 component.cljs:1456 把 now-time-atom
 *  直接 reset 成 simulated-minute，:1836 再喂给 timelineDayState。
 *  本移植原先只把帧给了 renderSpiral 的 playbackMinute，dayState 仍吃真实时钟
 *  ⇒ 流逝斜纹冻在真实 now、跑在针前面，弹性任务也不随帧重排。
 *
 *  断言方式：钉死挂钟，只让回放帧动。若 dayState 又退回真实时钟，
 *  三帧渲染出的容量/排程文本会**完全相同** —— 下面两条就会红。 */
async function renderAtPlayback(minute) {
  const plugin = makePlugin();
  const { el, view } = makeView(plugin, {
    sectionInfo: { text: PLAN_NOTE, lineEnd: PLAN_LINE_END },
  });
  view.chartState = {
    ...view.chartState,
    playback: minute === null ? null : { minute },
  };
  await view.render();
  // 🔴 只看容量指标区：它完全由 dayState（capacityFromMinutes 一路喂进
  //    calculateCapacity 与 renderCapacityHeader）决定，**不经过** renderSpiral
  //    的 playbackMinute 那条旁路 —— 否则「针在动」就足以让断言变绿，
  //    正是 L1-063 抓的那种自洽（V1「点着 bug 的名字却抓不住它」）。
  const metrics = el.querySelector(".nautilus-log-metrics");
  assert.ok(metrics, "容量指标区没渲染出来");
  return metrics.textContent;
}

test("🔴 L1-063 回放帧必须喂进 timelineDayState —— 不同帧画出不同的盘", async () => {
  const early = await renderAtPlayback(6 * 60);      // 06:00
  const late = await renderAtPlayback(15 * 60);      // 15:00
  assert.notEqual(early, late,
    "两个回放帧渲染结果一样 => dayState 吃的还是真实时钟，回放只剩针在动（L1-063）");
});

test("🔴 L1-063 回放帧 == 真实时钟那一帧时，与不回放渲染一致（钉住「帧就是此刻」）", async () => {
  const noPlayback = await renderAtPlayback(null);
  const sameAsNow = await renderAtPlayback(16 * 60 + 40);   // 挂钟被钉在 16:40
  assert.equal(sameAsNow, noPlayback);
});

/* ── 🔴 P1-046 · 状态栏点击三态 ─────────────────────────────────────────── */

/** 起一次执行层，把状态栏元素与运行时调用记录交回来。
 *  runtime.initialize() 会因为没有 initTimingObsidian 而 reject —— 这正好
 *  同时钉住 E1-016 的**异步**那一半（见下一条）。 */
function startStatusBar({ language = "zh" } = {}) {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const calls = [];
  const plugin = Object.create(M.default.prototype);
  Object.assign(plugin, {
    settings: {
      language, actualTimeTracking: true, pomodoroMinutes: 45,
      forgottenTimerMinutes: 120, recentRetentionMinutes: 45, todoDuration: 15,
    },
    runtimeState: {},
    saved: [],
    addStatusBarItem: () => el,
    async saveData(d) { plugin.saved.push(d); },
    refreshSidebars() {},
    async activateSidebar() { calls.push(["sidebar"]); },
    app: { workspace: { getLeavesOfType: () => [] } },
  });
  plugin.startExecutionLayer();
  // locate 的三态断言不该受 vendor 真实现干扰 —— 换成记录用的替身。
  plugin.timingRuntime = { locate: (opts) => { calls.push(["locate", opts]); } };
  return { el, plugin, calls };
}

function click(el, mods = {}) {
  // 🔴 修饰键只能经构造参数传 —— MouseEvent 上的 altKey/shiftKey 是只读的。
  el.dispatchEvent(new window.MouseEvent("click", {
    bubbles: true, altKey: false, shiftKey: false, ...mods,
  }));
}

test("🔴 P1-046 状态栏三态：title 承诺的三条分支与真实行为逐条对得上", () => {
  const { el, calls } = startStatusBar({ language: "zh" });
  assert.ok(el.title, "状态栏没有任何 title —— 三态此前只存在于代码注释里");
  // aria-label 不是 title 的镜像 —— 状态栏把【当前状态 + 容量摘要】也折进去了
  // （屏幕阅读器用户拿不到 title）。要求它同样承诺那三态即可。
  const aria = el.getAttribute("aria-label");
  assert.ok(aria, "状态栏必须有 aria-label");
  for (const needle of ["⌥", "⇧"]) {
    assert.ok(aria.includes(needle),
      `aria-label 少了 ${needle} —— 三态对屏幕阅读器用户不可见`);
  }
  // 文案承诺三件事：普通点击开侧栏、⌥ 在编辑区定位、⇧ 定位到右侧栏。
  assert.match(el.title, /点击：打开.*侧栏/);
  assert.match(el.title, /⌥.*编辑区定位/);
  assert.match(el.title, /⇧.*右侧栏/);

  click(el);
  click(el, { altKey: true });
  click(el, { shiftKey: true });
  assert.deepEqual(calls, [
    ["sidebar"],                      // 普通点击 → 打开侧栏
    ["locate", { sidebar: false }],   // ⌥ → 在主编辑区定位
    ["locate", { sidebar: true }],    // ⇧ → 送右侧栏
  ], "行为与 title 承诺的三态不一致（P1-046 在 exec-panel 那一半就是这么破的）");
});

test("状态栏 title 跟着语言走（en 下不是中文）", () => {
  const { el } = startStatusBar({ language: "en" });
  assert.doesNotMatch(el.title, /[一-鿿]/);
  assert.match(el.title, /Alt-click/);
});

test("🔴 E1-016 异步那一半：initialize() reject ⇒ 设置照样回滚为 false", async () => {
  const { plugin } = startStatusBar();
  // startExecutionLayer 里的 initialize() 必然 reject（适配器没初始化），
  // 回滚发生在它的 .catch 里 —— 等一轮微任务。
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(plugin.settings.actualTimeTracking, false,
    "异步初始化失败了开关却停在「开」=> 一个开着但毫无效果的开关（E1-016）");
  assert.equal(plugin.saved.at(-1).actualTimeTracking, false, "回滚必须落盘");
});
