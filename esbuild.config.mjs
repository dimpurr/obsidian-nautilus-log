import esbuild from "esbuild";
import process from "process";
import { builtinModules } from "module";
import { resolve } from "path";

const prod = process.argv[2] === "production";

const ctx = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: ["obsidian", "electron", ...builtinModules],
  format: "cjs",
  target: "es2018",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  // docs/test-note.md 直接内联成字符串 —— repo 里那份就是唯一真源，
  // 「创建测试笔记」命令与文档不可能漂移。
  loader: { '.md': 'text' },
  // 🔴 vendored 的 timing-runtime.js 里写死了 `from './timing-roam'`（上游的 Roam
  //    数据层）。vendor 不许改，所以在打包层把它重定向到我们的 Obsidian 实现。
  //    这是「零改动 vendor」这条铁律与「换掉数据层」这个需求的交汇点。
  //    ⚠️ esbuild 的 `alias` 选项不接受相对路径，只能用插件改 resolve。
  plugins: [{
    name: 'timing-roam-to-obsidian',
    setup(build) {
      build.onResolve({ filter: /(^|\/)timing-roam$/ }, () => ({
        path: resolve('src/timing-obsidian.ts'),
      }));
    },
  }],
  outfile: "main.js",
});

if (prod) { await ctx.rebuild(); process.exit(0); } else { await ctx.watch(); }
