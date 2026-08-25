/*
 * 主会话独立编写 —— 【不采信 worker 自述】。
 * 这是整个项目唯一会改用户文件的代码路径：坏了不是显示错，是损坏笔记。
 * 因此用【真实文件系统】跑完整读改写，不是纯 mock。
 */
const test=require('node:test'), assert=require('node:assert/strict');
const fs=require('fs'), os=require('os'), path=require('path');
const esbuild=require('esbuild');

esbuild.buildSync({entryPoints:[path.join(__dirname,'../src/timing-obsidian.ts')],bundle:true,
  format:'cjs',platform:'node',outfile:path.join(__dirname,'.tw.cjs'),external:['obsidian'],logLevel:'error'});
const T=require('./.tw.cjs');

/** 用真实文件系统撑起一个最小 vault。vault.process 走真实原子读改写。 */
function makeVault(){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nl-vault-'));
  const abs=p=>path.join(dir,p);
  const files=new Map();
  const api={
    dir,
    write(p,text){ fs.writeFileSync(abs(p),text); files.set(p,{path:p}); return files.get(p); },
    read(p){ return fs.readFileSync(abs(p),'utf8'); },
    cleanup(){ fs.rmSync(dir,{recursive:true,force:true}); },
  };
  const vault={
    getAbstractFileByPath:p=>files.get(p)||null,
    getMarkdownFiles:()=>[...files.values()],
    cachedRead:async f=>fs.readFileSync(abs(f.path),'utf8'),
    // 🔴 写回路径用的是 vault.read（未缓存的最新内容），不是 cachedRead。
    //    这个区分是对的：落笔前必须看到最新文件，缓存可能是旧的。
    read:async f=>fs.readFileSync(abs(f.path),'utf8'),
    process:async(f,fn)=>{ const cur=fs.readFileSync(abs(f.path),'utf8');
      const next=fn(cur); fs.writeFileSync(abs(f.path),next); return next; },
  };
  const app={vault, workspace:{iterateAllLeaves(){}, getLeaf:()=>null, openLinkText:async()=>{}},
             metadataCache:{on(){},off(){}}};
  T.initTimingObsidian({app});
  return api;
}

const NOTE=[
  '# 2026-08-24',            // 0
  '```naut',                 // 1
  '```',                     // 2
  '- [ ] 写周报 45m',         // 3
  '- [ ] 回邮件 30m',         // 4
].join('\n');

test('createRunningClock 在真实文件上写出未闭合 CLOCK', async () => {
  const v=makeVault(); v.write('d.md',NOTE);
  await T.createRunningClock('d.md:3', new Date(2026,7,24,10,0));
  const out=v.read('d.md');
  assert.match(out,/LOGBOOK::/,'应建出 LOGBOOK');
  assert.match(out,/CLOCK: \[2026-08-24 [A-Za-z]{3} 10:00\]\s*$/m,'未闭合 CLOCK');
  assert.match(out,/- \[ \] 回邮件 30m/,'其它行不得受损');
  assert.equal(out.split('\n').filter(l=>l.includes('写周报')).length,1,'任务行不得重复');
  v.cleanup();
});

test('closeClock 补上结束时间与时长', async () => {
  const v=makeVault(); v.write('d.md',NOTE);
  await T.createRunningClock('d.md:3', new Date(2026,7,24,10,0));
  const entries=await T.readAllEntries();
  const running=entries.find(e=>e.running);
  assert.ok(running,'应能读回正在跑的 CLOCK');
  await T.closeClock(running,new Date(2026,7,24,10,18));
  const out=v.read('d.md');
  assert.match(out,/--\[2026-08-24 [A-Za-z]{3} 10:18\] => 0:18/,'应写出闭合区间与时长');
  v.cleanup();
});

test('🔴 行号漂移 + 任务文本被改：CLOCK 行仍按【内容】定位，且结构不得破坏', async () => {
  const v=makeVault(); v.write('d.md',NOTE);
  await T.createRunningClock('d.md:3', new Date(2026,7,24,10,0));
  const running=(await T.readAllEntries()).find(e=>e.running);
  // 模拟用户在别处编辑：开头插两行（行号全漂）+ 改任务文本（但 CLOCK 行未变）
  const shifted=v.read('d.md').replace('- [ ] 写周报 45m','- [ ] 写周报（改过了）45m');
  v.write('d.md','新增一行\n又一行\n'+shifted);
  await T.closeClock(running,new Date(2026,7,24,10,18));
  const out=v.read('d.md');
  const clockLine=out.split('\n').find(l=>l.includes('CLOCK:'));
  assert.match(clockLine,/=> 0:18/,'CLOCK 行内容未变，应按内容定位并正确合上');
  // 🔴 结构必须原样：缩进 + 列表标记都要保留
  assert.match(clockLine,/^\s+- CLOCK:/,
    '列表标记被吃掉会破坏 Markdown 结构（clockPrefix 用非捕获组时踩过）');
  assert.match(out,/- \[ \] 写周报（改过了）45m/,'用户对任务行的改动不得被回滚');
  assert.equal((out.match(/CLOCK:/g)||[]).length,1,'不得写出第二条 CLOCK');
  v.cleanup();
});

