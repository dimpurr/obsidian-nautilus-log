/*
 * 主会话独立编写 —— 【不采信 worker 自述】。
 * 这是整个项目唯一会改用户文件的代码路径：坏了不是显示错，是损坏笔记。
 * 因此用【真实文件系统】跑完整读改写，不是纯 mock。
 */
const test=require('node:test'), assert=require('node:assert/strict');
const fs=require('fs'), os=require('os'), path=require('path');
const esbuild=require('esbuild');

const MOCK_OBSIDIAN=path.join(__dirname,'obsidian-mock.cjs');
const { TFile }=require(MOCK_OBSIDIAN);

/** obsidian 保持 external，但用 mockRequire 把它接回 mock —— bundle 与夹具共享
 *  同一个 TFile 类，`instanceof TFile` 才能跨 bundle 边界成立（与 sidebar.test.js 同款）。 */
function loadTimingBundle(){
  const result=esbuild.buildSync({entryPoints:[path.join(__dirname,'../src/timing-obsidian.ts')],bundle:true,
    format:'cjs',platform:'node',write:false,external:['obsidian'],logLevel:'error'});
  const shim={ exports:{} };
  const mockRequire=(id)=>(id==='obsidian'?require(MOCK_OBSIDIAN):require(id));
  new Function('module','exports','require',result.outputFiles[0].text)(shim,shim.exports,mockRequire);
  return shim.exports;
}
const T=loadTimingBundle();
// 冷缓存告警的独立 bundle：主 bundle 的 contentCache 会被前面的测试填满，
// 而「预热后仍为空」要求全局缓存为空 —— 只有一份全新模块实例才撑得出这场景。
const TC=loadTimingBundle();

/** 用真实文件系统撑起一个最小 vault。vault.process 走真实原子读改写。
 *  externalEdit 非空时：在【第一次】vault.process 落笔前，先把外部编辑写进磁盘
 *  —— 模拟「用户在 createRunningClock 读完文件之后、写回之前动了同一行」。 */
