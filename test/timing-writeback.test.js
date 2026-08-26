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

/* ─────────── RQ-4：vault 索引在 onload 时还没好 ───────────
 * 真实 Obsidian 在插件 onload 时 `getMarkdownFiles()` 返回空数组 —— 索引还没
 * 建完。同步内容缓存若在那时预热就永远是 0 条，执行层随之全面失明。
 * 见 test/reality-quirks.md RQ-4 与 PORTING-DECISIONS.md §D6。 */
function makeLateIndexVault(){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nl-late-'));
  const abs=p=>path.join(dir,p);
  const files=new Map();
  let indexed=false;                 // ← 现实：onload 时是 false
  const readyCbs=[];
  const api={
    dir,
    write(p,text){ fs.writeFileSync(abs(p),text); files.set(p,{path:p}); return files.get(p); },
    /** 模拟 Obsidian 建完索引并触发 onLayoutReady。 */
    finishIndexing(){ indexed=true; readyCbs.splice(0).forEach(cb=>cb()); },
    cleanup(){ fs.rmSync(dir,{recursive:true,force:true}); },
  };
  const vault={
    getAbstractFileByPath:p=>files.get(p)||null,
    // 🔴 索引没好之前返回空数组，正是真实行为
    getMarkdownFiles:()=>(indexed?[...files.values()]:[]),
    cachedRead:async f=>fs.readFileSync(abs(f.path),'utf8'),
    read:async f=>fs.readFileSync(abs(f.path),'utf8'),
    process:async(f,fn)=>{ const cur=fs.readFileSync(abs(f.path),'utf8');
      const next=fn(cur); fs.writeFileSync(abs(f.path),next); return next; },
  };
  const app={vault,
    workspace:{ iterateAllLeaves(){}, getLeaf:()=>null, openLinkText:async()=>{},
                onLayoutReady(cb){ readyCbs.push(cb); } },
    metadataCache:{on(){},off(){}}};
  T.initTimingObsidian({app});
  return api;
}

test('🔴 RQ-4 预热必须等 onLayoutReady —— 布局就绪前 timingCacheReady() 不许 resolve', async () => {
  const v=makeLateIndexVault();
  v.write('2026-08-26.md','```naut\n```\n- [ ] 写周报 45m');
  let resolved=false;
  const waiter=T.timingCacheReady().then(()=>{ resolved=true; });
  // 把微任务队列放干净；此刻布局还没就绪
  await new Promise((r)=>setImmediate(r));
  assert.equal(resolved, false,
    '抢在 onLayoutReady 之前 resolve = 执行层会拿着空缓存 initialize()，'
    + '而 reconcileLegacyOverlap / closeDoneClocks 是一次性的，空转就永远补不回来');
  v.finishIndexing();
  await waiter;
  assert.ok(resolved);
  v.cleanup();
});

test('RQ-4 resolve 的那一刻缓存必须已经填好（不是 onLayoutReady 一触发就 resolve）', async () => {
  const v=makeLateIndexVault();
  v.write('2026-08-26.md','```naut\n```\n- [ ] 写周报 45m');
  const waiter=T.timingCacheReady();
  v.finishIndexing();
  await waiter;
  assert.ok(T.readPrimaryPlan(new Date(2026,7,26,9,0)).plan,
    'resolve 之后必须立刻读得到 —— 执行层就是等它才启动的');
  v.cleanup();
});

/* ═══════════════════════════════════════════════════════════════════════
 * 认证审计收口 · A1 数据层
 * 每条测试都做过「回退实现 ⇒ 变红」验证（见本轮报告）。
 * ═══════════════════════════════════════════════════════════════════════ */

const core = require('../src/vendor/timing-core');

/* ─────────── A1-026：任务行漂移后 CLOCK 不得整批失配 ───────────
 * uid 是 `path:line`，运行时（timing-runtime.js:205）把【上一轮快照】里的
 * taskUid 原样喂回 readEntriesForTaskUids()。用户在任务上方插一行，
 * 纯字符串过滤就会把这个任务的 CLOCK 全滤掉 —— 正在跑的番茄钟凭空消失。 */
