const test=require('node:test'), assert=require('node:assert/strict');
const {JSDOM}=require('jsdom'), esbuild=require('esbuild'), path=require('path');
const dom=new JSDOM('<!doctype html><body><div id=h></div></body>',{url:'https://localhost/'});
global.window=dom.window; global.document=dom.window.document; global.localStorage=dom.window.localStorage;
esbuild.buildSync({entryPoints:[path.join(__dirname,'../src/controls.ts')],bundle:true,format:'cjs',
  platform:'node',outfile:path.join(__dirname,'.pb.cjs'),external:['obsidian'],logLevel:'error'});
const {renderChartControls}=require('./.pb.cjs');
const S={language:'en',workdayStartHour:5,workdayEndHour:21,descLength:22,todoDuration:15,urgentTrigger:''};
const OPTS={workdayStartMinutes:300,workdayEndMinutes:1260,nowMinutes:720};

/** 复刻宿主行为：每次 onChange 都整块重渲染（destroy 旧 controls，建新的）。
 *  这正是当初制造孤儿定时器的那个循环。 */
function host(){
  const box=document.getElementById('h'); box.innerHTML='';
  let state={showDone:true,collapsed:false,playback:null};
  let handle=null, renders=0;
  function rerender(){
    renders++;
    handle?.destroy();
    box.innerHTML='';
    handle=renderChartControls(box,state,{onChange:n=>{state=n; rerender();}},S,OPTS,'k');
  }
  rerender();
  return {get state(){return state;}, get renders(){return renders;},
          play:()=>box.querySelectorAll('button')[1].dispatchEvent(new dom.window.MouseEvent('click',{bubbles:true})),
          destroy:()=>handle?.destroy()};
}

test('🔴 回归：controls 内部不许持有播放定时器', () => {
  const src=require('fs').readFileSync(path.join(__dirname,'../src/controls.ts'),'utf8');
  // 只看真实调用，注释里提到不算（说明为什么不能这么写恰恰该保留）
  const code=src.split('\n').filter(l=>!/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  assert.ok(!/\bsetInterval\s*\(/.test(code),
    'controls.ts 里出现了 setInterval —— 宿主每 tick 重建组件，定时器会变成清不掉的孤儿');
});

test('点播放 => playback 非空，且从工作日起点开始', () => {
  const h=host();
  h.play();
  assert.notEqual(h.state.playback,null);
  assert.equal(h.state.playback.minute,300);
  h.destroy();
});

test('🔑 再点一次能停下来（当初停不掉的就是这里）', () => {
  const h=host();
  h.play();
  assert.notEqual(h.state.playback,null,'先要能启动');
  h.play();
  assert.equal(h.state.playback,null,'第二次点击后必须回到 null');
  h.destroy();
});

test('停止后不会被复活（孤儿定时器的症状）', async () => {
  const h=host();
  h.play(); h.play();
  const before=h.renders;
  await new Promise(r=>setTimeout(r,400));
  assert.equal(h.state.playback,null,'400ms 后 playback 仍须为 null');
  assert.equal(h.renders,before,'停止后不该再有自发重渲染');
  h.destroy();
});

test('没有可回放区间时不启动（now <= 起点）', () => {
  const box=document.getElementById('h'); box.innerHTML='';
  let st={showDone:true,collapsed:false,playback:null};
  renderChartControls(box,st,{onChange:n=>{st=n;}},S,
    {workdayStartMinutes:300,workdayEndMinutes:1260,nowMinutes:300},'k2');
  box.querySelectorAll('button')[1].dispatchEvent(new dom.window.MouseEvent('click',{bubbles:true}));
  assert.equal(st.playback,null);
});
