#!/usr/bin/env node
/*
 * 移植欠账检测器 —— PORTING-DECISIONS.md §7 的可执行版本。
 *
 * 为什么这几条有效：本移植的 **CSS 与 i18n 是整份从上游搬来的、代码是逐个写的**。
 * 两者之差就是一张现成的欠账清单 —— 不需要人去回忆上游有什么。
 *
 * 五个检测器全是机械判定，零语义推断：
 *   1. 孤儿 CSS      styles.css 里有规则、代码从不发射的类
 *   2. 孤儿文案      引擎文案表里有 key、渲染路径不可达
 *   3. 引擎导出面    src/vendor/*.js 导出了、没有任何调用点的符号
 *   4. 键名空间      vendor 里的 settings.get('...') 字面量必须在 shim 映射表里
 *   5. 上游漂移      vendor 基线与上游 HEAD 的距离（需本地有上游 clone）
 *   6. 怪癖钉子      test/reality-quirks.md 里每条现实怪癖必须有一个真实存在的测试钉住
 *
 * 用法：
 *   node scripts/audit-detectors.mjs           # 人读的报告
 *   node scripts/audit-detectors.mjs --json    # 机器读
 *
 * 🔴 已知欠账走 baseline（scripts/audit-baseline.json）：**新增**的孤儿会让
 *    退出码非 0，存量不会。修掉一条就把它从 baseline 里删掉 —— baseline
 *    只许变短，不许变长。
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const exists = (p) => existsSync(join(ROOT, p));

/** src/ 下所有非 vendor 的 .ts —— 「我们自己写的代码」。 */
function ownSources() {
  return readdirSync(join(ROOT, 'src'))
    .filter((f) => f.endsWith('.ts'))
    .map((f) => ({ path: `src/${f}`, text: read(`src/${f}`) }));
}
function vendorSources() {
  const dir = join(ROOT, 'src/vendor');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.js'))
    .map((f) => ({ path: `src/vendor/${f}`, text: read(`src/vendor/${f}`) }));
}

/** 真正**接线过**的 vendor 模块（从 src/*.ts 的 require 出发做传递闭包）。
 *  🔴 2026-08-26 修：孤儿 CSS 检测器原先把 `src/vendor/*.js` 全体当作「发射面」，
 *  于是只出现在 `timing-topbar.js` 里的类看起来「有人发射」—— 而那个模块
 *  **零 import**（§D3：挂载被 .rm-topbar 门控，改为手写重实现）。
 *  结果是检测器把大约 24 个 `.nautilus-log-timing__*` 孤儿全藏了起来 ——
 *  正是它本该抓的那一类欠账。**死模块不是发射面。** */
function reachableVendorSources() {
  const all = vendorSources();
  const byName = new Map(all.map((v) => [v.path.replace('src/vendor/', '').replace(/\.js$/, ''), v]));
  const own = ownSources().map((f) => f.text).join('\n');
  const seen = new Set();
  const queue = [];
  for (const [name] of byName) {
    if (new RegExp(`vendor/${name}['"\`]`).test(own)) queue.push(name);
  }
  while (queue.length) {
    const name = queue.shift();
    if (seen.has(name)) continue;
    seen.add(name);
    const mod = byName.get(name);
    if (!mod) continue;
    for (const [other] of byName) {
      if (seen.has(other)) continue;
      if (new RegExp(`\\./${other}['"\`]`).test(mod.text)) queue.push(other);
    }
  }
  return all.filter((v) => seen.has(v.path.replace('src/vendor/', '').replace(/\.js$/, '')));
}

