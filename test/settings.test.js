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
const { clampMinutes } = require('./.settings.cjs');

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
