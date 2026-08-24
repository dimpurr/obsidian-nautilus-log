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
  dom.window.moment = () => ({ format: () => "2026-08-24" });
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
  assert.equal(NAUTILUS_VIEW_TYPE, "nautilus-log-view");
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
