const test = require('node:test'), assert = require('node:assert/strict');
const esbuild = require('esbuild'), path = require('path');

// DEFAULT_SETTINGS lives in the TS contract — bundle it to CJS. It has no
// runtime imports, so this is a straight passthrough.
esbuild.buildSync({
  entryPoints: [path.join(__dirname, '../src/contract.ts')],
  bundle: true, format: 'cjs', platform: 'node',
  outfile: path.join(__dirname, '.contract.cjs'),
  external: ['obsidian'], logLevel: 'error',
});
const { DEFAULT_SETTINGS } = require('./.contract.cjs');

// clampMinutes lives in settings.ts. That file imports obsidian + main
// (type-only, stripped by esbuild) and obsidian at runtime — alias obsidian
// to a stub so it loads under node.
esbuild.buildSync({
  entryPoints: [path.join(__dirname, '../src/settings.ts')],
  bundle: true, format: 'cjs', platform: 'node',
  outfile: path.join(__dirname, '.settings.cjs'),
  alias: { obsidian: path.join(__dirname, 'obsidian-mock.cjs') },
  logLevel: 'error',
});
const {
  clampMinutes, DESC_LENGTH_SLIDER, POMODORO_SLIDER, workdayEndLabel, workdayEndDesc,
} = require('./.settings.cjs');

// All 11 keys, with the exact defaults pinned in the task table.
const EXPECTED = {
  language: 'en',
  workdayStartHour: 5,
  workdayEndHour: 21,
  descLength: 22,
  todoDuration: 15,
  urgentTrigger: '',
  actualTimeTracking: false,
  timingLineSidebar: true,
  pomodoroMinutes: 45,
  recentRetentionMinutes: 45,
  forgottenTimerMinutes: 120,
};

test('DEFAULT_SETTINGS 覆盖全部 11 个键', () => {
  const keys = Object.keys(DEFAULT_SETTINGS);
  for (const k of Object.keys(EXPECTED)) {
    assert.ok(keys.includes(k), `缺少键: ${k}`);
  }
  assert.equal(keys.length, 11, `应恰好 11 个键，实得 ${keys.length}`);
});

test('DEFAULT_SETTINGS 默认值与会表一致', () => {
  for (const [k, v] of Object.entries(EXPECTED)) {
    assert.equal(DEFAULT_SETTINGS[k], v, `键 ${k} 默认值错误`);
  }
});

test('clampMinutes: 只有显式 allowZero 的项才接受 0（照上游逐项语义）', () => {
  // guide §Settings 那张表逐项写明：
  //   Recent Retention        45 minutes; `0` disables
  //   Forgotten Timer Warning 120 minutes; `0` disables
  //   Pomodoro Threshold      45 minutes        <- 没有 `0` disables
  assert.equal(clampMinutes(0, 1440, 45, true), 0, 'Recent Retention 可关闭');
  assert.equal(clampMinutes(0, 1440, 120, true), 0, 'Forgotten Timer 可关闭');
  assert.equal(clampMinutes(0, 180, 45), 45,
    '番茄钟阈值没有关闭语义；若允许 0，「到点变红」在每一刻都成立');
});

test('clampMinutes: 负数退回默认值', () => {
  assert.equal(clampMinutes(-5, 180, 45), 45);
  assert.equal(clampMinutes(-1, 1440, 120), 120);
});

test('clampMinutes: NaN / 非数字退回默认值', () => {
  assert.equal(clampMinutes(NaN, 180, 45), 45);
  assert.equal(clampMinutes(undefined, 180, 45), 45);
  assert.equal(clampMinutes(null, 180, 45), 45);
  assert.equal(clampMinutes('45', 180, 45), 45);
  assert.equal(clampMinutes(Number.POSITIVE_INFINITY, 180, 45), 45);
});

test('clampMinutes: 超上限退回默认值', () => {
  assert.equal(clampMinutes(181, 180, 45), 45);
  assert.equal(clampMinutes(9999, 1440, 120), 120);
});

