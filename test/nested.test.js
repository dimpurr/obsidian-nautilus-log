const test=require('node:test'), assert=require('node:assert/strict');
const esbuild=require('esbuild'), path=require('path');
esbuild.buildSync({entryPoints:[path.join(__dirname,'../src/parser.ts')],bundle:true,format:'cjs',
  platform:'node',outfile:path.join(__dirname,'.n.cjs'),external:['obsidian'],logLevel:'error'});
const {parsePlan}=require('./.n.cjs');
const S={language:'en',workdayStartHour:5,workdayEndHour:21,descLength:22,todoDuration:15,urgentTrigger:''};
const P=a=>parsePlan(a.join('\n'),{sourcePath:'x.md',settings:S});

test('🔑 嵌套子任务不参与排程（对齐上游只取直接子块）', () => {
  const {tasks}=P(['- [ ] 写周报 60m','    - [ ] 收集数据 20m','    - [ ] 画图 20m','- [ ] 回邮件 30m']);
  assert.equal(tasks.length,2);
  assert.equal(tasks.reduce((s,t)=>s+t.duration,0),90,'子任务重复计入会变成 130m');
});

test('多层嵌套一并排除', () => {
  const {tasks}=P(['- [ ] A 60m','  - [ ] a1 10m','    - [ ] a1x 5m','- [ ] B 30m']);
  assert.equal(tasks.length,2);
});

test('整体缩进时以第一行为基准，不会把全部判成子项', () => {
  const {tasks}=P(['  - [ ] A 60m','  - [ ] B 30m']);
  assert.equal(tasks.length,2);
});

test('嵌套的事件行同样不算', () => {
  const {events}=P(['- 09:00-10:00 会','    - 09:15-09:30 子环节']);
  assert.equal(events.length,1);
});

test('顶层顺序保持不变', () => {
  const {tasks}=P(['- [ ] 第一 10m','   - [ ] 子 5m','- [ ] 第二 10m','- [ ] 第三 10m']);
  assert.deepEqual(tasks.map(t=>t.string.match(/第.\b?|第./)[0]),['第一','第二','第三']);
});
