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

## 📦 关于 vendor 代码

`src/vendor/` 下的文件从上游 `404KSG/roam-nautilus-log` 原样搬来（基线 `7bf19a1d`），
**一个字都不许改**。要适配就在自己的新文件里做。改了它，上游一更新就无法对齐。

`src/contract.ts` 是跨模块钉死的类型契约。发现它与实际实现不符时：
**按实际实现写代码 + 把分歧报上来**，不要擅自改契约、也不要将错就错。

## ⚖️ 许可与血统

LICENSE 保持不变（MIT，`Copyright (c) 2022 Matt Vogel`）——它继承自整条 fork 链的
最上游模板。README 的致谢链**不许精简**，那是本项目合法性的一部分。