test('🔴 内容有歧义（多行完全相同）时不得乱猜', async () => {
  const v=makeVault();
  v.write('d.md',['```naut','```','- [ ] 同名任务 30m','- [ ] 同名任务 30m'].join('\n'));
  await T.createRunningClock('d.md:2', new Date(2026,7,24,9,0));
  const out=v.read('d.md');
  const clocks=(out.match(/CLOCK:/g)||[]).length;
  assert.equal(clocks,1,'只应写出一条 CLOCK，不得两行都写');
  v.cleanup();
});

test('deleteClock 只删 CLOCK 行，不动任务行', async () => {
  const v=makeVault(); v.write('d.md',NOTE);
  await T.createRunningClock('d.md:3', new Date(2026,7,24,10,0));
  const running=(await T.readAllEntries()).find(e=>e.running);
  await T.deleteClock(running);
  const out=v.read('d.md');
  assert.ok(!/CLOCK:/.test(out),'CLOCK 行应被删除');
  assert.match(out,/- \[ \] 写周报 45m/,'任务行必须还在');
  v.cleanup();
});

/* ─────────────────── 笔记正被编辑器打开时的写回路径 ───────────────────
 * 🔴 上面的 makeVault() 里 iterateAllLeaves 是空实现 => 永远走 vault.process 分支。
 *    可现实中用户几乎【总是】开着今天的笔记，走的是 editor 分支。
 *    这个夹具的「不完整」曾经完整地藏住一个 bug：editor 分支把新行写成
 *    `内容\n` 追加在锚点【行尾】，产出 `- [ ] 任务 20m    - LOGBOOK::` 这种脏行。
 *    所以 editor 分支必须单独有夹具、单独有断言。 */
function makeVaultWithEditor(){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nl-vault-ed-'));
  const abs=p=>path.join(dir,p);
  const files=new Map();
  const editors=new Map();   // path -> editor
  function makeEditor(p){
    return {
      getValue(){ return fs.readFileSync(abs(p),'utf8'); },
      _set(t){ fs.writeFileSync(abs(p),t); },
      lineCount(){ return this.getValue().split('\n').length; },
      getLine(i){ return this.getValue().split('\n')[i] ?? ''; },
      setLine(i,text){ const l=this.getValue().split('\n'); l[i]=text; this._set(l.join('\n')); },
      // CodeMirror 语义：把 (line,ch) 当成整份文本里的一个绝对偏移。
      replaceRange(text,from,to){
        const v=this.getValue(); const lines=v.split('\n');
        const off=(pos)=>lines.slice(0,pos.line).reduce((n,l)=>n+l.length+1,0)+pos.ch;
        const a=off(from), b=to?off(to):a;
        this._set(v.slice(0,a)+text+v.slice(b));
      },
    };
  }
  const api={
    dir,
    write(p,text){ fs.writeFileSync(abs(p),text); files.set(p,{path:p});
                   editors.set(p,makeEditor(p)); return files.get(p); },
    read(p){ return fs.readFileSync(abs(p),'utf8'); },
    cleanup(){ fs.rmSync(dir,{recursive:true,force:true}); },
  };
  const vault={
    getAbstractFileByPath:p=>files.get(p)||null,
    getMarkdownFiles:()=>[...files.values()],
    cachedRead:async f=>fs.readFileSync(abs(f.path),'utf8'),
    read:async f=>fs.readFileSync(abs(f.path),'utf8'),
    process:async()=>{ throw new Error('开着编辑器时不该走 vault.process'); },
  };
  const app={vault,
    workspace:{
      iterateAllLeaves(cb){ for(const [p,ed] of editors) cb({view:{file:{path:p},editor:ed}}); },
      getLeaf:()=>null, openLinkText:async()=>{},
    },
    metadataCache:{on(){},off(){}}};
  T.initTimingObsidian({app});
  return api;
}

test('🔴 笔记开着编辑器时 Clock In：LOGBOOK 必须另起一行，不得拼在任务行尾', async () => {
  const v=makeVaultWithEditor(); v.write('d.md',NOTE);
  await T.createRunningClock('d.md:3', new Date(2026,7,24,10,0));
  const out=v.read('d.md');
  const taskLine=out.split('\n').find(l=>l.includes('写周报'));
  assert.equal(taskLine,'- [ ] 写周报 45m','任务行必须原样，不得被追加内容');
  assert.match(out,/^\s+- LOGBOOK::$/m,'抽屉必须是独立的一行');
  assert.match(out,/CLOCK: \[2026-08-24 [A-Za-z]{3} 10:00\]\s*$/m,'未闭合 CLOCK');
  assert.match(out,/- \[ \] 回邮件 30m/,'其它行不得受损');
  v.cleanup();
});

