/*
 * timing-stamp.test.js — `stampCompletionTime` 自动完成时间戳。
 *
 * 被测对象是 **src/timing-obsidian.ts 本体**（esbuild bundle），在真实文件系统
 * 上跑完整读改写（与 timing-writeback.test.js 同款）。自动写用户笔记是本插件
 * 最危险的一类操作 —— 每一条写回都必须走乐观锁（内容复核 / 歧义拒写 / 写后读回），
 * 绝不允许整文件覆盖。
 *
 * 🔴 触发语义：metadataCache 'changed' 触发时，文件【已经】被用户改动落盘，
 * `prev`/`fresh` 分别来自缓存（改动前）与磁盘（改动后）。所以端到端测试一律
 * 先把 `fresh` 写进磁盘、再调 stampCheckedTasks(prev, fresh) —— 与真实事件序
 * 一致，也让 writeChange 的乐观锁能在磁盘上找到 `expected`。
 *
 * 覆盖：
 *   · 勾选 → 追加 dHH:MM；取消勾选 → 移除锚点
 *   · 设置关闭时完全不写
 *   · 🔴 块外的任务行不受影响（管辖范围 = 今天日记第一个 nautilus 块的计划正文）
 *   · 已有锚点不重复追加
 *   · 防重入：处理中的同一文件再次触发不重复写
 *   · 执行层面板 Complete 按钮（completeTask）也打锚点
 *   · 乐观锁：检测与写回之间行被外部改动 ⇒ 拒写不落盘、外部编辑保留
 *   · metadataCache 'changed' 通路端到端
 *   · 纯函数：hasDoneAtAnchor / appendDoneAtStamp / stripTrailingDoneAtStamp /
 *     planCheckTransitions
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

/** 真实文件系统 vault。hostOverrides 注入 dailyNotePath / shouldStampCompletion /
 *  metadataCache（默认不记录监听器）。externalEdit 非空时在【第一次】vault.process
 *  落笔前先把外部编辑写进磁盘 —— 模拟「检测之后、写回之前用户又动了同一行」。 */
function makeVault({ host={}, externalEdit=null }={}){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nl-stamp-'));
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
    read:async f=>fs.readFileSync(abs(f.path),'utf8'),
    process:async(f,fn)=>{
      if (processes===0 && externalEdit) {
        const now=fs.readFileSync(abs(f.path),'utf8');
        fs.writeFileSync(abs(f.path), externalEdit(now));   // 外部编辑先落盘
      }
      processes++;
      const cur=fs.readFileSync(abs(f.path),'utf8');
      const next=fn(cur); fs.writeFileSync(abs(f.path),next); return next;
    },
  };
  const app={vault, workspace:{iterateAllLeaves(){}, getLeaf:()=>null, openLinkText:async()=>{}},
             metadataCache: host.metadataCache || {on(){},off(){}}};
  T.initTimingObsidian({ app, dailyNotePath:()=>'d.md', shouldStampCompletion:()=>true, ...host });
  return api;
}

const NOTE=[
  '# 2026-08-28',      // 0
  '```naut',           // 1
  '```',               // 2
  '- [ ] 写周报 45m',    // 3
  '- [ ] 回邮件 30m',    // 4
].join('\n');

async function waitFor(cond, ms=2000){
  const start=Date.now();
  while (Date.now()-start<ms){ if (cond()) return true; await new Promise(r=>setTimeout(r,10)); }
  return cond();
}

/* ── 纯函数 ─────────────────────────────────────────────────────────── */

test('🔴 hasDoneAtAnchor 与 parser 的 DONE_AT_RE 同语法：分钟可省、大小写不敏感', () => {
  assert.equal(T.hasDoneAtAnchor('- [x] 已完成 30m d14:30'), true);
  assert.equal(T.hasDoneAtAnchor('- [x] 已完成 30m d14'), true, '`d14` 也是合法锚点');
  assert.equal(T.hasDoneAtAnchor('- [x] 已完成 30m D14:30'), true, '大小写不敏感');
  assert.equal(T.hasDoneAtAnchor('- [x] 没有锚点 30m'), false);
  assert.equal(T.hasDoneAtAnchor('- [x] dood 不是锚点'), false);
  assert.equal(T.hasDoneAtAnchor('- [x] 2d14:30 不在词首'), false);
});

