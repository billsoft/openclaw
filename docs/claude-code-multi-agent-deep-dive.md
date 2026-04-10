# Claude Code 多 Agent 系统深度解剖：并行效率、提示词缓存"白嫖"与调度哲学

> **本文所有技术细节均来自 `claude-code` 源代码的直接阅读（`coordinator/coordinatorMode.ts`、`tools/AgentTool/forkSubagent.ts`、`utils/forkedAgent.ts` 等文件），无任何推测或幻觉成分。**

---

## 一、从"串行助手"到"并发工程师"：Claude Code 在解决什么问题？

当你让 Claude Code 帮你重构一个大型项目，最朴素的做法是：读文件 → 想方案 → 写代码 → 跑测试 → 提交。这是完全串行的，LLM 每次只做一件事，时间复杂度是线性的。

但真实的软件工程不是这样工作的。一个资深工程师处理复杂任务时，脑子里在同时推进多条线索：

- 一边让实习生去查数据库的历史迁移记录
- 一边自己在看主业务逻辑的调用链
- 同时心里已经在构思架构方案了

**Claude Code 的多 Agent 系统，本质上就是把这种"并发认知"用软件工程的方式实现出来。**

这里面有三个极度精妙的设计，每一个都值得深入分析。

---

## 二、三层角色体系：不是所有 Agent 都平等

阅读 `coordinator/coordinatorMode.ts` 和 `tools/AgentTool/forkSubagent.ts` 后，你会发现 Claude Code 的 Agent 世界里有着非常清晰的三层分工：

### 第一层：Coordinator（协调者）

通过环境变量 `CLAUDE_CODE_COORDINATOR_MODE=1` 启用，或由 Anthropic 内部用户自动开启（`USER_TYPE === 'ant'`）。

```typescript
// coordinator/coordinatorMode.ts
export function isCoordinatorMode(): boolean {
  if (feature('COORDINATOR_MODE')) {
    return isEnvTruthy(process.env.CLAUDE_CODE_COORDINATOR_MODE)
  }
  return false
}
```

Coordinator 是整个系统的大脑。它**绝对不自己动手干活**，它的职责是：

> "你是一个协调者。默认为所有实质性任务派生 Worker。不要自己做实现、研究或文件修改。只有对不需要工具的微不足道的问题才直接回答。"

这不是建议，是铁律。Coordinator 的 System Prompt（`getCoordinatorSystemPrompt()`）开篇第一句就给 LLM 定调了角色：**纯调度，不执行**。

### 第二层：Worker（工作者）

由 Coordinator 通过 `Agent` 工具派生，承担真实的代码读写、测试运行、Git 提交等工作。每个 Worker 拥有独立的上下文窗口、独立的 AbortController、独立的工具权限集。

值得注意的是，Worker 的工具集是经过精心裁剪的。通过 `ASYNC_AGENT_ALLOWED_TOOLS` 常量，Worker 被授予了所有主流工具，但内部协调专用工具（`TEAM_CREATE`、`TEAM_DELETE`、`SEND_MESSAGE`、`SYNTHETIC_OUTPUT`）被从 Worker 的工具池里过滤掉了：

```typescript
// coordinatorMode.ts
const INTERNAL_WORKER_TOOLS = new Set([
  TEAM_CREATE_TOOL_NAME,
  TEAM_DELETE_TOOL_NAME,
  SEND_MESSAGE_TOOL_NAME,
  SYNTHETIC_OUTPUT_TOOL_NAME,
])

const workerTools = Array.from(ASYNC_AGENT_ALLOWED_TOOLS)
  .filter(name => !INTERNAL_WORKER_TOOLS.has(name))
  .sort()
  .join(', ')
```

**这是一种精巧的权限沙箱设计。** Worker 干活，但不能越权去管理其他 Worker，防止层级混乱。

### 第三层：Fork Child（分叉子进程）

