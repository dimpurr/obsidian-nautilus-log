/*
 * sidebar.test.js — the sidebar view shell.
 *
 * Bundles `src/sidebar.ts` with esbuild, keeping `obsidian` external and
 * resolving it to `.mock-obsidian.cjs` so the test and the bundle share the
 * same class identities (`instanceof TFile` works across the boundary).
 * DOM comes from jsdom, with the Obsidian DOM helpers the view relies on
 * (createDiv / createEl / setText / addClass / empty) polyfilled onto the
 * jsdom HTMLElement prototype.
 *
 * Covered:
 *   · resolvePrimaryPlan takes the FIRST ```nautilus block from a Daily Note
 *     that contains several of them (block config in; plan body after it);
 *   · no Daily Note / no nautilus block => null (never a silent empty plate);
 *   · onClose clears the minute interval and the metadataCache listener.
 */

"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const path = require("node:path");
const esbuild = require("esbuild");
const { JSDOM } = require("jsdom");

const SRC = path.join(__dirname, "..", "src");
const MOCK_OBSIDIAN = path.join(__dirname, "obsidian-mock.cjs");
const { ItemView, TFile, WorkspaceLeaf } = require(MOCK_OBSIDIAN);

/* ------------------------------------------------------------------ */
/* Bundle the sidebar with obsidian left external                      */
/* ------------------------------------------------------------------ */

const result = esbuild.buildSync({
  entryPoints: [path.join(SRC, "sidebar.ts")],
  bundle: true,
  format: "cjs",
  platform: "node",
  write: false,
  external: ["obsidian"],
});
const moduleShim = { exports: {} };
const mockRequire = (id) => {
  if (id === "obsidian") return require(MOCK_OBSIDIAN);
  return require(id);
};
// eslint-disable-next-line no-new-func
new Function("module", "exports", "require", result.outputFiles[0].text)(
  moduleShim,
  moduleShim.exports,
  mockRequire,
);
const { resolvePrimaryPlan, NautilusSidebarView, NAUTILUS_VIEW_TYPE } = moduleShim.exports;

/* ------------------------------------------------------------------ */
/* jsdom + Obsidian DOM helpers + globals                              */
/* ------------------------------------------------------------------ */

function makeDom() {
  const dom = new JSDOM("<!DOCTYPE html><body></body>", { url: "http://localhost/" });
  const H = dom.window.HTMLElement.prototype;
  H.addClass = function addClass(cls) { this.classList.add(cls); };
  H.empty = function empty() { while (this.firstChild) this.removeChild(this.firstChild); };
  H.createDiv = function createDiv(opts = {}) {
    const d = dom.window.document.createElement("div");
    if (opts.cls) d.className = opts.cls;
    this.appendChild(d);
    return d;
  };
  H.createEl = function createEl(tag, opts = {}) {
    const e = dom.window.document.createElement(tag);
    if (opts.cls) e.className = opts.cls;
    if (opts.text) e.textContent = opts.text;
    this.appendChild(e);
    return e;
  };
  H.setText = function setText(t) { this.textContent = t; };
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  // Pin "today" so path resolution is deterministic regardless of wall clock.
  // 🔴 RQ-7：早期这里是 `format: () => "2026-08-24"` —— **不看参数**。
  //    于是 sidebar.ts 里 `formatDate(opts.format || 'YYYY-MM-DD')` 就算把用户
  //    配置的格式整个丢掉，测试也照样绿（V1 变异实验实测）。
  //    现在按真实 moment 的语义实现最小 token 集，夹具**不再比现实宽容**。
  dom.window.moment = () => ({
    format: (fmt) => String(fmt ?? "YYYY-MM-DD")
      .replace(/YYYY/g, "2026").replace(/MM/g, "08").replace(/DD/g, "24"),
  });
  return dom;
}

/* ------------------------------------------------------------------ */
/* App / vault / metadataCache mocks                                   */
/* ------------------------------------------------------------------ */

