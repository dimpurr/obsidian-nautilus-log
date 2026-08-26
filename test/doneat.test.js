const test=require('node:test'), assert=require('node:assert/strict');
const esbuild=require('esbuild'), path=require('path');
esbuild.buildSync({entryPoints:[path.join(__dirname,'../src/parser.ts')],bundle:true,format:'cjs',
  platform:'node',outfile:path.join(__dirname,'.d.cjs'),external:['obsidian'],logLevel:'error'});
const {parsePlan,taskDescription}=require('./.d.cjs');
const core=require('../src/vendor/log-core.js');
const S={language:'en',workdayStartHour:5,workdayEndHour:21,descLength:22,todoDuration:15,urgentTrigger:''};
const P=t=>parsePlan(t,{sourcePath:'x.md',settings:S});

test('解析 dHH:MM 完成锚点', () => {
  const {tasks}=P('- [x] 学术社交 40m d11:20');
  assert.equal(tasks[0].done,true);
  assert.equal(tasks[0].doneAt,680);
});

test('没有锚点则 doneAt 缺省', () => {
  assert.equal(P('- [x] 没记时刻 40m').tasks[0].doneAt,undefined);
});

test('🔑 有锚点 => 引擎能算出历史区间', () => {
  const t=P('- [x] 学术社交 40m d11:20').tasks[0];
  const slice=core.historicalDoneSlice({done:true,doneAt:t.doneAt,duration:t.duration,defaultDuration:15});
  assert.ok(slice,'应能画出来');
  assert.equal(slice.start,640); assert.equal(slice.end,680);  // 10:40-11:20
});

test('🔑 无锚点 => 引擎拒绝画（不编造历史）', () => {
  const t=P('- [x] 没记时刻 40m').tasks[0];
  assert.equal(core.historicalDoneSlice({done:true,doneAt:t.doneAt,duration:t.duration,defaultDuration:15}),null);
});

test('锚点不进图例', () => {
  assert.equal(taskDescription('- [x] 学术社交 40m d11:20',22),'学术社交');
});

test('已完成不占未来容量', () => {
  const {tasks}=P('- [x] 已完成 40m d11:20\n- [ ] 未完成 30m');
  const cap=core.calculateCapacity({startMinutes:300,endMinutes:1260,nowMinutes:720,
    fixedEvents:[],allFixedEvents:[],pendingTasks:tasks});
  assert.equal(cap.demandMinutes,30);
});

test('非法锚点忽略（d99:99）', () => {
  assert.equal(P('- [x] 任务 40m d99:99').tasks[0].doneAt,undefined);
});

// ── d18：无分钟的整点锚点（audit §P1-8，上游 component.cljs:604）──

test('d18（只有小时）视作整点 18:00', () => {
  const {tasks}=P('- [x] 学术社交 40m d18');
  assert.equal(tasks[0].doneAt,1080);
});

test('d9 单位数小时同样接受', () => {
  assert.equal(P('- [x] 任务 30m d9').tasks[0].doneAt,540);
});

test('🔴 d50% 是【进度】不是锚点（互斥的关键一条）', () => {
  const t=P('- [ ] 写周报 60m d50%').tasks[0];
  assert.equal(t.doneAt,undefined,'d50% 被读成了 50 点/或整点');
  assert.equal(t.progress,50);
});

test('🔴 d10% 不得被读成「10 点整」', () => {
  const t=P('- [ ] 写周报 60m d10%').tasks[0];
  assert.equal(t.doneAt,undefined);
  assert.equal(t.progress,10);
});

test('d18 与时长 token 互不干扰', () => {
  const t=P('- [x] 任务 1h30m d18').tasks[0];
  assert.equal(t.duration,90);
  assert.equal(t.doneAt,1080);
});

test('非法整点锚点忽略（d99）', () => {
  assert.equal(P('- [x] 任务 40m d99').tasks[0].doneAt,undefined);
});

test('整点锚点不进图例', () => {
  assert.equal(taskDescription('- [x] 学术社交 40m d18',22),'学术社交');
});

test('🔑 d18 有锚点 => 引擎能算出历史区间', () => {
  const t=P('- [x] 学术社交 40m d18').tasks[0];
  const slice=core.historicalDoneSlice({done:true,doneAt:t.doneAt,duration:t.duration,defaultDuration:15});
  assert.ok(slice); assert.equal(slice.end,1080); assert.equal(slice.start,1040);
});

test('P1-068 分钟省略的锚点也不进图例（解析认 d11，剥离就必须认）', () => {
  assert.equal(P('- [x] 学术社交 40m d11').tasks[0].doneAt, 660);
  assert.equal(taskDescription('- [x] 学术社交 40m d11', 22), '学术社交');
});