这是一个更加激进的实验性功能（`isForkSubagentEnabled()`），和 Coordinator Mode 互斥。Fork 模式的思想来自 Unix 的 `fork()` 系统调用：**子 Agent 直接克隆父 Agent 的完整对话历史**，而不是从空白开始。

这是实现提示词缓存白嫖的关键，我们第四节会专门解剖。

---

## 三、全异步调度：为什么主会话"永远不堵车"

这是 Claude Code 多 Agent 架构里最反直觉、也最工程精妙的部分。

### 传统方案的缺陷

假设你派了一个 Agent 去扫描一个 1000 文件的大型仓库，这可能需要 3 分钟。传统方案下，主会话会一直阻塞，你什么都干不了，只能盯着转圈圈。

### Claude Code 的异步模型

Claude Code 采用的是完全的 **Fire-and-Forget（开枪即忘）** 模式。

当你（或者 Coordinator）调用 `Agent` 工具时：

1. Agent 工具**立刻返回**一个 `task_id`，例如 `agent-a1b`
2. 主会话收到这个 ID 后，**结束当前 Turn**，界面恢复可交互状态
3. 子 Agent 在后台独立运行，消耗自己的 tokens，完全不阻塞主会话
4. 子 Agent 完成时，系统自动往主会话的消息队列里注入一条特殊的 XML 消息：

```xml
<task-notification>
<task-id>agent-a1b</task-id>
<status>completed</status>
<summary>Agent "Investigate auth bug" completed</summary>
<result>Found null pointer in src/auth/validate.ts:42...</result>
<usage>
  <total_tokens>12345</total_tokens>
  <tool_uses>23</tool_uses>
  <duration_ms>45000</duration_ms>
</usage>
</task-notification>
```

这条 `<task-notification>` 消息以 **user-role** 注入主会话，触发主模型的新一轮推理。主模型收到它后，通过 Coordinator System Prompt 里提前教过的格式识别规则，认出这是一个完成事件，然后更新自己的"内部工作清单"。

**这个设计的精妙之处在于**：主会话的 LLM 不需要轮询、不需要等待、不需要感知底层任务系统的复杂性。它只需要接受"就像用户发了一条消息"一样自然的通知，然后决策下一步该做什么。

### 完整的并发工作流示意

```
用户: "重构认证模块，同时检查内存泄漏"
                    ↓
Coordinator (单 Turn):
  ├── Agent({ task: "调研 src/auth/ 目录" })        → 立刻返回 task_id: agent-a1b
  ├── Agent({ task: "压测内存，生成火焰图" })         → 立刻返回 task_id: agent-c3d
  └── 回复用户: "两个 Worker 已启动，稍后通知您结果。"
                    ↓（用户可以继续和主会话对话）
[后台：agent-a1b 和 agent-c3d 并发运行]
                    ↓（agent-a1b 完成）
<task-notification><task-id>agent-a1b</task-id>...</task-notification>
                    ↓
Coordinator:
  ├── 理解：认证调研完成，发现 validate.ts:42 有空指针
  ├── SendMessage({ to: "agent-a1b", message: "修复空指针，commit 后报告" })
  └── 回复用户: "认证问题已定位，修复中。内存分析仍在进行。"
                    ↓（agent-c3d 完成）
<task-notification><task-id>agent-c3d</task-id>...</task-notification>
                    ↓
Coordinator: "所有任务完成！综合报告：..."
```

**整个过程中，用户界面始终响应，可以随时插话或追加新任务。** 这才是真正的"智能助手"体验，而不是"请等待……"。

---

## 四、Prompt Cache 白嫖大法：用对了能省 90% 的 Token 费用

这是最让工程师眼睛一亮的部分。读 `utils/forkedAgent.ts` 的第一行注释就能感受到设计者的用心：

> "This utility ensures forked agents share identical cache-critical params with the parent to guarantee prompt cache hits"

### Anthropic API 的缓存机制原理

