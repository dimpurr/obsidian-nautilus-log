/*
 * timing-refresh.test.js — 今日日记变更 → 执行层 requestRefresh（事件驱动）。
 *
 * 被测对象是 **src/timing-obsidian.ts 本体**（esbuild bundle）。这个文件把
 * metadataCache 'changed' 事件接到 runtime.requestRefresh 上：用户手动改今天的
 * Daily Note 后，执行层面板不再等 vendor 轮询间隔（15s / 上游 HEAD 起 5min），
 * 而是立刻刷新。见 PROGRESS.md 与台账 §D11。
 *
 * 覆盖（任务要求逐条）：
 *   · 今天的 Daily Note 变了 ⇒ 触发一次 requestRefresh
 *   · 🔴 别的文件变了 ⇒ 不触发（这条最重要）
 *   · 连续多次变更 ⇒ 合并成一次（防抖）
 *   · 我们自己的写回（Clock In 等）不触发第二轮（防重入）
 *   · 执行层关闭时不注册；重新打开时注册
 *   · 卸载后不再触发（无泄漏）
 *
 * 触发语义与 timing-stamp.test.js 同款：metadataCache 'changed' 触发时文件
 * 【已经】被改动落盘，所以测试一律先写磁盘、再手动调监听的 listener。
 * 我们自己的写回会再触发一次 'changed' —— 测试里也在写回完成后手动调 listener
 * 来模拟，验证防重入闸门（selfWritePaths）挡得住。
 */
const test=require('node:test'), assert=require('node:assert/strict');
const fs=require('fs'), os=require('os'), path=require('path');
const esbuild=require('esbuild');

const MOCK_OBSIDIAN=path.join(__dirname,'obsidian-mock.cjs');
const { TFile }=require(MOCK_OBSIDIAN);

/** obsidian 保持 external，但用 mockRequire 把它接回 mock —— bundle 与夹具共享
 *  同一个 TFile 类，`instanceof TFile` 才能跨 bundle 边界成立（同 sidebar.test.js）。 */
function loadTimingBundle(){
  const result=esbuild.buildSync({entryPoints:[path.join(__dirname,'../src/timing-obsidian.ts')],bundle:true,
    format:'cjs',platform:'node',write:false,external:['obsidian'],logLevel:'error'});
  const shim={ exports:{} };
  const mockRequire=(id)=>(id==='obsidian'?require(MOCK_OBSIDIAN):require(id));
  new Function('module','exports','require',result.outputFiles[0].text)(shim,shim.exports,mockRequire);
  return shim.exports;
}
const T=loadTimingBundle();

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

/** 真实文件系统 vault + 记录 listener 的 metadataCache mock。
 *  dailyNotePath 默认指向仓库根的 d.md —— 与 timing-obsidian 的 fallback 不同，
 *  这是 host 注入的那条链，测试里统一走它。 */
function makeEnv({ dailyNotePath='d.md' }={}){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nl-refresh-'));
  const abs=p=>path.join(dir,p);
  const files=new Map();
  const api={
    dir,
    write(p,text){ fs.writeFileSync(abs(p),text); files.set(p,new TFile(p)); return files.get(p); },
    read(p){ return fs.readFileSync(abs(p),'utf8'); },
    cleanup(){ fs.rmSync(dir,{recursive:true,force:true}); },
  };
  const vault={
    getAbstractFileByPath:p=>files.get(p)||null,
    getMarkdownFiles:()=>[...files.values()],
    cachedRead:async f=>fs.readFileSync(abs(f.path),'utf8'),
    read:async f=>fs.readFileSync(abs(f.path),'utf8'),
    process:async(f,fn)=>{ const cur=fs.readFileSync(abs(f.path),'utf8'); const next=fn(cur); fs.writeFileSync(abs(f.path),next); return next; },
  };
  let listener=null;
  const mc={
    on(ev,fn){ if (ev==='changed') listener=fn; return this; },
    off(ev,fn){ if (ev==='changed' && listener===fn) listener=null; return this; },
  };
  const app={ vault, workspace:{}, metadataCache:mc };
  let refreshCalls=0;
  T.initTimingObsidian({ app, dailyNotePath:()=>dailyNotePath, shouldStampCompletion:()=>false });
  return {
    api,
    get listener(){ return listener; },
    /** 模拟 Obsidian 对指定文件触发 metadataCache 'changed'。 */
    changed(filePath){ assert.ok(listener, '监听器必须已注册'); listener({ path:filePath }); },
    /** 打开执行层（注册今日日记刷新钩子）。 */
    openExecutionLayer(){ T.setDailyNoteRefreshCallback(()=>{ refreshCalls++; }); },
    /** 关闭执行层（摘钩）。 */
    closeExecutionLayer(){ T.setDailyNoteRefreshCallback(null); },
    get calls(){ return refreshCalls; },
    dispose(){ T.disposeTimingObsidian(); },
    cleanup(){ T.disposeTimingObsidian(); api.cleanup(); },
  };
}

/* ── 1. 今天的 Daily Note 变了 ⇒ 触发一次 ─────────────────────────────── */

test('今天的 Daily Note 变更 ⇒ 触发一次 requestRefresh', async () => {
  const env=makeEnv();
  env.api.write('d.md',NOTE);
  await T.primeTimingCache();                       // 缓存里有改动前的正文
  env.api.write('d.md', env.api.read('d.md').replace('- [ ] 写周报 45m','- [ ] 写周报 60m'));
  env.openExecutionLayer();
  env.changed('d.md');                              // 模拟 Obsidian 的 changed 事件
  const ok=await waitFor(()=>env.calls>0);
  assert.ok(ok, '今天的日记变了必须触发刷新');
  assert.equal(env.calls, 1, '单次变更只触发一次');
  env.cleanup();
});

