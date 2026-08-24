const test=require('node:test'), assert=require('node:assert/strict');
const esbuild=require('esbuild'), path=require('path');
esbuild.buildSync({entryPoints:[path.join(__dirname,'../src/blockconfig.ts')],bundle:true,
  format:'cjs',platform:'node',outfile:path.join(__dirname,'.bc.cjs'),external:['obsidian'],logLevel:'error'});
const {parseBlockConfig,applyOverrides,extractPlanBody}=require('./.bc.cjs');

const BASE={language:'en',workdayStartHour:5,workdayEndHour:21,descLength:22,todoDuration:15,urgentTrigger:''};

test('空块 = 完全沿用全局设置', () => {
  const o=parseBlockConfig('');
  assert.deepEqual(applyOverrides(BASE,o), BASE);
  assert.equal(o.unknown.length, 0);
});

test('end: 02:00 覆盖当天收工时间', () => {
  const s=applyOverrides(BASE, parseBlockConfig('end: 02:00'));
  assert.equal(s.workdayEndHour, 2);
  assert.equal(s.workdayStartHour, 5, '未指定的项不该被动');
});

test('多项覆盖 + 别名', () => {
  const s=applyOverrides(BASE, parseBlockConfig('start: 9\nend: 23\ndefault-duration: 30\nlang: zh'));
  assert.equal(s.workdayStartHour,9); assert.equal(s.workdayEndHour,23);
  assert.equal(s.todoDuration,30); assert.equal(s.language,'zh');
});

test('无法识别的键要报出来，不静默吞', () => {
  const o=parseBlockConfig('strat: 9\n随便写点什么');
  assert.equal(o.unknown.length, 2);
  assert.equal(o.workdayStartHour, undefined);
});

test('非法值不覆盖，且计入 unknown', () => {
  const o=parseBlockConfig('end: 99:99');
  assert.equal(o.workdayEndHour, undefined);
  assert.equal(o.unknown.length, 1);
});

// ── 边界规则：任何空白行 ──
const FILE=[
  '# 今天',            // 0
  '```nautilus',       // 1
  'end: 02:00',        // 2
  '```',               // 3
  '05:00-06:00 晨间',   // 4
  '- [ ] 任务 A 45m',   // 5
  '',                  // 6  ← 边界
  '- [ ] 这条不该被算进去', // 7
].join('\n');

test('计划止于第一个空白行', () => {
  const {body,startLine}=extractPlanBody(FILE, 3);
  assert.equal(startLine, 4);
  assert.equal(body.split('\n').length, 2);
  assert.ok(body.includes('晨间'));
  assert.ok(!body.includes('不该被算进去'));
});

test('块与计划之间允许有空行（多敲一个回车不该失效）', () => {
  const f=['```nautilus','```','','','- [ ] 任务 30m',''].join('\n');
  const {body,startLine}=extractPlanBody(f, 1);
  assert.equal(startLine, 4);
  assert.equal(body, '- [ ] 任务 30m');
});

test('块后立刻是空白/文件结尾 => 空计划', () => {
  assert.equal(extractPlanBody(['```nautilus','```'].join('\n'), 1).body, '');
});

test('不用标题也能正确切边界（很多人不写标题）', () => {
  const f=['```nautilus','```','- [ ] A 1h','- [ ] B 1h','','别的段落文字'].join('\n');
  const {body}=extractPlanBody(f,1);
  assert.equal(body,'- [ ] A 1h\n- [ ] B 1h');
});
