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

/* 🔴 style 夹具必须和真实 CSSStyleDeclaration 一样【不宽容】：
 *    自定义属性（`--pb-delay`）只能经 setProperty 设置，直接赋值静默无效。
 *    用普通对象当 style 会让 `style['--pb-delay']=x` 看起来成功 ——
 *    正是「夹具比现实更理想 => 真机才炸」那一类（PORTING-DECISIONS §8）。 */
function makeStyleShim() {
  const store = {};
  const setProperty = (name, value) => { store[name] = String(value); };
  return new Proxy(store, {
    set(target, key, value) {
      if (typeof key === "string" && key.startsWith("--")) return true;   // 静默丢弃
      target[key] = String(value);
      return true;
    },
    get(target, key) {
      if (key === "setProperty") return setProperty;
      return target[key];
    },
  });
}

function makeElement(tag) {
  const attrs = {};
  const children = [];
  const style = makeStyleShim();
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
  // 🔴 真实 document 两个都有。紧凑列表（compact.ts）走的是 createElement，
  //    早期 shim 只给了 createElementNS —— 又一次「夹具比现实更窄」，
  //    接线时整片 spiral 测试直接炸。见 PORTING-DECISIONS.md §8。
  createElement(tag) {
    const el = makeElement(tag);
    // log-core 的 truncateTextToWidth 会 `createElement('canvas').getContext('2d')`。
    // 真实浏览器里拿得到 2d 上下文（按像素量），Node 里拿不到 —— 返回 null 让它
    // 退到 fallbackTextWidth（按字符量）。缺这个方法会直接抛。
    if (tag === "canvas") el.getContext = () => null;
    return el;
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
const { renderSpiral, TOOLTIP_ANCHOR_RADIUS } = moduleShim.exports;

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
    // 原始整行 markdown（复选框 + 时长 token）—— P1-1 要求盘上只显示清洗后的正文。
    { uid: "tk-1", string: "- [ ] Write report 60m", duration: 60, done: false, start: 540, end: 600 },
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

  // P1-8：上游对事件与任务【用同一个类名】(component.cljs:1080)。
  const groups = (html.match(/class="nautilus-log-event-slice-group/g) || []).length;
  assert.strictEqual(
    groups,
    plan.events.length + capacity.scheduledTasks.length,
    "每个事件 / 每个已排程任务各一个切片组",
  );
});

/* ------------------------------------------------------------------ */
/* P1-1 盘上标签必须是清洗后的文本                                     */
/* ------------------------------------------------------------------ */

test("P1-1 引线标签用清洗后的描述，不是整行 markdown", () => {
  globalThis.document = documentShim;
  const container = makeContainer();
  renderSpiral(container, plan, capacity, settings, 600);
  const html = container.innerHTML;

  assert.match(html, />Write report</,
    "标签应是 `Write report`（复选框与时长 token 都已剥掉）");
  assert.ok(!/Write report 60m/.test(html),
    "时长 token 不该出现在盘上");
  assert.ok(!/\[ \]/.test(html),
    "复选框标记不该出现在盘上 —— 这正是截图里那条 `- [x] …`");
});

/* ------------------------------------------------------------------ */
/* P1-3 进度网点叠层                                                   */
/* ------------------------------------------------------------------ */

test("P1-3 progress>0 的任务叠一层网点，=0 的不叠", () => {
  globalThis.document = documentShim;
  const withProgress = {
    ...capacity,
    scheduledTasks: [
      { uid: "p-1", string: "- [ ] Half done 60m", duration: 60, done: false,
        progress: 50, start: 540, end: 600 },
      { uid: "p-2", string: "- [ ] Untouched 30m", duration: 30, done: false,
        start: 600, end: 630 },
    ],
  };
  const container = makeContainer();
  renderSpiral(container, { events: [], tasks: [], malformed: [] }, withProgress, settings, 600);
  const html = container.innerHTML;

  assert.match(html, /<pattern id="nautilus-log-dot-pattern"/,
    "网点图案的 <defs> 必须发出来，否则 url(#…) 解析不到");
  const dots = (html.match(/nautilus-log-slice-progress/g) || []).length;
  assert.strictEqual(dots, 1, "只有 progress>0 的那一条该叠网点");
  assert.match(html, /fill="url\(#nautilus-log-dot-pattern\)"/,
    "叠层必须用网点图案填充");
});

/* ------------------------------------------------------------------ */
/* P1-5 回放逐片动画                                                   */
/* ------------------------------------------------------------------ */

test("P1-5① playback-active 挂在 <svg> 上（不是按钮）", () => {
  globalThis.document = documentShim;
  const idle = makeContainer();
  renderSpiral(idle, plan, capacity, settings, 600);
  assert.ok(!/nautilus-log-playback-active/.test(idle.innerHTML),
    "没在回放时不该有这个类");

  const playing = makeContainer();
  renderSpiral(playing, plan, capacity, settings, 600, { playbackMinute: 700 });
  assert.match(playing.innerHTML, /class="nautilus-log-svg nautilus-log-playback-active"/,
    "styles.css:778 要求它是 .nautilus-log-slice 的【祖先】—— 只能在 <svg> 上");
});

test("P1-5② 每个切片带 --pb-delay（起始分钟 / 1440 * 6 秒）", () => {
  globalThis.document = documentShim;
  const container = makeContainer();
  renderSpiral(container, plan, capacity, settings, 600, { playbackMinute: 700 });
  const html = container.innerHTML;
  // tk-1 起于 540 => 540/1440*6 = 2.25s。三处都要有（上游 component.cljs:861/872/882），
  // 因为 styles.css:778-780 分别对 .nautilus-log-slice / -slice-group text / -link-line 生效。
  assert.match(html, /<path[^>]*class="nautilus-log-slice"[^>]*style="[^"]*--pb-delay:2\.25s/,
    "切片本体的 animation-delay 恒为 0 就没有「逐片亮起」，只是一起淡入");
  assert.match(html, /<g class="nautilus-log-slice-group" style="--pb-delay:2\.25s"/,
    "引线与标签也要错峰，否则文字先于切片全部出现");
  // ev-1 起于 480 => 2s
  assert.match(html, /--pb-delay:2s/, "不同起始时间必须给出不同的延迟");
});

/* ------------------------------------------------------------------ */
/* P1-8 类名对齐 / 紧凑模式 a11y / 盘心第一行                          */
/* ------------------------------------------------------------------ */

test("P1-8 任务切片不再用自造类名，且宽容器下带 --interactive", () => {
  globalThis.document = documentShim;
  const container = makeContainer();
  renderSpiral(container, plan, capacity, settings, 600);
  const html = container.innerHTML;
  assert.ok(!/nautilus-log-task-slice-group/.test(html),
    "styles.css 里这个名字 0 条规则 —— 任务切片的 hover/focus 高亮会全部落空");
  assert.match(html, /nautilus-log-event-slice-group--interactive/,
    "hover 可用时上游加 --interactive（component.cljs:1081）");
});

test("P1-8 紧凑模式不挂 tabindex/role（没有浮层可显示）", () => {
  globalThis.document = documentShim;
  const container = makeContainer();
  container.clientWidth = 360;   // <= 520 => isCompactChartWidth
  renderSpiral(container, plan, capacity, settings, 600);
  const html = container.innerHTML;
  assert.ok(!/nautilus-log-event-slice-group--interactive/.test(html),
    "紧凑时 hover 被关掉，不该再宣称 interactive");
  assert.ok(!/<g class="nautilus-log-event-slice-group[^"]*"[^>]*tabindex/.test(html),
    "无条件 tabindex 会给键盘用户留一串停不下来的空焦点");
});

