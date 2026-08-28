const test=require('node:test'), assert=require('node:assert/strict');
const {JSDOM}=require('jsdom'), esbuild=require('esbuild'), path=require('path');
const dom=new JSDOM('<!doctype html><body><div id=h></div></body>',{pretendToBeVisual:true});
global.window=dom.window; global.document=dom.window.document;
esbuild.buildSync({entryPoints:[path.join(__dirname,'../src/tooltip.ts')],bundle:true,format:'cjs',
  platform:'node',outfile:path.join(__dirname,'.t.cjs'),external:['obsidian'],logLevel:'error'});
const {createTooltip}=require('./.t.cjs');

// Obsidian 给 HTMLElement 加的扩展方法（obsidian.d.ts:105）。tooltip.ts 用它写
// 运行时坐标 / visibility —— 社区审核 obsidianmd/no-static-styles-assignment
// 要求的形态。夹具必须忠实实现：写进 el.style，不能是空函数（reality-quirks.md
// RQ-5：「样式没生效」这类 bug 全靠它暴露）。
dom.window.HTMLElement.prototype.setCssStyles = function setCssStyles(styles) {
  Object.assign(this.style, styles);
};

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
  const tip=host.querySelector('.nautilus-log-tooltip');
  assert.ok(tip.classList.contains('nautilus-log-tooltip--hidden'), '显隐走 CSS 类（内联 display 禁令）');
  assert.equal(tip.style.display, '', '不写内联 display');
});

test('mouseenter 显示并填入所有行', () => {
  const {host,el}=setup();
  el.dispatchEvent(new dom.window.Event('mouseenter'));
  const tip=host.querySelector('.nautilus-log-tooltip');
  assert.ok(!tip.classList.contains('nautilus-log-tooltip--hidden'), '显示 = 摘掉隐藏类');
  assert.equal(tip.querySelectorAll('.nautilus-log-tooltip-line').length,3);
  assert.ok(tip.textContent.includes('写周报'));
});

test('mouseleave 隐藏', () => {
  const {host,el}=setup();
  el.dispatchEvent(new dom.window.Event('mouseenter'));
  el.dispatchEvent(new dom.window.Event('mouseleave'));
  assert.ok(host.querySelector('.nautilus-log-tooltip').classList.contains('nautilus-log-tooltip--hidden'));
});

test('键盘 focus 同样触发（可访问性）', () => {
  const {host,el}=setup();
  el.dispatchEvent(new dom.window.Event('focus'));
  assert.ok(!host.querySelector('.nautilus-log-tooltip').classList.contains('nautilus-log-tooltip--hidden'));
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

/* ─────────── RQ-8：jsdom 的布局尺寸恒为 0 ───────────
 * `getBoundingClientRect()` 全 0、`offsetWidth/Height` 恒 0。于是引擎的
 * 翻面与安全边距分支在这条路上**一次都没执行过**，宿主相对定位整段删掉
 * 也不会红（V1 变异实验实测）。形态比 RQ-1 更隐蔽：分支进对了，只是数据
 * 是退化值。见 test/reality-quirks.md RQ-8。 */
test('🔴 RQ-8 定位必须减去宿主偏移（jsdom 尺寸恒 0，掩盖了这段）', () => {
  const {host, el, tt} = setup();
  const tip = host.querySelector('.nautilus-log-tooltip');

  // 同一次 hover，用两个只有原点不同的宿主各算一次：
  // 减了宿主偏移 => 两次的 style.left/top 应当【相同】（都是宿主内坐标）；
  // 没减 => 两次会差出宿主偏移量。这样断言与引擎算出的具体数值无关。
  const at = (left, top) => {
    host.getBoundingClientRect = () => ({ left, top, width: 600, height: 400,
      right: left + 600, bottom: top + 400, x: left, y: top });
    el.dispatchEvent(new dom.window.Event('mouseleave'));
    el.dispatchEvent(new dom.window.Event('mouseenter'));
    return [parseFloat(tip.style.left), parseFloat(tip.style.top)];
  };
  const [l0, t0] = at(0, 0);
  const [l1, t1] = at(120, 60);
  assert.ok(Number.isFinite(l0) && Number.isFinite(t0), '必须算出具体坐标');
  assert.equal(l1, l0,
    '浮层坐标是【宿主内】坐标 —— 宿主整体平移不该改变它。差值 '
    + `${l1 - l0} 说明没减 hostBox.left`);
  assert.equal(t1, t0,
    `同上，差值 ${t1 - t0} 说明没减 hostBox.top`);
  tt.destroy();
});

/* ─── 社区审核 obsidianmd/no-static-styles-assignment 的修复钉子 ───────────
 * src/tooltip.ts 原来的 4 处 `.style.` 直接赋值换成 `setCssStyles`（Obsidian
 * 给 HTMLElement 加的扩展方法，obsidian.d.ts:105）。审核的机械检查就是扫
 * `\.style\.` 赋值，所以这里用同一条 grep 钉死，回退立即红。 */
test('🔴 tooltip.ts 不再有 `.style.` 直接赋值（审核机械检查）', () => {
  const fs = require('fs');
  const src = fs.readFileSync(path.join(__dirname, '../src/tooltip.ts'), 'utf8');
  const hits = [...src.matchAll(/\.style\s*\.\s*[A-Za-z_$]/g)];
  assert.equal(hits.length, 0,
    `src/tooltip.ts 仍含 ${hits.length} 处 \`.style.…\` —— 该用 setCssStyles`);
});

test('🔴 两阶段渲染顺序不变：hidden 量尺寸 → left/top 定位 → visible', () => {
  const { host, el, tt } = setup();
  const tip = host.querySelector('.nautilus-log-tooltip');
  const calls = [];
  const proto = dom.window.HTMLElement.prototype;
  const orig = proto.setCssStyles;
  // 只记录 tip 自己的调用；忠实实现仍然生效（样式照常写进 el.style）。
  proto.setCssStyles = function (styles) {
    if (this === tip) calls.push({ ...styles });
    return orig.call(this, styles);
  };
  try {
    el.dispatchEvent(new dom.window.Event('mouseenter'));
    assert.equal(calls.length, 3,
      `应恰有 3 次 setCssStyles（hidden / 定位 / visible），实际 ${calls.length}`);
    assert.deepEqual(calls[0], { visibility: 'hidden' },
      '第 1 步先 hidden —— 用 visibility 不用 display，量 offsetWidth/offsetHeight');
    assert.deepEqual(Object.keys(calls[1]).sort(), ['left', 'top'],
      '第 2 步 left/top 合成一次调用');
    assert.ok(/px$/.test(calls[1].left) && /px$/.test(calls[1].top),
      `left/top 是算出来的像素坐标，实际 ${JSON.stringify(calls[1])}`);
    assert.deepEqual(calls[2], { visibility: 'visible' }, '第 3 步最后 visible');
    // 语义没被架空：坐标真的写进了 style，能被读回。
    assert.match(tip.style.left, /px$/);
    assert.match(tip.style.top, /px$/);
    assert.equal(tip.style.visibility, 'visible');
  } finally {
    proto.setCssStyles = orig;
  }
  tt.destroy();
});