test('clampMinutes: 范围内的值原样保留', () => {
  assert.equal(clampMinutes(45, 180, 45), 45);
  assert.equal(clampMinutes(120, 1440, 45), 120);
  assert.equal(clampMinutes(180, 180, 45), 180);
});


/* ─────────────────── P1-8 · 设置项两处小问题 + 量程对齐 ─────────────────── */

/** 🔴 曾经的自相矛盾：滑块 setLimits(0,180,5) 允许拖到 0，
 *  而 onChange 里的 clampMinutes(value,180,45,allowZero=false) 又把 0 退回 45，
 *  用户存完回来看见的是 45。desc 还写着「0 = off」。
 *  上游 index.js:412 的选项是 [15,20,25,30,45,50,60,90]，**没有 0**。
 *  这条测试把「滑块能拖到的每一个值都必须原样存下来」钉死 —— 只要下界回到 0 就红。 */
test('P1-8 番茄钟：滑块量程内的每个值都能原样保存（不再拖得到、存不下）', () => {
  assert.equal(POMODORO_SLIDER.min, 15, '上游最小选项是 15，不是 0');
  for (let v = POMODORO_SLIDER.min; v <= POMODORO_SLIDER.max; v += POMODORO_SLIDER.step) {
    assert.equal(clampMinutes(v, POMODORO_SLIDER.max, 45), v,
      `滑块能选到 ${v}，clampMinutes 却把它改掉了`);
  }
});

test('P1-8 番茄钟：0 依然不是合法值（上游没有关闭语义，别凭空造）', () => {
  assert.ok(POMODORO_SLIDER.min > 0);
  assert.equal(clampMinutes(0, POMODORO_SLIDER.max, 45), 45);
});

/** 上游 desc-length 的下拉列表是 [14,16,…,28]（index.js:494）。
 *  本移植曾写死 15–30：下界让上游可选的 14 选不到，上界又能选到上游没有的 30。 */
test('P1-8 图例长度：量程端点与上游列表 [14…28] 对齐', () => {
  assert.equal(DESC_LENGTH_SLIDER.min, 14);
  assert.equal(DESC_LENGTH_SLIDER.max, 28);
  assert.ok(DESC_LENGTH_SLIDER.min <= 22 && 22 <= DESC_LENGTH_SLIDER.max, '默认值 22 必须在量程内');
});

/** 上游 index.js:376-380：结束整点 ≤ 开始整点（且不是 24）时标「· 次日」。
 *  丢了这个标签，用户拖到 02:00 只看见一个 2，完全看不出是跨午夜。 */
test('P1-8 workdayEndLabel：结束 ≤ 开始时标「· 次日」', () => {
  assert.equal(workdayEndLabel(21, 5, 'en'), '21:00');
  assert.equal(workdayEndLabel(2, 5, 'en'), '02:00 · next day');
  assert.equal(workdayEndLabel(2, 5, 'zh'), '02:00 · 次日');
  assert.equal(workdayEndLabel(5, 5, 'zh'), '05:00 · 次日', '相等也算次日（上游是 <=）');
  assert.equal(workdayEndLabel(24, 5, 'zh'), '24:00', '24 是当天终点，不标次日');
  assert.equal(workdayEndLabel(24, 24, 'zh'), '24:00');
});

test('P1-8 workdayEndDesc 把「次日」带进设置项描述里', () => {
  // 断言的是【当前值那一段】，不是整段描述 —— 描述里本来就会解释「次日」是什么。
  assert.match(
    workdayEndDesc({ workdayEndHour: 2, workdayStartHour: 5, language: 'zh' }),
    /当前 02:00 · 次日/);
  assert.match(
    workdayEndDesc({ workdayEndHour: 2, workdayStartHour: 5, language: 'en' }),
    /Currently 02:00 · next day/);
  assert.match(
    workdayEndDesc({ workdayEndHour: 21, workdayStartHour: 5, language: 'zh' }),
    /当前 21:00。/);
});
