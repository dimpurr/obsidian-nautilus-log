const test=require('node:test'), assert=require('node:assert/strict');
const esbuild=require('esbuild'), path=require('path');
esbuild.buildSync({entryPoints:[path.join(__dirname,'../src/parser.ts')],bundle:true,format:'cjs',
  platform:'node',outfile:path.join(__dirname,'.p.cjs'),external:['obsidian'],logLevel:'error'});
const {parsePlan}=require('./.p.cjs');
const S={language:'en',workdayStartHour:5,workdayEndHour:21,descLength:22,todoDuration:15,urgentTrigger:''};
const P=t=>parsePlan(t,{sourcePath:'x.md',settings:S});

test('开始时刻 + 时长 => 钉死的事件', () => {
  const {events,tasks}=P('- [ ] 写周报 09:00 30m');
  assert.equal(tasks.length,0);
  assert.equal(events[0].start,540); assert.equal(events[0].end,570);
  assert.equal(events[0].meeting,true,'不设 meeting 引擎会静默丢弃');
});

test('只写时刻不写时长 => 用默认时长', () => {
  const {events}=P('- [ ] 09:00 开会');
  assert.equal(events[0].end-events[0].start,15);
});

test('am / pm 形式', () => {
  assert.equal(P('- [ ] 9am 早会 45m').events[0].start,540);
  assert.equal(P('- [ ] 2pm 下午会 1h').events[0].start,840);
});

test('完整区间优先于单时刻', () => {
  const {events}=P('- [ ] 09:00-10:00 会');
  assert.equal(events[0].end-events[0].start,60);
});

test('done 状态要保留', () => {
  assert.equal(P('- [x] 09:00 已完成 30m').events[0].done,true);
});

// ── 防误判：这几条是加这个特性最大的风险 ──
test('🔴 裸数字不算时刻（第 9 章）', () => {
  const {events,tasks}=P('- [ ] 读第 9 章 30m');
  assert.equal(events.length,0,'“9”被当成了 09:00');
  assert.equal(tasks[0].duration,30);
});

test('🔴 时长 token 不能被当成时刻', () => {
  const {events,tasks}=P('- [ ] 复习 1h30m');
  assert.equal(events.length,0);
  assert.equal(tasks[0].duration,90);
});

test('🔴 无时刻无时长 => 弹性任务 + 默认时长', () => {
  const {events,tasks}=P('- [ ] 买 3 个苹果');
  assert.equal(events.length,0);
  assert.equal(tasks[0].duration,15);
});