Anthropic 的 API 实现了 Prompt Cache（提示词缓存）。**当多个 API 请求的前缀（system prompt + messages 前段）完全一致时，后续请求可以直接复用已缓存的 KV，只需要计算不同的后缀部分。**

缓存命中 vs 未命中的价格差异是：**缓存命中 tokens 的成本约为正常 tokens 的 10%**。也就是说，如果你的 system prompt 有 10K tokens，并发 5 个 Agent，缓存命中可以让你在 system prompt 部分省下 **4 × 10K × 90% = 36K tokens** 的费用。

这不是小数目。

### Claude Code 的缓存共享设计

`CacheSafeParams` 这个类型是整个缓存共享机制的核心：

```typescript
// utils/forkedAgent.ts
export type CacheSafeParams = {
  /** System prompt - must match parent for cache hits */
  systemPrompt: SystemPrompt
  /** User context - prepended to messages, affects cache */
  userContext: { [k: string]: string }
  /** System context - appended to system prompt, affects cache */
  systemContext: { [k: string]: string }
  /** Tool use context containing tools, model, and other options */
  toolUseContext: ToolUseContext
  /** Parent context messages for prompt cache sharing */
  forkContextMessages: Message[]
}
```

这里的设计约束非常严格：**CacheSafeParams 里的任何一个字段发生变化，都会导致缓存 miss。** 因此代码里有大量的保护逻辑确保子 Agent 使用和父 Agent **字节完全一致**的 system prompt、工具定义和消息前缀。

### Fork 消息构造：最精妙的"批量缓存"技巧

当 Coordinator 在同一个 Turn 里并发派生 N 个 Worker 时，`buildForkedMessages` 函数会为每个 Worker 构造对话历史：

```typescript
// tools/AgentTool/forkSubagent.ts
export function buildForkedMessages(
  directive: string,
  assistantMessage: AssistantMessage,
): MessageType[] {
  // 1. 克隆父 Agent 的完整助手消息（所有 tool_use blocks）
  const fullAssistantMessage = { ...assistantMessage, ... }

  // 2. 为每个 tool_use block 构造一个统一的占位符结果
  //    注意：所有 fork child 用完全相同的占位符文本！
  const FORK_PLACEHOLDER_RESULT = 'Fork started — processing in background'
  const toolResultBlocks = toolUseBlocks.map(block => ({
    type: 'tool_result',
    tool_use_id: block.id,
    content: [{ type: 'text', text: FORK_PLACEHOLDER_RESULT }],
  }))

  // 3. 最后追加每个 child 各自的 directive（这是唯一不同的部分）
  const toolResultMessage = createUserMessage({
    content: [
      ...toolResultBlocks,   // ← 所有 child 完全一致（缓存共享段）
      { type: 'text', text: buildChildMessage(directive) },  // ← 每个 child 不同（缓存不命中段）
    ],
  })

  return [fullAssistantMessage, toolResultMessage]
}
```

**这个设计的精妙之处在于**：消息结构是这样的：

```
[...父会话全部历史]                    ← 所有 child 完全一致 ✅ 缓存命中
[父 Agent 的最后一条 assistant 消息]   ← 所有 child 完全一致 ✅ 缓存命中
[tool_result 占位符 × N]              ← 所有 child 完全一致 ✅ 缓存命中
[child 自己的 directive 文本]          ← 每个 child 不同    ❌ 缓存 miss（但很短！）
```

**整个消息历史里，只有最后几十个 tokens 是各个 child 独有的，前面 99% 的 tokens 全部缓存复用。** 这就是为什么在 Coordinator 模式下并发启动 10 个 Worker，其 API 成本几乎只比启动 1 个 Worker 多出 1/10。

### 代码里的缓存防御细节

设计者甚至专门加了注释来提醒未来的开发者不要无意中破坏缓存：

