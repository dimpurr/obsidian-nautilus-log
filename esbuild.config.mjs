import esbuild from "esbuild";
import process from "process";
import builtins from "builtin-modules";

const prod = process.argv[2] === "production";

const ctx = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: ["obsidian", "electron", ...builtins],
  format: "cjs",
  target: "es2018",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  // docs/test-note.md 直接内联成字符串 —— repo 里那份就是唯一真源，
  // 「创建测试笔记」命令与文档不可能漂移。
  loader: { '.md': 'text' },
  outfile: "main.js",
});

if (prod) { await ctx.rebuild(); process.exit(0); } else { await ctx.watch(); }
