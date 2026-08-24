const test=require('node:test'), assert=require('node:assert/strict');
const esbuild=require('esbuild'), path=require('path');
esbuild.buildSync({entryPoints:[path.join(__dirname,'../src/daystate.ts')],bundle:true,format:'cjs',
  platform:'node',outfile:path.join(__dirname,'.ds.cjs'),external:['obsidian'],logLevel:'error'});
const {resolveDayState,dateFromPath}=require('./.ds.cjs');
const NOW=new Date('2026-08-24T17:44:00');
const S={startMinutes:300,endMinutes:1260,nowMinutes:17*60+44,now:NOW};
const at=p=>resolveDayState({...S,sourcePath:p});

test('从路径认出日期', () => {
  assert.equal(dateFromPath('Daily/_Daily/2026-08-25.md').getMonth(),7);
  assert.equal(dateFromPath('Daily/_Daily/2026-08-25.md').getDate(),25);
  assert.equal(dateFromPath('随手记.md'),null);
});

test('今天：画红针、画斜纹、可交互', () => {
  const d=at('Daily/_Daily/2026-08-24.md');
  assert.equal(d.relation,'today');
  assert.equal(d.showNow,true);
  assert.equal(d.showElapsed,true);
  assert.equal(d.interactive,true);
});

test('🔴 明天：不画红针、【不画斜纹】、不可交互', () => {
  const d=at('Daily/_Daily/2026-08-25.md');
  assert.equal(d.relation,'future');
  assert.equal(d.showNow,false,'明天不该有"现在"这根针');
  assert.equal(d.showElapsed,false,'明天还没开始，不该有已流逝区 —— 曾整盘铺满斜纹');
  assert.equal(d.interactive,false);
  assert.equal(d.capacityFromMinutes,300,'容量应从当天起点算');
});

test('🔴 昨天：不画红针、斜纹铺满整天、容量按整天算', () => {
  const d=at('Daily/_Daily/2026-08-23.md');
  assert.equal(d.relation,'past');
  assert.equal(d.showNow,false);
  assert.equal(d.showElapsed,true);
  assert.equal(d.elapsedThroughMinutes,1260,'那天已经过完了');
  assert.equal(d.capacityFromMinutes,1260,'看昨天时"还剩多少"没有意义，应是整天容量');
  assert.equal(d.showAvailableSlots,false,'过去没有"空闲可安排"这回事');
});

test('非日记笔记退回今天', () => {
  assert.equal(at('随手记.md').relation,'today');
});

test('跨午夜特例：窗口 21:00→02:00 时，次日凌晨看昨天的计划仍算 today', () => {
  const d=resolveDayState({
    sourcePath:'Daily/_Daily/2026-08-24.md',
    startMinutes:21*60, endMinutes:26*60,          // 21:00 → 次日 02:00
    nowMinutes:1*60,                                // 凌晨 1 点
    now:new Date('2026-08-25T01:00:00'),
  });
  assert.equal(d.relation,'today','跨午夜窗口未结束前仍属当天计划');
});