test('doneAtStamp 补零成 dHH:MM', () => {
  assert.equal(T.doneAtStamp(new Date(2026,7,24,9,5)), 'd09:05');
  assert.equal(T.doneAtStamp(new Date(2026,7,24,16,40)), 'd16:40');
});

test('appendDoneAtStamp：只对缺锚点的已勾选任务行追加；已有锚点 / 非任务行不动', () => {
  assert.equal(T.appendDoneAtStamp('- [x] 写周报 45m', 'd16:40'), '- [x] 写周报 45m d16:40');
  assert.equal(T.appendDoneAtStamp('- [x] 已完成 30m d14:30', 'd16:40'), null, '已有锚点不重复追加');
  assert.equal(T.appendDoneAtStamp('- [ ] 未完成 45m', 'd16:40'), null, '未勾选不是要追加的目标');
  assert.equal(T.appendDoneAtStamp('随手写的一行', 'd16:40'), null, '非任务行不动');
});

test('stripTrailingDoneAtStamp：只移除未勾选任务行【行尾】的锚点', () => {
  assert.equal(T.stripTrailingDoneAtStamp('- [ ] 写周报 45m d16:40'), '- [ ] 写周报 45m');
  assert.equal(T.stripTrailingDoneAtStamp('- [ ] 写周报 45m D16:40'), '- [ ] 写周报 45m', '大小写不敏感');
  assert.equal(T.stripTrailingDoneAtStamp('- [ ] 写周报 45m d14'), '- [ ] 写周报 45m', '分钟可省');
  assert.equal(T.stripTrailingDoneAtStamp('- [ ] 读 d14 章 30m'), null, '标题中间的 d14 不动');
  assert.equal(T.stripTrailingDoneAtStamp('- [x] 已勾选 30m d16:40'), null, '已勾选不是要移除的目标');
  assert.equal(T.stripTrailingDoneAtStamp('- [ ] 没有锚点 30m'), null);
});

test('planCheckTransitions：勾选跃迁只发生在 checkbox 恰好翻转、其余未变的行', () => {
  const prev=['- [ ] 写周报 45m','- [ ] 回邮件 30m'];
  const fresh=['- [x] 写周报 45m','- [ ] 回邮件 30m'];
  const out=T.planCheckTransitions(prev, fresh, 0, 2, 'd16:40');
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], { action:'append', line:0, expected:'- [x] 写周报 45m', next:'- [x] 写周报 45m d16:40' });
  // 取消勾选 → strip
  const back=T.planCheckTransitions(
    ['- [x] 写周报 45m d16:40'], ['- [ ] 写周报 45m d16:40'], 0, 1, 'd16:40');
  assert.equal(back.length, 1);
  assert.deepEqual(back[0], { action:'strip', line:0, expected:'- [ ] 写周报 45m d16:40', next:'- [ ] 写周报 45m' });
  // 其余部分也变了（用户一边勾选一边改文字）→ 保守跳过，不打时间戳
  const edited=T.planCheckTransitions(
    ['- [ ] 写周报 45m'], ['- [x] 写周报和邮件 45m'], 0, 1, 'd16:40');
  assert.equal(edited.length, 0);
  // 非任务行 / checkbox 没变 → 跳过
  assert.equal(T.planCheckTransitions(['- 普通行'], ['- 普通行'], 0, 1, 'd16:40').length, 0);
  assert.equal(T.planCheckTransitions(
    ['- [x] 已完成 45m'], ['- [x] 已完成 45m d16:40'], 0, 1, 'd16:40').length, 0,
    '新行已带锚点 → checkbox 没变，不该再动');
});

/* ── 端到端：stampCheckedTasks ───────────────────────────────────────── */

