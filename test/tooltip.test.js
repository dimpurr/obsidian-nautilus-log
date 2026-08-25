const test=require('node:test'), assert=require('node:assert/strict');
const {JSDOM}=require('jsdom'), esbuild=require('esbuild'), path=require('path');
const dom=new JSDOM('<!doctype html><body><div id=h></div></body>',{pretendToBeVisual:true});
global.window=dom.window; global.document=dom.window.document;
esbuild.buildSync({entryPoints:[path.join(__dirname,'../src/tooltip.ts')],bundle:true,format:'cjs',
  platform:'node',outfile:path.join(__dirname,'.t.cjs'),external:['obsidian'],logLevel:'error'});
const {createTooltip}=require('./.t.cjs');

function setup(){
  const host=document.getElementById('h');
  host.innerHTML='';
  const el=document.createElement('div'); host.appendChild(el);
  const tt=createTooltip(host);
  tt.attach([{el,startMinutes:600,endMinutes:660,lines:['写周报','10:00–11:00','1h']}],
            {centerX:300,centerY:400,radius:150});
  return {host,el,tt};
}

test('默认隐藏', () => {
  const {host}=setup();
  assert.equal(host.querySelector('.nautilus-log-tooltip').style.display,'none');
});

test('mouseenter 显示并填入所有行', () => {
  const {host,el}=setup();
  el.dispatchEvent(new dom.window.Event('mouseenter'));
  const tip=host.querySelector('.nautilus-log-tooltip');
  assert.notEqual(tip.style.display,'none');
  assert.equal(tip.querySelectorAll('.nautilus-log-tooltip-line').length,3);
  assert.ok(tip.textContent.includes('写周报'));
});

test('mouseleave 隐藏', () => {
  const {host,el}=setup();
  el.dispatchEvent(new dom.window.Event('mouseenter'));
  el.dispatchEvent(new dom.window.Event('mouseleave'));
  assert.equal(host.querySelector('.nautilus-log-tooltip').style.display,'none');
});

test('键盘 focus 同样触发（可访问性）', () => {
  const {host,el}=setup();
  el.dispatchEvent(new dom.window.Event('focus'));
  assert.notEqual(host.querySelector('.nautilus-log-tooltip').style.display,'none');
});

test('destroy 后移除浮层且不再响应', () => {
  const {host,el,tt}=setup();
  tt.destroy();
  assert.equal(host.querySelector('.nautilus-log-tooltip'),null);
  el.dispatchEvent(new dom.window.Event('mouseenter'));   // 不应抛错
});

test('重复 attach 不累积监听（防泄漏）', () => {
  const host=document.getElementById('h'); host.innerHTML='';
  const el=document.createElement('div'); host.appendChild(el);
  const tt=createTooltip(host);
  const t=[{el,startMinutes:600,endMinutes:660,lines:['a']}];
  const geo={centerX:300,centerY:400,radius:150};
  for(let i=0;i<5;i++) tt.attach(t,geo);
  el.dispatchEvent(new dom.window.Event('mouseenter'));
  assert.equal(host.querySelectorAll('.nautilus-log-tooltip').length,1);
  tt.destroy();
});

/* ------------------------------------------------------------------ */
/* P1-9 几何对齐（上游 component.cljs:427 / 436-459 / 468-482）        */
/* ------------------------------------------------------------------ */

/** 上游 hover-anchor 用方向向量相对圆心的主轴决定 preferred；
 *  不传的话引擎默认恒 'right'（vendor/log-core.js:1389），
 *  于是【左半盘】的提示一律朝右弹、正好盖住盘面。 */
test('P1-9② 左半盘的提示朝左弹（preferred 必须传）', () => {
  const host=document.getElementById('h'); host.innerHTML='';
  const el=document.createElement('div'); host.appendChild(el);
  const tt=createTooltip(host);
  // 600–660 的中点 630 => 角 45° => 方向向量在圆心【左上】，dx = dy < 0 => 'left'
  tt.attach([{el,startMinutes:600,endMinutes:660,lines:['写周报']}],
            {centerX:300,centerY:400,radius:158});
  el.dispatchEvent(new dom.window.Event('mouseenter'));
  assert.equal(host.querySelector('.nautilus-log-tooltip').dataset.placement,'left');
  tt.destroy();
});

test('P1-9③ 锚点走 getScreenCTM 换算，而不是「viewBox 缩放 = 1」', () => {
  const host=document.getElementById('h'); host.innerHTML='';
  const NS='http://www.w3.org/2000/svg';
  const svg=document.createElementNS(NS,'svg');
  svg.setAttribute('class','nautilus-log-svg');
  const el=document.createElementNS(NS,'g');
  svg.appendChild(el); host.appendChild(svg);
  // 缩放 2 倍：用户坐标 (x,y) -> 屏幕 (2x, 2y)。jsdom 不实现这两个 API，
  // 按实例挂桩即可（生产里由浏览器提供）。
  svg.getScreenCTM=()=>({a:2,b:0,c:0,d:2,e:0,f:0});
  svg.createSVGPoint=()=>({x:0,y:0,matrixTransform(m){return {x:this.x*m.a+m.e,y:this.y*m.d+m.f};}});

  const tt=createTooltip(host);
  tt.attach([{el,startMinutes:600,endMinutes:660,lines:['写周报']}],
            {centerX:300,centerY:400,radius:158});
  el.dispatchEvent(new dom.window.Event('mouseenter'));
  const tip=host.querySelector('.nautilus-log-tooltip');
  // 方向向量 ≈ (188.3, 288.3) => 屏幕 ≈ (376.6, 576.6)；placement=left => x = 锚点 - gap(10)
  const left=parseFloat(tip.style.left);
  assert.ok(Math.abs(left-366.6)<1.5,
    `锚点应落在屏幕坐标上（≈366.6px），实际 ${left} —— 未换算时会是 ≈178.3`);
  tt.destroy();
});