test('🔴 A1-026 任务行上方插行后，旧 taskUid 仍能按内容锚回它的 CLOCK', async () => {
  const v=makeVault(); v.write('d.md',NOTE);
  await T.createRunningClock('d.md:3', new Date(2026,7,24,10,0));
  const before=T.readEntriesForTaskUids(['d.md:3']);
  assert.equal(before.length,1,'前提：漂移前本来就读得到');
  // 用户在文件开头插两行 —— 任务行从 3 漂到 5
  v.write('d.md','新增一行\n又一行\n'+v.read('d.md'));
  await T.primeTimingCache();
  const after=T.readEntriesForTaskUids(['d.md:3']);
  assert.equal(after.length,1,
    '行漂后旧 uid 必须仍能命中；失配 = 该任务历史 CLOCK 在 refresh 里整批消失');
  assert.equal(after[0].taskUid,'d.md:5','应锚到漂移后的新行号');
  assert.equal(after[0].running,true);
  v.cleanup();
});

test('🔴 A1-026 两行任务文本完全相同时宁可放弃，也不猜', async () => {
  const v=makeVault();
  v.write('d.md',['```naut','```','- [ ] 同名任务 30m','- [ ] 同名任务 30m'].join('\n'));
  await T.createRunningClock('d.md:2', new Date(2026,7,24,9,0));
  await T.primeTimingCache();
  // 第二条同名任务也有自己的 CLOCK => 漂移后备忘里的原文两边都匹配 => 歧义
  await T.createRunningClock('d.md:5', new Date(2026,7,24,9,30));
  assert.equal(T.readEntriesForTaskUids(['d.md:2']).length,1,'前提：漂移前读得到');
  v.write('d.md','新增一行\n'+v.read('d.md'));
  await T.primeTimingCache();
  assert.equal(T.readEntriesForTaskUids(['d.md:2']).length,0,
    '歧义时必须放弃锚定 —— 猜错 = 把 CLOCK 记到另一个任务头上');
  v.cleanup();
});

/* ─────────── A1-074：新 CLOCK 插在抽屉最前（对齐上游 order:0） ─────────── */
test('🔴 A1-074 新 CLOCK 插在抽屉【最前】，与上游 order:0 一致', async () => {
  const v=makeVault(); v.write('d.md',NOTE);
  await T.createRunningClock('d.md:3', new Date(2026,7,24,10,0));
  const first=(await T.readAllEntries()).find(e=>e.running);
  await T.closeClock(first,new Date(2026,7,24,10,18));
  await T.createRunningClock('d.md:3', new Date(2026,7,24,11,0));
  const lines=v.read('d.md').split('\n');
  const drawer=lines.findIndex(l=>/LOGBOOK::/.test(l));
  assert.match(lines[drawer+1],/11:00/,'抽屉正下方必须是【最新】的那条 CLOCK');
  assert.match(lines[drawer+2],/10:00/,'旧的那条排在它后面');
  v.cleanup();
});

test('A1-074 新 CLOCK 的缩进/标记从已有 CLOCK 继承（契约漏洞 4）', async () => {
  const v=makeVault();
  v.write('d.md',['```naut','```','- [ ] 写周报 45m','  * LOGBOOK::',
                  '      * CLOCK: [2026-08-25 Tue 09:00]--[2026-08-25 Tue 09:30] => 0:30'].join('\n'));
  await T.primeTimingCache();
  await T.createRunningClock('d.md:2', new Date(2026,7,25,11,0));
  const line=v.read('d.md').split('\n').find(l=>/11:00/.test(l));
  assert.equal(line,'      * CLOCK: [2026-08-25 Tue 11:00]',
    '必须继承已有 CLOCK 的 6 空格缩进与 `* ` 标记，而不是 drawerIndent+4 + `- `');
  v.cleanup();
});

/* ─────────── A1-078：Clock In 的确认不得认到别人的同分钟 CLOCK ─────────── */
const SAME_MIN=[
  '# 2026-08-25',                              // 0
  '```naut',                                   // 1
  '```',                                       // 2
  '- [ ] 任务甲 30m',                           // 3
  '    - LOGBOOK::',                           // 4
  '        - CLOCK: [2026-08-25 Tue 10:00]',   // 5  ← 甲的，running
  '- [ ] 任务乙 30m',                           // 6
].join('\n');

