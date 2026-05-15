# context-manager

Turn agent conversations into reusable guidance and context.

把对话整理成后续 agent 可以直接复用的经验和上下文。

`context-manager` 帮助 agent 从历史对话里保留真正重要的信息，避免每次都从头再来。当前先服务于 Codex，后续会扩展到 Claude Code 等其它 agent。

## 背景与问题

Agent 用久了以后，历史对话会越来越长，但真正有用的信息很难留下来。

结果通常是两种：

- 上下文越来越重，但真正重要的内容越来越难找
- 会话结束或被压缩后，已经验证过的做法又要重新想一遍

`context-manager` 会自动整理这些对话，把有价值的内容沉淀下来，供后续 agent 继续使用。

## 核心工作流

```text
对话
  -> 提炼
  -> working-memory/
  -> guidance/
  -> 后续 agent 按需读取
```

它会做的事情很简单：

- 捕获对话产物
- 提炼出高信号内容
- 写入 `working-memory/`
- 再编译成更高层的 `guidance/`
- 让后续 agent 在需要时直接读取这些结果

## 快速开始

当前有两种使用方式：

通过 npm：

1. 进入你要接入的目标 repo
2. 运行 `npx @zhexulong/context-manager init --repo-root .`

通过源码仓库：

1. 克隆这个仓库
2. 进入 `context-manager/`
3. 运行 `npm install`
4. 进入你要接入的目标 repo
5. 运行 `node /path/to/context-manager/bin/context-manager.mjs init --repo-root .`

如果你当前就在 `context-manager/` 目录里，也可以直接指定目标 repo：

- `node ./bin/context-manager.mjs init --repo-root /path/to/target-repo`

常用命令：

- `npm test`
- `node scripts/compile.mjs`
- `node scripts/lint.mjs`
- `node scripts/replay_pending.mjs`
- `node scripts/smoke_e2e.mjs`

## 当前状态

当前实现是 Codex-first：

- 目前通过 Codex hooks 接入
- 会生成 `working-memory/` 和 `guidance/`
- 会在后续会话里通过 `guidance-recall` 供 agent 按需读取
- 后续会扩展到其它 agent，而不是停留在 Codex 专用实现

## 开发与实现约定

- `scripts/prompts/flush.md` 与 `scripts/prompts/compile.md` 是默认提示词模板
- 可通过 `CODEX_MEMORY_COMPILER_PROMPTS_DIR` 覆盖模板目录
- `reports/pending-flush/` 只承担可重放入口
- `reports/llm-failures/` 只承担失败诊断记录
- 项目级 hook 定义位于 `.codex/config.toml`
- `guidance-recall` skill 安装到 `~/.codex/skills/guidance-recall/`
- `compile` 在来源冲突时以后来的、已验证的当前状态为准，不继续固化过时 guidance
- `activate_hooks.mjs` 是 `init` 命令的内部实现
- 日常是否触发通过 `reports/runtime/` 下的被动痕迹判断，不依赖 doctor

## 参考仓库

当前主要参考了这些仓库：

- `coleam00/claude-memory-compiler`
- `openai/codex`
- `openai/codex-plugin-cc`
- `zilliztech/memsearch`
