/*
 * settings-panel.test.js — 设置面板本体 + 主开关生命周期 + 设置迁移。
 *
 * 被测对象是 **src/settings.ts 与 src/main.ts 本体**（esbuild bundle），
 * 不是复刻件。obsidian 的替身在本文件里现做 —— 它比 test/obsidian-mock.cjs
 * 的 `Setting` 多记了 name/desc/limits/onChange，不这么记就没法断言
 * 「这一页到底显示了什么文案、拖动之后发生了什么」。
 *
 * 覆盖的认证审计条目：
 *   · E1-026 设置面板整页双语（上游 index.js:290-346 是两张完整 zh/en 表）
 *   · E1-003 language onChange 立刻重建面板
 *   · E1-009 拖 start 之后 end 的「· 次日」desc 必须跟着变
 *   · E1-021/022 recent / forgotten 是**自由整数输入**，20/25/40 必须可达
 *   · E1-016 开 tracking 失败 ⇒ **回滚设置为 false**
 *   · E1-017/059 关 tracking ⇒ runtime.disable()（关掉在跑的 CLOCK）
 *   · E1-039/040 设置版本戳 + 一次性迁移机制；语言脏值净化
 */

"use strict";

const assert = require("node:assert/strict");
const { test, before } = require("node:test");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.join(__dirname, "..");

/* ── obsidian 替身（记得住这一页显示了什么）───────────────────────────── */

class RecordingSetting {
  constructor(containerEl) {
    this.containerEl = containerEl;
    this.name = "";
    this.desc = "";
    this.controls = [];
    containerEl.settings.push(this);
  }
  setName(n) { this.name = n; return this; }
  setDesc(d) { this.desc = d; return this; }
  addText(cb) { const c = makeControl("text"); this.controls.push(c); cb(c); return this; }
  addToggle(cb) { const c = makeControl("toggle"); this.controls.push(c); cb(c); return this; }
  addDropdown(cb) {
    const c = makeControl("dropdown");
    c.options = [];
    c.addOption = (v, label) => { c.options.push([v, label]); return c; };
    this.controls.push(c); cb(c); return this;
  }
  addSlider(cb) {
    const c = makeControl("slider");
    c.setLimits = (min, max, step) => { c.limits = [min, max, step]; return c; };
    c.setDynamicTooltip = () => c;
    this.controls.push(c); cb(c); return this;
  }
}

function makeControl(kind) {
  const c = {
    kind,
    value: undefined,
    placeholder: undefined,
    handler: null,
    setValue(v) { c.value = v; return c; },
    setPlaceholder(p) { c.placeholder = p; return c; },
    setDisabled() { return c; },
    onChange(fn) { c.handler = fn; return c; },
    /** 模拟用户操作。 */
    fire(v) { c.value = v; return c.handler(v); },
  };
  return c;
}

function makeContainer() {
  const el = { settings: [], empty() { el.settings.length = 0; } };
  return el;
}

/** 🔴 只**覆盖** `Setting`：其余类（ItemView / TFile / …）沿用共享的
 *  test/obsidian-mock.cjs，避免在这里再养一份会漂移的第二真源。
 *  共享 mock 的 `Setting` 不记 name/desc/limits/onChange，而本文件的断言
 *  全都是「这一页显示了什么、拖动之后发生了什么」—— 只能自己记。 */
const OBSIDIAN_STUB = {
  ...require(path.join(__dirname, "obsidian-mock.cjs")),
  Setting: RecordingSetting,
};

/* ── bundle ───────────────────────────────────────────────────────────── */

let S;   // src/settings.ts
let M;   // src/main.ts

function load(text) {
  const shim = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function("module", "exports", "require", text)(
    shim, shim.exports, (id) => (id === "obsidian" ? OBSIDIAN_STUB : require(id)),
  );
  return shim.exports;
}

