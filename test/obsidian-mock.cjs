/*
 * `obsidian` 模块的测试替身。测试里通过 esbuild 的 alias 把它顶上去。
 *
 * 🔴 文件名【不以点开头】：它是源码不是构建产物。以前叫 .mock-obsidian.cjs /
 *    .obsidian-stub.cjs，被 .gitignore 的 `test/.*.cjs` 规则挡住没进版本控制，
 *    结果新克隆的仓库里两个测试直接 Cannot find module。
 */
class Plugin {}
class PluginSettingTab { constructor(app, plugin){ this.app=app; this.plugin=plugin;
  this.containerEl=makeEl(); } display(){} hide(){} }
class ItemView {
  constructor(leaf){
    this.leaf=leaf;
    // ItemView 在真实 Obsidian 里从 leaf 拿到 app；mock 必须透传，
    // 否则 view 里 this.app.xxx 全是 undefined。
    if (leaf && leaf.app) this.app = leaf.app;
    // 🔴 真实 Obsidian 的 ItemView.containerEl 是两层：children[0] 是 header，
    //    children[1] 才是内容区。插件普遍写 containerEl.children[1]，
    //    mock 不还原这个结构就会 undefined.addClass。
    this.containerEl=makeEl();
    this.containerEl.appendChild(makeEl());          // header
    this.contentEl=makeEl();
    this.containerEl.appendChild(this.contentEl);    // content
  }
  onOpen(){} onClose(){}
  registerInterval(id){ return id; }
  registerEvent(){}
}
class MarkdownRenderChild { constructor(el){ this.containerEl=el; } onload(){} onunload(){} }
class Notice { constructor(msg){ this.message=msg; } }
class TFile {
  // 兼容两种构造：new TFile('a/b.md') 与 new TFile({path:'a/b.md'})
  // —— 各测试写法不一，统一在这里吸收，别让每个测试各自去适配。
  constructor(arg){
    const p = (arg && typeof arg === 'object') ? arg.path : arg;
    this.path = p;
    this.basename = String(p||'').split('/').pop().replace(/\.md$/,'');
    this.extension = 'md';
  }
}
class WorkspaceLeaf { constructor(app){ this.view=null; this.app=app||null; } setViewState(){ return Promise.resolve(); } }
class TFolder { constructor(path){ this.path=path; this.children=[]; } }

function makeEl(){
  const g=typeof document!=='undefined'?document:null;
  if (g) { const d=g.createElement('div'); patch(d); return d; }
  return patch({ children:[], empty(){}, createDiv(){return makeEl();},
                 createEl(){return makeEl();}, addClass(){}, removeClass(){},
                 setText(){}, appendChild(){}, });
}
function patch(el){
  if (el && typeof el.createDiv !== 'function') {
    el.createDiv=(o)=>{ const d=document.createElement('div');
      if(o&&o.cls) d.className=typeof o.cls==='string'?o.cls:o.cls.join(' ');
      el.appendChild(d); patch(d); return d; };
    el.createEl=(t,o)=>{ const d=document.createElement(t);
      if(o&&o.cls) d.className=o.cls; if(o&&o.text) d.textContent=o.text;
      el.appendChild(d); patch(d); return d; };
    el.empty=()=>{ while(el.firstChild) el.removeChild(el.firstChild); };
    el.addClass=(c)=>el.classList&&el.classList.add(c);
    el.removeClass=(c)=>el.classList&&el.classList.remove(c);
    el.setText=(t)=>{ el.textContent=t; };
  }
  return el;
}

class Setting {
  constructor(containerEl){ this.containerEl=containerEl; this.name=''; this.desc=''; }
  setName(n){ this.name=n; return this; }
  setDesc(d){ this.desc=d; return this; }
  addText(cb){ cb(stub()); return this; }
  addToggle(cb){ cb(stub()); return this; }
  addDropdown(cb){ cb(Object.assign(stub(),{addOption(){return this;}})); return this; }
  addSlider(cb){ cb(Object.assign(stub(),{setLimits(){return this;},setDynamicTooltip(){return this;}})); return this; }
}
function stub(){ const s={ setValue(){return s;}, setPlaceholder(){return s;},
  onChange(){return s;}, setDisabled(){return s;} }; return s; }

function setIcon(el, name){ if (el && el.setAttribute) el.setAttribute('data-icon', name); }

/** Obsidian 的 normalizePath：反斜杠→正斜杠，折叠重复斜杠，剥 `.` / 解析 `..`，
 *  去尾部斜杠。sidebar.ts 用它清洗用户配置（folder + format）拼出的日记路径，
 *  mock 必须与真身同构，否则「文件夹名带反斜杠」的测试会在夹具里假绿。 */
function normalizePath(p){
  p = String(p ?? '').replace(/\\/g, '/');
  const parts = p.split('/');
  const normalized = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (normalized.length > 0 && normalized[normalized.length - 1] !== '..') normalized.pop();
      else normalized.push(part);
    } else normalized.push(part);
  }
  return normalized.join('/');
}

module.exports = { Plugin, PluginSettingTab, ItemView, MarkdownRenderChild,
  Notice, TFile, TFolder, WorkspaceLeaf, Setting, setIcon, normalizePath,
  MarkdownRenderer: { render: async()=>{}, renderMarkdown: async()=>{} } };
