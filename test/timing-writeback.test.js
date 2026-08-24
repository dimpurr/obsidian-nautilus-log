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