test('🔴 A1-078 Clock In 的确认按锚点定位，不得认到同分钟的另一条 running CLOCK', async () => {
  const v=makeVault(); v.write('2026-08-25.md',SAME_MIN);
  await T.primeTimingCache();
  const { entry } = await T.createRunningClock('2026-08-25.md:6', new Date(2026,7,25,10,0));
  assert.equal(entry.clockUid,'2026-08-25.md:8',
    'clockUid 必须指向刚写下的那一行（7=新抽屉, 8=新 CLOCK）；'
    +'指到第 5 行 = 之后 closeClock/deleteClock 全改到任务甲头上');
  assert.equal(entry.taskUid,'2026-08-25.md:6');
  await T.closeClock(entry,new Date(2026,7,25,10,25));
  const out=v.read('2026-08-25.md').split('\n');
  assert.equal(out[5],'        - CLOCK: [2026-08-25 Tue 10:00]','任务甲的 CLOCK 必须原封不动');
  assert.match(out[8],/=> 0:25/,'该合上的是任务乙那一条');
  v.cleanup();
});

/* ─────────── A1-095：重复 Clock Out 幂等 ─────────── */
test('🔴 A1-095 重复 Clock Out 幂等：返回已闭合值，且不再写文件', async () => {
  const v=makeVault(); v.write('d.md',NOTE);
  await T.createRunningClock('d.md:3', new Date(2026,7,24,10,0));
  const running=(await T.readAllEntries()).find(e=>e.running);
  const first=await T.closeClock(running,new Date(2026,7,24,10,18));
  const snapshot=v.read('d.md');
  // 拿【同一个 running entry】再关一次（真实场景：两次点击 / 队列重放）
  const again=await T.closeClock(running,new Date(2026,7,24,10,45));
  assert.equal(v.read('d.md'),snapshot,
    '第二次不得改文件 —— 否则 10:18 的记录会被 10:45 覆盖，用户凭空多出 27 分钟');
  assert.equal(again.running,false,'必须返回已闭合状态');
  assert.equal(again.minutes,first.minutes,'时长必须还是第一次那个');
  assert.equal(again.end.getTime(),first.end.getTime());
  v.cleanup();
});

/* ─────────── A1-110 / A1-199 / A1-202：editor 分支的 remove ─────────── */
const LAST_LINE_NOTE=[
  '# 2026-08-25',                              // 0
  '```naut',                                   // 1
  '```',                                       // 2
  '- [ ] 写周报 45m',                           // 3
  '    - LOGBOOK::',                           // 4
  '        - CLOCK: [2026-08-25 Tue 10:00]',   // 5  ← 末行
].join('\n');
const LAST_LINE_ENTRY={ clockUid:'2026-08-25.md:5', taskUid:'2026-08-25.md:3',
  running:true, start:new Date(2026,7,25,10,0) };

test('🔴 A1-110 CLOCK 是文件末行时，editor 分支必须真删整行（不是清空留空行）', async () => {
  const v=makeVaultWithEditor(); v.write('2026-08-25.md',LAST_LINE_NOTE);
  await T.primeTimingCache();
  await T.deleteClock({...LAST_LINE_ENTRY});
  const out=v.read('2026-08-25.md');
  assert.equal(out,['# 2026-08-25','```naut','```','- [ ] 写周报 45m','    - LOGBOOK::'].join('\n'),
    '末行被删后不得留下一个空行');
  v.cleanup();
});

test('🔴 A1-202 两条写回通道的 remove 必须逐字节等价', async () => {
  for (const note of [LAST_LINE_NOTE, LAST_LINE_NOTE+'\n- [ ] 回邮件 30m']) {
    const a=makeVault();            a.write('2026-08-25.md',note);
    await T.primeTimingCache();
    await T.deleteClock({...LAST_LINE_ENTRY});
    const viaProcess=a.read('2026-08-25.md'); a.cleanup();

    const b=makeVaultWithEditor();  b.write('2026-08-25.md',note);
    await T.primeTimingCache();
    await T.deleteClock({...LAST_LINE_ENTRY});
    const viaEditor=b.read('2026-08-25.md'); b.cleanup();

    assert.equal(viaEditor,viaProcess,
      'editor 分支与 vault.process 分支产出必须一模一样 —— 同一个 LineChange 不许有两种语义');
  }
});

