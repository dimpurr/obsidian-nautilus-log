/*
 * spiral.test.js — smoke test for the spiral renderer.
 *
 * No jsdom: we bundle `src/spiral.ts` with esbuild into a single CJS file,
 * install a tiny DOM shim (createElementNS / appendChild / text nodes), render
 * into a fake container, then assert on the serialized HTML string.
 *
 * Covered:
 *   · renderSpiral produces an <svg> in the container;
 *   · one event slice group per fixed event;
 *   · one task slice group per scheduled task.
 */

"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const path = require("node:path");
const esbuild = require("esbuild");

/* ------------------------------------------------------------------ */
/* Minimal DOM shim                                                    */
/* ------------------------------------------------------------------ */

function makeElement(tag) {
  const attrs = {};
  const children = [];
  const style = {};
  return {
    nodeType: 1,
    tagName: tag,
    attrs,
    children,
    style,
    setAttribute(name, value) {
      attrs[name] = String(value);
    },
    setAttributeNS(_ns, name, value) {
      attrs[name] = String(value);
    },
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null;
    },
    appendChild(child) {
      children.push(child);
      return child;
    },
  };
}

function makeText(data) {
  return { nodeType: 3, data: String(data) };
}

const documentShim = {
  createElementNS(_ns, tag) {
    return makeElement(tag);
  },
  createTextNode(text) {
    return makeText(text);
  },
};

function escapeAttr(s) {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}
function escapeText(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function serialize(node) {
  if (node.nodeType === 3) return escapeText(node.data);
  let attrs = Object.entries(node.attrs)
    .map(([k, v]) => ` ${k}="${escapeAttr(v)}"`)
    .join("");
  const styleKeys = Object.keys(node.style);
  if (styleKeys.length) {
    attrs += ` style="${styleKeys.map((k) => `${k}:${node.style[k]}`).join(";")}"`;
  }
  const inner = node.children.map(serialize).join("");
  return `<${node.tagName}${attrs}>${inner}</${node.tagName}>`;
}

function makeContainer() {
  return {
    clientWidth: 600,
    clientHeight: 800,
    children: [],
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    get innerHTML() {
      return this.children.map(serialize).join("");
    },
  };
}

/* ------------------------------------------------------------------ */
/* Load the bundled renderer                                           */
/* ------------------------------------------------------------------ */

const result = esbuild.buildSync({
  entryPoints: [path.join(__dirname, "..", "src", "spiral.ts")],
  bundle: true,
  format: "cjs",
  platform: "node",
  write: false,
});
const moduleShim = { exports: {} };
// eslint-disable-next-line no-new-func
new Function("module", "exports", "require", result.outputFiles[0].text)(
  moduleShim,
  moduleShim.exports,
  require,
);
const { renderSpiral } = moduleShim.exports;

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

const plan = {
  events: [
    { uid: "ev-1", string: "Standup", start: 480, end: 510, meeting: true, done: false },
    { uid: "ev-2", string: "Lunch", start: 720, end: 780, meeting: true, done: false },
  ],
  tasks: [
    { uid: "tk-1", string: "Write report", duration: 60, done: false },
  ],
  malformed: [],
};

const capacity = {
  availableMinutes: 0,
  demandMinutes: 0,
  overloadMinutes: 0,
  slackMinutes: 0,
  unplacedMinutes: 0,
  fixedMinutes: 0,
  totalAvailableMinutes: 0,
  totalFixedMinutes: 0,
  burningBucket: null,
  scheduledTasks: [
    { uid: "tk-1", string: "Write report", duration: 60, done: false, start: 540, end: 600 },
    { uid: "tk-2", string: "Read", duration: 30, done: false, start: 600, end: 630 },
    { uid: "tk-3", string: "Email", duration: 45, done: false, start: 660, end: 705 },
  ],
  overflowTasks: [],
};

const settings = {
  language: "en",
  workdayStartHour: 5,
  workdayEndHour: 21,
  descLength: 22,
  todoDuration: 15,
  urgentTrigger: "",
};

/* ------------------------------------------------------------------ */
/* Tests                                                               */
/* ------------------------------------------------------------------ */

test("renderSpiral produces an <svg> with one group per event and task", () => {
  globalThis.document = documentShim;
  const container = makeContainer();

  renderSpiral(container, plan, capacity, settings, 600);

  const html = container.innerHTML;

  assert.match(html, /<svg/, "container should contain an <svg>");
  assert.match(html, /nautilus-log-svg/, "svg should carry the .nautilus-log-svg class");

  const eventSlices = (html.match(/class="nautilus-log-event-slice-group/g) || []).length;
  const taskSlices = (html.match(/class="nautilus-log-task-slice-group/g) || []).length;

  assert.strictEqual(
    eventSlices,
    plan.events.length,
    "event slice groups should equal the number of fixed events",
  );
  assert.strictEqual(
    taskSlices,
    capacity.scheduledTasks.length,
    "task slice groups should equal the number of scheduled tasks",
  );
});

test("renderSpiral still emits an <svg> for an empty plan", () => {
  globalThis.document = documentShim;
  const container = makeContainer();

  renderSpiral(
    container,
    { events: [], tasks: [], malformed: [] },
    { ...capacity, scheduledTasks: [] },
    settings,
    600,
  );

  assert.match(container.innerHTML, /<svg/, "empty plan still renders an <svg>");
});
