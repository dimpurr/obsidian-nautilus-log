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