/* ── 1. 孤儿 CSS ─────────────────────────────────────────────────────────── */
function orphanCss() {
  const css = read('styles.css');
  // 只看本插件自己的命名空间；Obsidian 内置类不归我们管。
  const classes = new Set(
    [...css.matchAll(/\.(nautilus-log-[a-zA-Z0-9_-]+)/g)].map((m) => m[1]),
  );
  // 发射面 = 我们的 TS + vendor 的 JS（vendor 也发射 class）。
  // 🔴 注释不是发射面。`nautilus-log-container` 只在 header.ts 的一段注释里
  //    出现过（那段注释恰恰是在解释「这个类从没被发射过」），却因此逃出了
  //    检测 —— 认证审计 C2-056/057 就是这么漏的。剥注释再匹配。
  const stripComments = (t) => t
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
  const emitted = [...ownSources(), ...reachableVendorSources()]
    .map((f) => stripComments(f.text)).join('\n');
  const orphans = [];
  for (const cls of classes) {
    // 类名常常是拼出来的（模板字符串 / BEM 修饰），所以「去掉修饰后缀」再匹配一次。
    // 🔴 2026-08-26 修：这里原先还有第三条兜底 `emitted.includes(suffix)`
    //    —— 把 `nautilus-log-` 前缀剥掉再匹配。后果是 `container` / `collapsed`
    //    / `content` / `shell` 这类**普通英文词**在源码里随处可见，于是这几个
    //    类永远「命中」，逃出了 baseline。认证审计 C2-056/057/091 正是这么漏的。
    //    前缀是这套类名唯一的身份，剥掉它就没有身份了 —— 该兜底整条删除。
    const base = cls.replace(/--[a-zA-Z0-9_-]+$/, '');
    if (emitted.includes(cls) || emitted.includes(base)) continue;
    orphans.push(cls);
  }
  return orphans.sort();
}