test("P1-8 盘心第一行是页名（逗号切两段、每段截 16 字）", () => {
  globalThis.document = documentShim;
  const blank = makeContainer();
  renderSpiral(blank, plan, capacity, settings, 600);
  assert.match(blank.innerHTML, /nautilus-log-center-date/, "盘心分组仍在");

  const named = makeContainer();
  renderSpiral(named, plan, capacity, settings, 600, { pageTitle: "2026-08-25" });
  assert.match(named.innerHTML, />2026-08-25</, "页名必须真的画出来（原先恒为空串）");

  const long = makeContainer();
  renderSpiral(long, plan, capacity, settings, 600,
    { pageTitle: "0123456789ABCDEFGH,second" });
  assert.match(long.innerHTML, />0123456789ABCDEF</,
    "上游 len-central-legend = 16，且只取逗号前的第一段");
  assert.ok(!/second/.test(long.innerHTML), "逗号后的第二段不进第一行");
});

/* ------------------------------------------------------------------ */
/* P1-9① tooltip 锚点半径                                             */
/* ------------------------------------------------------------------ */

test("P1-9① hover 锚点半径 = 8 + 最大外径，不是内圈 50", () => {
  assert.strictEqual(TOOLTIP_ANCHOR_RADIUS, 158,
    "上游 component.cljs:427 传 (+ 8 max-outer-radius)；传内圈 50 会把提示锚在盘面【内部】");
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

/* ------------------------------------------------------------------ */
/* 空闲时段 hover 预览（availableSlotGroups）                          */
/* ------------------------------------------------------------------ */
/* 🔴 类名与结构必须是上游那套：外层 .nautilus-log-available-slot 一组一个、
 *    内层每个整点分片一个 .nautilus-log-available-slot-hit。styles.css 里
 *    这套规则（含 --now 修饰与 hover 高亮）早就移植好了，另造名字就白写。 */

function slotGroups(html) {
  return (html.match(/class="nautilus-log-available-slot(?![-s])[^"]*"/g) || []);
}
function slotLabels(html) {
  return (html.match(/aria-label="[^"]*"/g) || [])
    .filter((a) => /Available/.test(a))
    .map((a) => a.slice('aria-label="'.length, -1));
}

test("空闲时段：占用区间的补集，且裁到此刻之后", () => {
  globalThis.document = documentShim;
  const container = makeContainer();
  renderSpiral(container, plan, capacity, settings, 600);
  const html = container.innerHTML;

  // 工作日 5:00–21:00 = 300..1260；占用 = 480-510 / 540-630 / 660-705 / 720-780
  // now = 600 => 600 之前的空档（300-480、510-540）不该出现。
  const labels = slotLabels(html);
  assert.deepEqual(
    labels.map((l) => l.replace(/^Available slot /, "").replace(/ \S+$/, "")),
    ["10:30–11:00", "11:45–12:00", "13:00–21:00"],
    "只应留下此刻之后的三段空档",
  );
  assert.equal(slotGroups(html).length, 3, "一段连续空档 = 一个 group");
});

test("空闲时段：整段报时长，不是单个格子", () => {
  globalThis.document = documentShim;
  const container = makeContainer();
  renderSpiral(container, plan, capacity, settings, 600);
  const last = slotLabels(container.innerHTML).pop();
  // 13:00–21:00 跨 8 个整点，会切成 8 个 hit 分片，但报的必须是整段 8h。
  assert.match(last, /13:00–21:00 8h$/,
    "这个特性的价值就是「这儿还能塞下多长的活」，报单格时长等于没做");
  const hits = (container.innerHTML.match(/nautilus-log-available-slot-hit/g) || []).length;
  assert.ok(hits > slotGroups(container.innerHTML).length,
    "分片数应多于组数（按整点切开，与盘上格子对齐）");
});

test("空闲时段：过去的日子不给预览", () => {
  globalThis.document = documentShim;
  const container = makeContainer();
  renderSpiral(container, plan, capacity, settings, 600, {
    dayState: {
      relation: "past",
      timelineMinutes: 1260,
      scheduleFromMinutes: 300,
      capacityFromMinutes: 1260,
      elapsedThroughMinutes: 1260,
      showNow: false,
      showElapsed: true,
    },
  });
  assert.equal(slotGroups(container.innerHTML).length, 0,
    "「昨天还剩多少空档」没有意义");
});

test("空闲时段：未来的日子整天都算空着", () => {
  globalThis.document = documentShim;
  const container = makeContainer();
  renderSpiral(container, plan, capacity, settings, 600, {
    dayState: {
      relation: "future",
      timelineMinutes: 300,
      scheduleFromMinutes: 300,
      capacityFromMinutes: 300,
      elapsedThroughMinutes: 300,
      showNow: false,
      showElapsed: false,
    },
  });
  const labels = slotLabels(container.innerHTML);
  assert.ok(/^Available slot 05:00–08:00/.test(labels[0]),
    "看明天时不裁到「此刻」，第一段空档应从工作日起点算起");
});

/* ------------------------------------------------------------------ */
/* P0-4 已完成任务的「实际耗时」切片 · P0-5 排程起点与容量起点分开     */
/* ------------------------------------------------------------------ */

test("P0-4 没有 dHH:MM 锚点但打过卡的已完成任务，仍能用 CLOCK 画出来", () => {
  globalThis.document = documentShim;
  const container = makeContainer();
  const donePlan = {
    events: [],
    // 🔴 没有 doneAt —— 早期实现会 return null 直接不画
    tasks: [{ uid: "tk-done", string: "{{DONE}} 写周报 60m", duration: 60, done: true }],
    malformed: [],
  };
  const base = new Date(); base.setHours(0, 0, 0, 0);
  const ms = (min) => base.getTime() + min * 60000;
  renderSpiral(container, donePlan, { ...capacity, scheduledTasks: [] }, settings, 700, {
    clockEntries: [
      { taskUid: "tk-done", start: ms(600), end: ms(645), running: false },
    ],
  });
  assert.match(container.innerHTML, /nautilus-log-event-slice-group/,
    "有完整 CLOCK 记录就该画出历史切片，不该因为缺 dHH:MM 而消失");
});

test("P0-4 没有 CLOCK 记录时退回纯估计值（不炸、不编造）", () => {
  globalThis.document = documentShim;
  const container = makeContainer();
  const donePlan = {
    events: [],
    tasks: [{ uid: "tk-done", string: "{{DONE}} 写周报 60m", duration: 60, done: true }],
    malformed: [],
  };
  // 不传 clockEntries：引擎「不编造历史」，没锚点就不画 —— 这是上游立场
  renderSpiral(container, donePlan, { ...capacity, scheduledTasks: [] }, settings, 700, {});
  assert.doesNotMatch(container.innerHTML, /nautilus-log-event-slice-group/,
    "既无锚点又无 CLOCK 时不画，是上游的明确立场（does not invent history）");
});

/* ------------------------------------------------------------------ */
/* RQ-6 夹具必须至少和真实 document 一样宽                            */
/* ------------------------------------------------------------------ */
/* 真实 document 同时有 createElementNS（SVG）与 createElement（HTML），
 * 且 createElement('canvas').getContext 一定存在。早期 shim 只给了前者，
 * 接紧凑列表时整片 spiral 测试直接抛 'document.createElement is not a
 * function' —— 这类「夹具比现实窄」的会大声炸，成本低；真正危险的是反过来。
 * 见 test/reality-quirks.md RQ-6。 */
test("RQ-6 documentShim 覆盖真实 document 的必需面（createElement + canvas.getContext）", () => {
  assert.equal(typeof documentShim.createElementNS, "function");
  assert.equal(typeof documentShim.createElement, "function",
    "紧凑列表（compact.ts）走的是 createElement");
  const canvas = documentShim.createElement("canvas");
  assert.equal(typeof canvas.getContext, "function",
    "log-core 的 truncateTextToWidth 会 createElement('canvas').getContext('2d')；"
    + "缺这个方法会直接抛，而不是退到 fallbackTextWidth");
  assert.equal(canvas.getContext("2d"), null,
    "Node 里拿不到 2d 上下文 —— 返回 null 让引擎按【字符数】兜底，"
    + "真实 Electron 里拿得到、按【像素】量（parser.test.js 那条钉的就是这个差异）");
});
