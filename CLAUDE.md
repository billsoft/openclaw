# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> **完整 root 政策/约定/路由都在 [`AGENTS.md`](AGENTS.md) 里 — 进入子目录前先读对应 scoped `AGENTS.md` (例如 `extensions/AGENTS.md`)。** 本文件只补 CLAUDE 视角的高层导航、关键命令和架构地图,不重复 AGENTS.md 的规则。

## 这是什么

**OpenClaw** — 个人 AI 助手,跑在你自己设备上,通过已有聊天通道交互(WhatsApp / Telegram / Slack / Discord / Google Chat / Signal / iMessage / IRC / MS Teams / Matrix / Feishu / LINE / Mattermost / Nextcloud Talk / Nostr / Synology Chat / Tlon / Twitch / Zalo / Zalo Personal / WeChat / QQ / WebChat …)。Gateway 是控制平面,助手本身才是产品。

- 版本: `2026.5.28` (alpha.1),仓库 `https://github.com/openclaw/openclaw`
- 本地 fork: `origin` → `git@github.com:billsoft/openclaw.git`,`upstream` → `openclaw/openclaw`
- 运行时: **Node 24 推荐 / Node 22.19+ 最低**;包管理器: **pnpm** (用 `pnpm openclaw ...` 或 `pnpm dev`,别自己 `vitest` / `tsc --noEmit`)

## 关键命令

| 场景 | 命令 |
|---|---|
| 安装依赖 | `pnpm install` |
| 本地运行 CLI | `pnpm openclaw ...` 或 `pnpm dev` |
| 构建 | `pnpm build` |
| 跑测试 | `pnpm test <path-or-filter> [vitest args...]` |
| 只跑变更 | `pnpm test:changed`, `pnpm check:changed` |
| 串行测试 | `pnpm test:serial` |
| 覆盖率 | `pnpm test:coverage` |
| 扩展测试 | `pnpm test:extensions`, `pnpm test extensions/<id>` |
| Lane 列 | `pnpm changed:lanes --json` |
| 暂存检查 | `pnpm check:changed --staged` |
| 全量检查 | `pnpm check` |
| 类型检查 | `pnpm tsgo*` (用 `tsgo` lanes,不是 `tsc --noEmit`) |
| 格式化 | `pnpm format:*`,`pnpm lint:*` (用 `oxfmt`/`oxlint`,不是 Prettier) |
| Live test | `OPENCLAW_LIVE_TEST=1 pnpm test:live` |
| 提交 | `scripts/committer "<msg>" <file...>` (不要 `git commit` 直跑) |
| 提 PR | `gh pr create` (body 要含 Summary + Verification) |
| 合并上游 | 见下面"上游合并" |

**不要做的事:**

- 不要 raw `vitest` / `tsc --noEmit` / `prettier`,全用仓库 wrapper
- 不要改 `node_modules`
- 不要在 `node_modules` 路径里 import
- 不要用绝对路径或 `~/...` 回复用户,用 repo-root refs(如 `extensions/telegram/src/index.ts:80`)

## 架构地图

```
src/                    # Core TS (主运行时,plugin-agnostic)
  cli/                  # CLI 入口和子命令
  commands/             # 各 openclaw 子命令实现
  gateway/              # Gateway 控制平面 (WebSocket/HTTP/RPC)
  channels/             # 通道实现 (plugin 用 SDK seam,不在这里加东西)
  agents/               # Agent 循环、工具、记忆
  auto-reply/           # 自动回复管线
  config/               # 配置 schema、加载、迁移、doctor
  plugins/              # Plugin loader
  plugin-sdk/           # 给插件用的公共 SDK surface
  cron/ daemon/ hooks/  # 调度/守护/钩子
  acp/ context-engine/  # ACP 协议,上下文工程
  flows/                # 编排流
  ...

ui/                     # Web UI
packages/               # 独立 npm 包
  agent-core/
  gateway-client/       # Gateway 客户端 SDK
  gateway-protocol/     # Gateway 协议定义
  plugin-sdk/           # 插件 SDK 包
  plugin-package-contract/
  ...

extensions/             # 插件 (provider / channel / memory / tool / skill …)
  anthropic/ openai/ google/ xai/ ...   # 模型 provider
  telegram/ discord/ slack/ whatsapp/ feishu/ ...  # 通道
  memory-lancedb/ memory-wiki/          # 记忆后端
  diffs/ qa-*/ diagnostics-*/ ...       # 工具 & 诊断

apps/                   # 配套应用 (macOS / iOS / Android / Windows / Linux)
docs/                   # 文档源 (同步到 openclaw/docs,host 在 docs.openclaw.ai)
skills/                 # 内置 skill bundle (新 skill 走 ClawHub,不进 core)
scripts/                # 工具脚本 (committer, run-vitest, crabbox wrapper …)
test/                   # 跨包测试、e2e fixtures
```