test('笔记开着编辑器时 closeClock 也能正确合上', async () => {
  const v=makeVaultWithEditor(); v.write('d.md',NOTE);
  await T.createRunningClock('d.md:3', new Date(2026,7,24,10,0));
  const running=(await T.readAllEntries()).find(e=>e.running);
  assert.ok(running,'应能读回正在跑的 CLOCK');
  await T.closeClock(running,new Date(2026,7,24,10,18));
  assert.match(v.read('d.md'),/--\[2026-08-24 [A-Za-z]{3} 10:18\] => 0:18/);
  v.cleanup();
});

/* ─────────────────── 嵌套子步骤不得进执行层 ───────────────────
 * 上游 projectDirectTasks 只取 `parentUid === planUid` 的行（文案原文就叫
 * "direct-child"）。Roam 里 block 自带真实 parentUid；这边正文是纯文本，
 * 必须按缩进还原层级，否则过滤恒为真。
 * 🔴 曾经把 rows 拍平 => 嵌套子步骤冒进 Plan/Review 面板、被套 15m 默认预算，
 *    而容量条（走 parser.ts 的 baseIndent）根本没算它们 —— 面板与螺旋图对不上。 */
const NESTED_NOTE=[
  '# 2026-08-25',                   // 0
  '```naut',                        // 1
  '```',                            // 2
  '- [x] 办理 EE 路由器 final bill 1h d11:21', // 3
  '\t- [x] 准备 playbook',           // 4
  '\t- [x] 电话询问',                 // 5
  '- [ ] Oxford WhatsApp 群发消息',   // 6
  '- [ ] Oxford EDM 筹备 2h',        // 7
  '\t- [ ] 整理 next steps',         // 8
  '\t- [ ] 整理 wider bg',           // 9
  '\t- [ ] 写作新版标题和摘要',        // 10
  '\t- [ ] 给 Mark 邮件确认',         // 11
  '- [ ] ChatGPT 对话整理',          // 12
].join('\n');

/** readPrimaryPlan 走「今日日记路径 + 同步缓存」两道关：文件名必须是当天
 *  `YYYY-MM-DD.md`，且 initTimingObsidian 的预热是异步的 —— 建库后写的文件
 *  不在缓存里，必须显式 await 一次 primeTimingCache()。 */
async function nestedVault(){
  const v=makeVault(); v.write('2026-08-25.md',NESTED_NOTE);
  await T.primeTimingCache();
  return v;
}
const AT = new Date(2026,7,25,15,14);

test('🔴 Plan 只列直接子任务，嵌套子步骤不出现', async () => {
  const v=await nestedVault();
  const titles=T.readPrimaryPlan(AT).tasks.map(t=>t.title);
  assert.deepEqual(titles,
    ['Oxford WhatsApp 群发消息','Oxford EDM 筹备','ChatGPT 对话整理'],
    '4 个嵌套子步骤不得混进来（会被套 15m 默认预算，容量条却没算它们）');
  v.cleanup();
});

test('🔴 Review 也只认直接子任务', async () => {
  const v=await nestedVault();
  const rows=T.readPrimaryPlan(AT).reviewTasks;
  assert.equal(rows.length,4,'3 个未完成 + 1 个已完成的直接子任务，共 4');
  assert.ok(!rows.some(r=>/准备 playbook|电话询问|整理 next steps/.test(r.title)),
    '嵌套项混进 Review 会让 Completed x/y 虚高（实测出过 9/9 其实只有 7）');
  v.cleanup();
});

test('parentUid 按缩进还原，子步骤挂在父任务上', async () => {
  const v=await nestedVault();
  const rows=T.readPrimaryPlan(AT).rows;
  const byLine=n=>rows.find(r=>r.uid===`2026-08-25.md:${n}`);
  assert.equal(byLine(7).parentUid,'2026-08-25.md:2','顶层任务的父是计划块本身');
  assert.equal(byLine(8).parentUid,'2026-08-25.md:7','子步骤的父是它上面那条顶层任务');
  assert.equal(byLine(11).parentUid,'2026-08-25.md:7','同一父下的最后一条子步骤同理');
  v.cleanup();
});

/* ─────────────── D1：有意不跟随上游的「TODO 可选」 ───────────────
 * 上游 HEAD 起 projectDirectTasks 的过滤器清空，计划块任何直接子行只要不是
 * 时间段就成为弹性任务（隐式 TODO）。本移植【有意不跟随】，理由见
 * docs/PORTING-DECISIONS.md §D1：Obsidian 日记里随手写的 bullet 太常见。
 * 🔴 实现在适配层「不喂给引擎」，vendor 保持零修改。这条测试是那个决策的锚。 */