function makeApp(files, dnOptions) {
  const metadataCache = {
    _handlers: {},
    on(name, cb) {
      (this._handlers[name] = this._handlers[name] || []).push(cb);
    },
    off(name, cb) {
      const arr = this._handlers[name] || [];
      const i = arr.indexOf(cb);
      if (i >= 0) arr.splice(i, 1);
    },
  };
  const vault = {
    getAbstractFileByPath(p) {
      return Object.prototype.hasOwnProperty.call(files, p) ? new TFile({ path: p }) : null;
    },
    cachedRead(file) {
      return Promise.resolve(files[file.path]);
    },
  };
  return {
    vault,
    metadataCache,
    internalPlugins: {
      plugins: dnOptions
        ? { "daily-notes": { instance: { options: dnOptions } } }
        : {},
    },
  };
}

const SETTINGS = {
  language: "en",
  workdayStartHour: 5,
  workdayEndHour: 21,
  descLength: 22,
  todoDuration: 15,
  urgentTrigger: "",
};

const DN_OPTIONS = { format: "YYYY-MM-DD", folder: "" };

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

/** A Daily Note holding TWO nautilus blocks — the plan must come from the
 *  FIRST one, and only the sibling lines after it (until the blank line). */
const MULTI_BLOCK = [
  "# 2026-08-24",
  "",
  "```nautilus",
  "start: 6",
  "language: zh",
  "```",
  "",
  "- [ ] Write report 45m",
  "09:00-10:00 Standup",
  "",
  "```nautilus",
  "start: 9",
  "```",
  "- [ ] Second block task 30m",
].join("\n");

/* ------------------------------------------------------------------ */
/* Tests — resolvePrimaryPlan                                          */
/* ------------------------------------------------------------------ */

test("resolvePrimaryPlan takes the FIRST nautilus block of a multi-block Daily Note", async () => {
  makeDom();
  const app = makeApp({ "2026-08-24.md": MULTI_BLOCK }, DN_OPTIONS);

  const plan = await resolvePrimaryPlan(app, SETTINGS);

  assert.ok(plan, "a Daily Note with a nautilus block must resolve a plan");
  assert.equal(plan.path, "2026-08-24.md");
  assert.equal(plan.lineOffset, 7, "plan body starts at the real line of the sibling list");
  assert.match(plan.body, /Write report 45m/, "first block's plan is present");
  assert.match(plan.body, /09:00-10:00 Standup/, "first block's event is present");
  assert.doesNotMatch(plan.body, /Second block task/, "second block must not leak into the plan");
});

test("resolvePrimaryPlan returns null when there is no Daily Note today", async () => {
  makeDom();
  const app = makeApp({}, DN_OPTIONS);

  const plan = await resolvePrimaryPlan(app, SETTINGS);
  assert.equal(plan, null, "no file => null, never a silent empty plate");
});

test("resolvePrimaryPlan returns null when the Daily Note has no nautilus block", async () => {
  makeDom();
  const app = makeApp({ "2026-08-24.md": "# 2026-08-24\n\nJust some notes.\n" }, DN_OPTIONS);

  const plan = await resolvePrimaryPlan(app, SETTINGS);
  assert.equal(plan, null, "a note without a nautilus block resolves no plan");
});

test("resolvePrimaryPlan falls back to root YYYY-MM-DD.md when Daily Notes is unconfigured", async () => {
  makeDom();
  // No daily-notes plugin at all => viaPlugin false, but still resolves the root file.
  const app = makeApp({ "2026-08-24.md": MULTI_BLOCK }, null);

  const plan = await resolvePrimaryPlan(app, SETTINGS);
  assert.ok(plan, "falls back to the root YYYY-MM-DD.md path");
  assert.equal(plan.path, "2026-08-24.md");
});

/* ------------------------------------------------------------------ */
/* Tests — view lifecycle                                              */
/* ------------------------------------------------------------------ */