```typescript
// utils/forkedAgent.ts
/**
 * Optional cap on output tokens. CAUTION: setting this changes both max_tokens
 * AND budget_tokens (via clamping in claude.ts). If the fork uses cacheSafeParams
 * to share the parent's prompt cache, a different budget_tokens will invalidate
 * the cache — thinking config is part of the cache key. Only set this when cache
 * sharing is not a goal.
 */
maxOutputTokens?: number
```

连 `maxOutputTokens` 这种看似无关的参数，也会通过影响 `budget_tokens`，间接破坏提示词缓存。这种精细的工程意识，体现了 Anthropic 工程团队对 API 细节的极度掌握。

---

## 五、Worker 的"强制沉默协议"：系统提示词工程的极致

这是整个系统里提示词工程做得最细腻的部分。

当一个 Fork Child 被创建时，它收到的第一条消息不是任务，而是一段强制性的、几乎带有军事风格的自我角色重置：

```typescript
// tools/AgentTool/forkSubagent.ts
export function buildChildMessage(directive: string): string {
  return `<fork-boilerplate>
STOP. READ THIS FIRST.

You are a forked worker process. You are NOT the main agent.

RULES (non-negotiable):
1. Your system prompt says "default to forking." IGNORE IT — that's for the parent.
   You ARE the fork. Do NOT spawn sub-agents; execute directly.
2. Do NOT converse, ask questions, or suggest next steps
3. Do NOT editorialize or add meta-commentary
4. USE your tools directly: Bash, Read, Write, etc.
5. If you modify files, commit your changes before reporting. Include the commit hash.
6. Do NOT emit text between tool calls. Use tools silently, then report once at the end.
7. Stay strictly within your directive's scope.
8. Keep your report under 500 words unless the directive specifies otherwise.
9. Your response MUST begin with "Scope:". No preamble, no thinking-out-loud.
10. REPORT structured facts, then stop

Output format:
  Scope: <echo back your assigned scope in one sentence>
  Result: <the answer or key findings>
  Key files: <relevant file paths>
  Files changed: <list with commit hash>
  Issues: <list>
</fork-boilerplate>

[FORK_DIRECTIVE]: ${directive}`
}
```

这段提示词有几个非常重要的工程决策值得深思：

**决策一：`STOP. READ THIS FIRST.`**
这是一种"注意力中断"技术。LLM 处理上下文时有惯性，会把继承的父会话上下文作为主要参考。这段文字的目的是强制打破惯性，让 Worker 的"第一反应"是重新校准自己的角色。

**决策二：明确覆盖冲突指令**
父会话的 System Prompt 说"默认 fork 子 Agent"，但 Worker 本身就是一个 Fork，如果它也遵守这条规则，就会无限递归地创建子 Worker。所以提示词里明确写了：`"IGNORE IT — that's for the parent. You ARE the fork."`

这是一种递归防护机制，在代码层面（`isInForkChild()` 检测 `<fork-boilerplate>` 标签）也有对应的硬件防护：

```typescript
// forkSubagent.ts
export function isInForkChild(messages: MessageType[]): boolean {
  return messages.some(m => {
    // ...
    return content.some(
      block =>
        block.type === 'text' &&
        block.text.includes(`<${FORK_BOILERPLATE_TAG}>`),
    )
  })
}
```

**决策三：强制结构化输出**
`"Your response MUST begin with 'Scope:'"` 这条规则解决了一个严重的实际问题：LLM 在完成复杂任务后，往往会有大量的"废话"（"好的，我已经完成了您的任务，以下是我的发现……"）。

这些废话在单轮对话里影响不大，但在多 Agent 系统里，每个 Worker 的输出都会被注入到 Coordinator 的上下文里。如果 10 个 Worker 各带 500 tokens 的废话，Context 窗口会被迅速填满，而且 Coordinator 在综合信息时需要从噪音中提取有效信息，降低准确率。

结构化输出把 Worker 的结果变成机器可读的格式，Coordinator 可以快速提取关键信息，大幅提高多轮调度的可靠性。