const BARE_NOTE=[
  '# 2026-08-25',              // 0
  '```naut',                   // 1
  '```',                       // 2
  '- [ ] 写周报 45m',           // 3  显式 TODO → 任务
  '- 记得带钥匙',                // 4  裸行 → 不该成为任务
  '- 08:30-09:30 起床',         // 5  时间段 → 固定事件
  '- 随手写的一句备注',           // 6  裸行 → 不该成为任务
  '- [x] 已完成的事 30m d11:00', // 7  显式 DONE → 进 Review
].join('\n');

async function bareVault(){
  const v=makeVault(); v.write('2026-08-25.md',BARE_NOTE);
  await T.primeTimingCache();
  return v;
}

test('🔴 D1 裸行不成为弹性任务（有意不跟随上游的 TODO-可选）', async () => {
  const v=await bareVault();
  const snap=T.readPrimaryPlan(new Date(2026,7,25,9,0));
  assert.deepEqual(snap.tasks.map(t=>t.title), ['写周报'],
    '「记得带钥匙」「随手写的一句备注」不得被隐式当成 15m 任务吃掉容量');
  v.cleanup();
});

test('D1 时间段裸行仍然是固定事件（不能连它一起滤掉）', async () => {
  const v=await bareVault();
  const events=T.readPrimaryPlan(new Date(2026,7,25,9,0)).fixedEvents;
  assert.equal(events.length,1,'时间段行必须留下');
  assert.match(events[0].string,/起床/);
  v.cleanup();
});

test('D1 显式标记的行不受影响', async () => {
  const v=await bareVault();
  const titles=T.readPrimaryPlan(new Date(2026,7,25,9,0)).reviewTasks.map(t=>t.title);
  assert.ok(titles.includes('写周报') && titles.includes('已完成的事'),
    'Review 应同时含未完成与已完成的显式任务');
  assert.ok(!titles.some(t=>/记得带钥匙|随手写/.test(t)),'裸行不得进 Review');
  v.cleanup();
});

/* ─────────── P0-3：CLOCK 定位不得在歧义时改错人 ───────────
 * 上游用 entry.clockUid 精确读一个 block；这边 uid 是 path:line、行会漂，
 * 早期退化成「全文件扫第一条同起始分钟的」。同文件两条相同起始分钟的 running
 * CLOCK 就会认错 —— 而这正是 reconcileLegacyOverlap 要修的场景。 */
const DUP_NOTE=[
  '# 2026-08-25',                                  // 0
  '```naut',                                       // 1
  '```',                                           // 2
  '- [ ] 任务甲 30m',                               // 3
  '    - LOGBOOK::',                               // 4
  '        - CLOCK: [2026-08-25 Tue 10:00]',       // 5  ← 甲的
  '- [ ] 任务乙 30m',                               // 6
  '    - LOGBOOK::',                               // 7
  '        - CLOCK: [2026-08-25 Tue 10:00]',       // 8  ← 乙的，同一分钟
].join('\n');

test('🔴 P0-3 行没漂时按 clockUid 精确命中，不会改到同分钟的另一条', async () => {
  const v=makeVault(); v.write('2026-08-25.md',DUP_NOTE);
  await T.primeTimingCache();
  const entryB={ clockUid:'2026-08-25.md:8', taskUid:'2026-08-25.md:6', running:true,
            start:new Date(2026,7,25,10,0) };
  await T.closeClock(entryB, new Date(2026,7,25,10,25));
  const out=v.read('2026-08-25.md').split('\n');
  assert.match(out[8], /=> 0:25/, '应该合上第 8 行（乙）');
  assert.equal(out[5], '        - CLOCK: [2026-08-25 Tue 10:00]',
    '第 5 行（甲）必须原封不动 —— 早期实现会扫到它');
  v.cleanup();
});

test('🔴 P0-3 行漂且歧义时拒写，而不是赌一个', async () => {
  const v=makeVault(); v.write('2026-08-25.md',DUP_NOTE);
  await T.primeTimingCache();
  // clockUid 指向一个不再是 CLOCK 的行 => 走兜底扫描 => 两条都匹配 => 必须拒写
  const ambiguous={ clockUid:'2026-08-25.md:3', taskUid:'2026-08-25.md:6', running:true,
              start:new Date(2026,7,25,10,0) };
  await assert.rejects(() => T.closeClock(ambiguous, new Date(2026,7,25,10,25)),
    /could not/i, '歧义时宁可报错也不能改错人');
  const out=v.read('2026-08-25.md').split('\n');
  assert.ok(!out.some(l=>/=> 0:25/.test(l)),'拒写后文件不得被改动');
  v.cleanup();
});