test('A1-202 editor 分支删的是 CLOCK 行本身，任务行与抽屉都在', async () => {
  const v=makeVaultWithEditor(); v.write('2026-08-25.md',LAST_LINE_NOTE+'\n- [ ] 回邮件 30m');
  await T.primeTimingCache();
  await T.deleteClock({...LAST_LINE_ENTRY});
  const out=v.read('2026-08-25.md');
  assert.ok(!/CLOCK:/.test(out),'CLOCK 行应被删除');
  assert.match(out,/- \[ \] 写周报 45m/);
  assert.match(out,/- \[ \] 回邮件 30m/);
  v.cleanup();
});

/* ─────────── A1-113 / A1-124：updateGraphBlock 必须精确定位 ───────────
 * 唯一调用者是 reconcileLegacyOverlap（timing-runtime.js:375），场景定义就是
 * 「同一文件里多条 running CLOCK」。选错行之后写回乐观锁【不构成防护】：
 * expected 取自已经选错的那一行，内容当然匹配。 */
test('🔴 A1-113 updateGraphBlock 按 clockUid 精确命中，不改同分钟的另一条', async () => {
  const v=makeVault(); v.write('2026-08-25.md',DUP_NOTE);
  await T.primeTimingCache();
  const closed=core.formatClockLine(new Date(2026,7,25,10,0), new Date(2026,7,25,10,20));
  await T.updateGraphBlock('2026-08-25.md:8', closed);
  const out=v.read('2026-08-25.md').split('\n');
  assert.match(out[8],/=> 0:20/,'应改第 8 行（reconcile 要关掉的那条）');
  assert.equal(out[5],'        - CLOCK: [2026-08-25 Tue 10:00]',
    '第 5 行是 focused、必须保留 —— 全文件扫首个命中会把它关掉，'
    +'而 runtime 的事后校验只查内存 Map、不重读文件，这次误写没有任何断言拦得住');
  assert.match(out[8],/^\s+- CLOCK:/,'缩进与列表标记必须保留');
  v.cleanup();
});

test('🔴 A1-113 行漂且歧义时 updateGraphBlock 拒写', async () => {
  const v=makeVault(); v.write('2026-08-25.md',DUP_NOTE);
  await T.primeTimingCache();
  const before=v.read('2026-08-25.md');
  const closed=core.formatClockLine(new Date(2026,7,25,10,0), new Date(2026,7,25,10,20));
  // clockUid 指向一个不再是 CLOCK 的行 => 兜底扫描两条都匹配 => 必须拒写
  await assert.rejects(()=>T.updateGraphBlock('2026-08-25.md:3', closed), /Aborting/);
  assert.equal(v.read('2026-08-25.md'),before,'拒写后文件不得被改动');
  v.cleanup();
});

/* ─────────── A1-127：非 x 标记的任务也要能勾完成 ─────────── */
const MARK_NOTE=[
  '# 2026-08-25',                   // 0
  '```naut',                        // 1
  '```',                            // 2
  '- [/] 进行中的任务 30m',           // 3
  '- [-] 取消的任务 30m',             // 4
  '- [ ] 带 [[链接]] 的任务 30m',      // 5
  '\t- [>] 推迟的子步骤',             // 6
].join('\n');

test('🔴 A1-127 `- [/]` / `- [-]` / `- [>]` 都能被 completeTask 勾成 `- [x]`', async () => {
  const v=makeVault(); v.write('2026-08-25.md',MARK_NOTE);
  await T.primeTimingCache();
  for (const n of [3,4,6]) {
    await T.completeTask(`2026-08-25.md:${n}`);
    await T.primeTimingCache();
  }
  const out=v.read('2026-08-25.md').split('\n');
  assert.equal(out[3],'- [x] 进行中的任务 30m',
    '读侧把 `- [/]` 当成 TODO（进 Plan、吃容量、能 Clock In），完成这一步就必须也能走通');
  assert.equal(out[4],'- [x] 取消的任务 30m');
  assert.equal(out[6],'\t- [x] 推迟的子步骤','缩进与 tab 必须原样保留');
  v.cleanup();
});