/* ── 2. 孤儿文案 ─────────────────────────────────────────────────────────── */
function orphanCopy() {
  const out = [];
  for (const { path, text } of vendorSources()) {
    // 文案表形如：  key: 'value',  —— 只取看起来像用户可见字符串的行。
    // 🔴 原正则只认 `X = {`，而 timing-core 写的是 `X = Object.freeze({` ——
    //    整张 EXECUTION_COPY 从来没被检查过（认证审计 P1-102 抓到，
    //    手工补检当场发现真孤儿 openPanelHint）。
    const table = /(?:UI_COPY|EXECUTION_COPY)\s*=\s*(?:Object\.freeze\()?\{/.exec(text);
    if (!table) continue;
    const body = text.slice(table.index);
    const keys = new Set(
      [...body.matchAll(/^\s{4,}([a-zA-Z][a-zA-Z0-9]*)\s*:\s*['"]/gm)].map((m) => m[1]),
    );
    // 🔴 消费者一侧也必须排除【死模块】：timing-topbar.js 消费了大量文案 key，
    //    但它零 import（§D3）。把它算作消费者就等于宣布那些 key「有人用」——
    //    与孤儿 CSS 检测器犯过的是同一个错（认证审计 P1-102 / S1）。
    const consumers = [...ownSources(), ...reachableVendorSources()]
      .filter((f) => f.path !== path)
      .map((f) => f.text)
      .join('\n')
      + text.slice(0, table.index) + body.replace(/^\s{4,}[a-zA-Z][a-zA-Z0-9]*\s*:\s*['"].*$/gm, '');
    for (const k of keys) {
      // 四种取法都算引用：`copy.bar` · `copy['bar']` · 动态键 `cond ? 'bar' : …`
      //   · 以及 `text[name]` 这种完全动态的（那种检测不了，靠 §7 的人工复核）
      if (new RegExp(`[.\\[]['"]?${k}\\b`).test(consumers)) continue;
      if (new RegExp(`['"\`]${k}['"\`]`).test(consumers)) continue;
      out.push(`${path.replace('src/vendor/', '')}:${k}`);
    }
  }
  return out.sort();
}

/* ── 3. 引擎导出面 ───────────────────────────────────────────────────────── */
function unreachableExports() {
  const out = [];
  const own = ownSources().map((f) => f.text).join('\n');
  const vendors = vendorSources();
  for (const { path, text } of vendors) {
    // 🔴 原先只认 CJS `module.exports = {}`；timing-topbar.js 是 ESM
    //    `export function …`，于是整个模块的导出面从没被检查过（P1-053）。
    const block = /module\.exports\s*=\s*\{([\s\S]*?)\n\};/.exec(text);
    const names = block
      ? [...block[1].matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*,?\s*$/gm)].map((m) => m[1])
      : [...text.matchAll(/^export\s+(?:async\s+)?function\s+([A-Za-z_][A-Za-z0-9_]*)/gm)].map((m) => m[1]);
    if (!names.length) continue;
    // 可达 = 我们直接调 || 别的 vendor 文件调（那条链的入口另有检测器管）
    const others = vendors.filter((v) => v.path !== path).map((v) => v.text).join('\n');
    for (const n of names) {
      // SCREAMING_CASE 是【常量】不是函数 —— 按「有没有调用点」判会全体误报。
      const isConst = /^[A-Z][A-Z0-9_]*$/.test(n);
      const re = isConst
        ? new RegExp(`\\b${n}\\b`, 'm')
        : new RegExp(`[.\\b]${n}\\s*\\(|\\b${n}\\s*\\(`, 'm');
      if (re.test(own) || re.test(others)) continue;
      out.push(`${path.replace('src/vendor/', '')}:${n}`);
    }
  }
  return out.sort();
}

/* ── 4. 键名空间 ─────────────────────────────────────────────────────────── */
function unmappedSettingKeys() {
  const asked = new Set(
    vendorSources().flatMap(({ text }) => (
      [...text.matchAll(/settings\.get\(['"]([^'"]+)['"]\)/g)].map((m) => m[1])
    )),
  );
  const main = exists('src/main.ts') ? read('src/main.ts') : '';
  const runtimeOnly = /const\s+RUNTIME_ONLY_KEYS[\s\S]*?\];/.exec(main)?.[0] || '';
  return [...asked]
    .filter((k) => !main.includes(`'${k}'`) && !runtimeOnly.includes(k))
    .sort();
}

/* ── 5. 上游漂移 ─────────────────────────────────────────────────────────── */
function upstreamDrift() {
  // 🔴 原实现只 return 一句提示字符串，**永远不会红**（P1-106）。
  //    真正能机械判定的是：本地 vendor 与 UPSTREAM_DIR 里同名文件是否逐字节相同。
  //    没给 UPSTREAM_DIR 就明说「未检查」，不假装通过。
  const doc = exists('docs/PORTING-DECISIONS.md') ? read('docs/PORTING-DECISIONS.md') : '';
  const baseline = /vendor 基线 \| `([0-9a-f]{7,40})`/.exec(doc)?.[1] || null;
  const up = process.env.UPSTREAM_DIR;
  if (!up) {
    return { baseline, checked: false, diffs: [],
      note: `未检查（设 UPSTREAM_DIR=<上游 clone> 可启用逐字节比对）。基线 ${baseline || '未登记'}` };
  }
  const diffs = [];
  for (const { path } of vendorSources()) {
    const name = path.replace('src/vendor/', '');
    const theirs = join(up, 'src', name);
    if (!existsSync(theirs)) { diffs.push(`${name}: 上游没有同名文件`); continue; }
    if (readFileSync(theirs, 'utf8') !== read(path)) diffs.push(`${name}: 与上游不一致`);
  }
  return { baseline, checked: true, diffs,
    note: diffs.length ? `vendor 与上游有 ${diffs.length} 处不一致` : 'vendor 与上游逐字节相同' };
}

/* ── 6. 怪癖钉子 ─────────────────────────────────────────────────────────
 * test/reality-quirks.md 是一个【棘轮】：它发现不了新怪癖，但保证已发现的
 * 丢不掉。每条 `## RQ-n` 必须有一行 `**钉住它的测试**：\`file\` → \`name\``，
 * 且该文件真的存在、真的含有那个测试名。断链即红。
 * 🔴 与 baseline 不同，这里【没有豁免】—— 怪癖表只许变长。 */
function danglingQuirkPins() {
  const REL = 'test/reality-quirks.md';
  if (!exists(REL)) return [`${REL} 未找到（已查：仓库根下该相对路径）`];
  const doc = read(REL);
  const out = [];
  const sections = [...doc.matchAll(/^## (RQ-\d+)[^\n]*\n([\s\S]*?)(?=^## |\Z)/gm)];
  if (!sections.length) return [`${REL} 里未找到任何 \`## RQ-n\` 条目`];
  for (const [, id, body] of sections) {
    const pin = /\*\*钉住它的测试\*\*[：:]\s*`([^`]+)`\s*(?:→|->)\s*`([^`]+)`/.exec(body);
    if (!pin) { out.push(`${id}: 缺「钉住它的测试」一行`); continue; }
    const [, file, name] = pin;
    if (!exists(file)) { out.push(`${id}: 钉子文件不存在 → ${file}`); continue; }
    if (!read(file).includes(name)) out.push(`${id}: ${file} 里找不到测试「${name}」`);
  }
  return out;
}

/* ── 汇总 ───────────────────────────────────────────────────────────────── */
const result = {
  orphanCss: orphanCss(),
  orphanCopy: orphanCopy(),
  unreachableExports: unreachableExports(),
  unmappedSettingKeys: unmappedSettingKeys(),
  upstreamDrift: upstreamDrift(),
  danglingQuirkPins: danglingQuirkPins(),
};

const BASELINE_PATH = 'scripts/audit-baseline.json';
const baseline = exists(BASELINE_PATH) ? JSON.parse(read(BASELINE_PATH)) : {};
const regressions = {};
for (const key of ['orphanCss', 'orphanCopy', 'unreachableExports', 'unmappedSettingKeys']) {
  const known = new Set(baseline[key] || []);
  const fresh = result[key].filter((x) => !known.has(x));
  if (fresh.length) regressions[key] = fresh;
  // baseline 只许变短：已修好的条目留在 baseline 里会掩盖将来的回归
  const fixed = [...known].filter((x) => !result[key].includes(x));
  if (fixed.length) (regressions.__staleBaseline ||= []).push(...fixed.map((x) => `${key}:${x}`));
}

if (result.danglingQuirkPins.length) regressions.danglingQuirkPins = result.danglingQuirkPins;

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ result, regressions }, null, 2));
} else {
  const label = {
    orphanCss: '孤儿 CSS（样式表有规则、代码不发射）',
    orphanCopy: '孤儿文案（文案表有 key、渲染不可达）',
    unreachableExports: '引擎导出但零调用',
    unmappedSettingKeys: '未映射的设置键（会静默落硬编码兜底）',
  };
  for (const [k, title] of Object.entries(label)) {
    console.log(`\n## ${title} — ${result[k].length} 条`);
    for (const x of result[k]) console.log(`  ${known0(baseline[k], x) ? ' ' : '🔴'} ${x}`);
  }
  console.log(`\n## 怪癖钉子（test/reality-quirks.md）`);
  console.log(result.danglingQuirkPins.length
    ? result.danglingQuirkPins.map((x) => `  🔴 ${x}`).join('\n')
    : '  ✅ 每条怪癖都有活着的钉子');
  console.log(`\n## 上游漂移\n  ${result.upstreamDrift.note}`);
  if (Object.keys(regressions).length) {
    console.log('\n🔴 相对 baseline 的新增/过期：');
    console.log(JSON.stringify(regressions, null, 2));
  } else {
    console.log('\n✅ 无新增欠账');
  }
}
function known0(list, x) { return (list || []).includes(x); }

process.exit(Object.keys(regressions).length ? 1 : 0);