function makeVault(externalEdit){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nl-vault-'));
  const abs=p=>path.join(dir,p);
  const files=new Map();
  const api={
    dir,
    write(p,text){ fs.writeFileSync(abs(p),text); files.set(p,new TFile(p)); return files.get(p); },
    read(p){ return fs.readFileSync(abs(p),'utf8'); },
    cleanup(){ fs.rmSync(dir,{recursive:true,force:true}); },
  };
  let processes=0;
  const vault={
    getAbstractFileByPath:p=>files.get(p)||null,
    getMarkdownFiles:()=>[...files.values()],
    cachedRead:async f=>fs.readFileSync(abs(f.path),'utf8'),
    // 🔴 写回路径用的是 vault.read（未缓存的最新内容），不是 cachedRead。
    //    这个区分是对的：落笔前必须看到最新文件，缓存可能是旧的。
    read:async f=>fs.readFileSync(abs(f.path),'utf8'),
    process:async(f,fn)=>{
      if (processes===0 && externalEdit) {
        const now=fs.readFileSync(abs(f.path),'utf8');
        fs.writeFileSync(abs(f.path), externalEdit(now));   // 外部编辑先落盘
      }
      processes++;
      const cur=fs.readFileSync(abs(f.path),'utf8');
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

test('🔴 A1-069 已完成任务不得被 createRunningClock 打卡 —— 完整守卫抑制脏写', async () => {
  const v=makeVault(); v.write('d.md',['# 2026-08-24','```naut','```','- [x] 已完成 30m','- [ ] 未完成 30m'].join('\n'));
  await assert.rejects(()=>T.createRunningClock('d.md:3', new Date(2026,7,24,10,0)),
    /unfinished TODO/, '已勾选（DONE）的任务必须被拒');
  const out1=v.read('d.md');
  assert.ok(!/LOGBOOK::/.test(out1),'拒写后不得留下任何 LOGBOOK 抽屉或 CLOCK');
  assert.ok(!/CLOCK:/.test(out1),'拒写后不得插入 CLOCK');
  // 未完成任务仍可正常打卡，证明守卫与正常路径互不干扰
  await T.createRunningClock('d.md:4', new Date(2026,7,24,10,0));
  assert.match(v.read('d.md'),/CLOCK: \[2026-08-24 [A-Za-z]{3} 10:00\]/,
    '未完成任务必须仍能正常写入未闭合 CLOCK');
  v.cleanup();
});

test('🔴 乐观锁：任务行在读后、写回前被外部改动，createRunningClock 必须拒写不落盘', async () => {
  const v=makeVault((cur)=>cur.replace('- [ ] 写周报 45m','- [ ] 写周报（外部改过来）45m'));
  v.write('d.md',NOTE);
  await assert.rejects(()=>T.createRunningClock('d.md:3', new Date(2026,7,24,10,0)),
    /changed while writing/i,
    '锚点行已不是读到的原文，必须中止 —— 否则 LOGBOOK 会插到被改过的任务后面');
  const out=v.read('d.md');
  assert.match(out,/- \[ \] 写周报（外部改过来）45m/,'外部编辑必须保留');
  assert.ok(!/LOGBOOK::/.test(out),'拒写后不得把 LOGBOOK 插到外部改动过的行后面');
  assert.ok(!/CLOCK:/.test(out),'也不得插入 CLOCK');
  v.cleanup();
});

test('🔴 tab 缩进任务 · Clock In：抽屉与 CLOCK 的层级必须落在 tab 子树下方', async () => {
  const v=makeVault();
  v.write('d.md',['# 2026-08-24','- 顶层','\t- [ ] tab 缩进任务 30m','\t- [ ] 同级任务 30m'].join('\n'));
  await T.createRunningClock('d.md:2', new Date(2026,7,24,10,0));
  const lines=v.read('d.md').split('\n');
  // tab 计数为 1 ⇒ 抽屉缩进 = taskIndent(1) + 4 = 5 个空格
  const drawer=lines.findIndex(l=>/LOGBOOK::/.test(l));
  assert.equal(drawer,3,'抽屉应紧接着 tab 任务行（原行 2，插入后为行 3）');
  assert.equal(lines[drawer],'     - LOGBOOK::',
    'tab 任务（缩进 1）的抽屉必须是 5 空格 —— 只数空格不数 tab 会把它掉到 4 空格 = 插进上级');
  assert.equal(lines[drawer-1],'\t- [ ] tab 缩进任务 30m','抽屉正上方必须是原任务行');
  // 新 CLOCK 缩进 = 抽屉 + 4 = 9 空格
  const clock=lines.find(l=>/CLOCK: \[/.test(l));
  assert.equal(clock,'         - CLOCK: [2026-08-24 Mon 10:00]',
    '新 CLOCK 必须继承抽屉的 9 空格层级，不能掉到顶层');
  // 原任务行不受损
  assert.equal(lines[1],'- 顶层');
  assert.equal(lines[drawer+2],'\t- [ ] 同级任务 30m','同级任务行必须原样保留');
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
    write(p,text){ fs.writeFileSync(abs(p),text); files.set(p,new TFile(p));
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
    write(p,text){ fs.writeFileSync(abs(p),text); files.set(p,new TFile(p)); return files.get(p); },
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

/* ─────────── 社区审核：默认控制台只该出现 error ───────────
 * 预热后缓存仍为空 = 执行层全面失明（readPrimaryPlan / readAllEntries 都只认
 * 这份缓存），必须让用户看见。此前用 console.warn，审核指南要求 default
 * console 只该有 error。这条守卫 console.error / 不退回 console.warn。 */
test('🔴 预热后缓存仍为空时用 console.error 告警（不是 console.warn）', async () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nl-cold-'));
  const files=new Map([['2026-08-26.md',new TFile('2026-08-26.md')]]);
  const readyCbs=[];
  const vault={
    getAbstractFileByPath:p=>files.get(p)||null,
    getMarkdownFiles:()=>[...files.values()],
    // 🔴 cachedRead 全失败 => 预热后缓存仍为空 => 触发 cold-cache 告警
    cachedRead:async()=>{ throw new Error('read failure'); },
    read:async()=>{ throw new Error('read failure'); },
  };
  const app={vault,
    workspace:{ iterateAllLeaves(){}, getLeaf:()=>null, openLinkText:async()=>{},
                onLayoutReady(cb){ readyCbs.push(cb); } },
    metadataCache:{on(){},off(){}}};
  const errors=[], warns=[];
  const origError=console.error, origWarn=console.warn;
  console.error=(...a)=>{ errors.push(a.join(' ')); };
  console.warn=(...a)=>{ warns.push(a.join(' ')); };
  try {
    TC.initTimingObsidian({app});
    readyCbs[0]();               // 触发 onLayoutReady → 预热 → warnIfCacheStillCold
    await TC.timingCacheReady();
    assert.ok(errors.some(m=>m.includes('同步内容缓存预热后仍为空')),
      '缓存仍空必须 console.error —— 执行层会全面失明，用户该看到');
    assert.ok(!warns.some(m=>m.includes('同步内容缓存预热后仍为空')),
      '不得退回 console.warn（社区审核：默认控制台只该出现 error）');
  } finally {
    console.error=origError;
    console.warn=origWarn;
    fs.rmSync(dir,{recursive:true,force:true});
  }
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

/* ─────────── 乐观锁：外部并发编辑不得被 Clock Out 覆盖 ───────────
 * closeClock 先读文件定位 CLOCK 行（拿到 expected），后写回。若写回那一刻
 * [目标行已被外部改动]，必须在 applyChange 的内容校验处【拒写】——绝不能
 * 按记录行号把用户刚改的内容整个盖掉（乐观锁失效 = 覆盖真实事故）。
 * 用「状态化 getValue」模拟：closeClock 读第一版 A，写回时看到已变的 B。 */
function makeRacingEditorVault(){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nl-race-'));
  const abs=p=>path.join(dir,p);
  const files=new Map();
  const snapshots=new Map();   // path -> { first, rest, calls }
  const api={
    dir,
    write(p,text){ fs.writeFileSync(abs(p),text); files.set(p,new TFile(p));
      snapshots.set(p,{first:text, rest:text, calls:0}); return files.get(p); },
    /** 让「下一次写回提交」看到一份与读取时不同的文件（模拟外部并发编辑）。 */
    mutateBeforeWrite(p,newText){ const s=snapshots.get(p); s.rest=newText; fs.writeFileSync(abs(p),newText); return api; },
    read(p){ return fs.readFileSync(abs(p),'utf8'); },
    cleanup(){ fs.rmSync(dir,{recursive:true,force:true}); },
  };
  function makeEditor(p){
    return {
      getValue(){
        const s=snapshots.get(p); s.calls+=1;
        // 第 1 次读 = closeClock 的定位读（first）；之后 = 写回时的提交读（rest）
        return s.calls===1 ? s.first : s.rest;
      },
      lineCount(){ return this.getValue().split('\n').length; },
      getLine(i){ return this.getValue().split('\n')[i] ?? ''; },
      setLine(i,text){ const l=this.getValue().split('\n'); l[i]=text;
        const joined=l.join('\n'); fs.writeFileSync(abs(p),joined);
        const s=snapshots.get(p); s.rest=joined; s.first=joined; },
      replaceRange(text,from,to){
        const v=this.getValue(); const lines=v.split('\n');
        const off=(pos)=>lines.slice(0,pos.line).reduce((n,l)=>n+l.length+1,0)+pos.ch;
        const a=off(from), b=to?off(to):a;
        const joined=v.slice(0,a)+text+v.slice(b);
        fs.writeFileSync(abs(p),joined);
        const s=snapshots.get(p); s.rest=joined; s.first=joined;
      },
    };
  }
  const editors=new Map();
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
  // write() 后补挂 editors
  const origWrite=api.write.bind(api);
  api.write=(p,text)=>{ const f=origWrite(p,text); editors.set(p,makeEditor(p)); return f; };
  T.initTimingObsidian({app});
  return api;
}

const RACE_NOTE=[
  '# 2026-08-25',                              // 0
  '```naut',                                   // 1
  '```',                                       // 2
  '- [ ] 写周报 45m',                           // 3
  '    - LOGBOOK::',                           // 4
  '        - CLOCK: [2026-08-25 Tue 10:00]',   // 5  ← 运行中的 CLOCK
].join('\n');
const RACE_ENTRY={ clockUid:'2026-08-25.md:5', taskUid:'2026-08-25.md:3',
  running:true, start:new Date(2026,7,25,10,0) };

test('🔴 乐观锁：目标行在定位与写回之间被外部改掉，Clock Out 必须拒写而非覆盖', async () => {
  const v=makeRacingEditorVault(); v.write('2026-08-25.md',RACE_NOTE);
  await T.primeTimingCache();
  // closeClock 读到第一版后，写回那一刻 CLOCK 行已被外部改成（仍运行中但多了注记）
  v.mutateBeforeWrite('2026-08-25.md',
    RACE_NOTE.replace('        - CLOCK: [2026-08-25 Tue 10:00]',
                     '        - CLOCK: [2026-08-25 Tue 10:00]  # 外部注记'));
  await assert.rejects(()=>T.closeClock({...RACE_ENTRY}, new Date(2026,7,25,10,18)),
    /target line changed|Aborting/i,
    '乐观锁生效：预期拒绝写回（外部已改动，不能按行号盲写覆盖）');
  const out=v.read('2026-08-25.md');
  assert.match(out,/外部注记/,'用户外部新增的内容必须原样保留，绝不能被我覆盖');
  assert.ok(!/=> 0:18/.test(out),'拒写后文件不得出现闭合改写的身影');
  v.cleanup();
});

test('🔴 A1-095 行号漂移后重复 Clock Out 仍幂等：按内容锚回，不写文件', async () => {
  const v=makeVault(); v.write('d.md',NOTE);
  await T.createRunningClock('d.md:3', new Date(2026,7,24,10,0));
  const running=(await T.readAllEntries()).find(e=>e.running);
  const first=await T.closeClock(running,new Date(2026,7,24,10,18));
  // 用户在闭合同再次编辑：开头插两行（CLOCK 行号漂移）
  v.write('d.md','新增一行\n又一行\n'+v.read('d.md'));
  const snapshot=v.read('d.md');
  // 拿【同一个 running entry】在漂移后再关一次
  const again=await T.closeClock(running,new Date(2026,7,24,10,45));
  assert.equal(v.read('d.md'),snapshot,
    '行漂后第二次 Clock Out 仍不得改文件 —— 闭合同内容的覆盖 = 用户凭空多出 27 分钟');
  assert.equal(again.running,false,'必须返回已闭合状态');
  assert.equal(again.end.getTime(),first.end.getTime(),'结束时刻必须是第一次的 10:18');
  assert.equal(again.minutes,first.minutes);
  v.cleanup();
});

/* ─────────── A1-078 镜像：Clock Out 的闭合确认不得认到同分钟的另一条 ───────────
 * closeClock 写回的确认按「running:false 的精确重定位」走；若退化成「全文扫
 * 第一条同起始分钟」，会拍在【别人的、仍运行中】的同分钟 CLOCK 上，返回一个
 * 仍然 running 的 entry，调用方（runtime）就以为这条还没闭 —— 之后任何
 * closeDoneClocks/reconcile 都会再次对着它下笔。文件写对了也白搭：状态机错了。 */
test('🔴 闭合确认按精确重定位，返回已闭合同一条，不认同分钟的另一条 running', async () => {
  const v=makeVault(); v.write('2026-08-25.md',DUP_NOTE);
  await T.primeTimingCache();
  const entryB={ clockUid:'2026-08-25.md:8', taskUid:'2026-08-25.md:6', running:true,
            start:new Date(2026,7,25,10,0) };
  const closed=await T.closeClock(entryB, new Date(2026,7,25,10,25));
  // 🔴 返回的必须是【已闭合】的那一条（乙），而不是同分钟仍在跑的甲
  assert.equal(closed.running,false,
    '返回必须已闭合 —— 命中甲的那条 running 会让 runtime 认为还没闭，之后重复下笔');
  assert.equal(closed.end.getTime(), new Date(2026,7,25,10,25).getTime(),'结束时刻 = 本次 Clock Out');
  assert.equal(closed.clockUid, '2026-08-25.md:8','确认的对象必须是刚关的乙 line:8');
  // 文件层面：改的只是乙
  const out=v.read('2026-08-25.md').split('\n');
  assert.match(out[8],/=> 0:25/);
  assert.equal(out[5],'        - CLOCK: [2026-08-25 Tue 10:00]','甲的 CLOCK 必须原样保留');
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

/* ─────────── 点击盘面切片 +10% 进度（bumpProgress）───────────
 * 语义对齐上游 update-block-progress（component.cljs:518-545）。
 * 这里是端到端：真实文件系统 + 乐观锁写回，四条分支 + 拒写 + editor 通路。 */

const PROGRESS_NOTE=[
  '# 2026-08-24',                // 0
  '```naut',                     // 1
  '```',                         // 2
  '- [ ] 写周报 45m d50%',        // 3
  '- [ ] 回邮件 30m d90%',        // 4
  '- [ ] 做方案 30m d95%',        // 5
  '- [x] 已归档 30m d11:30',      // 6
].join('\n');

test('bumpProgress +10 普通：d50% → d60%，勾选状态不动', async () => {
  const v=makeVault(); v.write('d.md',PROGRESS_NOTE);
  await T.bumpProgress('d.md:3', 10, new Date(2026,7,24,10,0));
  assert.equal(v.read('d.md').split('\n')[3],'- [ ] 写周报 45m d60%');
  assert.match(v.read('d.md'),/- \[ \] 回邮件 30m d90%/,'其它行不得受损');
  v.cleanup();
});

test('bumpProgress 跨到正好 100：勾选 + 去 dNN% + 追加 dHH:MM 锚点', async () => {
  const v=makeVault(); v.write('d.md',PROGRESS_NOTE);
  await T.bumpProgress('d.md:4', 10, new Date(2026,7,24,10,0));
  assert.equal(v.read('d.md').split('\n')[4],'- [x] 回邮件 30m d10:00',
    'now=10:00 必须锚成 d10:00，且任务被勾选');
  v.cleanup();
});

test('bumpProgress 超过 100：去掉 dNN%（回到无进度），不改勾选', async () => {
  const v=makeVault(); v.write('d.md',PROGRESS_NOTE);
  await T.bumpProgress('d.md:5', 10, new Date(2026,7,24,10,0));
  assert.equal(v.read('d.md').split('\n')[5],'- [ ] 做方案 30m');
  v.cleanup();
});

test('bumpProgress 从无到有：追加 d10% + 取消勾选 + 剥掉 dHH:MM 锚点', async () => {
  const v=makeVault(); v.write('d.md',PROGRESS_NOTE);
  await T.bumpProgress('d.md:6', 10, new Date(2026,7,24,10,0));
  assert.equal(v.read('d.md').split('\n')[6],'- [ ] 已归档 30m d10%',
    '已完成任务被重新打开：去 x、去旧锚点、给 10%');
  v.cleanup();
});

test('🔴 乐观锁：点击前目标行被外部改掉 → bumpProgress 必须拒写不落盘', async () => {
  const v=makeVault((cur)=>cur.replace('- [ ] 写周报 45m d50%','- [ ] 写周报（外部改过）45m d50%'));
  v.write('d.md',PROGRESS_NOTE);
  await assert.rejects(()=>T.bumpProgress('d.md:3', 10, new Date(2026,7,24,10,0)),
    /changed while writing/i,
    '目标行已不是点击时读到的原文，必须中止 —— 否则会把用户对那一行的改动无声抹掉');
  const out=v.read('d.md');
  assert.match(out,/- \[ \] 写周报（外部改过）45m d50%/,'外部编辑必须保留');
  assert.ok(!/- \[ \] 写周报 45m d60%/.test(out),'不得把进度写到外部改动过的行上');
  v.cleanup();
});

test('笔记开着编辑器时 bumpProgress 走 editor 分支写回', async () => {
  const v=makeVaultWithEditor(); v.write('d.md',PROGRESS_NOTE);
  await T.bumpProgress('d.md:3', 10, new Date(2026,7,24,10,0));
  const out=v.read('d.md').split('\n');
  assert.equal(out[3],'- [ ] 写周报 45m d60%','进度必须经 editor 写进文件');
  assert.equal(out[4],'- [ ] 回邮件 30m d90%','其它行不得受损');
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
    write(p,text){ fs.writeFileSync(abs(p),text); files.set(p,new TFile(p)); return files.get(p); },
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

test('🔴 目录（TFolder）不是 TFile：openTask 必须显式拒掉，绝不拿文件夹 openFile', async () => {
  // 回归钉：旧的 isFileLike 只认 `{path: string}`，TFolder 也满足 ⇒ 文件夹会被
  // 一路当成 TFile 送进 openFile（对着错误的对象做 IO）。换成 `instanceof TFile`
  // 之后必须显式失败。回退实现（isFileLike + as TFile）本测试会红。
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nl-folder-'));
  const abs=p=>path.join(dir,p);
  const { TFolder }=require('./obsidian-mock.cjs');
  const folder=new TFolder('folder');
  const files=new Map([['folder',folder]]);
  const opened=[];
  const vault={
    getAbstractFileByPath:p=>files.get(p)||null,
    getMarkdownFiles:()=>[...files.values()],
    cachedRead:async f=>fs.readFileSync(abs(f.path),'utf8'),
    read:async f=>fs.readFileSync(abs(f.path),'utf8'),
    process:async()=>{ throw new Error('文件夹不该走 vault.process'); },
  };
  const app={vault,
    workspace:{ iterateAllLeaves(){}, getActiveLeaf:()=>null,
      getLeaf:()=>({ opened, openFile:async f=>opened.push(f.path) }),
      getRightLeaf:()=>null, openLinkText:async()=>{} },
    metadataCache:{on(){},off(){}}};
  T.initTimingObsidian({app});
  await assert.rejects(()=>T.openTaskInMainWindow('folder:0'), /no file path/i,
    '文件夹路径必须被拒（instanceof TFile 窄化失败）');
  assert.deepEqual(opened,[], '绝不允许把 TFolder 送进 openFile');
  fs.rmSync(dir,{recursive:true,force:true});
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
    write(p,text){ fs.writeFileSync(abs(p),text); files.set(p,new TFile(p)); return files.get(p); },
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

/* ═══════════════════════════════════════════════════════════════════════
 * 变异实验第 3 组补测 —— deleteClock / updateGraphBlock：
 *   定位 / 歧义拒写 / 末行删除边界。
 * 每条都先注入对应变异、确认本文件变红、再还原验证全绿（见 report-3.md）。
 * 禁止写成「断言源码长什么样」—— 全部造真实文件、跑真实写回、断言内容。
 * ═══════════════════════════════════════════════════════════════════════ */

test('🔴 deleteClock 行漂 + 同分钟两条 running CLOCK 时歧义拒写，不赌一个', async () => {
  const v=makeVault(); v.write('2026-08-25.md',DUP_NOTE);
  await T.primeTimingCache();
  // 行首插一行：uid 5（甲原先的 CLOCK 行）现在落在甲的 LOGBOOK 抽屉行上
  v.write('2026-08-25.md','# 补丁\n'+v.read('2026-08-25.md'));
  await T.primeTimingCache();
  assert.ok(!/CLOCK:/.test(v.read('2026-08-25.md').split('\n')[5]),'前提：第 5 行已不是 CLOCK');
  const entryA={ clockUid:'2026-08-25.md:5', taskUid:'2026-08-25.md:3', running:true,
    start:new Date(2026,7,25,10,0) };
  await assert.rejects(()=>T.deleteClock(entryA), /Aborting/,
    'uid 行漂后全文件扫出两条同分钟 running 命中，必须拒写而不是删第一条');
  assert.equal((v.read('2026-08-25.md').match(/CLOCK:/g)||[]).length,2,
    '两条 CLOCK 必须原样保留 —— 赌一个 = 删掉用户保留的另一条记录');
  v.cleanup();
});

test('🔴 deleteClock 不得删掉已经被外部闭合的 CLOCK（running 过滤是最后防线）', async () => {
  const v=makeVault();
  v.write('2026-08-25.md',['# 2026-08-25',
    '    - LOGBOOK::',
    '        - CLOCK: [2026-08-25 Tue 10:00]--[2026-08-25 Tue 10:25] => 0:25'].join('\n'));
  await T.primeTimingCache();
  // 内存快照里还是 running 的 entry，磁盘上已被外部编辑闭合 —— 已闭合是用户保留的历史
  const entry={ clockUid:'2026-08-25.md:2', taskUid:'2026-08-25.md:0', running:true,
    start:new Date(2026,7,25,10,0) };
  await assert.rejects(()=>T.deleteClock(entry), /Aborting/,
    '磁盘上不是 running 的 CLOCK 不得按 stale entry 删除');
  assert.match(v.read('2026-08-25.md'),/CLOCK: \[2026-08-25 Tue 10:00\]--/,
    '已闭合的记录必须原样保留');
  v.cleanup();
});

test('🔴 deleteClock 行漂后按内容精确定位删除，绝不按 uid 里的旧行号盲删', async () => {
  const v=makeVault(); v.write('2026-08-25.md',LAST_LINE_NOTE);
  await T.primeTimingCache();
  // 行首插一行：CLOCK 从 5 漂到 6，uid 的旧行号 5 现在指着 LOGBOOK 抽屉行
  v.write('2026-08-25.md','# 补丁\n'+v.read('2026-08-25.md'));
  await T.primeTimingCache();
  await T.deleteClock({...LAST_LINE_ENTRY});
  const out=v.read('2026-08-25.md');
  assert.ok(!/CLOCK:/.test(out),'跑掉的那条 CLOCK 必须被真正删除');
  assert.match(out,/^    - LOGBOOK::$/m,'抽屉必须原样保留，不得把抽屉行当 CLOCK 删掉');
  assert.match(out,/- \[ \] 写周报 45m/,'任务行完好');
  v.cleanup();
});

test('🔴 updateGraphBlock 行漂后按内容精确定位写入，不按 uid 旧行号盲写', async () => {
  const v=makeVault(); v.write('2026-08-25.md',LAST_LINE_NOTE);
  await T.primeTimingCache();
  // 同上：CLOCK 漂到 6，uid 旧行号 5 = LOGBOOK 抽屉行
  v.write('2026-08-25.md','# 补丁\n'+v.read('2026-08-25.md'));
  await T.primeTimingCache();
  const closed=core.formatClockLine(new Date(2026,7,25,10,0), new Date(2026,7,25,10,20));
  await T.updateGraphBlock('2026-08-25.md:5', closed);
  const out=v.read('2026-08-25.md').split('\n');
  assert.match(out.join('\n'),/^    - LOGBOOK::$/m,
    '抽屉必须原样保留 —— 盲写会把 LOGBOOK 行改成 CLOCK');
  const clock=out.findIndex(l=>/CLOCK:/.test(l));
  assert.equal(clock,6,'漂移后该闭合的是第 6 行的那条 CLOCK');
  assert.match(out[clock],/=> 0:20/,'reconcileLegacyOverlap 要补的结束时刻必须落到对的这一行');
  assert.match(out[clock],/^\s+- CLOCK:/,'缩进与列表标记必须保留');
  v.cleanup();
});
/* ─────────────────── 写回乐观锁：两个读之间内容被改写时必须拒写 ───────────────────
 * 变异实验（report-4，第 4 组）把「写回前不比对 expected 内容」的三种打碎方式都放进了
 * 现有夹具 —— 全部存活：现有测试里 read 与 process 之间从不夹进一次写入，
 * 乐观锁那行代码从来没真正被考验过。以下用「第一个读返回旧快照、写回读磁盘当前态」
 * 的夹具模拟两个读之间的并发改写，再断言写回必须落在【当前】内容上、或干脆拒写。 */
function makeRaceVault(){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nl-race-'));
  const abs=p=>path.join(dir,p);
  const files=new Map();
  let stale=null, staleServed=false;
  const api={ dir,
    write(p,text){ fs.writeFileSync(abs(p),text); files.set(p,new TFile(p)); return files.get(p); },
    read(p){ return fs.readFileSync(abs(p),'utf8'); },
    /** 让「第一个读」返回旧快照，之后的读一律回到磁盘当前内容。 */
    setStale(text){ stale=text; staleServed=false; },
    cleanup(){ fs.rmSync(dir,{recursive:true,force:true}); } };
  const vault={
    getAbstractFileByPath:p=>files.get(p)||null,
    getMarkdownFiles:()=>[...files.values()],
    cachedRead:async f=>fs.readFileSync(abs(f.path),'utf8'),
    read:async f=>{
      if(stale!==null && !staleServed){ staleServed=true; return stale; }
      return fs.readFileSync(abs(f.path),'utf8');
    },
    // 🔴 process 永远读【磁盘当前内容】—— 模拟两个读之间文件被其它写入者改了
    process:async(f,fn)=>{ const cur=fs.readFileSync(abs(f.path),'utf8');
      const nxt=fn(cur); fs.writeFileSync(abs(f.path),nxt); return nxt; } };
  const app={vault, workspace:{iterateAllLeaves(){}, getLeaf:()=>null, openLinkText:async()=>{}},
             metadataCache:{on(){},off(){}}};
  T.initTimingObsidian({app});
  return api;
}

test('🔴 乐观锁：扫描与写回之间任务行被插行移动，completeTask 必须按【内容】回锚，不得按旧行号落笔', async () => {
  const v=makeRaceVault();
  const STALE=['# 2026-08-25','- [ ] 写周报 45m','- [ ] 回邮件 30m'].join('\n');
  const LIVE =['# 2026-08-25','- 用户刚插入的行','- [ ] 写周报 45m','- [ ] 回邮件 30m'].join('\n');
  v.write('d.md', LIVE);
  v.setStale(STALE);
  await T.completeTask('d.md:1');            // 调用方手里的 uid 还指旧行号
  const out=v.read('d.md').split('\n');
  assert.equal(out[1],'- 用户刚插入的行','用户刚插入的行必须原样，不得被改写成任务');
  assert.equal(out[2],'- [x] 写周报 45m','写回必须落到【当前】那一行（按内容回锚），而不是旧行号');
  assert.equal((out.join('\n').match(/CLOCK:/g)||[]).length,0,'不得产生多余行');
  v.cleanup();
});

test('🔴 乐观锁：CLOCK 行在定位与写回之间被改（如用户手动闭合），deleteClock 必须拒删',
  async () => {
    const v=makeRaceVault();
    const STALE=['# 2026-08-25','- [ ] 写周报 45m','    - LOGBOOK::',
      '        - CLOCK: [2026-08-25 Tue 10:00]'].join('\n');
    const LIVE =['# 2026-08-25','- [ ] 写周报 45m','    - LOGBOOK::',
      '        - CLOCK: [2026-08-25 Tue 10:00]--[2026-08-25 Tue 10:30] => 0:30'].join('\n');
    v.write('d.md', LIVE);
    v.setStale(STALE);
    const entry={ clockUid:'d.md:3', taskUid:'d.md:1', running:true,
      start:new Date(2026,7,25,10,0) };
    await assert.rejects(()=>T.deleteClock(entry), /changed|Aborting/i,
      '目标行已变时必须拒删抛错；静默返回 true = 用户以为删了其实还在（乐观锁失效）');
    assert.match(v.read('d.md'),/=> 0:30/,'用户手动闭合的记录必须原样保留');
    v.cleanup();
  });

test('🔴 乐观锁：editor 通道同样必须拒写 —— 两个读之间 CLOCK 被改，deleteClock 不许静默成功',
  async () => {
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nl-race-ed-'));
    const abs=p=>path.join(dir,p);
    const files=new Map();
    // 🔴 两次 getValue 返回不同内容：第一次是「定位时」的快照，第二次是「写回时」已变的内容。
    const seq=new Map();   // path -> [stale, live]
    const counts=new Map();
    const api={ dir,
      write(p,text){ fs.writeFileSync(abs(p),text); files.set(p,new TFile(p)); return files.get(p); },
      read(p){ return fs.readFileSync(abs(p),'utf8'); },
      setSeq(p,a,b){ seq.set(p,[a,b]); counts.set(p,0); },
      cleanup(){ fs.rmSync(dir,{recursive:true,force:true}); } };
    function makeEditor(p){
      return {
        getValue(){
          const c=(counts.get(p)||0); counts.set(p,c+1);
          const s=seq.get(p);
          if(s && c<s.length) return s[c];
          return fs.readFileSync(abs(p),'utf8');
        },
        lineCount(){ return this.getValue().split('\n').length; },
        getLine(i){ return this.getValue().split('\n')[i] ?? ''; },
        setLine(i,text){ const l=this.getValue().split('\n'); l[i]=text;
          fs.writeFileSync(abs(p),l.join('\n')); },
        replaceRange(text,from,to){
          const v=this.getValue(); const lines=v.split('\n');
          const off=(pos)=>pos.line>=0?lines.slice(0,pos.line).reduce((n,l)=>n+l.length+1,0)+pos.ch:0;
          const a=off(from), b=to?off(to):a;
          fs.writeFileSync(abs(p),v.slice(0,a)+text+v.slice(b));
        },
      };
    }
    const editors=new Map();
    const vault={
      getAbstractFileByPath:p=>files.get(p)||null,
      getMarkdownFiles:()=>[...files.values()],
      cachedRead:async f=>fs.readFileSync(abs(f.path),'utf8'),
      read:async f=>fs.readFileSync(abs(f.path),'utf8'),
      process:async()=>{ throw new Error('开着编辑器时不该走 vault.process'); } };
    const app={vault,
      workspace:{ iterateAllLeaves(cb){ for(const [p] of editors) cb({view:{file:{path:p},editor:editors.get(p)}}); },
        getLeaf:()=>null, openLinkText:async()=>{} },
      metadataCache:{on(){},off(){}}};
    T.initTimingObsidian({app});
    const STALE=['# 2026-08-25','- [ ] 写周报 45m','    - LOGBOOK::',
      '        - CLOCK: [2026-08-25 Tue 10:00]'].join('\n');
    const LIVE =['# 2026-08-25','- [ ] 写周报 45m','    - LOGBOOK::',
      '        - CLOCK: [2026-08-25 Tue 10:00]--[2026-08-25 Tue 10:30] => 0:30'].join('\n');
    api.write('d.md', LIVE);
    editors.set('d.md', makeEditor('d.md'));
    api.setSeq('d.md', STALE, LIVE);
    const entry={ clockUid:'d.md:3', taskUid:'d.md:1', running:true,
      start:new Date(2026,7,25,10,0) };
    await assert.rejects(()=>T.deleteClock(entry), /changed|Aborting/i,
      'editor 通道目标已变时同样必须拒删抛错，不得静默返回 true');
    assert.match(api.read('d.md'),/=> 0:30/,'手动闭合的记录必须原样保留');
    api.cleanup();
  });

test('🔴 通道等价：completeTask 经 vault.process 与经 editor 写回，产生的文件必须逐字节一致',
  async () => {
    const run=(maker)=>{
      const v=maker(); v.write('d.md',NOTE);
      return T.completeTask('d.md:3').then(()=>{ const out=v.read('d.md'); v.cleanup(); return out; });
    };
    const viaProcess=await run(makeVault);
    const viaEditor =await run(makeVaultWithEditor);
    assert.equal(viaEditor,viaProcess,
      'replace 写在两条通道下必须一模一样（A1-202 只断言了 remove，这里补 replace）');
  });


/* ═══════ 变异测试 · 第 5 组 ═══════ */

/* ═══════ 寻址内核：写回落笔前文件被并发改了（乐观锁的用武之地）═══════
 * 🔴 前面所有夹具的「读 → 写」之间文件从未变过，所以 locateLine /
 *    applyChange 的 expected 校验永远命中、永远走 uid 快路径 ——
 *    这正是乐观锁代码面从未被测到真实路径的原因。
 *
 *    这条夹具模拟的是最真实的损坏场景：适配器拿到快照（expected、行号）
 *    之后、vault.process 落笔之前，另一个写者（用户在编辑器里、别的插件、
 *    同步服务）改了同一份文件。含竞态的 writeback 必须：
 *    · 行漂了 → 按【内容】重新定位（locateLine / applyChange 的回退路径）；
 *    · 定位有歧义 → 拒写（宁可报错也不改错人）；
 *    · 纯内容被改 → 拒写（乐观锁，绝不猜着写）。
 *
 *    具体做法：fake vault 的 process 在跑 applyChange 之前先按 raceFn
 *    并发落一次盘 —— readFreshLines 读到的是改动前的快照，
 *    applyChange 拿到的却是改动后的行集。文件与写回仍全部真实。 */
function makeRacingVault_g5(raceFn){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nl-race-'));
  const abs=p=>path.join(dir,p);
  const files=new Map();
  const api={ dir,
    write(p,text){ fs.writeFileSync(abs(p),text); files.set(p,new TFile(p)); return files.get(p); },
    read(p){ return fs.readFileSync(abs(p),'utf8'); },
    cleanup(){ fs.rmSync(dir,{recursive:true,force:true}); } };
  const vault={
    getAbstractFileByPath:p=>files.get(p)||null,
    getMarkdownFiles:()=>[...files.values()],
    cachedRead:async f=>fs.readFileSync(abs(f.path),'utf8'),
    read:async f=>fs.readFileSync(abs(f.path),'utf8'),
    // 🔴 竞态注入点：先并发写盘，再读出内容喂给 applyChange。
    process:async(f,fn)=>{ const raced=raceFn(fs.readFileSync(abs(f.path),'utf8'));
      fs.writeFileSync(abs(f.path),raced);
      const next=fn(fs.readFileSync(abs(f.path),'utf8'));
      fs.writeFileSync(abs(f.path),next); return next; },
  };
  const app={vault, workspace:{iterateAllLeaves(){}, getLeaf:()=>null, openLinkText:async()=>{}},
             metadataCache:{on(){},off(){}}};
  T.initTimingObsidian({app});
  return api;
}

/* ─────────── 行漂：CLOCK 上方插一行，closeClock 必须按内容追到新位置 ─────────── */
const RACE_CLOCK_NOTE_g5=[
  '# 2026-08-25',                               // 0
  '```naut',                                    // 1
  '```',                                        // 2
  '- [ ] 写周报 45m',                            // 3
  '    - LOGBOOK::',                            // 4
  '        - CLOCK: [2026-08-25 Tue 10:00]',    // 5  ← running，全文唯一
].join('\n');
const RACE_ENTRY_g5={ clockUid:'2026-08-25.md:5', taskUid:'2026-08-25.md:3', running:true,
  start:new Date(2026,7,25,10,0) };

test('🔴 写回落笔前任务上方插进一行：closeClock 按内容追到漂移后的 CLOCK 合上，插入行不得受损', async () => {
  const v=makeRacingVault_g5((cur)=>cur.replace('# 2026-08-25','# 2026-08-25\n如果有人在写'));
  v.write('2026-08-25.md',RACE_CLOCK_NOTE_g5);
  await T.primeTimingCache();
  await T.closeClock(RACE_ENTRY_g5, new Date(2026,7,25,10,18));
  const out=v.read('2026-08-25.md').split('\n');
  // 并发插入的行在快照之后落盘（现在的第 1 行），本写回必须原样放它过去
  assert.equal(out[1],'如果有人在写','并发插入的行必须完好（不得被我们的写回覆盖）');
  assert.equal(out[4],'- [ ] 写周报 45m','任务行必须还在原位');
  assert.equal(out[5],'    - LOGBOOK::','抽屉行必须还在原位');
  assert.match(out[6],/--\[2026-08-25 [A-Za-z]{3} 10:18\] => 0:18/,
    'CLOCK 从第 5 行漂到第 6 行，必须在【新位置】合上，而不是按旧行号写进抽屉行');
  assert.equal(out.filter(l=>/CLOCK:/.test(l)).length,1,'不得写出第二条 CLOCK');
  v.cleanup();
});

/* ─────────── 歧义：任务行被插入行挤走，且全文有两行同文本 ───────────
 * completeTask 的 expected 是任务行原文。落笔时若行号已不再是它、
 * 且这个文本在全文出现两次 ⇒ 只能拒写。早期的 locateLine 回退会取
 * 第一个命中 → 勾到【另一个同名任务】头上（A1-127 的反向事故）。 */
const RACE_DUP_NOTE_g5=[
  '# 2026-08-25',          // 0
  '- [ ] 写周报 45m',       // 1  ← 任务甲
  '    - LOGBOOK::',       // 2
  '        - CLOCK: [2026-08-25 Tue 10:00]--[2026-08-25 Tue 10:30] => 0:30', // 3
  '- [ ] 写周报 45m',       // 4  ← 任务乙（与甲同文本）
].join('\n');

test('🔴 写回落笔前挤进一行且全文有两行同文本：completeTask 必须拒写，而不是勾到第一个同名任务', async () => {
  const v=makeRacingVault_g5((cur)=>cur.replace('# 2026-08-25','# 2026-08-25\n- [ ] 别的任务 10m'));
  v.write('2026-08-25.md',RACE_DUP_NOTE_g5);
  await T.primeTimingCache();
  const before=v.read('2026-08-25.md');
  await assert.rejects(()=>T.completeTask('2026-08-25.md:4'), /changed while writing|Aborting|target line/i,
    '落笔时发现 expected 已在两处出现（行号也不再指向任务行），必须拒写，不得勾掉任何一个同名任务');
  const out=v.read('2026-08-25.md').split('\n');
  assert.equal(out[2],'- [ ] 写周报 45m','任务甲不得被误勾（它现在在第 2 行）');
  assert.equal(out[5],'- [ ] 写周报 45m','任务乙不得被误勾（它现在在第 5 行）');
  assert.ok(!/\[x\]/.test(v.read('2026-08-25.md')),'全文不得出现任何勾选（已查 /\\[x\\]/）');
  assert.equal(out[1],'- [ ] 别的任务 10m','并发插入的那行必须原样留下（这正是拒写的原因）');
  assert.equal(out[4],'        - CLOCK: [2026-08-25 Tue 10:00]--[2026-08-25 Tue 10:30] => 0:30','CLOCK 行不得受损');
  v.cleanup();
});


/* ═══════ 变异测试 · 第 6 组 ═══════ */

/* ═══════════════════════════════════════════════════════════════════════
 * 变异证伪第 6 组 · 读侧（scanFile / readPrimaryPlan / taskLineMemo / CRLF）
 * 每条都做过「打上变异 ⇒ 变红、还原 ⇒ 全绿」验证，见 report-6.md。
 * 只改 test 文件，src/ 不动。
 * ═══════════════════════════════════════════════════════════════════════ */

/* ─────────── 本组 M9：findParentTaskIndex 必须按【缩进】回退 ───────────
 * 抽屉上方紧邻的一行可能是任务自己的缩进子项（笔记、备注），不是父任务。
 * 只抓「紧邻上一非空行」会让 taskUid 指到子项行 —— 之后 createRunningClock
 * 就跑去子项下面建抽屉、CLOCK 全记到别的东西头上（A1-005 只钉了
 * 「不是 LOGBOOK 行、不是后面的任务」，没钉「不是紧邻的子项」）。 */
const SUBITEM_DRAWER_g6=[
  '# 2026-08-25',                                  // 0
  '- [ ] 任务甲 30m',                               // 1
  '    - 备注子项',                                  // 2  ← 抽屉上方最近的【非空】行，但不是父
  '    - LOGBOOK::',                               // 3
  '        - CLOCK: [2026-08-25 Tue 10:00]',       // 4
].join('\n');

test('🔴 本组-M9 抽屉的父任务按缩进回退，不得抓紧邻的缩进子项', async () => {
  const v=makeVault(); v.write('d.md',SUBITEM_DRAWER_g6);
  await T.primeTimingCache();
  const e=T.readAllEntries()[0];
  assert.ok(e,'应扫到该 CLOCK');
  assert.equal(e.taskUid,'d.md:1',
    '父任务是缩进更小的 任务甲（d.md:1），不是紧邻上方的 备注子项（d.md:2）—— '
    +'否则新打卡的抽屉会建到子项下面，CLOCK 被记到子项头上');
  v.cleanup();
});

/* ─────────── 本组 M6：scanFile 离开任务子树必须关闭抽屉 ───────────
 * 抽屉的「作用域」到缩进不再大于它为止。用户删掉 LOGBOOK 行后、CLOCK 残留在
 * 下一个任务的子树里时，若不关闭上一个抽屉，残留 CLOCK 会被算到上一个任务
 * 头上（taskUid 指错人）。这喂给运行时谁拥有哪条 CLOCK，读错就写错。 */
const STRAY_NOTE_g6=[
  '# 2026-08-25',                                  // 0
  '- [ ] 任务甲 30m',                               // 1
  '    - LOGBOOK::',                               // 2
  '        - CLOCK: [2026-08-25 Tue 10:00]',       // 3  ← 甲的
  '- [ ] 任务乙 30m',                               // 4  ← 缩进 0，甲子树的终点
  '    - 手动粘贴的残行',                            // 5
  '        - CLOCK: [2026-08-25 Tue 11:00]',       // 6  ← 乙子树里的残留 CLOCK（抽屉被删了）
].join('\n');

test('🔴 本组-M6 离开任务子树后，残留 CLOCK 不得算到上一个任务头上', async () => {
  const v=makeVault(); v.write('d.md',STRAY_NOTE_g6);
  await T.primeTimingCache();
  const entries=T.readAllEntries();
  assert.equal(entries.length,1,
    '只该收集任务甲抽屉里那一条；乙子树里没抽屉的 CLOCK 不得被兜进甲名下');
  assert.equal(entries[0].start.getTime(), new Date(2026,7,25,10,0).getTime());
  assert.equal(entries[0].taskUid,'d.md:1');
  v.cleanup();
});

/* ─────────── 本组 M4：写回前的乐观锁必须按【内容】复核 ───────────
 * locateLine 若只信行号、不信内容，那么「外层读完之后、落笔之前」文件被并发
 * 改动（Obsidian 的 editor 写、另一个插件写）时，我们仍按旧行号把改动写进去，
 * 把用户的并发编辑整个盖掉。上游 Tasks 插件的注释正是这句：
 * "Obsidian would write after us and overwrite our change."
 * 夹具模拟一次恰好落在两次读之间的并发修改：真实文件、真实写回、断言盘上内容。 */
function makeTickVault_g6(){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nl-tick-'));
  const abs=p=>path.join(dir,p);
  const files=new Map();
  const editors=new Map();
  let reads=0;
  // 从第 2 次读开始，磁盘上先被「并发」改掉任务行，再返回 —— 模拟用户在
  // 我们读到之后、落笔之前的那一瞬改了同一行（Obsidian 自己就是这么写的）。
  const tick=(p)=>{ const t=fs.readFileSync(abs(p),'utf8');
    fs.writeFileSync(abs(p), t.replace('- [ ] 写周报 45m','- [ ] 写周报（正在被用户改写）45m')); };
  const api={
    dir,
    write(p,text){ fs.writeFileSync(abs(p),text); files.set(p,new TFile(p));
                   editors.set(p,makeEditor(p)); return files.get(p); },
    read(p){ return fs.readFileSync(abs(p),'utf8'); },
    cleanup(){ fs.rmSync(dir,{recursive:true,force:true}); },
  };
  function makeEditor(p){
    return {
      getValue(){ reads+=1; if(reads>=2) tick(p); return fs.readFileSync(abs(p),'utf8'); },
      lineCount(){ return fs.readFileSync(abs(p),'utf8').split('\n').length; },
      getLine(i){ return fs.readFileSync(abs(p),'utf8').split('\n')[i] ?? ''; },
      setLine(i,text){ const l=fs.readFileSync(abs(p),'utf8').split('\n'); l[i]=text;
                       fs.writeFileSync(abs(p),l.join('\n')); },
      replaceRange(){ throw new Error('本场景不该走 insert 分支'); },
    };
  }
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

test('🔴 本组-M4 写回前有并发修改时按内容复核拒写，绝不按行号盲写', async () => {
  const v=makeTickVault_g6(); v.write('d.md',NOTE);
  // 任务行在「读后写前」被并发改成了别的文本 —— completeTask 必须察觉并放弃
  await assert.rejects(()=>T.completeTask('d.md:3'), /changed while writing/,
    '外层读与落笔之间内容已变，乐观锁必须拦下，不能按旧行号硬写');
  const out=v.read('d.md');
  assert.match(out,/- \[ \] 写周报（正在被用户改写）45m/,
    '用户的并发编辑必须原封不动');
  assert.ok(!/- \[x\] 写周报/.test(out),
    '不得把完成动作落到被并发改过的行上 —— 那是把用户正在写的话整个盖掉');
  assert.equal((out.match(/写周报/g)||[]).length,1,'不得凭空多出一行任务');
  v.cleanup();
});

/* ─────────── 本组 M2：CRLF 读侧契约钉 ───────────
 * cachedLines 必须与 extractPlanBody 用同一套切分规则（/\r?\n/），读侧的行
 * 原文不得携带 \r 残留 —— 否则任务行原文喂给寻址 / taskLineMemo 重锚时全是
 * 带 \r 的脏串。（M2「只按 \\n 切分」实测因读侧全在 trim 而呈现中性，这条
 * 钉的是切分契约本身，不是先验的变异杀手。） */
test('本组-M2 CRLF 读侧契约：readBlockString 的任务行原文不得带 \\r 残留', async () => {
  const v=makeVault(); v.write('2026-08-25.md',CRLF_NOTE);
  await T.primeTimingCache();
  const s=T.readBlockString('2026-08-25.md:3');
  assert.equal(s,'{{TODO}} 写周报 45m',
    '读侧产出的任务串必须干净（无 \\r），否则寻址与 memo 重锚会带着 CRLF 脏尾比较');
  v.cleanup();
});
