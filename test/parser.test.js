/*
 * Parser tests for stage one.  `src/parser.ts` is TypeScript, but the test
 * command is a plain `node --test` (no type-stripping flag), so we load the
 * parser by transforming it in memory with esbuild (a devDependency) and
 * evaluating it against a require bound to `src/` so its `./vendor/log-core`
 * import resolves.  The vendored engine itself is a plain CJS module and is
 * required directly.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { createRequire } = require('node:module');
const esbuild = require('esbuild');

const SRC = path.join(__dirname, '..', 'src');
const logCore = require(path.join(SRC, 'vendor', 'log-core.js'));

function loadParser() {
  const entry = path.join(SRC, 'parser.ts');
  const { code } = esbuild.transformSync(fs.readFileSync(entry, 'utf8'), {
    loader: 'ts',
    format: 'cjs',
    target: 'es2018',
  });
  const srcRequire = createRequire(path.join(SRC, '_parser_loader.js'));
  const module = { exports: {} };
  // eslint-disable-next-line no-new-func
  const fn = new Function('require', 'module', 'exports', code);
  fn(srcRequire, module, module.exports);
  return module.exports;
}

const parser = loadParser();

const DEFAULTS = {
  language: 'en',
  workdayStartHour: 5,
  workdayEndHour: 21,
  descLength: 22,
  todoDuration: 15,
  urgentTrigger: '',
};

test('parses the 5-line sample into 2 events + 3 tasks, order preserved', () => {
  const source = [
    '05:00-06:00 Morning routine',
    '- [ ] Write project brief 45m',
    '- [ ] Review notes 30m',
    '11:45-12:30 Lunch',
    '- [ ] Reply to email',
  ].join('\n');
  const plan = parser.parsePlan(source, { sourcePath: 'daily/2026-08-24.md', settings: DEFAULTS });

  assert.equal(plan.events.length, 2);
  assert.equal(plan.tasks.length, 3);
  assert.equal(plan.malformed.length, 0);

  // Order preserved exactly as written.
  assert.equal(plan.events[0].string, '05:00-06:00 Morning routine');
  assert.equal(plan.events[1].string, '11:45-12:30 Lunch');
  assert.equal(plan.tasks[0].string, '- [ ] Write project brief 45m');
  assert.equal(plan.tasks[1].string, '- [ ] Review notes 30m');
  assert.equal(plan.tasks[2].string, '- [ ] Reply to email');

  // Events are meetings; clock minutes land in the 05:00-21:00 window.
  assert.equal(plan.events[0].meeting, true);
  assert.equal(plan.events[0].done, false);
  assert.equal(plan.events[0].start, 300);
  assert.equal(plan.events[0].end, 360);
  assert.equal(plan.events[1].start, 705);
  assert.equal(plan.events[1].end, 750);

  // Tasks keep their explicit durations.
  assert.equal(plan.tasks[0].duration, 45);
  assert.equal(plan.tasks[1].duration, 30);
});

test('untimed task falls back to todoDuration', () => {
  const plan = parser.parsePlan('- [ ] Reply to email', { sourcePath: 'f.md', settings: DEFAULTS });
  assert.equal(plan.tasks.length, 1);
  assert.equal(plan.tasks[0].duration, 15);
});

test('parses the "9 to 10:45" range form', () => {
  const plan = parser.parsePlan('9 to 10:45 Standup', { sourcePath: 'f.md', settings: DEFAULTS });
  assert.equal(plan.events.length, 1);
  assert.equal(plan.events[0].meeting, true);
  assert.equal(plan.events[0].start, 540);
  assert.equal(plan.events[0].end, 645);
});

test('completed checkbox sets done true; description strips markers', () => {
  const plan = parser.parsePlan('- [x] Done task 20m', { sourcePath: 'f.md', settings: DEFAULTS });
  assert.equal(plan.tasks[0].done, true);
  assert.equal(plan.tasks[0].duration, 20);
  assert.equal(parser.taskDescription('- [x] Done task 20m', 22), 'Done task');
});

test('unparseable line is captured in malformed, not dropped', () => {
  const plan = parser.parsePlan('some freeform note', { sourcePath: 'f.md', settings: DEFAULTS });
  assert.equal(plan.events.length, 0);
  assert.equal(plan.tasks.length, 0);
  assert.equal(plan.malformed.length, 1);
  assert.equal(plan.malformed[0].line, 0);
  assert.equal(plan.malformed[0].text, 'some freeform note');
});

test('stuffed tasks drive calculateCapacity overloadMinutes > 0', () => {
  const lines = ['09:00-17:00 Work'];
  for (let i = 0; i < 6; i += 1) lines.push(`- [ ] Task ${i} 100m`);
  const plan = parser.parsePlan(lines.join('\n'), { sourcePath: 'f.md', settings: DEFAULTS });

  assert.equal(plan.events.length, 1);
  assert.equal(plan.tasks.length, 6);

  const capacity = logCore.calculateCapacity({
    startMinutes: 300,
    endMinutes: 1260,
    nowMinutes: 300,
    fixedEvents: plan.events,
    allFixedEvents: plan.events,
    pendingTasks: plan.tasks,
  });

  // 6x100m demand (600) vs 480 available after the 09:00-17:00 event.
  assert.equal(capacity.demandMinutes, 600);
  assert.equal(capacity.availableMinutes, 480);
  assert.ok(capacity.overloadMinutes > 0);
  assert.equal(capacity.overloadMinutes, 120);
});

test('overnight window 21:00-02:00 normalizes end to 1560, not 120', () => {
  const schedule = logCore.normalizeScheduleSettings({ startHour: 21, endHour: 2 });
  assert.equal(schedule.startMinutes, 1260);
  assert.equal(schedule.endMinutes, 1560);
});

test('🔴 descLength 非法时不得吞掉正文（只剩 "…"）', () => {
  // truncateTextToWidth 在 maxWidth 为 0/NaN/undefined 时返回单个 "…"，
  // 且不报错 —— 界面上表现为 `· ... 30m`，正文整个消失。
  for (const w of [0, NaN, undefined, -5]) {
    const out = parser.taskDescription('- [ ] Nautilus Log 插件完善 30m', w);
    assert.ok(out.length > 1 && out !== '…', `descLength=${w} 时正文被吞: ${out}`);
    assert.match(out, /Nautilus Log/);
  }
});

test('descLength 正常时照常截断', () => {
  assert.equal(parser.taskDescription('- [ ] Nautilus Log 插件完善 30m', 22), 'Nautilus Log 插件完善');
  assert.match(parser.taskDescription('- [ ] 办理 EE 路由器 final bill / 研究新家网络', 22), /…$/);
});