test('A1-127 判定与 normalizeTaskString 完全一致：非 x 即未完成、x 即已完成', async () => {
  const v=makeVault(); v.write('2026-08-25.md',MARK_NOTE);
  await T.primeTimingCache();
  // 读侧：三种标记都被判成 TODO
  for (const n of [3,4,6]) {
    assert.match(T.readBlockString(`2026-08-25.md:${n}`),/^\{\{TODO\}\}/,
      `第 ${n} 行读侧必须是 TODO —— 读侧说 TODO、写侧却完不成，就是死路`);
  }
  // 写侧：勾完之后读侧必须变 DONE，且第二次调用被守卫拒绝
  await T.completeTask('2026-08-25.md:3');
  await T.primeTimingCache();
  assert.match(T.readBlockString('2026-08-25.md:3'),/^\{\{DONE\}\}/);
  await assert.rejects(()=>T.completeTask('2026-08-25.md:3'),/Only unfinished/);
  v.cleanup();
});

test('A1-127 勾选不得动到正文里的方括号（`[[链接]]` 必须完好）', async () => {
  const v=makeVault(); v.write('2026-08-25.md',MARK_NOTE);
  await T.primeTimingCache();
  await T.completeTask('2026-08-25.md:5');
  assert.equal(v.read('2026-08-25.md').split('\n')[5],'- [x] 带 [[链接]] 的任务 30m');
  v.cleanup();
});

/* ─────────── A1-152：revealLine 必须用传进来的 leaf ───────────
 * `getRightLeaf(false).openFile()` 不设 active ⇒ getActiveLeaf() 仍是用户的主笔记。
 * 拿 active 的 editor 去 setCursor = 把用户的光标扔到【另一个文件的行号】上，
 * 并 scrollIntoView。默认开侧栏时【每次 Clock In 都撞一次】，60ms 后再来一遍。 */
function makeVaultWithLeaves(){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nl-leaf-'));
  const abs=p=>path.join(dir,p);
  const files=new Map();
  function makeEditor(p){
    return { path:p, cursor:null, scrolled:null, opened:[],
      getValue(){ return fs.readFileSync(abs(this.path),'utf8'); },
      lineCount(){ return this.getValue().split('\n').length; },
      getLine(i){ return this.getValue().split('\n')[i] ?? ''; },
      setCursor(pos){ this.cursor=pos; },
      scrollIntoView(range){ this.scrolled=range; },
    };
  }
  function makeLeaf(p){
    const editor=makeEditor(p);
    const node={ classes:new Set(),
      classList:{ add(c){ node.classes.add(c); }, remove(c){ node.classes.delete(c); } } };
    const leaf={ editor, node, opened:[],
      view:{ file:{path:p}, editor,
             contentEl:{ querySelector:(sel)=> sel==='.cm-active-line' ? node : null } },
      // 真实行为：openFile 之后这个 leaf 显示的是新文件（编辑器内容随之换掉）
      openFile:async(f)=>{ leaf.opened.push(f.path); editor.path=f.path; leaf.view.file={path:f.path}; },
    };
    return leaf;
  }
  const mainLeaf=makeLeaf('主笔记.md');
  const rightLeaf=makeLeaf('主笔记.md');   // openFile 之后才换文件，但 editor 是它自己的
  // 🔴 现实：openFile 是异步的、getRightLeaf(false) 更是根本不设 active，
  //    所以 getActiveLeaf() 返回的【不是】我们刚打开的那个 leaf。
  const strayLeaf=makeLeaf('主笔记.md');
  const api={ dir, mainLeaf, rightLeaf, strayLeaf,
    write(p,text){ fs.writeFileSync(abs(p),text); files.set(p,{path:p}); return files.get(p); },
    read(p){ return fs.readFileSync(abs(p),'utf8'); },
    cleanup(){ fs.rmSync(dir,{recursive:true,force:true}); } };
  const vault={
    getAbstractFileByPath:p=>files.get(p)||null,
    getMarkdownFiles:()=>[...files.values()],
    cachedRead:async f=>fs.readFileSync(abs(f.path),'utf8'),
    read:async f=>fs.readFileSync(abs(f.path),'utf8'),
    process:async(f,fn)=>{ const cur=fs.readFileSync(abs(f.path),'utf8');
      const next=fn(cur); fs.writeFileSync(abs(f.path),next); return next; },
  };
  const app={vault,
    workspace:{ iterateAllLeaves(){},
      getActiveLeaf:()=>strayLeaf,
      getLeaf:()=>mainLeaf,
      getRightLeaf:()=>rightLeaf,
      openLinkText:async()=>{} },
    metadataCache:{on(){},off(){}}};
  T.initTimingObsidian({app});
  return api;
}
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));