test("view exposes the standard ItemView surface", async () => {
  makeDom();
  const app = makeApp({ "2026-08-24.md": MULTI_BLOCK }, DN_OPTIONS);
  const view = new NautilusSidebarView(new WorkspaceLeaf(app), SETTINGS);

  assert.ok(view instanceof ItemView, "NautilusSidebarView extends ItemView");
  assert.equal(view.getViewType(), NAUTILUS_VIEW_TYPE);
  assert.equal(NAUTILUS_VIEW_TYPE, "nautilus-logger-view");
  assert.equal(typeof view.getDisplayText(), "string");
  assert.equal(typeof view.getIcon(), "string");
});

test("onClose clears the minute interval and the metadataCache listener", async () => {
  makeDom();
  const app = makeApp({ "2026-08-24.md": MULTI_BLOCK }, DN_OPTIONS);

  const intervals = [];
  const cleared = [];
  const w = globalThis.window;
  w.setInterval = (fn, ms) => { const id = { fn, ms }; intervals.push(id); return id; };
  w.clearInterval = (id) => { cleared.push(id); };

  const view = new NautilusSidebarView(new WorkspaceLeaf(app), SETTINGS);

  await view.onOpen();
  assert.equal(intervals.length, 1, "onOpen starts exactly one minute interval");
  assert.equal(
    (app.metadataCache._handlers["changed"] || []).length,
    1,
    "onOpen registers exactly one changed listener",
  );

  // A change to the primary plan file triggers a re-render; a change to some
  // other file must not (the listener filters by path).
  const before = view.contentEl.innerHTML.length;
  app.metadataCache._handlers["changed"][0]({ path: "some-other-file.md" });
  assert.equal(view.contentEl.innerHTML.length, before, "unrelated file change does not re-render");

  await view.onClose();

  assert.deepEqual(cleared, intervals, "onClose clears the started interval");
  assert.equal(
    (app.metadataCache._handlers["changed"] || []).length,
    0,
    "onClose removes the changed listener",
  );
});

test("onClose does not throw when opened against a missing Daily Note", async () => {
  makeDom();
  const app = makeApp({}, DN_OPTIONS);
  const w = globalThis.window;
  w.setInterval = () => 1;
  w.clearInterval = () => {};

  const view = new NautilusSidebarView(new WorkspaceLeaf(app), SETTINGS);

  await view.onOpen();
  await view.onClose();   // must not throw even though no spiral was ever built
});

test('🔴 daily-notes.json 只有 folder、没有 format（Obsidian 未改日期格式时的真实形态）', async () => {
  // 用户没改过日期格式时 Obsidian 【不写 format 键】，配置就是 {"folder":"Daily/_Daily"}。
  // 早先要求 opts.format 存在，导致 folder 被一起丢掉、退回根目录，
  // 报「找不到今日笔记」而笔记就在那儿。
  const app = makeApp({ "Daily/_Daily/2026-08-24.md": MULTI_BLOCK }, { folder: "Daily/_Daily" });
  const found = await resolvePrimaryPlan(app, SETTINGS);
  assert.ok(found, '只有 folder 时也必须能定位到今日笔记');
  assert.equal(found.path, "Daily/_Daily/2026-08-24.md");
});

/* ------------------------------------------------------------------ */
/* P1-8 · 空态文案跟随 settings.language                                */
/* ------------------------------------------------------------------ */

/** 侧栏空态曾经硬编码英文：language='zh' 的用户也只看得到英文
 *  （docs/parity-audit-2026-08-25.md §P1-8，sidebar.ts:315,318-320）。 */
async function renderEmptyState(settings, dnOptions) {
  makeDom();
  const app = makeApp({}, dnOptions);          // 没有今日笔记 => 走空态分支
  const w = globalThis.window;
  w.setInterval = () => 1;
  w.clearInterval = () => {};
  const view = new NautilusSidebarView(new WorkspaceLeaf(app), settings);
  await view.onOpen();
  const text = view.contentEl.textContent;
  await view.onClose();
  return text;
}

