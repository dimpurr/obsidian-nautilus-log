/*
 * copy.test.js — P1-8「6 处用户可见文案硬编码英文」。
 *
 * 被审版本里 `settings.language='zh'` 时，代码块的空态提示 / 配置警告 tooltip
 * 与侧栏空态**依然是英文**（docs/parity-audit-2026-08-25.md §P1-8）。
 * 侧栏那两处在 sidebar.test.js 里钉；这里钉 main.ts 的四处 + 双语表本身。
 *
 * 🔴 断言对象是 **main.ts 真实导出的渲染函数**，不是复刻件（audit §5）。
 *
 * ⚠️ `formatCapacitySummary` 硬编码中文是**上游行为**（header.ts:411 /
 *    contract.ts:195 有注释），不在本条范围内、也不许"顺手改掉"。
 */

"use strict";

const assert = require("node:assert/strict");
const { test, before } = require("node:test");
const path = require("node:path");
const esbuild = require("esbuild");
const { JSDOM } = require("jsdom");

const ROOT = path.join(__dirname, "..");
const MOCK_OBSIDIAN = path.join(__dirname, "obsidian-mock.cjs");

let M;      // src/main.ts
let S;      // src/settings.ts

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

  const settingsBuild = esbuild.buildSync({
    entryPoints: [path.join(ROOT, "src", "settings.ts")],
    bundle: true, format: "cjs", platform: "node", write: false,
    alias: { obsidian: MOCK_OBSIDIAN }, logLevel: "error",
  });
  const shim2 = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function("module", "exports", "require", settingsBuild.outputFiles[0].text)(
    shim2, shim2.exports, require,
  );
  S = shim2.exports;
});

function makeRoot() {
  const dom = new JSDOM("<!DOCTYPE html><body></body>");
  const H = dom.window.HTMLElement.prototype;
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
  return dom.window.document.body;
}

/* ─────────────────────────── 双语表本身 ─────────────────────────── */

test("LOCAL_COPY 的 en / zh 键集完全一致（少一个 key 就是一处 undefined 文案）", () => {
  const en = Object.keys(S.LOCAL_COPY.en).sort();
  const zh = Object.keys(S.LOCAL_COPY.zh).sort();
  assert.deepEqual(zh, en);
  for (const k of en) assert.equal(typeof S.LOCAL_COPY.zh[k], typeof S.LOCAL_COPY.en[k]);
});

test("COMMAND_COPY 的 en / zh 键集完全一致（命令名少一个 key 就是一处 undefined 文案）", () => {
  const en = Object.keys(S.COMMAND_COPY.en).sort();
  const zh = Object.keys(S.COMMAND_COPY.zh).sort();
  assert.deepEqual(zh, en);
  for (const k of en) assert.equal(typeof S.COMMAND_COPY.zh[k], typeof S.COMMAND_COPY.en[k]);
});

test("COMMAND_COPY 命令名不带插件名、sentence case（ribbon tooltip 是例外）", () => {
  const en = S.COMMAND_COPY.en;
  assert.equal(en.openSidebar, "Open sidebar");
  assert.equal(en.openSettings, "Open settings");
  assert.equal(en.createTestNote, "Create test note");
  // Timing Line / Primary Plan 是本插件的概念名，sentence case 下保持大写
  assert.equal(en.focusCurrentBlock, "Focus current block on the Timing Line");
  assert.equal(en.locatePrimaryPlan, "Locate Primary Plan");
  // ribbon tooltip 孤悬在侧栏，没有「归属插件」的上下文，保留插件名
  assert.equal(en.ribbonOpen, "Open Nautilus Log");
  assert.equal(S.COMMAND_COPY.zh.ribbonOpen, "打开 Nautilus Log");
});

test("localCopy 未知语言退回英文，'zh' 拿到中文", () => {
  assert.equal(S.localCopy("zh").clockIn, "开始计时");
  assert.equal(S.localCopy("en").clockIn, "Clock in");
  assert.equal(S.localCopy("fr").clockIn, "Clock in");
});

/* ──────────────────── main.ts 的四处（P1-8 前恒为英文） ──────────────────── */

test("🔴 P1-8 代码块空态：zh 出中文，en 出英文", () => {
  const zh = makeRoot();
  M.renderBlockEmptyState(zh, S.localCopy("zh"), "diag-line");
  const zhText = zh.textContent;
  assert.match(zhText, /请把计划直接写在这个块的下方/);
  assert.match(zhText, /计划到第一个空行为止/);
  assert.match(zhText, /晨间例程/);            // 示例正文也翻译（audit 列的第 3 处）
  assert.doesNotMatch(zhText, /write the plan directly below/i);
  assert.match(zhText, /diag-line/);            // 诊断行不受语言影响，必须还在

  const en = makeRoot();
  M.renderBlockEmptyState(en, S.localCopy("en"), "diag-line");
  assert.match(en.textContent, /write the plan directly below this block/);
  assert.match(en.textContent, /Morning routine/);
});

test("🔴 P1-8 配置警告 tooltip：zh 出中文，键名列表照旧显示", () => {
  const zh = makeRoot();
  M.renderConfigWarning(zh, [{ key: "strat", value: "6" }, { key: "foo" }], S.localCopy("zh"));
  const warn = zh.querySelector(".nautilus-log-config-warning");
  assert.equal(warn.textContent, "⚠ strat: 6 · foo");
  assert.match(warn.title, /无法识别的配置项/);
  assert.doesNotMatch(warn.title, /Unrecognised/);

  const en = makeRoot();
  M.renderConfigWarning(en, [{ key: "foo" }], S.localCopy("en"));
  assert.match(en.querySelector(".nautilus-log-config-warning").title, /Unrecognised setting/);
});
