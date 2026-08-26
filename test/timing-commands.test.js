/*
 * timing-commands.test.js — P1-6 的命令面板 3 条 + 块右键菜单 2 条。
 *
 * 🔴 这份测试 bundle 的是 **src/main.ts 本体**，不是复刻件。
 *    test/locate.test.js 的做法（在测试里重写一遍 main.ts 的算法然后测那份重写）
 *    是假覆盖：实现漂移了测试照样绿（docs/parity-audit-2026-08-25.md §5）。
 *    这里所有断言的被测对象都从 main.ts 的真实导出取得。
 *
 * 覆盖：
 *   · uidForLine / editorTaskStatus / planTaskUids / focusedTaskUid（纯函数）
 *   · timingMenuActions —— 上游 display-conditional 的等价物
 *   · focusCurrentBlockError —— 上游 timing-commands.js:34-38 的两条判据
 *   · registerTimingCommands 这层壳：注册了哪 3 条命令、editor-menu 挂没挂上、
 *     以及 🔴 执行层总开关关闭时**一个入口都不出现**
 */

"use strict";

const assert = require("node:assert/strict");
const { test, before } = require("node:test");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.join(__dirname, "..");
const MOCK_OBSIDIAN = path.join(__dirname, "obsidian-mock.cjs");

let M; // src/main.ts 的导出面