before(async () => {
  const s = esbuild.buildSync({
    entryPoints: [path.join(ROOT, "src", "settings.ts")],
    bundle: true, format: "cjs", platform: "node", write: false,
    external: ["obsidian"], logLevel: "error",
  });
  S = load(s.outputFiles[0].text);

  const m = await esbuild.build({
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
  M = load(m.outputFiles[0].text);
});

/* ── 夹具 ─────────────────────────────────────────────────────────────── */

const DEFAULTS = {
  language: "en",
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
};

function makeTab(overrides = {}) {
  const plugin = {
    settings: { ...DEFAULTS, ...overrides },
    saved: 0,
    async saveSettings() { this.saved += 1; },
    async setTrackingEnabled(v) { this.settings.actualTimeTracking = v; return v; },
    startExecutionLayer() { return true; },
    stopExecutionLayer() {},
    refreshSidebars() {},
  };
  const tab = new S.NautilusLogSettingTab({}, plugin);
  tab.containerEl = makeContainer();
  return { tab, plugin };
}

/** 这一页当前显示的 [name, desc] 列表。 */
const pageOf = (tab) => tab.containerEl.settings.map((s) => [s.name, s.desc]);
const findSetting = (tab, name) => tab.containerEl.settings.find((s) => s.name === name);

/* ── E1-026 · 整页双语 ────────────────────────────────────────────────── */

test("🔴 E1-026 设置页整页双语：zh 下每一项的 name/desc 都不再是硬编码英文", () => {
  const { tab } = makeTab({ language: "zh", actualTimeTracking: true });
  tab.display();
  const page = pageOf(tab);
  assert.equal(page.length, 11, `应有 11 项设置，实得 ${page.length}`);
  const cjk = /[一-鿿]/;
  for (const [name, desc] of page) {
    assert.ok(cjk.test(name), `设置项标题仍是纯英文：${name}`);
    assert.ok(cjk.test(desc), `设置项说明仍是纯英文：${name} → ${desc}`);
  }
  // 上游 index.js:293 的原话，逐字对齐
  assert.ok(page.some(([n]) => n === "语言 / Language"));
  assert.ok(page.some(([n]) => n === "执行层 · 进阶"));
});

test("E1-026 en 下同样 11 项，且没有中文漏网", () => {
  const { tab } = makeTab({ language: "en", actualTimeTracking: true });
  tab.display();
  const page = pageOf(tab);
  assert.equal(page.length, 11);
  for (const [name, desc] of page) {
    assert.ok(name && desc, `${name} 缺 name 或 desc`);
    assert.doesNotMatch(name, /[一-鿿]/, `en 页里出现中文标题：${name}`);
  }
});

test("SETTINGS_COPY 的 en / zh 键集完全一致（少一个 key 就是一处 undefined 文案）", () => {
  const en = Object.keys(S.SETTINGS_COPY.en).sort();
  const zh = Object.keys(S.SETTINGS_COPY.zh).sort();
  assert.deepEqual(zh, en);
  for (const k of en) assert.equal(typeof S.SETTINGS_COPY.zh[k], typeof S.SETTINGS_COPY.en[k]);
});

test("主开关关闭时执行层那 4 项不显示（11 → 7）", () => {
  const { tab } = makeTab({ actualTimeTracking: false });
  tab.display();
  assert.equal(pageOf(tab).length, 7);
});

/* ── E1-003 · language onChange 重建面板 ──────────────────────────────── */

test("🔴 E1-003 切语言立刻重建整页（否则要关掉设置页再打开才换语言）", async () => {
  const { tab, plugin } = makeTab({ language: "en" });
  tab.display();
  const dropdown = findSetting(tab, S.SETTINGS_COPY.en.language).controls[0];
  await dropdown.fire("zh");
  assert.equal(plugin.settings.language, "zh");
  assert.equal(plugin.saved, 1);
  // 重建之后这一页必须已经是中文的
  assert.ok(pageOf(tab).every(([n]) => /[一-鿿]/.test(n)),
    "language onChange 之后没有重建面板 => 页面仍是旧语言");
});

/* ── E1-009 · 拖 start 要刷新 end 的「· 次日」 ────────────────────────── */

test("🔴 E1-009 拖开始整点 → 结束整点的「· 次日」提示必须跟着变", async () => {
  const { tab } = makeTab({ workdayStartHour: 5, workdayEndHour: 21 });
  tab.display();
  const endSetting = findSetting(tab, S.SETTINGS_COPY.en.end);
  // 只看「Currently …」那一段：句尾那句是恒定的规则说明，不是当前状态。
  assert.match(endSetting.desc, /Currently 21:00\./, "5 → 21 不跨午夜");
  const startSlider = findSetting(tab, S.SETTINGS_COPY.en.start).controls[0];
  await startSlider.fire(22);        // 22 → 21 就跨午夜了
  assert.match(endSetting.desc, /Currently 21:00 · next day/,
    "start 变了但 end 的 desc 没刷新 => 用户看不出 21:00 其实是次日");
});

test("E1-008 拖结束整点自身也刷新它的 desc", async () => {
  const { tab } = makeTab({ workdayStartHour: 5, workdayEndHour: 21 });
  tab.display();
  const endSetting = findSetting(tab, S.SETTINGS_COPY.en.end);
  await endSetting.controls[0].fire(2);
  assert.match(endSetting.desc, /02:00 · next day/);
});

/* ── E1-021 / E1-022 · 自由整数输入 ──────────────────────────────────── */

test("🔴 E1-021/022 recent / forgotten 是自由文本输入，不是 step 15 的滑块", () => {
  const { tab } = makeTab({ actualTimeTracking: true });
  tab.display();
  for (const [name, ph] of [
    [S.SETTINGS_COPY.en.recentRetention, "45"],
    [S.SETTINGS_COPY.en.forgottenTimer, "120"],
  ]) {
    const c = findSetting(tab, name).controls[0];
    assert.equal(c.kind, "text", `${name} 仍是滑块 => 20/25/40 分钟不可达`);
    assert.equal(c.placeholder, ph);       // 上游 index.js:427 / :438 的 placeholder
  }
});

test("🔴 E1-021/022 上游能填的 20 / 25 / 40 / 5000 这里都能填（无上限）", async () => {
  const { tab, plugin } = makeTab({ actualTimeTracking: true });
  tab.display();
  const recent = findSetting(tab, S.SETTINGS_COPY.en.recentRetention).controls[0];
  for (const v of ["20", "25", "40", "5000"]) {
    // eslint-disable-next-line no-await-in-loop
    await recent.fire(v);
    assert.equal(plugin.settings.recentRetentionMinutes, Number(v),
      `${v} 分钟被吃掉了 —— 上游是无上限的自由整数输入`);
  }
  const forgotten = findSetting(tab, S.SETTINGS_COPY.en.forgottenTimer).controls[0];
  await forgotten.fire("25");
  assert.equal(plugin.settings.forgottenTimerMinutes, 25);
});

test("parseExecutionMinutes 逐条照抄上游 updateExecutionMinutes（index.js:355-363）", () => {
  assert.equal(S.parseExecutionMinutes("", 45), null);      // 空串：用户正在删，忽略
  assert.equal(S.parseExecutionMinutes("   ", 45), null);
  assert.equal(S.parseExecutionMinutes("abc", 45), 45);     // 非数字 → 默认
  assert.equal(S.parseExecutionMinutes("0", 45), 0);        // 0 = 关闭，合法
  assert.equal(S.parseExecutionMinutes("-5", 45), 0);       // max(0, …)
  assert.equal(S.parseExecutionMinutes("20.4", 45), 20);    // round
  assert.equal(S.parseExecutionMinutes("20.6", 45), 21);
  assert.equal(S.parseExecutionMinutes("99999", 45), 99999); // 无上限
});

test("空串不写盘（否则用户删到一半就被写成 0）", async () => {
  const { tab, plugin } = makeTab({ actualTimeTracking: true });
  tab.display();
  const before = plugin.settings.recentRetentionMinutes;
  await findSetting(tab, S.SETTINGS_COPY.en.recentRetention).controls[0].fire("");
  assert.equal(plugin.settings.recentRetentionMinutes, before);
});

/* ── E1-016 / E1-017 · 主开关生命周期 ────────────────────────────────── */

function makePlugin({ startOk = true } = {}) {
  const calls = [];
  const p = Object.create(M.default.prototype);
  Object.assign(p, {
    settings: { ...DEFAULTS },
    runtimeState: {},
    saved: [],
    calls,
    async saveData(d) { p.saved.push(d); },
    refreshSidebars() { calls.push("refreshSidebars"); },
    startExecutionLayer() { calls.push("startExecutionLayer"); return startOk; },
    stopExecutionLayer(opts) { calls.push(["stopExecutionLayer", opts]); },
    app: { workspace: { getLeavesOfType: () => [] } },
  });
  return p;
}

test("🔴 E1-016 开 tracking 失败 ⇒ 设置回滚为 false（开关不许停在「开」）", async () => {
  const p = makePlugin({ startOk: false });
  const final = await p.setTrackingEnabled(true);
  assert.equal(final, false);
  assert.equal(p.settings.actualTimeTracking, false,
    "启动失败了开关却停在「开」=> 一个开着但毫无效果的开关（E1-016）");
  // 回滚必须**落盘**，不能只改内存 —— 否则下次启动又是「开」。
  assert.equal(p.saved.at(-1).actualTimeTracking, false);
});

test("E1-016 开 tracking 成功 ⇒ 不回滚", async () => {
  const p = makePlugin({ startOk: true });
  assert.equal(await p.setTrackingEnabled(true), true);
  assert.equal(p.settings.actualTimeTracking, true);
  assert.equal(p.saved.at(-1).actualTimeTracking, true);
});

test("🔴 E1-017/059 关 tracking ⇒ closeActive:true（关掉在跑的 CLOCK）", async () => {
  const p = makePlugin();
  p.settings.actualTimeTracking = true;
  await p.setTrackingEnabled(false);
  const stop = p.calls.find((c) => Array.isArray(c) && c[0] === "stopExecutionLayer");
  assert.ok(stop, "关开关没有拆执行层");
  assert.deepEqual(stop[1], { closeActive: true },
    "closeActive 不为 true => 不走 runtime.disable() => running CLOCK 永久留在笔记里");
});

test("E1-017 stopExecutionLayer：closeActive 走 disable()，插件卸载只 destroy()", () => {
  const seen = [];
  const p = Object.create(M.default.prototype);
  Object.assign(p, {
    statusBar: null,
    timingRuntime: { disable: () => seen.push("disable"), destroy: () => seen.push("destroy") },
  });
  p.stopExecutionLayer({ closeActive: true });
  assert.deepEqual(seen, ["disable"]);

  p.timingRuntime = { disable: () => seen.push("disable"), destroy: () => seen.push("destroy") };
  p.stopExecutionLayer();          // 插件卸载：用户没说要结束工作
  assert.deepEqual(seen, ["disable", "destroy"]);
});

/* ── E1-039 / E1-040 · 版本戳 + 迁移机制 + 脏值净化 ──────────────────── */

test("🔴 E1-039/040 设置版本戳机制存在，并把戳写进 data.json", async () => {
  const p = makePlugin();
  p.loadData = async () => ({ language: "zh", workdayEndHour: 24 });
  await p.loadSettings();
  assert.equal(p.saved.at(-1)._settingsVersion, M.SETTINGS_VERSION);
  // 有意偏离：上游那条 `workday-end===24 → 21` 不照抄（24 在本移植是合法选择）
  assert.equal(p.settings.workdayEndHour, 24);
  // 上游那条「首次强制写 en」也不照抄：用户主动选的 zh 不许被抹掉
  assert.equal(p.settings.language, "zh");
});

test("迁移表按 to 升序补跑，跑完打戳；已是最新则不重跑", () => {
  const run = [];
  const table = M.SETTINGS_MIGRATIONS;
  const saved = table.slice();
  table.push({ to: 3, migrate: (d) => { run.push(3); d.three = true; } });
  table.push({ to: 2, migrate: (d) => { run.push(2); d.two = true; } });
  try {
    const r = M.migrateSettingsData({ a: 1 }, 1);
    assert.deepEqual(run, [2, 3], "迁移必须按 to 升序执行");
    assert.equal(r.data.two, true);
    assert.equal(r.data.three, true);
    assert.equal(r.changed, true);
    run.length = 0;
    const again = M.migrateSettingsData({ a: 1 }, 3);
    assert.deepEqual(run, [], "版本已到位就不该重跑");
    assert.equal(again.version, M.SETTINGS_VERSION);
  } finally {
    table.length = 0;
    table.push(...saved);
  }
});

test("🔴 E1-040 语言脏值净化：非 en/zh 一律重置为 en（脏值会被喂给 vendor）", async () => {
  assert.equal(M.sanitizeSettings({ language: "jp" }).language, "en");
  assert.equal(M.sanitizeSettings({ language: "" }).language, "en");
  assert.equal(M.sanitizeSettings({ language: "zh" }).language, "zh");

  const p = makePlugin();
  p.loadData = async () => ({ language: "jp" });
  await p.loadSettings();
  assert.equal(p.settings.language, "en");
  assert.equal(p.saved.at(-1).language, "en", "净化结果必须落盘，否则每次启动都要再修一遍");
});

test("下划线元数据键不许渗进 settings 对象", async () => {
  const p = makePlugin();
  p.loadData = async () => ({ language: "en", _runtime: { pomo: 1 }, _settingsVersion: 1 });
  await p.loadSettings();
  assert.equal(p.settings._runtime, undefined);
  assert.equal(p.settings._settingsVersion, undefined);
  assert.deepEqual(p.runtimeState, { pomo: 1 });
});
