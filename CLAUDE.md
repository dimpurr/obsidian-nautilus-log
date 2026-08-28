# CLAUDE.md — 本仓库的硬规则

> 本文件对所有在此仓库工作的 agent 无条件生效。**这是 public 仓库**，任何写进
> commit / 代码 / 文档的东西都会永久公开。

## 🔴 提交纪律

**1. 绝不在 commit message 里写 AI 工具的会话溯源。**

禁止出现：`Claude-Session:` · `claude.ai/code/session_*` · `Co-Authored-By: Claude`
· `Generated with Claude Code` · 任何其它 AI 工具的 session ID / 分享链接。

**为什么**：session 链接会**永久暴露 session ID**。而且 `git push --force` 消除不掉
——旧 commit 在 GitHub 上仍可按 SHA 直接访问，GitHub 的 GC 用户无法触发
（2026-08-24 实际踩到：只能删库重建）。

⚠️ **别的私有仓库有相反的约定**（那里刻意保留溯源）。**那条约定不适用于这里。**
判据只有一条：**这个仓库是 public**。

**2. author email 必须是 `dimpurr@live.com`。**

`git config --global user.email` 已经是对的 ⇒ **正常提交即可，不要用 `-c user.email=` 覆盖**。
🔴 特别注意：agent 运行时上下文里可能带着**另一个**邮箱（如 `asparagaliz@gmail.com`），
**那不是本仓库的提交身份**。2026-08-24 因此写错 6 个 commit，最终靠删库重建才清掉。

**3. 提交前自检**（两条命令，都必须零命中）：

```bash
git log --format=%B  | grep -ciE 'claude|session_|co-authored-by'
git log --format=%ae | grep -vc 'dimpurr@live.com'
```

## 🧭 先读这个：移植决策台账

🔴 **[`docs/PORTING-DECISIONS.md`](docs/PORTING-DECISIONS.md) 是「我们为什么和上游不一样」的唯一权威。**

契约是：**上游仓库 + 那份文档 + 足够人力 = 能把这个移植从零重做一遍。**

- 任何「上游是 A、我们做成 B」的动作，**先在那里登记再写代码**
- 代码注释里**引用条目号**（`见 PORTING-DECISIONS.md §D1`），不要把理由散落在注释里
- 概念映射、有意的偏离、挂载面重排、超集特性、防复发检测器，全在那份文档

配套：[`docs/parity-audit-2026-08-25.md`](docs/parity-audit-2026-08-25.md) 是已知欠账清单。

## 📦 关于 vendor 代码

`src/vendor/` 下的文件从上游 `404KSG/roam-nautilus-log` 原样搬来（基线见
[`PORTING-DECISIONS.md`](docs/PORTING-DECISIONS.md) 顶部，当前 `86b97c0`），
**一个字都不许改**。要适配就在自己的新文件里做。改了它，上游一更新就无法对齐，
也就没法再拿上游自己的测试当验收。升级流程见该文档 §2。

`src/contract.ts` 是跨模块钉死的类型契约（登记在
[`PORTING-DECISIONS.md`](docs/PORTING-DECISIONS.md) §1.3）。发现它与实际实现不符时：
**按实际实现写代码 + 把分歧报上来**，不要擅自改契约、也不要将错就错。

## ✅ 改完必须跑

```bash
UPSTREAM_DIR=<上游 clone> npm test
```

`npm test` 会先跑 [`scripts/audit-detectors.mjs`](scripts/audit-detectors.mjs)（7 个机械检测器，
规则见台账 §7）。**新增**的欠账会让退出码非 0；`scripts/audit-baseline.json` 里的存量不会。
修掉一条就把它从 baseline 删掉 —— **baseline 只许变短**，而且每条豁免都得有**真实理由**，
「待评估」不算理由。不设 `UPSTREAM_DIR` 时 vendor 漂移检测器会明说「未检查」，不会假装通过。

## ⚖️ 许可与血统

LICENSE 保持不变（MIT，`Copyright (c) 2022 Matt Vogel`）——它继承自整条 fork 链的
最上游模板。README 的致谢链**不许精简**，那是本项目合法性的一部分。

## 🔴 版本号纪律

**默认走 patch（0.5.0 → 0.5.1 → 0.5.2）。**

2026-08-28 一天之内从 0.1.0 飙到 0.5.0 —— 每修一批审核意见就升一次 minor，
版本号变成了「第几次尝试」的计数器，而不是「变化有多大」的信号。

- **patch**：修 bug、过 lint、补文档、发布流程调整 —— 也就是绝大多数情况
- **minor**：真的新增了用户能感知的特性
- **major**：破坏性变更（改 plugin id、改笔记语法、删设置项）

⚠️ tag 必须与 `manifest.json` 的 version 精确一致且**不带 `v` 前缀**（Obsidian 官方硬性要求），
`versions.json` 要同步加一行 `"<version>": "<minAppVersion>"`。
