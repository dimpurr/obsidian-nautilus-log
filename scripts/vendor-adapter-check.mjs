/*
 * vendor 的 import 面 vs 适配层的导出面机械核对。
 *
 * 为什么：本项目把上游引擎逐字 vendor 在 src/vendor/，esbuild 把里面的
 * from './timing-roam' 重定向到 src/timing-obsidian.ts。
 * 上游每次升级都可能新增 import（如 14e8d07 新增 pageTitleFor / projectPrimaryPlanPull）。
 *
 * 判定规则：
 *   1. 扫 src/vendor/*.js，收集所有 from './timing-roam' 的 import 名单（支持多行）。
 *   2. 扫 src/timing-obsidian.ts 的导出面。
 *   3. import 里有、导出面里没有的 ⇒ 报错退出（非 0）。
 *   4. 适配层导出了但 vendor 不 import ⇒ 正常（不报错）。
 */

/** 剥去 JS/TS 源码中的注释，防止注释中的 import/export 伪造符号。 */
export function stripComments(t) {
  return (t || '')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

/**
 * 从单个 vendor 文件源码中提取所有从 './timing-roam' 导入的符号列表。
 * 支持多行 import、别名 (foo as bar -> foo)、default 导入以及 require 解构。
 */
export function extractTimingRoamImports(text) {
  const clean = stripComments(text || '');
  const imports = new Set();

  // 1. ESM import ... from './timing-roam' (支持多行与 .js 后缀)
  const importRe = /import\s+([\s\S]*?)\s+from\s+['"]\.\/timing-roam(?:\.[a-zA-Z0-9_-]+)?['"]/g;
  let match;
  while ((match = importRe.exec(clean)) !== null) {
    const clause = match[1].trim();
    if (clause.includes('{')) {
      const beforeBrace = clause.slice(0, clause.indexOf('{')).replace(/,/g, '').trim();
      if (beforeBrace && !beforeBrace.startsWith('*')) {
        imports.add('default');
      }
      const inside = clause.slice(clause.indexOf('{') + 1, clause.lastIndexOf('}'));
      for (const raw of inside.split(',')) {
        const item = raw.trim();
        if (!item) continue;
        const noType = item.replace(/^type\s+/, '').trim();
        // `orig as alias` -> 需要适配层导出 `orig`
        const orig = noType.split(/\s+as\s+/)[0].trim();
        if (orig && /^[a-zA-Z0-9_$]+$/.test(orig)) {
          imports.add(orig);
        }
      }
    } else if (clause.startsWith('* as ')) {
      imports.add('*');
    } else if (clause) {
      imports.add('default');
    }
  }

  // 2. CJS require('./timing-roam')
  const reqRe = /(?:const|let|var)\s*\{([\s\S]*?)\}\s*=\s*require\(['"]\.\/timing-roam(?:\.[a-zA-Z0-9_-]+)?['"]\)/g;
  while ((match = reqRe.exec(clean)) !== null) {
    const inside = match[1];
    for (const raw of inside.split(',')) {
      const item = raw.trim();
      if (!item) continue;
      // `prop: alias` -> 需要适配层导出 `prop`
      const orig = item.split(':')[0].trim();
      if (orig && /^[a-zA-Z0-9_$]+$/.test(orig)) {
        imports.add(orig);
      }
    }
  }

  return [...imports].sort();
}

/**
 * 从 timing-obsidian.ts 源码中提取所有 export 的符号名。
 */
export function extractAdapterExports(text) {
  const clean = stripComments(text || '');
  const exports = new Set();

  // export [async] function foo
  for (const m of clean.matchAll(/export\s+(?:async\s+)?function\s+([a-zA-Z0-9_$]+)/g)) {
    exports.add(m[1]);
  }

  // export [const|let|var] foo
  for (const m of clean.matchAll(/export\s+(?:const|let|var)\s+([a-zA-Z0-9_$]+)/g)) {
    exports.add(m[1]);
  }

  // export [abstract] class Foo
  for (const m of clean.matchAll(/export\s+(?:abstract\s+)?class\s+([a-zA-Z0-9_$]+)/g)) {
    exports.add(m[1]);
  }

  // export [type|interface|enum|const enum] Foo
  for (const m of clean.matchAll(/export\s+(?:type|interface|(?:const\s+)?enum)\s+([a-zA-Z0-9_$]+)/g)) {
    exports.add(m[1]);
  }

  // export default
  if (/export\s+default\b/.test(clean)) {
    exports.add('default');
  }

  // export { a, b as c } [from '...']
  for (const m of clean.matchAll(/export\s*\{([\s\S]*?)\}(?:\s*from\s*['"][^'"]+['"])?/g)) {
    const inside = m[1];
    for (const raw of inside.split(',')) {
      const item = raw.trim();
      if (!item) continue;
      const noType = item.replace(/^type\s+/, '').trim();
      if (noType.includes(' as ')) {
        // `export { a as b }` 外部导入时看到的是 `b`
        const exported = noType.split(/\s+as\s+/)[1].trim();
        if (exported && /^[a-zA-Z0-9_$]+$/.test(exported)) {
          exports.add(exported);
        }
      } else if (noType && /^[a-zA-Z0-9_$]+$/.test(noType)) {
        exports.add(noType);
      }
    }
  }

  return exports;
}

/**
 * 比对 vendor 的 import 名单与适配层的 export 面。
 * 返回未实现的条目列表（形如 `timing-runtime.js:foo`）。
 */
export function analyzeAdapterExports(vendorSourcesList, timingObsidianTsText) {
  const exports = extractAdapterExports(timingObsidianTsText || '');
  const missing = [];

  for (const { path, text } of vendorSourcesList) {
    const importedSymbols = extractTimingRoamImports(text);
    const fileName = path.replace(/^src\/vendor\//, '');
    for (const sym of importedSymbols) {
      if (sym === '*') {
        if (exports.size === 0) {
          missing.push(`${fileName}:*`);
        }
      } else if (!exports.has(sym)) {
        missing.push(`${fileName}:${sym}`);
      }
    }
  }

  return missing.sort();
}