test('🔴 A1-152 送侧栏时光标只动侧栏那个 leaf，绝不劫持主编辑器', async () => {
  const v=makeVaultWithLeaves();
  v.write('主笔记.md','用户正在写的东西\n第二行\n第三行');
  v.write('任务.md',NOTE);
  const r=await T.frontBlockInRightSidebar('任务.md:3');
  assert.equal(r.ok,true);
  await sleep(120);   // 等 60ms 的重放也跑完
  assert.deepEqual(v.rightLeaf.editor.cursor,{line:3,ch:0},'侧栏 leaf 的光标才是该动的');
  assert.equal(v.mainLeaf.editor.cursor,null,
    '主编辑器光标不得被动 —— 早期实现取 getActiveLeaf() 的 editor，'
    +'把用户光标扔到另一个文件的行号上，且每次 Clock In 都撞一次');
  assert.equal(v.mainLeaf.editor.scrolled,null,'主编辑器也不得被滚动');
  assert.equal(v.strayLeaf.editor.cursor,null,'getActiveLeaf() 返回的那个 leaf 更不该被动');
  v.cleanup();
});

test('🔴 A1-152 openPrimaryPlan 走主编辑区时同样用它自己 openFile 的那个 leaf', async () => {
  const v=makeVaultWithLeaves();
  v.write('主笔记.md','用户正在写的东西\n第二行\n第三行');
  v.write('计划.md',NOTE);
  await T.openPrimaryPlan('计划.md:3');
  await sleep(140);
  assert.deepEqual(v.mainLeaf.editor.cursor,{line:3,ch:0});
  assert.deepEqual(v.mainLeaf.opened,['计划.md'],'必须是它自己 openFile 的那个 leaf');
  assert.equal(v.strayLeaf.editor.cursor,null,
    'openFile 是异步的、active 会滞后 —— 定位必须认 leaf，不许回落 getActiveLeaf()');
  v.cleanup();
});

test('定位高亮 __located：挂上 1200ms 再摘掉（上游 timing-roam.js 的 __located）', async () => {
  const v=makeVaultWithLeaves();
  v.write('主笔记.md','x');
  v.write('任务.md',NOTE);
  await T.frontBlockInRightSidebar('任务.md:3');
  await sleep(120);
  assert.ok(v.rightLeaf.node.classes.has('nautilus-log-timing__located'),
    '定位后必须给那一行挂上高亮类（styles.css 里的规则一直是孤儿）');
  assert.ok(!v.mainLeaf.node.classes.has('nautilus-log-timing__located'),'不得挂到主编辑器上');
  await sleep(1300);
  assert.ok(!v.rightLeaf.node.classes.has('nautilus-log-timing__located'),
    '1200ms 后必须摘掉 —— 不摘就再也触发不了第二次动画');
  v.cleanup();
});

/* ─────────── A1-066：CRLF 文件必须整份一致，不许混行尾 ───────────
 * cachedLines（split('\n') 会残留 \r）与 blockconfig 的 extractPlanBody
 * （/\r?\n/）两处切分规则不一致：同一个 CRLF 文件两边算出不同行集，
 * 写回时新行被拼成裸 LF、与全文 CRLF 混在一起（git 整份飘红）。
 * 🔴 修复前 readAllEntries 在纯 LF 上一切正常 —— 这就是它没被发现的
 *    原因：夹具全是 LF。 */