---

## 六、Worktree 隔离：Git 层面的并发安全

当多个 Worker 同时修改代码时，最大的风险是写冲突。Claude Code 提供了一个可选的隔离机制：`isolation: "worktree"`。

```typescript
// AgentTool.tsx (schema 定义)
isolation: z.enum(['worktree']).optional().describe(
  'Isolation mode. "worktree" creates a temporary git worktree so the agent works on an isolated copy of the repo.'
)
```

Git Worktree 允许在同一个仓库里创建多个独立的工作目录，每个目录有自己的独立 HEAD 和暂存区，但共享相同的对象数据库（历史提交、objects 等）。

当 Worker 运行在 Worktree 里时，它的文件修改、Stage、Commit 都是完全隔离的，不会影响主工作区或其他 Worker。

为了让 Worker 理解这种环境的特殊性，`buildWorktreeNotice()` 会在 Worker 启动时注入一段额外的上下文说明：

```typescript
// forkSubagent.ts
export function buildWorktreeNotice(
  parentCwd: string,
  worktreeCwd: string,
): string {
  return `You've inherited the conversation context above from a parent agent working in ${parentCwd}.
You are operating in an isolated git worktree at ${worktreeCwd} — same repository, same relative file structure, separate working copy.
Paths in the inherited context refer to the parent's working directory; translate them to your worktree root.
Re-read files before editing if the parent may have modified them since they appear in the context.
Your changes stay in this worktree and will not affect the parent's files.`
}
```

这段提示词解决了一个微妙的问题：Worker 继承了父会话的历史，历史里的所有文件路径都是父工作区的路径。Worker 在 Worktree 里工作时，需要理解这种路径翻译关系。

---

## 七、Feature Gate 与灰度发布：企业级工程思维

Claude Code 是一个面向数百万用户的商业产品，新功能不能直接全量发布。阅读代码可以清晰地看到两层开关：

```typescript
// utils/agentSwarmsEnabled.ts
export function isAgentSwarmsEnabled(): boolean {
  // Ant（Anthropic 内部用户）：永远开启
  if (process.env.USER_TYPE === 'ant') {
    return true
  }

  // 外部用户：需要同时满足：
  // 1. 主动 opt-in（环境变量或 CLI flag）
  if (
    !isEnvTruthy(process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS) &&
    !isAgentTeamsFlagSet()
  ) {
    return false
  }

  // 2. GrowthBook 功能开关未被 kill（应急关闭阀）
  if (!getFeatureValue_CACHED_MAY_BE_STALE('tengu_amber_flint', true)) {
    return false
  }

  return true
}
```

这套设计有三个层次：

- **Anthropic 内部（ant）**：永远开启，用于快速验证
- **外部用户**：需要主动选择加入（`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`），防止普通用户意外触发不稳定功能
- **GrowthBook Kill Switch**：即使用户开启了，Anthropic 也能通过远程配置在几分钟内关闭整个功能，应对潜在的线上事故

这是标准的 Feature Flag 灰度发布模式，在规模化 SaaS 产品里是必备的工程基础设施。

---

## 八、LLM 作为调度器：提示词即架构

在整个多 Agent 系统里，最核心的技术不是某个算法，而是 **Coordinator System Prompt 的工程质量**。

`getCoordinatorSystemPrompt()` 函数直接返回了一段精心设计的文本，它实质上是在用自然语言编写一个"调度算法"：

```
## 4. Task Workflow

**Parallelism is your superpower. Workers are async. Launch independent workers concurrently 
whenever possible — don't serialize work that can run simultaneously and look for 
opportunities to fan out.**