**关键边界 (踩到就改):**

- Core **不能** import `extensions/*/src/**`、其他插件 `src/**`、`src/plugin-sdk-internal/**`、`onboard.js`
- 插件 **只能** import `openclaw/plugin-sdk/*` 和自己的 `./api.ts` / `./runtime-api.ts` 桶
- Provider 特有逻辑 (auth / catalog / onboarding) 留在插件里,别因为两个 provider 像就抽到 core
- 协议版本 bump = 显式 owner 确认,绝不自动
- 兼容性 = opt-in;"shipped" = release tag 之后的代码,`main` / PR 都不算 shipped
- 新增 plugin/app/channel/doc 表面 → 同步更新 `.github/labeler.yml` + GH labels

**两类插件:**

1. **Code plugin** — 跑 OpenClaw 插件代码,需要 runtime hooks/providers/channels/tools
2. **Bundle plugin** — 打包稳定的外部 surface (skills / MCP servers / 配置) — 优先用这个,边界更小更安全

## 上游合并 (核心工作流)

本地 fork `billsoft/openclaw` 持续同步 `openclaw/openclaw` 的提交。前面已经做过 `Merge upstream round 16` (929 commits, v2026.5.28-alpha.1)。

合并流程(以 round N 为例):

```bash
git fetch upstream --tags
# 1. 找上游最新 tag / commit,定 round N
# 2. 创建 merge 分支或直接在 main 上 merge upstream/main
# 3. 处理冲突 (一般不冲突;真冲突时 review 上游意图)
# 4. pnpm install (可能需要)
# 5. pnpm build → 修 TS strict / 打包错误 (常见 image-ops / auth-storage 这种 strict 类型修复)
# 6. 必要时 pnpm check:changed 验证
# 7. scripts/committer "Merge upstream round N: <X> new commits (<version>)" <files>
#    scripts/committer "fix: <具体修复>" <files>
# 8. push 到 origin
```

> 修上游合并后的类型错误是正常环节,不是返工 — 上游用 `tsgo` strict 模式,我们 fork 走相同 lint 规则。常见的修复模式见最近几轮 commit message。

## 测试约定

- Vitest;colocate `*.test.ts`,e2e 用 `*.e2e.test.ts`
- 不要在同一个 worktree 并行跑独立的 `pnpm test` / `vitest` (Vitest cache 会 ENOTEMPTY);用 `OPENCLAW_VITEST_FS_MODULE_CACHE_PATH` 区分
- Test workers 上限 16;内存压力下用 `OPENCLAW_VITEST_MAX_WORKERS=1 pnpm test`
- 不要改 baseline / inventory / ignore / snapshot / expected-failure 文件来静音检查
- 测 GPT 用 `gpt-5.5` (5.4 ok),别用 GPT-4.x agent-smoke;测主模型用 `sonnet-4.6`

## 安全 / 凭据

- 永不提交真实手机号、视频、凭据、live config
- Channel/provider 凭据 → `~/.openclaw/credentials/`
- Model auth profile → `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`
- 依赖补丁/override/vendor 改动 = 显式 approval
- `@buape/carbon` pin 是 owner-only,别动
- Release / publish / version bump = 显式 approval,走 `$release-openclaw-maintainer`

## 提交 / PR / 推送

- `commit`: 只 stage 自己的变更;`commit all`: 全 stage 分组提交;`push`: 可以先 `git pull --rebase`
- `ship it`: commit + pull --rebase + push
- `main` 上: **不要 merge commit**,rebase 到 `origin/main` 之后再 push
- PR body 必填 Summary + Verification;引用 issue 编号
- 截图/录像/证明资产 → 走 Crabbox artifact publishing,别 push 到 openclaw 产品仓库的任何分支(包括临时 artifact 分支)
- Issue/PR 最后一个回答: GitHub URL

## 必读

- 任何目录工作前: 读 **该目录** 的 `AGENTS.md` (有 scoped 规则)
- Subtree 路由: `src/{plugin-sdk,channels,plugins,gateway,agents}/`、`packages/`、`extensions/`、`test/helpers*/`、`docs/`、`ui/`、`scripts/` 都有自己的 scoped `AGENTS.md`
- 修改 config / setup / plugin SDK / CLI 公共 flags → 兼容性敏感,看 AGENTS.md 兼容性章节
- 改前先看 `git diff --numstat` — 真有意义的 refactor 应该删的代码 ≥ 加的代码

**Skilled 路由:** Skills (`skills/`) 拥有具体工作流;根 AGENTS.md 只管硬政策和路由。看到 `$openclaw-pr-maintainer` / `$crabbox` / `$autoreview` / `$release-openclaw-maintainer` / `$security-triage` / `$technical-documentation` / `$openclaw-testing` 等,直接用对应 skill。