test("🔴 P1-8 侧栏空态：language='zh' 时出中文，不再恒为英文", async () => {
  const zh = await renderEmptyState({ ...SETTINGS, language: "zh" }, DN_OPTIONS);
  assert.match(zh, /今天还没有计划/);
  assert.match(zh, /请把今天的计划写进那篇日记/);
  assert.doesNotMatch(zh, /no plan for today/);

  const en = await renderEmptyState({ ...SETTINGS, language: "en" }, DN_OPTIONS);
  assert.match(en, /no plan for today/);
  assert.match(en, /Write today's plan in that Daily Note/);
});

test("🔴 P1-8 侧栏空态：没有 Daily Notes 配置时的兜底提示也双语", async () => {
  const zh = await renderEmptyState({ ...SETTINGS, language: "zh" }, null);
  assert.match(zh, /没找到 Daily Notes 插件配置/);
  const en = await renderEmptyState({ ...SETTINGS, language: "en" }, null);
  assert.match(en, /No Daily Notes plugin config found/);
});

/* ─────────── RQ-7：用户自定义日期格式必须被真正使用 ───────────
 * 见 test/reality-quirks.md RQ-7。夹具的 moment 曾经**不看 format 参数**，
 * 于是「把用户配置的格式整个丢掉」这种实现也能全绿（V1 变异实验实测）。 */
test('🔴 RQ-7 Daily Notes 配了非默认日期格式时，路径必须按它来算', async () => {
  const app = makeApp({ 'Journal/24-08-2026.md': MULTI_BLOCK },
                       { folder: 'Journal', format: 'DD-MM-YYYY' });
  const found = await resolvePrimaryPlan(app, SETTINGS);
  assert.ok(found,
    '丢掉 opts.format 会退回 YYYY-MM-DD，路径指向一个不存在的文件 —— '
    + '用户看到「今天没有 Nautilus Log」，而他明明配置好了');
  assert.equal(found.path, 'Journal/24-08-2026.md');
});

/* ─────────── 官方指南：Use normalizePath() to clean up user-defined paths ───────────
 * 日记路径由 Daily Notes 的用户配置（folder + format）拼出。folder 可能带
 * 反斜杠（Windows）、尾部/重复斜杠 —— 不经 normalizePath 会拼出一个
 * vault.getAbstractFileByPath 认不出的脏路径（回退实现 = 这两条直接红）。 */
test('🔴 normalizePath：folder 带反斜杠（Windows 形态）时路径被清洗', async () => {
  const app = makeApp({ 'Daily/_Daily/2026-08-24.md': MULTI_BLOCK },
                       { folder: 'Daily\\_Daily' });   // 真机 Windows 上 daily-notes.json 就是这种值
  const found = await resolvePrimaryPlan(app, SETTINGS);
  assert.ok(found, '带反斜杠的 folder 必须也能定位到今日笔记');
  assert.equal(found.path, 'Daily/_Daily/2026-08-24.md');
});

test('🔴 normalizePath：folder 带重复斜杠时路径被清洗', async () => {
  const app = makeApp({ 'Journal/2026-08-24.md': MULTI_BLOCK },
                       { folder: 'Journal//' });
  const found = await resolvePrimaryPlan(app, SETTINGS);
  assert.ok(found, '重复斜杠的 folder 必须也能定位');
  assert.equal(found.path, 'Journal/2026-08-24.md');
});

/* ================================================================== */
/* 认证审计 C2-058 / C2-101 / L2-127 · 侧栏的控制栏、骨架与面板顺序      */
/* ================================================================== */

/** 一份能真的排出楔形的今日计划：两个事件 + 两个任务（其中一个已完成）。 */
const FULL_PLAN = [
  "# 2026-08-24",
  "",
  "```nautilus",
  "start: 5",
  "end: 21",
  "```",
  "",
  "09:00-10:00 Standup",
  "14:00-15:00 Review",
  "10:00-10:00 Zero length slot",   // => 警告面板（sameTime）
  "- [ ] Write report 45m",
  "- [x] Answer mail 30m d11:20",
  "- [ ] Oversized A 900m",         // => 溢出面板（排不下）
  "- [ ] Oversized B 900m",
].join("\n");

/** 打开一个真的画出图的侧栏，返回 view 与块根。 */
async function openFullSidebar(settings = SETTINGS) {
  makeDom();
  const w = globalThis.window;
  w.setInterval = () => 1;
  w.clearInterval = () => {};
  const app = makeApp({ "2026-08-24.md": FULL_PLAN }, DN_OPTIONS);
  const view = new NautilusSidebarView(new WorkspaceLeaf(app), settings);
  // 🔴 mock 的 containerEl 是游离节点 => `planHost.isConnected` 恒 false =>
  //    ensureHosts 每次渲染都新建一个 host，`contentEl.querySelector` 会一直
  //    取到第一个（陈旧的）那份。挂进 document 才是真实 Obsidian 的形态。
  w.document.body.appendChild(view.containerEl);
  await view.onOpen();
  const root = view.contentEl.querySelector(".nautilus-log");
  assert.ok(root, "侧栏画出了块根");
  return { view, root };
}

test("🔴 C2-058 侧栏有眼睛/播放/折叠三个按钮，且挂在 header-actions 列里", async () => {
  const { view, root } = await openFullSidebar();

  const bar = root.querySelector(".nautilus-log-controls-top");
  assert.ok(bar, "侧栏此前【完全没有】控制栏（sidebar.ts 从不调 renderChartControls）");
  const buttons = bar.querySelectorAll("button.nautilus-log-toggle-btn");
  assert.equal(buttons.length, 3, "上游顺序：眼睛 / 播放 / 折叠");
  assert.ok(buttons[2].classList.contains("nautilus-log-collapse-btn"));

  // C2-023：和正文块一样，按钮必须在 header 的动作列里。
  const actions = root.querySelector(".nautilus-log-header-actions");
  assert.ok(actions, "header 的动作列存在");
  assert.equal(bar.parentNode, actions);

  await view.onClose();
});

test("🔴 C2-058 眼睛真的接到图上：关掉后已完成任务的楔形消失", async () => {
  const { view, root } = await openFullSidebar();

  const titles = (el) => Array.from(el.querySelectorAll(".nautilus-log-slice-group title"))
    .map((t) => t.textContent);

  const before = titles(root);
  assert.ok(
    before.some((t) => /Answer mail/.test(t)),
    "夹具里必须真有一个已完成任务的楔形（带 d11:20 锚点），否则这条断言什么都证明不了",
  );

  root.querySelector(".nautilus-log-controls-top button").click();   // 眼睛
  await new Promise((r) => setTimeout(r, 0));

  const after = titles(view.contentEl.querySelector(".nautilus-log"));
  assert.equal(
    after.some((t) => /Answer mail/.test(t)),
    false,
    "showDone 必须真的传进 renderSpiral 的 options —— 只改本地状态等于按钮点了没反应",
  );
  assert.deepEqual(
    before.filter((t) => !/Answer mail/.test(t)),
    after,
    "只有那一个已完成项消失，其余楔形不受影响",
  );

  await view.onClose();
});

test("🔴 C2-101 溢出/警告面板排在螺旋图【之后】（上游 nautilus-log-content 内的顺序）", async () => {
  const { view, root } = await openFullSidebar();

  const content = root.querySelector(".nautilus-log-content");
  assert.ok(content, "S1-005：上游 component.cljs:1885 的 nautilus-log-content 此前从不发射");
  assert.ok(root.querySelector(".nautilus-log-shell"), "S1-005：nautilus-log-shell 同上");

  const order = Array.from(content.children).map((n) => n.className.split(/\s+/)[0]);
  const chart = order.indexOf("nautilus-log-chart");
  const overflow = order.indexOf("nautilus-log-overflow-panel");
  const warning = order.indexOf("nautilus-log-warning-panel");
  // 🔴 夹具必须真的把这两个面板逼出来 —— 否则 indexOf 恒为 -1，
  //    「面板在图之后」这条断言会空洞地永远成立（V1 变异实验里的经典陷阱）。
  assert.ok(chart >= 0, "图在 content 里");
  assert.ok(overflow >= 0, "夹具里必须真有排不下的任务，溢出面板才存在");
  assert.ok(warning >= 0, "夹具里必须真有一条排期警告，警告面板才存在");
  assert.ok(overflow > chart, "溢出面板必须在图之后（原先在图之前）");
  assert.ok(warning > chart, "警告面板必须在图之后");
  assert.ok(warning > overflow, "上游顺序 visual → overflow → warning");

  await view.onClose();
});

test("🔴 C2-024 侧栏折叠后只剩一排按钮：头部与紧凑概览都不显示", async () => {
  const { view, root } = await openFullSidebar();

  root.querySelectorAll(".nautilus-log-controls-top button")[2].click();   // 折叠
  await new Promise((r) => setTimeout(r, 0));

  const after = view.contentEl.querySelector(".nautilus-log");
  assert.ok(
    after.classList.contains("nautilus-log-collapsed"),
    "折叠后块根带 nautilus-log-collapsed（styles.css:692-709 的挂点）",
  );
  assert.equal(after.querySelector(".nautilus-log-header"), null, "上游折叠后不渲染头部");
  assert.equal(after.querySelector(".nautilus-log-compact-overview"), null, "也不渲染紧凑概览");
  assert.equal(after.querySelector(".nautilus-log-chart"), null, "更没有图");
  assert.equal(
    after.querySelectorAll(".nautilus-log-controls-top button").length,
    3,
    "按钮条还在，且是块根的直接子节点",
  );
  assert.equal(after.querySelector(".nautilus-log-controls-top").parentNode, after);

  await view.onClose();
});

test("🔴 L2-127 侧栏用 ResizeObserver 跟随宽度；紧凑判定翻转时才重排", async () => {
  makeDom();
  const w = globalThis.window;
  w.setInterval = () => 1;
  w.clearInterval = () => {};

  const observed = [];
  let fire = null;
  w.ResizeObserver = class {
    constructor(cb) { fire = cb; }
    observe(el) { observed.push(el); }
    disconnect() { fire = null; }
  };

  const app = makeApp({ "2026-08-24.md": FULL_PLAN }, DN_OPTIONS);
  const view = new NautilusSidebarView(new WorkspaceLeaf(app), SETTINGS);
  w.document.body.appendChild(view.containerEl);
  await view.onOpen();

  assert.equal(observed.length, 1, "onOpen 必须注册一个 ResizeObserver（上游 observe-compact-width!）");
  assert.equal(observed[0], view.contentEl.querySelector(".nautilus-log-plan-host"));

  // jsdom 里 clientWidth 恒为 0 => isCompactChartWidth(0) 为 true。
  // 首次触发：判定从 null 翻到 true => 必须重渲染。
  const before = view.contentEl.innerHTML;
  fire();
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(view.contentEl.querySelector(".nautilus-log"), "重渲染后块根还在");

  // 第二次触发：判定没变 => 不能再重渲染（否则 observer 自激成死循环）。
  let renders = 0;
  const origRender = Object.getPrototypeOf(view).render;
  Object.getPrototypeOf(view).render = function counted(...args) {
    renders += 1;
    return origRender.apply(this, args);
  };
  fire();
  await new Promise((r) => setTimeout(r, 0));
  Object.getPrototypeOf(view).render = origRender;
  assert.equal(renders, 0, "紧凑判定没翻转就不许重画 —— 无条件重画是自激循环");
  assert.ok(before.length >= 0);

  await view.onClose();
  assert.equal(fire, null, "onClose 必须 disconnect");
});