/* ── 2. 别的文件变了 ⇒ 不触发 ─────────────────────────────────────────── */

test('🔴 别的文件变更 ⇒ 不触发 requestRefresh', async () => {
  const env=makeEnv();
  env.api.write('d.md',NOTE);
  env.api.write('other.md','# 别的笔记\n');
  await T.primeTimingCache();
  env.openExecutionLayer();
  env.changed('other.md');                          // 非今日日记
  await new Promise(r=>setTimeout(r,300));          // 覆盖防抖窗口，误排也会跑完
  assert.equal(env.calls, 0, '非今日日记的文件不得触发刷新');
  env.cleanup();
});

/* ── 3. 连续多次变更 ⇒ 合并成一次 ─────────────────────────────────────── */

test('连续多次变更 ⇒ 合并成一次 requestRefresh（防抖）', async () => {
  const env=makeEnv();
  env.api.write('d.md',NOTE);
  await T.primeTimingCache();
  env.openExecutionLayer();
  // 一次打字风暴：同一 tick 内连发 10 次变更，每次正文都不同。
  for (let i=0;i<10;i++){
    env.api.write('d.md', env.api.read('d.md')+`\n- [ ] 追加 ${i} 10m`);
    env.changed('d.md');
  }
  const ok=await waitFor(()=>env.calls>0);
  assert.ok(ok, '编辑风暴后必须刷新（合并成一次）');
  await new Promise(r=>setTimeout(r,300));          // 让可能误排的第二桶也跑完
  assert.equal(env.calls, 1, '同一次编辑风暴必须合并成一次刷新');
  env.cleanup();
});

/* ── 4. 我们自己的写回不触发第二轮 ────────────────────────────────────── */

test('🔴 我们自己的写回不触发第二轮（防重入），且闸门会自己过期', async () => {
  const env=makeEnv();
  env.api.write('d.md',NOTE);
  await T.primeTimingCache();
  env.openExecutionLayer();
  // Clock In：本插件自己的写回通道（writeChange 会置位 selfWritePaths 闸门）。
  await T.createRunningClock('d.md:3', new Date(2026,7,28,9,0));
  // 写回落盘后 metadataCache 'changed' 到达 —— 这一轮必须被闸住。
  env.changed('d.md');
  await new Promise(r=>setTimeout(r,300));          // 覆盖防抖窗口
  assert.equal(env.calls, 0, '我们自己的写回不得触发 requestRefresh');
  // 闸门（SELF_WRITE_GUARD_MS=500）过期后，用户的一次真实编辑仍要触发 ——
  // 证明闸门不会把 path 永久吞掉。
  await new Promise(r=>setTimeout(r,400));          // 总等 700ms > 500ms 闸门
  env.api.write('d.md', env.api.read('d.md')+'\n- [ ] 手动新增 10m');
  env.changed('d.md');
  const ok=await waitFor(()=>env.calls>0);
  assert.ok(ok, '闸门过期后用户编辑必须触发刷新');
  env.cleanup();
});

/* ── 5. 执行层关闭时不注册；重新打开时注册 ────────────────────────────── */

test('执行层关闭时不注册；重新打开时注册', async () => {
  const env=makeEnv();
  env.api.write('d.md',NOTE);
  await T.primeTimingCache();
  // 初始：执行层关闭（钩子未注册）—— 今日日记变了也不刷新。
  env.changed('d.md');
  await new Promise(r=>setTimeout(r,300));
  assert.equal(env.calls, 0, '未注册钩子时不得触发刷新');
  // 打开执行层 → 触发一次，但在防抖窗口内立刻摘钩 —— pending 的刷新必须被清掉。
  env.openExecutionLayer();
  env.api.write('d.md', env.api.read('d.md')+'\n- [ ] 新任务 10m');
  env.changed('d.md');
  env.closeExecutionLayer();                        // 150ms 防抖窗口内摘钩
  await new Promise(r=>setTimeout(r,300));
  assert.equal(env.calls, 0, '摘钩后 pending 的防抖不得再触发');
  // 重新打开执行层 → 注册 → 触发。
  env.openExecutionLayer();
  env.api.write('d.md', env.api.read('d.md')+'\n- [ ] 再来 10m');
  env.changed('d.md');
  const ok=await waitFor(()=>env.calls>0);
  assert.ok(ok, '重新打开后必须触发刷新');
  assert.equal(env.calls, 1, '重新打开后恰好一次');
  env.cleanup();
});

/* ── 6. 卸载后不再触发（无泄漏） ──────────────────────────────────────── */

test('卸载后不再触发（无泄漏）', async () => {
  const env=makeEnv();
  env.api.write('d.md',NOTE);
  await T.primeTimingCache();
  env.openExecutionLayer();
  const capturedListener=env.listener;
  assert.ok(capturedListener, '监听器必须先存在');
  env.dispose();                                    // 卸载：dispose 必须 off 掉监听器
  assert.equal(env.listener, null, 'dispose 后监听器必须被摘掉');
  // 已排队的迟到事件（off 挡不住的那一类）：直接调老的 listener 引用。
  capturedListener({ path:'d.md' });
  await new Promise(r=>setTimeout(r,300));
  assert.equal(env.calls, 0, '卸载后任何变更都不得触发刷新');
  env.cleanup();
});