const CRLF_NOTE = [
  '# 2026-08-25',          // 0
  '```naut',               // 1
  '```',                   // 2
  '- [ ] 写周报 45m',       // 3
  '    - LOGBOOK::',       // 4
  '        - CLOCK: [2026-08-25 Tue 10:00]--[2026-08-25 Tue 10:30] => 0:30', // 5
].join('\r\n');

test('🔴 A1-066 readAllEntries/readPrimaryPlan 在 CRLF 文件上必须照常工作', async () => {
  const v=makeVault(); v.write('2026-08-25.md',CRLF_NOTE);
  await T.primeTimingCache();
  const entries=T.readAllEntries();
  assert.equal(entries.length,1,'CRLF 抽屉里的 CLOCK 必须被扫到');
  assert.equal(entries[0].minutes,30,'解析不受 \\r 残留影响');
  const snap=T.readPrimaryPlan(new Date(2026,7,25,9,0));
  assert.equal(snap.tasks.length,1,'计划正文在 CRLF 下也能解析出弹性任务');
  v.cleanup();
});

test('🔴 A1-066 CRLF 文件写回后必须【整份一致】：新行不许拼成裸 LF', async () => {
  const v=makeVault(); v.write('2026-08-25.md',CRLF_NOTE);
  await T.primeTimingCache();
  await T.createRunningClock('2026-08-25.md:3', new Date(2026,7,25,11,0));
  const out=v.read('2026-08-25.md');
  // 🔴 全文的行尾必须是单一风格：要么 CRLF、要么 LF，绝不允许两种混在一个文件里。
  const bareLf=(out.match(/(?<!\r)\n/g)||[]).length;
  const crlf=(out.match(/\r\n/g)||[]).length;
  assert.equal(bareLf,0,`不允许裸 LF 行尾（git 会整份飘红）。实测: CRLF=${crlf} 裸LF=${bareLf}`);
  assert.ok(crlf>0,'CRLF 行尾本身不能丢（否则文件被静默转成 LF）');
  const newClock=out.split(/\r?\n/).find(l=>l.includes('11:00'));
  assert.ok(newClock,'新 CLOCK 行必须写进去');
  assert.ok(!/[^\r]\r$/.test(newClock)&&newClock.length>0,'新行本身不该混入杂散 \\r');
  v.cleanup();
});

/* ─────────── A1-003：buildEntry 的 end/minutes 字段直接钉子 ─────────── */
test('🔴 A1-003 readAllEntries 对已闭合 CLOCK 返回正确的 end/minutes', async () => {
  const v=makeVault();
  v.write('d.md',['```naut','```','- [ ] 写周报 45m','    - LOGBOOK::',
    '        - CLOCK: [2026-08-25 Tue 10:00]--[2026-08-25 Tue 10:30] => 0:30'].join('\n'));
  await T.primeTimingCache();
  const e=T.readAllEntries()[0];
  assert.ok(e,'应扫到该 CLOCK');
  assert.equal(e.running,false);
  assert.equal(e.minutes,30,'minutes 必须由区间长度算出');
  assert.equal(e.end.getTime(), new Date(2026,7,25,10,30).getTime(),'end 是闭合时刻');
  assert.equal(e.title,'写周报','buildEntry 的 title 字段');
  v.cleanup();
});

/* ─────────── A1-005：findParentTaskIndex 的直接钉子 ───────────
 * scanFile 里 taskUid = `${path}:${findParentTaskIndex(...)}`，
 * 即抽屉上方最近的非空小缩进行。这里直接断言任务行号。 */
