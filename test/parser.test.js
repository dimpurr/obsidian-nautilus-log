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

test('🔴🔴 有 canvas 的环境下也不许把正文截没（真实浏览器路径）', () => {
  // truncateTextToWidth 默认用 canvas 按【像素】测量。descLength 是【字符数】，
  // 直接传进去 => 22 被当成 22 像素 ≈ 两个字符宽 => 正文只剩 "…"。
  // 🔴 jsdom 没有 canvas，会退化成按字符计宽，所以这个 bug 在测试里【永远复现不出】。
  //    这里显式装一个假 canvas，把真实浏览器那条路径逼出来。
  const saved = global.document;
  global.document = {
    createElement: () => ({ getContext: () => ({ measureText: (t) => ({ width: t.length * 7 }) }) }),
  };
  try {
    const out = parser.taskDescription('- [ ] Nautilus Log 插件完善 30m', 22);
    assert.ok(out.length > 1 && out !== '…', `正文被像素测量截没了: ${out}`);
    assert.match(out, /Nautilus Log/);
  } finally {
    global.document = saved;
  }
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

// ────────────────────────────────────────────────────────────────────────────
// d50% 进度（audit §P1-3）
// ────────────────────────────────────────────────────────────────────────────

test('d50% => progress 50，duration 保持【原始估计】', () => {
  const { tasks } = parser.parsePlan('- [ ] 写周报 60m d50%', { sourcePath: 'f.md', settings: DEFAULTS });
  assert.equal(tasks[0].progress, 50);
  assert.equal(tasks[0].duration, 60, 'duration 不能被解析器先折减一次');
});

test('🔑 progress 折减的是【剩余时长】，由引擎自己算', () => {
  const { tasks } = parser.parsePlan('- [ ] 写周报 60m d50%', { sourcePath: 'f.md', settings: DEFAULTS });
  const cap = logCore.calculateCapacity({
    startMinutes: 300, endMinutes: 1260, nowMinutes: 720,
    fixedEvents: [], allFixedEvents: [], pendingTasks: tasks,
  });
  assert.equal(cap.demandMinutes, 30, '引擎 remainingDuration 应折掉一半');
});

test('无 d 百分号 token => 不带 progress 字段（保持缺省语义）', () => {
  const { tasks } = parser.parsePlan('- [ ] 写周报 60m', { sourcePath: 'f.md', settings: DEFAULTS });
  assert.equal('progress' in tasks[0], false);
});

test('d150% 夹到 100（对齐 timing-core taskProgress）', () => {
  const { tasks } = parser.parsePlan('- [ ] 写周报 60m d150%', { sourcePath: 'f.md', settings: DEFAULTS });
  assert.equal(tasks[0].progress, 100);
});

test('进度 token 不进图例', () => {
  assert.equal(parser.taskDescription('- [ ] 写周报 60m d50%', 22), '写周报');
});

// ────────────────────────────────────────────────────────────────────────────
// 紧急触发词：词边界 + 去空格（audit §P1-8）
// ────────────────────────────────────────────────────────────────────────────

const withTrigger = (trigger) => ({ ...DEFAULTS, urgentTrigger: trigger });
const isUrgent = (text, trigger) =>
  parser.parsePlan(text, { sourcePath: 'f.md', settings: withTrigger(trigger) }).tasks[0].urgent === true;

test('触发词作为独立 token 才命中（英文）', () => {
  assert.equal(isUrgent('- [ ] urgent 写周报 30m', 'urgent'), true);
  assert.equal(isUrgent('- [ ] 写周报 urgent', 'urgent'), true);
});

test('🔴 英文子串不得误判（urgently / nonurgent）', () => {
  assert.equal(isUrgent('- [ ] act urgently 30m', 'urgent'), false);
  assert.equal(isUrgent('- [ ] nonurgent 30m', 'urgent'), false);
});

test('🔴 中文子串不得误判（“紧急处理”不算触发词“紧急”）', () => {
  assert.equal(isUrgent('- [ ] 紧急处理邮件 30m', '紧急'), false);
  assert.equal(isUrgent('- [ ] 写周报 紧急 30m', '紧急'), true);
});

test('设置里的空格被去掉（对齐上游 index.js:349）', () => {
  assert.equal(isUrgent('- [ ] 写周报 #紧急 30m', ' #紧 急 '), true);
});

test('空触发词永不命中', () => {
  assert.equal(isUrgent('- [ ] 写周报 30m', ''), false);
  assert.equal(isUrgent('- [ ] 写周报 30m', '   '), false);
});

test('触发词含正则元字符不得炸（转义）', () => {
  assert.doesNotThrow(() => isUrgent('- [ ] 写周报 30m', 'a+(b'));
  assert.equal(isUrgent('- [ ] a+(b 写周报 30m', 'a+(b'), true);
});

// ────────────────────────────────────────────────────────────────────────────
// warningCode 不再被丢弃（audit §P1-8）
// ────────────────────────────────────────────────────────────────────────────

test('起止相同的时间段带出 warning', () => {
  const plan = parser.parsePlan('09:00-09:00 会议', { sourcePath: 'f.md', settings: DEFAULTS });
  assert.equal(plan.warnings.length, 1);
  assert.equal(plan.warnings[0].code, 'sameTime');
  assert.equal(plan.warnings[0].line, 0);
  assert.equal(plan.warnings[0].uid, 'f.md:0');
  assert.equal(plan.warnings[0].message, logCore.uiCopy('en').warnings.sameTime);
});

test('warning 文案跟随语言（取引擎自己的 i18n 表）', () => {
  const plan = parser.parsePlan('09:00-09:00 会议', {
    sourcePath: 'f.md', settings: { ...DEFAULTS, language: 'zh' },
  });
  assert.equal(plan.warnings[0].message, logCore.uiCopy('zh').warnings.sameTime);
});

test('warning 的 line 用 lineOffset 后的真实行号', () => {
  const plan = parser.parsePlan('- [ ] 正常 30m\n09:00-09:00 会议', {
    sourcePath: 'f.md', settings: DEFAULTS, lineOffset: 10,
  });
  assert.equal(plan.warnings[0].uid, 'f.md:11');
});

test('正常计划 warnings 为空数组（不是 undefined）', () => {
  const plan = parser.parsePlan('09:00-10:00 会议\n- [ ] 写周报 30m', { sourcePath: 'f.md', settings: DEFAULTS });
  assert.deepEqual(plan.warnings, []);
});

// ────────────────────────────────────────────────────────────────────────────
// 认证审计 L1-031 · 图例/溢出面板不得显示时间段 token
// ────────────────────────────────────────────────────────────────────────────

test('L1-031 taskDescription 剥掉时间区间（上游 :description 就是 cleaned-str）', () => {
  // 回退验证：把 stripTaskTokens 里的 parseTimeRangeToken 那两行删掉 => 这条挂。
  assert.equal(parser.taskDescription('- 08:30-09:30 起床', 22), '起床');
  assert.equal(parser.taskDescription('08:30-09:30 起床', 22), '起床');
  assert.equal(parser.taskDescription('- [x] 12:30-14:00 Lunch with Ada', 22), 'Lunch with Ada');
});

test('L1-031 区间剥离走引擎的 token 文法，不是自写正则', () => {
  // 自写的 /\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2}/ 一条都盖不住这些形状 ——
  // 这正是「两份实现」必然漂移的证据（引擎 TIME_RANGE_TOKEN_RE）。
  assert.equal(parser.taskDescription('9am-10am Standup', 22), 'Standup');
  assert.equal(parser.taskDescription('9–10 Deep work', 22), 'Deep work');
  assert.equal(parser.taskDescription('13:00 to 14:00 Review', 22), 'Review');
});

test('L1-031 区间被剥掉后 descLength 预算全给正文', () => {
  // 带区间时旧实现要用 11 格宽去放 "08:30-09:30 "，正文当场被截。
  const out = parser.taskDescription('- 08:30-09:30 Nautilus Log 插件完善', 22);
  assert.equal(out, 'Nautilus Log 插件完善');
});

test('L1-031 没有区间的行原样保留（parseTimeRangeToken 返回 null 时不动）', () => {
  assert.equal(parser.taskDescription('- [ ] 写周报 30m', 22), '写周报');
  assert.equal(parser.taskDescription('- [ ] 09:00 写周报 30m', 22), '09:00 写周报');
});

// ────────────────────────────────────────────────────────────────────────────
// 认证审计 P1-068（契约漏洞 2）· dHH:MM 解析与剥离必须同一套语法
// ────────────────────────────────────────────────────────────────────────────

test('P1-068 能解析成锚点的写法一定能被剥掉（分钟可省 / 大小写不敏感）', () => {
  for (const line of ['- [x] 写稿 30m d14:30', '- [x] 写稿 30m d14', '- [x] 写稿 30m D14:30', '- [x] 写稿 30m D9']) {
    const { tasks } = parser.parsePlan(line, { sourcePath: 'f.md', settings: DEFAULTS });
    assert.ok(typeof tasks[0].doneAt === 'number', `${line} 应被解析成锚点`);
    assert.equal(parser.taskDescription(line, 22), '写稿', `${line} 的锚点没剥干净`);
  }
});

// ────────────────────────────────────────────────────────────────────────────
// 认证审计 C2-107 / C2-103 · 警告面板的左栏与数据面
// ────────────────────────────────────────────────────────────────────────────

test('C2-107 warning 带上任务标题（上游 component.cljs:1699 的 :description）', () => {
  const plan = parser.parsePlan('- 09:00-09:00 每日站会', { sourcePath: 'f.md', settings: DEFAULTS });
  assert.equal(plan.warnings.length, 1);
  assert.equal(plan.warnings[0].text, '每日站会',
    'text 缺失 ⇒ compact.ts describeWarning 恒退回 L{n} 行号');
});

test('C2-107 钉住事件（只写开始时刻）的 warning 同样带标题', () => {
  const plan = parser.parsePlan('- [ ] 09:00 写周报 0m', { sourcePath: 'f.md', settings: { ...DEFAULTS, todoDuration: 0 } });
  for (const w of plan.warnings) assert.equal(typeof w.text, 'string');
});

test('C2-103 已完成的行不进警告面板（上游只喂未完成的 text-events）', () => {
  const plan = parser.parsePlan(
    '- [x] 09:00-09:00 已开完的会\n- [ ] 10:00-10:00 还没开的会',
    { sourcePath: 'f.md', settings: DEFAULTS },
  );
  assert.equal(plan.warnings.length, 1, '勾掉的行不该再报排期问题');
  assert.equal(plan.warnings[0].uid, 'f.md:1');
});

// ────────────────────────────────────────────────────────────────────────────
// 认证审计 L1-042 · language 归一化（非 'zh' 一律 'en'）
// ────────────────────────────────────────────────────────────────────────────

test('L1-042 未知语言归一到 en（引擎 uiCopy 未知语言会退中文）', () => {
  assert.equal(parser.normalizeLanguage('de'), 'en');
  assert.equal(parser.normalizeLanguage(undefined), 'en');
  assert.equal(parser.normalizeLanguage('zh'), 'zh');
  // 端到端：data.json 被手改成 "de" 时，警告文案必须是英文，
  // 否则同一个块里 LOCAL_COPY 出英文、引擎文案出中文，当场分叉。
  const plan = parser.parsePlan('09:00-09:00 会议', {
    sourcePath: 'f.md', settings: { ...DEFAULTS, language: 'de' },
  });
  assert.equal(plan.warnings[0].message, logCore.uiCopy('en').warnings.sameTime);
  assert.notEqual(plan.warnings[0].message, logCore.uiCopy('zh').warnings.sameTime);
});