test('勾选 → 自动追加 dHH:MM；取消勾选 → 自动移除', async () => {
  const v=makeVault();
  v.write('d.md',NOTE);
  const prev=v.read('d.md');
  const fresh=prev.replace('- [ ] 写周报 45m','- [x] 写周报 45m');
  v.write('d.md',fresh);                       // 用户勾选已落盘
  assert.equal(await T.stampCheckedTasks('d.md', prev, fresh), 1);
  assert.match(v.read('d.md'), /- \[x\] 写周报 45m d\d{2}:\d{2}/, '勾选行必须补上锚点');
  assert.match(v.read('d.md'), /- \[ \] 回邮件 30m/, '其它行不得受损');
  // 取消勾选 → 锚点移除（prev2 是带锚点的已勾选态，fresh2 是用户取消勾选）
  const prev2=v.read('d.md');
  const fresh2=prev2.replace(/- \[x\] 写周报 45m/,'- [ ] 写周报 45m');
  v.write('d.md',fresh2);
  assert.equal(await T.stampCheckedTasks('d.md', prev2, fresh2), 1);
  assert.match(v.read('d.md'), /- \[ \] 写周报 45m$/m, '取消勾选必须移除锚点');
  v.cleanup();
});

test('🔴 设置关闭时完全不写（返回 0 且文件保持用户勾选后的原样）', async () => {
  const v=makeVault({ host:{ shouldStampCompletion:()=>false } });
  v.write('d.md',NOTE);
  const prev=v.read('d.md');
  const fresh=prev.replace('- [ ] 写周报 45m','- [x] 写周报 45m');
  v.write('d.md',fresh);
  assert.equal(await T.stampCheckedTasks('d.md', prev, fresh), 0);
  assert.equal(v.read('d.md'), fresh, '设置关闭时文件必须原样（用户自己的勾选保留，但绝不补锚点）');
  v.cleanup();
});

test('🔴 块外的任务行不受影响（管辖范围只到今天日记第一个 nautilus 块的计划正文）', async () => {
  const v=makeVault();
  // 行 0 在块【上方】；行 5 在第一个空行【之后】（跳出计划正文）—— 都不该被打戳。
  const text=[
    '- [ ] 块上方的任务 10m',  // 0
    '```naut',                 // 1
    '```',                     // 2
    '- [ ] 计划内任务 30m',      // 3
    '',                        // 4 ← 空行，正文到此为止
    '- [ ] 空行之后的任务 20m',  // 5
  ].join('\n');
  v.write('d.md',text);
  const prev=v.read('d.md');
  const fresh=prev
    .replace('- [ ] 块上方的任务 10m','- [x] 块上方的任务 10m')
    .replace('- [ ] 计划内任务 30m','- [x] 计划内任务 30m')
    .replace('- [ ] 空行之后的任务 20m','- [x] 空行之后的任务 20m');
  v.write('d.md',fresh);
  assert.equal(await T.stampCheckedTasks('d.md', prev, fresh), 1, '只该写计划内那一行');
  const out=v.read('d.md').split('\n');
  assert.match(out[0], /- \[x\] 块上方的任务 10m(?! d)/, '块上方不得补锚点');
  assert.match(out[3], /- \[x\] 计划内任务 30m d\d{2}:\d{2}/, '计划内必须补锚点');
  assert.match(out[5], /- \[x\] 空行之后的任务 20m(?! d)/, '空行之后不得补锚点');
  v.cleanup();
});

test('已有锚点不重复追加：勾选已带锚点的行，锚点保持原样', async () => {
  const v=makeVault();
  const text=['# 2026-08-28','```naut','```','- [ ] 写周报 45m d16:40'].join('\n');
  v.write('d.md',text);
  const prev=v.read('d.md');
  const fresh=prev.replace('- [ ] 写周报 45m d16:40','- [x] 写周报 45m d16:40');
  v.write('d.md',fresh);
  assert.equal(await T.stampCheckedTasks('d.md', prev, fresh), 0, '已有锚点 → 无写回');
  assert.equal(v.read('d.md'), fresh, '文件必须保持用户勾选后的样子，不再追加第二个锚点');
  v.cleanup();
});

test('🔴 防重入：同一文件处理中再次触发直接跳过，只写一轮', async () => {
  const v=makeVault();
  v.write('d.md',NOTE);
  const prev=v.read('d.md');
  const fresh=prev.replace('- [ ] 写周报 45m','- [x] 写周报 45m');
  v.write('d.md',fresh);
  // 不 await：第一轮在处理中（stampingPaths 已置位），第二轮必须被闸住。
  const p1=T.stampCheckedTasks('d.md', prev, fresh);
  const p2=T.stampCheckedTasks('d.md', prev, fresh);
  const [n1,n2]=await Promise.all([p1,p2]);
  assert.equal(n1, 1, '第一轮正常写');
  assert.equal(n2, 0, '第二轮必须被防重入闸住');
  assert.equal((v.read('d.md').match(/d\d{2}:\d{2}/g)||[]).length, 1, '锚点只允许出现一个');
  v.cleanup();
});