Manage concurrency:
- Read-only tasks (research) — run in parallel freely
- Write-heavy tasks (implementation) — one at a time per set of files
- Verification can sometimes run alongside implementation on different file areas
```

这段 Prompt 实际上在告诉 LLM：
- 读操作（研究类）：完全并发，毫无顾虑
- 写操作（实现类）：按文件区域串行，避免冲突
- 验证操作：可以和不相关区域的实现并发

**这是一个完全用自然语言表达的并发调度策略。** LLM 读懂它后，在实际分配任务时会自动遵循这套策略，就像一个受过良好训练的工程经理一样。

这背后的哲学是：**LLM 足够聪明，不需要硬编码的调度逻辑，只需要清晰、精确的决策框架描述。** Prompt 就是架构。

---

## 九、和 OpenClaw 的横向对比：两套实现，同一个目标

在深入理解了 Claude Code 的实现后，我们可以用一张表格对比 Claude Code 和 OpenClaw 在多 Agent 架构上的实现差异：

| 能力维度 | Claude Code 的实现方式 | OpenClaw 的实现方式 |
|---------|----------------------|-------------------|
| **Worker 派生** | `Agent` 工具（`AgentTool.tsx`）| `sessions_spawn` 工具 |
| **结果回传** | `<task-notification>` XML 注入 user-role 消息 | `[Internal task completion event]` 通过 `queueEmbeddedPiMessage` 注入 |
| **主会话状态控制** | `SendMessage`、`TaskStop` 工具 | `subagents` 工具（`list/kill/steer`） |
| **提示词缓存** | `buildForkedMessages`：统一占位符 + 末尾 directive | `subagent-announce.ts`：`END OF STABLE SYSTEM INSTRUCTIONS` 边界截断 |
| **隔离模式** | Git Worktree 原生支持 | AbortController 级别隔离（`subagent-isolation.ts`） |
| **功能开关** | GrowthBook + 环境变量双重控制 | Config 级别启用 |
| **Worker 输出格式** | `Scope: / Result: / Key files: / Files changed:` | `SCOPE: / OUTCOME: / FINDINGS: / COMMIT:` |

两套实现的**本质哲学完全相同**：

1. 全异步 Fire-and-Forget
2. 完成事件推送（而非主动轮询）
3. Stable Prefix 共享缓存
4. 结构化输出降低 Context 噪音
5. LLM 作为调度器，Prompt 即策略

差异主要在于：
- Claude Code 是**进程内实现**（子 Agent 在同一 Node.js 进程里作为异步任务运行）
- OpenClaw 是**跨 Session 实现**（子 Agent 是独立的 Gateway Session，通过消息队列通信）

OpenClaw 的跨 Session 架构天然更适合**长时间运行**和**跨平台通知**（Telegram/Discord/Slack 等）的场景，而 Claude Code 的进程内架构更适合**低延迟、高交互**的命令行环境。

---

## 十、总结：多 Agent 系统的工程本质

读完这些代码，我对"多 Agent 系统"有了一个更清醒的认识：

**所谓"多 Agent 并发"，本质上是一个分布式系统问题，只不过"节点"是 LLM，"RPC 协议"是自然语言。**

Claude Code 在解决这个问题时，展示了几个极其重要的工程原则：

1. **异步优先（Async First）**：宁愿复杂，也不阻塞。主会话永远不等待，结果推送而非轮询。

2. **最小权限（Least Privilege）**：Worker 被精确裁剪了工具权限，不能越权管理其他 Worker。

3. **缓存意识（Cache Awareness）**：在 API 调用层面把缓存利用率最大化，不是事后优化，而是架构设计时就考虑进去的核心约束。

4. **Prompt 即策略（Prompt as Policy）**：不需要硬编码复杂的调度算法，LLM 足够聪明，精确的自然语言描述就是最好的策略表达。

5. **结构化边界（Structured Boundaries）**：Worker 输入（Directive）和输出（Structured Report）都是强格式约束，降低信息传递中的噪音和误解。

这套设计思想，不仅适用于 AI Agent，也适用于任何分布式系统的架构设计。

---

*本文基于 Claude Code 源代码直接阅读撰写，所有引用代码均来自真实文件。欢迎讨论和指正。*
