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

/* ── 1. 孤儿 CSS ─────────────────────────────────────────────────────────── */
function orphanCss() {
  const css = read('styles.css');
  // 只看本插件自己的命名空间；Obsidian 内置类不归我们管。
  const classes = new Set(
    [...css.matchAll(/\.(nautilus-log-[a-zA-Z0-9_-]+)/g)].map((m) => m[1]),
  );
  // 发射面 = 我们的 TS + vendor 的 JS（vendor 也发射 class）。
  const emitted = [...ownSources(), ...vendorSources()].map((f) => f.text).join('\n');
  const orphans = [];
  for (const cls of classes) {
    // 类名常常是拼出来的（模板字符串 / BEM 修饰），所以用「去掉修饰后缀」再匹配一次。
    const base = cls.replace(/--[a-zA-Z0-9_-]+$/, '');
    const suffix = cls.replace(/^nautilus-log-/, '');
    if (emitted.includes(cls) || emitted.includes(base) || emitted.includes(suffix)) continue;
    orphans.push(cls);
  }
  return orphans.sort();
}

/* ── 2. 孤儿文案 ─────────────────────────────────────────────────────────── */
function orphanCopy() {
  const out = [];
  for (const { path, text } of vendorSources()) {
    // 文案表形如：  key: 'value',  —— 只取看起来像用户可见字符串的行。
    const table = /(?:UI_COPY|EXECUTION_COPY)\s*=\s*\{/.exec(text);
    if (!table) continue;
    const body = text.slice(table.index);
    const keys = new Set(
      [...body.matchAll(/^\s{4,}([a-zA-Z][a-zA-Z0-9]*)\s*:\s*['"]/gm)].map((m) => m[1]),
    );
    const consumers = [...ownSources(), ...vendorSources()]
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
    const block = /module\.exports\s*=\s*\{([\s\S]*?)\n\};/.exec(text);
    if (!block) continue;
    const names = [...block[1].matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*,?\s*$/gm)].map((m) => m[1]);
    // 可达 = 我们直接调 || 别的 vendor 文件调（那条链的入口另有检测器管）
    const others = vendors.filter((v) => v.path !== path).map((v) => v.text).join('\n');
    for (const n of names) {
      const re = new RegExp(`[.\\b]${n}\\s*\\(|\\b${n}\\s*\\(`, 'm');
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
  const doc = exists('docs/PORTING-DECISIONS.md') ? read('docs/PORTING-DECISIONS.md') : '';
  const baseline = /vendor 基线 \| `([0-9a-f]{7,40})`/.exec(doc)?.[1] || null;
  return { baseline, note: baseline
    ? `对照命令：git -C <upstream> log --oneline ${baseline}..HEAD`
    : '未在 PORTING-DECISIONS.md 里找到 vendor 基线（已查：正则 /vendor 基线 \\| `sha`/）' };
}

/* ── 汇总 ───────────────────────────────────────────────────────────────── */
const result = {
  orphanCss: orphanCss(),
  orphanCopy: orphanCopy(),
  unreachableExports: unreachableExports(),
  unmappedSettingKeys: unmappedSettingKeys(),
  upstreamDrift: upstreamDrift(),
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