test('🔴 乐观锁：检测与写回之间行被外部改动 ⇒ 拒写不落盘、外部编辑保留', async () => {
  const v=makeVault({ externalEdit:(cur)=>cur.replace('- [x] 写周报 45m','- [x] 写周报（外部改过）45m') });
  v.write('d.md',NOTE);
  const prev=v.read('d.md');
  const fresh=prev.replace('- [ ] 写周报 45m','- [x] 写周报 45m');
  v.write('d.md',fresh);
  await assert.rejects(()=>T.stampCheckedTasks('d.md', prev, fresh), /changed while writing/i,
    '目标行已不是检测时读到的原文，必须中止 —— 绝不猜着写');
  const out=v.read('d.md');
  assert.match(out, /- \[x\] 写周报（外部改过）45m/, '外部编辑必须保留');
  assert.ok(!/d\d{2}:\d{2}/.test(out), '拒写后不得把锚点追加到被改过的行');
  v.cleanup();
});

test('非今天日记的文件不被打戳', async () => {
  const v=makeVault();
  v.write('other.md',NOTE);   // dailyNotePath 是 'd.md'，这是别的文件
  const prev=v.read('other.md');
  const fresh=prev.replace('- [ ] 写周报 45m','- [x] 写周报 45m');
  v.write('other.md',fresh);
  assert.equal(await T.stampCheckedTasks('other.md', prev, fresh), 0);
  assert.equal(v.read('other.md'), fresh, '非今天日记必须原样');
  v.cleanup();
});

/* ── 执行层面板：completeTask ───────────────────────────────────────── */

test('🔴 设置开启时 completeTask（执行层面板 Complete 按钮）也补 dHH:MM 锚点', async () => {
  const v=makeVault();
  v.write('d.md',NOTE);
  await T.primeTimingCache();
  await T.completeTask('d.md:3');
  const out=v.read('d.md');
  assert.match(out, /- \[x\] 写周报 45m d\d{2}:\d{2}/, 'Complete 按钮必须打锚点');
  assert.match(out, /- \[ \] 回邮件 30m/, '其它行不得受损');
  v.cleanup();
});

test('设置关闭时 completeTask 只勾选、不打锚点', async () => {
  const v=makeVault({ host:{ shouldStampCompletion:()=>false } });
  v.write('d.md',NOTE);
  await T.primeTimingCache();
  await T.completeTask('d.md:3');
  assert.equal(v.read('d.md').split('\n')[3], '- [x] 写周报 45m', '默认/关闭时保持原行为');
  v.cleanup();
});

/* ── metadataCache 'changed' 通路 ───────────────────────────────────── */

test('metadataCache changed 通路端到端：勾选落盘 → 监听器自动补锚点', async () => {
  let listener=null;
  const mc={
    on(ev,fn){ if (ev==='changed') listener=fn; return this; },
    off(){},
  };
  const v=makeVault({ host:{ metadataCache:mc } });
  v.write('d.md',NOTE);
  await T.primeTimingCache();               // 缓存里有改动前的正文
  const prev=v.read('d.md');
  const fresh=prev.replace('- [ ] 写周报 45m','- [x] 写周报 45m');
  v.write('d.md',fresh);                    // 用户勾选落盘
  assert.ok(listener, '监听器必须被注册');
  listener({ path:'d.md' });                // 模拟 Obsidian 的 changed 事件
  const stamped=await waitFor(()=>/d\d{2}:\d{2}/.test(v.read('d.md')));
  assert.ok(stamped, '勾选落盘后监听器必须补上锚点');
  assert.match(v.read('d.md'), /- \[x\] 写周报 45m d\d{2}:\d{2}/);
  // 我们自己的写回又触发了一次 changed ⇒ 已是归一化态，不得再来第二轮
  const count=(v.read('d.md').match(/d\d{2}:\d{2}/g)||[]).length;
  assert.equal(count, 1, '写回触发的第二轮必须被闸住，锚点只允许一个');
  v.cleanup();
});
