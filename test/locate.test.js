const test=require('node:test'), assert=require('node:assert/strict');
const fs=require('fs'), path=require('path');

/** 复刻 main.ts 里 locateInText + 消歧的算法，用于把索引空间错配钉死。 */
function scanBlocks(text){
  const LANGS=['nautilus','naut'];
  const OPEN=new RegExp('^\\s*```+\\s*(?:'+LANGS.join('|')+')\\s*$');
  const CLOSE=/^\s*```+\s*$/;
  const lines=text.split(/\r?\n/), out=[];
  for(let i=0;i<lines.length;i++){
    if(!OPEN.test(lines[i])) continue;
    let j=i+1; const body=[];
    while(j<lines.length && !CLOSE.test(lines[j])){body.push(lines[j]); j++;}
    out.push({body:body.join('\n'),lineEnd:j}); i=j;
  }
  return out;
}
/** ordinal 必须在【同源块】里数 */
function pick(ends, source, ordinalAmongPeers){
  const src=source.replace(/\s+$/,'');
  const same=ends.filter(e=>e.body.replace(/\s+$/,'')===src);
  const pool=same.length?same:ends;
  return pool[Math.min(ordinalAmongPeers,pool.length-1)];
}

const NOTE=fs.readFileSync(path.join(__dirname,'../docs/test-note.md'),'utf8');

test('测试笔记里能扫出全部块', () => {
  const b=scanBlocks(NOTE);
  assert.ok(b.length>=7, `只扫到 ${b.length} 个`);
});

test('多个空块时，第 N 个空块必须定位到第 N 个空块（曾经取错）', () => {
  const ends=scanBlocks(NOTE);
  const empties=ends.filter(e=>!e.body.trim());
  assert.ok(empties.length>=3, '这条测试需要至少 3 个空块才有意义');
  empties.forEach((e,idx)=>{
    const got=pick(ends,'',idx);
    assert.equal(got.lineEnd, e.lineEnd,
      `第 ${idx} 个空块应落在 lineEnd=${e.lineEnd}，实际 ${got.lineEnd}`);
  });
});

test('🔴 回归：ordinal 若按【全部块】序号取会错位', () => {
  const ends=scanBlocks(NOTE);
  const empties=ends.filter(e=>!e.body.trim());
  const target=empties[empties.length-2];              // 倒数第二个空块
  const globalIdx=ends.findIndex(e=>e.lineEnd===target.lineEnd);
  const peerIdx=empties.findIndex(e=>e.lineEnd===target.lineEnd);
  assert.notEqual(globalIdx, peerIdx, '本测试要求两个索引空间确实不同');
  assert.equal(pick(ends,'',peerIdx).lineEnd, target.lineEnd, '同源序号：正确');
  assert.notEqual(pick(ends,'',globalIdx).lineEnd, target.lineEnd, '全局序号：应当取错');
});

test('带内容的块唯一匹配，与 ordinal 无关', () => {
  const ends=scanBlocks(NOTE);
  const cfg=ends.find(e=>e.body.includes('start:'));
  assert.ok(cfg);
  for(const o of [0,1,5]) assert.equal(pick(ends,cfg.body,o).lineEnd, cfg.lineEnd);
});

test('naut 短别名块也会被扫到', () => {
  const b=scanBlocks('```naut\nend: 23\n```\n- [ ] x 1h');
  assert.equal(b.length,1); assert.equal(b[0].body,'end: 23');
});