before(async () => {
  // buildSync 不支持 plugins，而 vendored timing-runtime.js 里写死了
  // `from './timing-roam'`（vendor 一个字都不许改），所以必须走异步 build +
  // 与 esbuild.config.mjs 同一条 onResolve 重定向。
  const result = await esbuild.build({
    entryPoints: [path.join(ROOT, "src", "main.ts")],
    bundle: true,
    format: "cjs",
    platform: "node",
    write: false,
    external: ["obsidian"],
    loader: { ".md": "text" },
    logLevel: "error",
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
  const mockRequire = (id) => (id === "obsidian" ? require(MOCK_OBSIDIAN) : require(id));
  // eslint-disable-next-line no-new-func
  new Function("module", "exports", "require", result.outputFiles[0].text)(
    shim, shim.exports, mockRequire,
  );
  M = shim.exports;
});

/* ───────────────────────────── 纯函数 ───────────────────────────── */

test("uidForLine 产出 `filepath:line` —— 与 timing-obsidian.splitUid 同一形态", () => {
  assert.equal(M.uidForLine("Journal/2026-08-25.md", 12), "Journal/2026-08-25.md:12");
  assert.equal(M.uidForLine("a b/c.md", 0), "a b/c.md:0");
});

test("editorTaskStatus 认 markdown checkbox，裸行/事件行一律不是任务（§D1）", () => {
  assert.equal(M.editorTaskStatus("- [ ] 写项目简报 45m"), "TODO");
  assert.equal(M.editorTaskStatus("  - [x] 已完成 30m d14:30"), "DONE");
  assert.equal(M.editorTaskStatus("* [ ] 星号也算"), "TODO");
  assert.equal(M.editorTaskStatus("- 裸行不是任务"), null);      // §D1
  assert.equal(M.editorTaskStatus("05:00-06:00 晨间例程"), null); // 时间段事件
  assert.equal(M.editorTaskStatus(""), null);
  assert.equal(M.editorTaskStatus(undefined), null);
});

test("planTaskUids / focusedTaskUid 从快照里取，形状不对时不炸", () => {
  const snap = {
    planSnapshot: { tasks: [{ uid: "a.md:1" }, { uid: "a.md:2" }, { uid: 7 }] },
    activeWork: { focused: { taskUid: "a.md:2" } },
  };
  assert.deepEqual(M.planTaskUids(snap), ["a.md:1", "a.md:2"]);
  assert.equal(M.focusedTaskUid(snap), "a.md:2");
  assert.deepEqual(M.planTaskUids(null), []);
  assert.deepEqual(M.planTaskUids({ planSnapshot: null }), []);
  assert.equal(M.focusedTaskUid(null), null);
  assert.equal(M.focusedTaskUid({ activeWork: { focused: null } }), null);
});

/* ───────────── §D8 · `dHH:MM` 完成锚点（P1「契约漏洞 2」/ P1-068）───────────── */

/** 语法的唯一权威是 parser.ts:89 的 DONE_AT_RE：**分钟可省、大小写不敏感**。
 *  main.ts 的去重判断原先要求分钟且区分大小写 ⇒ 写了 `d14` 的行会被 parser
 *  认成锚点、却在这里被判成「还没有锚点」而被**再追加一个**。 */
test("🔴 hasDoneAtAnchor 与 parser 的 DONE_AT_RE 同语法：分钟可省、大小写不敏感", () => {
  assert.equal(M.hasDoneAtAnchor("- [x] 已完成 30m d14:30"), true);
  assert.equal(M.hasDoneAtAnchor("- [x] 已完成 30m d14"), true, "🔴 `d14` 也是合法锚点");
  assert.equal(M.hasDoneAtAnchor("- [x] 已完成 30m D14:30"), true, "🔴 大小写不敏感");
  assert.equal(M.hasDoneAtAnchor("- [x] 已完成 30m D9"), true);
  assert.equal(M.hasDoneAtAnchor("- [x] 已完成 30m d14:5"), true, "分钟可以是一位");
  assert.equal(M.hasDoneAtAnchor("- [x] 没有锚点 30m"), false);
  assert.equal(M.hasDoneAtAnchor("- [x] dood 不是锚点"), false);
  assert.equal(M.hasDoneAtAnchor("- [x] 2d14:30 不在词首"), false);
});

test("🔴 已有 `d14` 这类锚点的行不许被再追加一个（一行两个锚点）", () => {
  assert.equal(M.completeWithTimestamp("- [x] 已完成 30m d14", "d16:40"), null);
  assert.equal(M.completeWithTimestamp("- [x] 已完成 30m D14:30", "d16:40"), null);
});

test("completeWithTimestamp：勾上 + 追加锚点；非任务行静默不动（P1-070）", () => {
  assert.equal(M.completeWithTimestamp("- [ ] 写简报 45m", "d16:40"), "- [x] 写简报 45m d16:40");
  assert.equal(M.completeWithTimestamp("  * [ ] 缩进也认 30m ", "d16:40"), "  * [x] 缩进也认 30m d16:40");
  assert.equal(M.completeWithTimestamp("- [x] 已勾但没锚点", "d16:40"), "- [x] 已勾但没锚点 d16:40");
  assert.equal(M.completeWithTimestamp("随手写的一行", "d16:40"), null);
  assert.equal(M.completeWithTimestamp("08:00-09:00 晨会", "d16:40"), null);
});

test("doneAtStamp 补零成 dHH:MM", () => {
  assert.equal(M.doneAtStamp(new Date(2026, 7, 24, 9, 5)), "d09:05");
  assert.equal(M.doneAtStamp(new Date(2026, 7, 24, 16, 40)), "d16:40");
});

/* ─────────────────── 条件显示（上游 display-conditional） ─────────────────── */

const PLAN = ["today.md:3", "today.md:5"];
const base = {
  line: "- [ ] 写项目简报 45m",
  uid: "today.md:3",
  enabled: true,
  focusedTaskUid: null,
  planTaskUids: PLAN,
};

test("未完成 TODO 且在今天的主计划里 → 只出 Clock in", () => {
  assert.deepEqual(M.timingMenuActions(base), ["clock-in"]);
});

test("🔴 执行层总开关关闭 → 一个菜单项都不出", () => {
  assert.deepEqual(M.timingMenuActions({ ...base, enabled: false }), []);
  assert.deepEqual(
    M.timingMenuActions({ ...base, enabled: false, focusedTaskUid: "today.md:3" }),
    [],
  );
});

test("不是任务行 / 已完成 → 不出 Clock in（别无条件往右键菜单里塞东西）", () => {
  assert.deepEqual(M.timingMenuActions({ ...base, line: "随手写的一行" }), []);
  assert.deepEqual(M.timingMenuActions({ ...base, line: "- [x] 已完成 30m" }), []);
});

test("TODO 但不在今天的主计划里 → 不出 Clock in（vendor startTask 会拒绝）", () => {
  assert.deepEqual(M.timingMenuActions({ ...base, uid: "other.md:9" }), []);
});

test("该行正是当前 Timing Line → 出 Clock out", () => {
  assert.deepEqual(
    M.timingMenuActions({ ...base, line: "- [x] 已完成", focusedTaskUid: "today.md:3" }),
    ["clock-out"],
  );
  assert.deepEqual(
    M.timingMenuActions({ ...base, focusedTaskUid: "today.md:3" }),
    ["clock-in", "clock-out"],
  );
});

test("focusCurrentBlockError 复刻上游的两条判据", () => {
  assert.equal(M.focusCurrentBlockError("- [ ] 未完成"), null);
  assert.equal(M.focusCurrentBlockError("- [x] 已完成"), "onlyTodo");
  assert.equal(M.focusCurrentBlockError("不是任务行"), "needTodo");
});

/* ─────────────────────────── 注册这层壳 ─────────────────────────── */

function makeMenu() {
  const items = [];
  return {
    items,
    addItem(cb) {
      const item = {
        setTitle(t) { item.title = t; return item; },
        setIcon(i) { item.icon = i; return item; },
        onClick(fn) { item.click = fn; return item; },
      };
      cb(item);
      items.push(item);
      return this;
    },
  };
}

function makePlugin({ tracking = true, runtime = null, language = "en" } = {}) {
  const calls = [];
  const rt = runtime || {
    getSnapshot: () => ({
      planSnapshot: { tasks: [{ uid: "today.md:3" }] },
      activeWork: { focused: { taskUid: "today.md:3" } },
    }),
    startTask: (...a) => { calls.push(["startTask", ...a]); return Promise.resolve(); },
    stopTask: (...a) => { calls.push(["stopTask", ...a]); return Promise.resolve(); },
    locate: (...a) => { calls.push(["locate", ...a]); return Promise.resolve(); },
  };
  const commands = [];
  const events = [];
  const plugin = Object.create(M.default.prototype);
  Object.assign(plugin, {
    settings: { actualTimeTracking: tracking, language },
    timingRuntime: rt,
    commands,
    events,
    calls,
    addCommand: (c) => { commands.push(c); },
    registerEvent: (e) => e,
    app: { workspace: { on: (name, cb) => { events.push({ name, cb }); return { name }; } } },
  });
  plugin.registerTimingCommands();
  return plugin;
}

test("注册了上游那 3 条命令 + editor-menu 挂载面", () => {
  const p = makePlugin();
  assert.deepEqual(p.commands.map((c) => c.id), [
    "focus-current-block", "clock-out-timing-line", "locate-primary-plan",
  ]);
  assert.deepEqual(p.events.map((e) => e.name), ["editor-menu"]);
});

test("🔴 总开关关闭 → 3 条命令在命令面板里全部不出现，右键菜单也是空的", () => {
  const p = makePlugin({ tracking: false });
  const editor = { getCursor: () => ({ line: 3 }), getLine: () => "- [ ] 任务 30m" };
  const info = { file: { path: "today.md" } };
  assert.equal(p.commands[0].editorCheckCallback(true, editor, info), false);
  assert.equal(p.commands[1].checkCallback(true), false);
  assert.equal(p.commands[2].checkCallback(true), false);
  const menu = makeMenu();
  p.events[0].cb(menu, editor, info);
  assert.equal(menu.items.length, 0);
});

test("总开关打开 → 命令可见，Clock out / Locate 直达 runtime", () => {
  const p = makePlugin();
  const editor = { getCursor: () => ({ line: 3 }), getLine: () => "- [ ] 任务 30m" };
  const info = { file: { path: "today.md" } };
  assert.equal(p.commands[0].editorCheckCallback(true, editor, info), true);
  assert.equal(p.commands[1].checkCallback(true), true);
  assert.equal(p.commands[2].checkCallback(true), true);
  p.commands[1].checkCallback(false);
  p.commands[2].checkCallback(false);
  assert.deepEqual(p.calls.map((c) => c[0]), ["stopTask", "locate"]);
});

test("Focus current block：TODO 行送 startTask，非任务行只提示、不写任何东西", () => {
  const p = makePlugin();
  const info = { file: { path: "today.md" } };
  p.commands[0].editorCheckCallback(
    false, { getCursor: () => ({ line: 3 }), getLine: () => "- [ ] 任务 30m" }, info,
  );
  assert.deepEqual(p.calls[0].slice(0, 2), ["startTask", "today.md:3"]);
  p.calls.length = 0;
  p.commands[0].editorCheckCallback(
    false, { getCursor: () => ({ line: 9 }), getLine: () => "随手写的一行" }, info,
  );
  assert.deepEqual(p.calls, []);
});

test("editor-menu：条件命中时按语言出中文标题，点击直达 runtime", () => {
  const p = makePlugin({ language: "zh" });
  const editor = { getCursor: () => ({ line: 3 }), getLine: () => "- [ ] 任务 30m" };
  const menu = makeMenu();
  p.events[0].cb(menu, editor, { file: { path: "today.md" } });
  assert.deepEqual(menu.items.map((i) => i.title), ["开始计时", "结束计时"]);
  menu.items[0].click();
  menu.items[1].click();
  assert.deepEqual(p.calls.map((c) => c[0]), ["startTask", "stopTask"]);
});

test("editor-menu：无文件（例如 canvas 里的编辑器）不挂任何项", () => {
  const p = makePlugin();
  const menu = makeMenu();
  p.events[0].cb(menu, { getCursor: () => ({ line: 0 }), getLine: () => "- [ ] x" }, {});
  assert.equal(menu.items.length, 0);
});

/* ─────────────────── onload 真的把它们挂上去了吗 ─────────────────── */

/** 🔴 上面那些测试直接调 registerTimingCommands()，所以**光有它们，
 *  把 onload 里那行调用删掉照样全绿**。这条把 onload → 注册 这条边也钉住。 */
test("onload 注册了上游那 3 条命令，并挂上 editor-menu", async () => {
  const cmds = [];
  const events = [];
  const p = Object.create(M.default.prototype);
  Object.assign(p, {
    loadData: async () => ({}),
    saveData: async () => {},
    registerMarkdownCodeBlockProcessor() {},
    registerView() {},
    addRibbonIcon() {},
    addCommand(c) { cmds.push(c.id); },
    addSettingTab() {},
    addStatusBarItem() { return {}; },
    registerEvent(e) { return e; },
    app: {
      vault: { getMarkdownFiles: () => [], on() {}, adapter: { read: async () => "{}", exists: async () => false } },
      workspace: {
        on(name) { events.push(name); return { name }; },
        onLayoutReady() {},
        getLeavesOfType: () => [],
      },
      metadataCache: { on() {} },
      internalPlugins: { plugins: {} },
    },
  });

  await p.onload();

  for (const id of ["focus-current-block", "clock-out-timing-line", "locate-primary-plan"]) {
    assert.ok(cmds.includes(id), `onload 没有注册命令 ${id}`);
  }
  assert.ok(events.includes("editor-menu"), "onload 没有挂上 editor-menu 右键菜单");
});