test('🔴 A1-005 readAllEntries 的 taskUid 还原到抽屉的缩进父任务行', async () => {
  const v=makeVault();
  v.write('d.md',[
    '# 2026-08-25',                              // 0
    '- [ ] 写周报 45m',                           // 1
    '    - LOGBOOK::',                           // 2
    '        - CLOCK: [2026-08-25 Tue 10:00]--[2026-08-25 Tue 10:30] => 0:30', // 3
    '- [ ] 回邮件 30m',                           // 4  ← 同一文件里还有一个任务
  ].join('\n'));
  await T.primeTimingCache();
  const e=T.readAllEntries()[0];
  assert.ok(e,'应扫到该 CLOCK');
  assert.equal(e.taskUid,'d.md:1',
    '抽屉父任务必须还原到【任务行】而非 LOGBOOK 行、更不是后面的回邮件行');
  v.cleanup();
});

/* ─────────── A1-145：openTaskInMainWindow 的直接钉子 ─────────── */
test('🔴 A1-145 openTaskInMainWindow 在主编辑区打开并定位，不动侧栏', async () => {
  const v=makeVaultWithLeaves();
  v.write('主笔记.md','用户正在写的东西\n第二行\n第三行');
  v.write('任务.md',NOTE);
  const r=await T.openTaskInMainWindow('任务.md:3');
  assert.equal(r.ok,true,'必须返回 {ok:true}（runtime 的调用方按这个判断）');
  await sleep(120);
  assert.deepEqual(v.mainLeaf.opened,['任务.md'],'必须用主编辑区 leaf openFile');
  assert.deepEqual(v.mainLeaf.editor.cursor,{line:3,ch:0},'主编辑器定位到目标行');
  assert.equal(v.rightLeaf.editor.cursor,null,'侧栏 leaf 不得被碰');
  assert.equal(v.strayLeaf.editor.cursor,null,'active 那个 leaf 更不该被碰');
  v.cleanup();
});

/* ─────────── A1-189 / T2-061：showToast 与 frontBlock 失败文案 ─────────── */
function makeToastHost(){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nl-toast-'));
  const abs=p=>path.join(dir,p);
  const files=new Map();
  const notify=[];   // 记录 (message, intent)
  const api={ dir,
    write(p,text){ fs.writeFileSync(abs(p),text); files.set(p,{path:p}); return files.get(p); },
    cleanup(){ fs.rmSync(dir,{recursive:true,force:true}); } };
  const vault={
    getAbstractFileByPath:p=>files.get(p)||null, getMarkdownFiles:()=>[...files.values()],
    cachedRead:async f=>fs.readFileSync(abs(f.path),'utf8'),
    read:async f=>fs.readFileSync(abs(f.path),'utf8'),
    process:async(f,fn)=>{ const cur=fs.readFileSync(abs(f.path),'utf8');
      const next=fn(cur); fs.writeFileSync(abs(f.path),next); return next; } };
  const app={vault, workspace:{iterateAllLeaves(){}, getLeaf:()=>null, openLinkText:async()=>{}, onLayoutReady(cb){ cb(); }},
    metadataCache:{on(){},off(){}}};
  T.initTimingObsidian({ app, notify:(msg,intent)=>notify.push({msg,intent}) });
  return { notify, api };
}

test('🔴 A1-189 showToast 把 intent 透传给宿主 notify（部分调用方传 danger）', async () => {
  const { notify, api }=makeToastHost();
  T.showToast('Clock Out 失败','danger');
  T.showToast('普通提醒');
  assert.equal(notify.length,2);
  assert.equal(notify[0].intent,'danger','intent 不能被丢掉（A1-183 的隐患在 main.ts 侧）');
  assert.equal(notify[1].intent,'warning','缺省必须是 warning');
  assert.equal(notify[0].msg,'Clock Out 失败');
  api.cleanup();
});

test('🔴 T2-061 空 taskUid 的失败必须带自己的 message，绝不让 Roam 文案漏给 Obsidian 用户', () => {
  const r=T.frontBlockInRightSidebar('');
  assert.ok(r instanceof Promise);
  return r.then((res)=>{
    assert.equal(res.ok,false);
    assert.equal(res.reason,'missing-uid');
    assert.ok(res.message && res.message.length>0,'失败必须带 message，否则 vendor '
      +'回落「The task started, but Roam could not show it…」这种 Roam 文案');
    assert.ok(!/Roam/i.test(res.message),'message 不得再含 Roam 字样');
  });
});
