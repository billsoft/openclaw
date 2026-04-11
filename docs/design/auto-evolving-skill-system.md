# Auto-Evolving Skill System (自进化技能系统)

> OpenClaw 当前技能系统的核心短板：技能只能被人类手动编写、注册和维护。Agent 无法从成功的交互中自主学习、提炼最佳路径并封装为可复用技能，也无法在后续对话中自动调用这些技能并根据反馈持续优化。

## 1. 需求背景与目标

### 1.1 核心痛点

| 痛点                 | 现状                                                                         | 目标                                              |
| -------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------- |
| **不能自我进化**     | 技能文件必须由人类在 `skills/` 目录手动创建 `SKILL.md`                       | Agent 自动从成功交互中提取并封装技能              |
| **不能识别任务完成** | 系统不知道对话何时"成功完成了一项工作"                                       | LLM 在对话流中实时判定任务完成 + 用户满意         |
| **不能提炼最佳路径** | 对话中的失败尝试、踩坑过程与最终方案混在一起                                 | 后台 Agent 去除失败路径，只保留"可复现的最短路径" |
| **不能自动使用技能** | 技能仅在系统提示词中展示为 `<available_skills>` 列表，靠模型"主动想起来去读" | 基于触发条件自动匹配 + 加载到上下文               |
| **不能编排多技能**   | 一次只能调用一个技能                                                         | 支持技能之间的顺序依赖、并行执行和组合编排        |

### 1.2 设计原则

1. **会话后触发优于做梦批处理** — 技能提取在任务完成后立即触发后台 Agent，保证时效性和上下文完整性（做梦阶段距离原始对话可能已过去数小时/数天，丢失关键细节）。
2. **技能记忆分层** — 主会话上下文只加载技能索引（名称 + 描述 + 触发条件），具体执行步骤按需懒加载。
3. **去噪优先** — 提炼的是"从零到成功的最短可复现路径"，而非对话的完整记录。
4. **渐进式信心** — 新生成的技能为 `draft` 状态，经过多次成功调用后自动升级为 `proven`。
5. **向后兼容** — 完全兼容现有手动 `SKILL.md` 格式，自动生成的技能与手动技能在运行时无差别。

## 2. 系统架构总览

```
┌─────────────────────────────────────────────────────────────────┐
│                      主会话 (Main Session)                        │
│                                                                   │
│  用户 ←→ Agent                                                    │
│    │                                                              │
│    ├─ [实时] SkillMatcher: 匹配触发条件 → 自动加载技能到上下文      │
│    │                                                              │
│    └─ [实时] TaskCompletionDetector: 检测任务完成 + 用户满意       │
│              │                                                    │
│              ▼                                                    │
│         ┌────────────────────┐                                    │
│         │  触发后台 Agent     │                                    │
│         │  SkillExtractor    │                                    │
│         └────────┬───────────┘                                    │
│                  │                                                │
│                  ▼                                                │
│  ┌───────────────────────────────────┐                           │
│  │   技能存储层 (Managed Skills Dir)  │                           │
│  │                                    │                           │
│  │  skills/                           │                           │
│  │  ├── _index.md          (索引)     │                           │
│  │  ├── deploy-nextjs/                │                           │
│  │  │   ├── SKILL.md       (技能卡)   │                           │
│  │  │   └── steps.md       (详细步骤) │                           │
│  │  └── fix-eslint-config/            │                           │
│  │      ├── SKILL.md                  │                           │
│  │      └── steps.md                  │                           │
│  └───────────────────────────────────┘                           │
│                  │                                                │
│                  ▼                                                │
│  ┌───────────────────────────────────┐                           │
│  │  技能编排层 (SkillOrchestrator)    │                           │
│  │  - 顺序执行 (sequential)           │                           │
│  │  - 并行执行 (parallel)             │                           │
│  │  - 条件分支 (conditional)          │                           │
│  └───────────────────────────────────┘                           │
└─────────────────────────────────────────────────────────────────┘
```

## 3. 模块详细设计

### 3.1 模块一：TaskCompletionDetector (任务完成检测器)

**目的**：在对话流中实时判断"一次有意义的任务是否已经成功完成且用户满意"。

**位置**：`src/agents/skills/auto-evolve/task-completion-detector.ts`

**触发时机**：作为 `postSamplingHook` 或 `stopHook`，在每轮 Agent 回复后执行。

**检测信号**（按权重）：

| 信号             | 权重 | 说明                                           |
| ---------------- | ---- | ---------------------------------------------- |
| 用户显式确认     | 高   | "好了"、"完美"、"可以了"、"谢谢" 等            |
| Agent 宣告完成   | 中   | Agent 回复中包含 "已完成"、"Done"、"已部署" 等 |
| 对话节奏变化     | 低   | 用户在最后一轮回复后长时间不再发送消息         |
| 工具调用成功闭环 | 中   | 一系列编辑/执行工具调用无错误返回              |

**检测方式**：不使用独立的 LLM 调用（成本太高），而是在现有 Agent 回复的 system prompt 末尾追加一个极短的结构化标记请求：

```
If you believe the user's current task is now complete and they are satisfied,
append at the very end of your reply: <task_signal status="completed" confidence="high|medium"/>
```

Agent 的回复经后处理解析该标记（对用户不可见），提取信号后决定是否触发技能提取。

**输出**：`TaskCompletionSignal`

```typescript
type TaskCompletionSignal = {
  detected: boolean;
  confidence: "high" | "medium" | "low";
  taskSummary: string; // Agent 对完成任务的一句话描述
  turnRange: [number, number]; // 对话中属于本次任务的起止 turn 索引
};
```

### 3.2 模块二：SkillExtractor (技能提取后台 Agent)

**目的**：在任务完成信号触发后，异步启动一个后台 Agent，回顾对话历史，去除失败和冗余路径，将"最佳路径"封装为标准 `SKILL.md`。

**位置**：`src/agents/skills/auto-evolve/skill-extractor.ts`

**触发方式**：由 `TaskCompletionDetector` 发出 `TaskCompletionSignal` 后异步派生（类似现有 `extractMemories` 的 `postSamplingHook` 机制，但产出物是技能文件而非记忆文件）。

**提取 Agent 的能力要求（工具与上下文）**：

SkillExtractor 后台 Agent **不是盲写**，它必须具备以下能力：

1. **搜索现有技能**：提取前先扫描 `_index.md` 和 managed skills 目录，检查是否已有高度相似的技能。如果有，执行**合并更新**而非新建。
2. **搜索记忆**：调用现有 memory search 管线，查询是否有相关的用户偏好、项目决策等长期记忆，将其融入技能步骤（例如用户偏好 pnpm 而非 npm）。
3. **搜索对话历史**：如果当前对话引用了过去的做法，Agent 可 grep 历史 session transcripts 获取上下文。
4. **读取代码/配置**：对于涉及代码修改的技能，Agent 应能读取相关文件确认步骤的正确性。

这些工具权限通过 `canUseTool` 白名单控制（类似 `extractMemories` 的 `createAutoMemCanUseTool`），仅开放**只读类工具**（read_file、grep、memory_search），不开放写入类工具（除了最终的 skill 文件写入）。

**核心 Prompt 设计**（提取 Agent 的系统提示）：

````markdown
# Skill Extraction

你是一个技能提炼专家。你将收到一段完整的人机对话记录，其中用户和 Agent 协作完成了一项任务。

## 你的目标

1. **搜索已有技能**：先查看技能索引，确认是否已有可复用或可合并的技能。
2. **搜索相关记忆**：查询用户偏好和项目记忆，确保提炼的步骤符合用户习惯。
3. **识别任务**：这段对话完成了什么任务？
4. **去噪**：去除所有失败的尝试、错误的方向、调试踩坑过程。
5. **提炼最佳路径**：只保留"从零到成功"的最短可复现步骤序列。
6. **封装技能**：输出标准的 SKILL.md 格式（新建或合并更新）。

## 输出格式

```yaml
---
name: <kebab-case 技能名>
description: <一句话描述，不超过 120 字符>
trigger-patterns:
  - <触发此技能的用户意图模式 1>
  - <触发此技能的用户意图模式 2>
confidence: draft
version: 1
created-from-session: <session-id>
depends-on: []
---
```
````

后接详细步骤的 Markdown 正文。

## 规则

- 步骤必须是可复现的命令或操作，不要包含"我试过 X 但失败了"这类内容。
- 如果任务太简单（例如只是回答一个问题），则不适合封装为技能，返回空。
- 如果检测到已有类似技能，应合并/更新而非创建新技能。

````

**去噪算法**：

1. 将对话 turns 标注为 `attempt` / `error` / `correction` / `success`
2. 构建有向图：`turn[i]` → `turn[j]` 表示 j 是 i 的修正/后续
3. 从最后一个 `success` turn 反向追溯，只保留到达成功的最短路径上的 turns
4. 将路径 turns 重新组织为线性步骤

**产出物**：
- `skills/<skill-name>/SKILL.md` — 标准技能卡（索引用）
- `skills/<skill-name>/steps.md` — 详细执行步骤（运行时按需加载）

### 3.3 模块三：SkillIndex (技能索引管理)

**目的**：维护一个轻量级的技能索引文件 `_index.md`，供主会话上下文加载。

**位置**：`src/agents/skills/auto-evolve/skill-index.ts`

**设计理念**：
- 主会话的 system prompt 中 `<available_skills>` 只包含**索引信息**（名称 + 描述 + 触发条件），不包含具体步骤。
- 当 Agent 决定使用某技能时，通过 `read_file` 工具按需加载 `steps.md`。
- 这样即使有 100+ 个自动生成的技能，system prompt 也不会膨胀。

**索引格式** (`_index.md`)：

```markdown
# Auto-Evolved Skills Index

## deploy-nextjs
- **Description**: Deploy a Next.js app to Vercel with environment variables
- **Triggers**: "部署 Next.js", "deploy to vercel", "上线项目"
- **Confidence**: proven (5 successful uses)
- **Depends**: [setup-vercel-cli]
- **Location**: skills/deploy-nextjs/SKILL.md

## fix-eslint-config
- **Description**: Fix common ESLint + Prettier configuration conflicts
- **Triggers**: "eslint 报错", "prettier 冲突", "lint fix"
- **Confidence**: draft (1 successful use)
- **Location**: skills/fix-eslint-config/SKILL.md
````

**与现有系统的集成**：

现有的 `loadSkillEntries()` (`src/agents/skills/workspace.ts`) 已经支持从多个来源加载技能并按优先级合并。自动生成的技能写入 `managedSkillsDir`（优先级低于手动的 workspace 技能），自然融入现有的加载链：

```
extra < bundled < managed(自动生成) < agents-skills-personal < agents-skills-project < workspace(手动)
```

### 3.4 模块四：SkillMatcher (技能自动匹配器)

**目的**：在每轮用户消息到达时，自动匹配适用的技能并将其详细步骤加载到上下文中。

**位置**：`src/agents/skills/auto-evolve/skill-matcher.ts`

**匹配策略**（多级漏斗）：

1. **关键词匹配**：用户消息与技能的 `trigger-patterns` 做模糊匹配（快速、零成本）
2. **语义匹配**（可选）：如果关键词未命中，使用现有的 memory embedding 进行向量相似度匹配
3. **LLM 确认**（可选）：在高置信度阈值下跳过；低置信度时追加一次轻量级 LLM 判断

**匹配结果注入方式**：

```typescript
// 不修改 system prompt，而是在用户消息后追加一条系统消息
appendSystemMessage({
  role: "system",
  content: `[Auto-loaded skill: "${skillName}"]
The following skill steps are relevant to the user's request.
Follow them as a guide, adapting as needed.

${skillStepsContent}`,
});
```

### 3.5 模块五：SkillOrchestrator (技能编排器)

**目的**：支持多技能的顺序、并行和条件组合执行。

**位置**：`src/agents/skills/auto-evolve/skill-orchestrator.ts`

**编排声明方式**（在 SKILL.md frontmatter 中）：

```yaml
---
name: full-stack-deploy
description: Full stack deployment (frontend + backend + database migration)
depends-on:
  - name: run-db-migrations
    order: 1
  - name: deploy-backend-api
    order: 2
  - name: deploy-nextjs-frontend
    order: 3
    parallel-with: deploy-cdn-assets
  - name: deploy-cdn-assets
    order: 3
---
```

**运行时行为**：

1. 当 `full-stack-deploy` 被触发时，SkillOrchestrator 解析 `depends-on` 声明
2. 按 `order` 分组：同组内可并行，不同组间严格顺序
3. 每个子技能的 `steps.md` 按序/并行加载到上下文中
4. Agent 按照编排顺序执行步骤，每完成一个子技能发出进度信号

### 3.6 模块六：SkillEvolution (技能进化与反馈循环)

**目的**：技能不是一次生成后永远不变的，而是通过使用反馈持续进化。

**位置**：`src/agents/skills/auto-evolve/skill-evolution.ts`

**信心等级模型**：

```
draft → validated → proven → archived
  │         │          │         │
  │         │          │         └── 长期未使用或被更好技能替代
  │         │          └── 5+ 次成功使用且无修正
  │         └── 2-4 次成功使用
  └── 首次由 SkillExtractor 生成
```

**黄金原则：满意即保持，不画蛇添足**

当一个技能被调用后用户满意（任务完成 + 无修正），系统**什么都不做**——不更新、不重构、不"优化"。这是最重要的稳定性保证。只有在明确的负面信号出现时，才触发诊断和进化。

**进化行为**：

| 事件                           | 行为                                                                             |
| ------------------------------ | -------------------------------------------------------------------------------- |
| 技能被调用且用户满意           | `useCount++` + `successCount++`，如达阈值则升级 confidence。**不修改技能内容。** |
| 技能被调用但用户明确不满意     | 触发 **SkillDiagnostics**（见 3.7），诊断失败原因后分流处理                      |
| 技能被调用但用户手动修正了步骤 | 触发 SkillExtractor 以新对话为输入，**合并更新**现有技能                         |
| 技能长时间未被调用             | 在做梦阶段被标记为 `archived`（不删除，但从索引移除）                            |
| 两个技能高度相似               | 在做梦阶段合并为一个，保留更高置信度的版本                                       |

**统计信息存储**（在 SKILL.md frontmatter 中追加）：

```yaml
stats:
  use-count: 12
  success-count: 10
  fail-count: 2
  wrong-match-count: 1
  last-used: 2026-04-10T15:30:00Z
  last-evolved: 2026-04-08T03:00:00Z
  evolved-from-sessions:
    - session-abc123
    - session-def456
negative-patterns:
  - "删除数据库" # 曾被错误匹配到此查询，已排除
```

### 3.7 模块七：SkillDiagnostics (技能调用失败诊断)

**目的**：当技能被调用后用户不满意时，诊断根因并分流到正确的修复路径。

**位置**：`src/agents/skills/auto-evolve/skill-diagnostics.ts`

**触发条件**：技能被自动匹配并加载到上下文后，`TaskCompletionDetector` 检测到任务未完成或用户不满意。

**诊断分支（Decision Tree）**：

```
技能被调用 → 用户不满意
  │
  ├─ 诊断 A：匹配错误（Wrong Skill）
  │   │  信号：用户说"不是这个"、Agent 放弃了技能步骤转用其他方法
  │   │  行为：降低该技能对此类查询的匹配分数（在 trigger-patterns 中
  │   │        添加 negative-patterns 排除项）
  │   └─ 重新搜索技能库，尝试匹配其他技能或技能组合
  │
  ├─ 诊断 B：技能过时需升级（Skill Outdated）
  │   │  信号：技能步骤执行了但结果不对（API 变了、版本不兼容等）
  │   │  行为：触发 SkillExtractor，以当前对话为输入，合并更新该技能
  │   └─ `failCount++`，连续失败 3 次则降级 confidence
  │
  └─ 诊断 C：需要技能组合（Needs Orchestration）
      │  信号：单个技能只完成了部分任务，用户需要更多步骤
      │  行为：触发 SkillExtractor 生成一个新的编排技能（depends-on 引用
      └─ 现有技能），或在现有技能中追加缺失步骤
```

**诊断方式**：

诊断不需要独立的 LLM 调用。在 SkillExtractor 后台 Agent 的 Prompt 中追加诊断上下文：

```markdown
## 诊断上下文

本次对话中，系统自动加载了技能 "{{skill_name}}"（v{{version}}），
但用户未表达满意。请分析：

1. 技能是否被错误匹配？（如果是，建议调整 trigger-patterns）
2. 技能步骤是否过时需要更新？（如果是，输出更新后的 SKILL.md）
3. 是否需要组合其他技能？（如果是，输出编排声明）

在分析时，请：

- 搜索现有技能索引，查看是否有更合适的技能
- 搜索用户记忆，查看是否有相关偏好变化
- 检查技能步骤中引用的命令/API 是否仍然有效
```

**产出物**：`SkillDiagnosticsResult`

```typescript
type SkillDiagnosticsResult = {
  diagnosis: "wrong_match" | "outdated" | "needs_orchestration" | "unknown";
  /** 匹配错误时，建议添加的排除模式 */
  negativePatterns?: string[];
  /** 技能过时时，更新后的 SKILL.md 内容 */
  updatedSkill?: string;
  /** 需要编排时，建议的技能组合 */
  suggestedOrchestration?: { skills: string[]; order: number[] };
};
```

## 4. 与做梦系统的协同

虽然技能提取的主触发点是**会话后实时触发**，但做梦系统（`memory-host-sdk/dreaming.ts`）仍然承担以下辅助职责：

| 做梦阶段  | 技能相关职责                                                       |
| --------- | ------------------------------------------------------------------ |
| **Light** | 扫描近期自动生成的 `draft` 技能，检查是否有重复或质量问题          |
| **Deep**  | 跨技能关联分析：发现可合并的技能对，清理 archived 技能             |
| **REM**   | 从长期对话历史中发掘"从未被封装但反复出现的模式"，**补偿提取遗漏** |

这实现了双保险：实时提取保证时效性，做梦补偿保证覆盖率。

## 5. 配置接口设计

在 `OpenClawConfig` 中新增以下配置段（通过 Web 页面可视化配置）：

```typescript
// 新增配置项（嵌入 config.ts 的 skills 段）
type SkillAutoEvolveConfig = {
  /** 是否启用自动技能进化 */
  enabled: boolean;
  /** 任务完成检测方式 */
  detection: {
    /** 是否在 Agent 回复中嵌入 <task_signal> 标记 */
    inlineSignal: boolean;
    /** 最低触发置信度 */
    minConfidence: "high" | "medium" | "low";
  };
  /** 技能提取配置 */
  extraction: {
    /** 提取使用的模型（可用便宜模型降低成本） */
    model?: string;
    /** 单次提取的最大输出 Token */
    maxOutputTokens?: number;
    /** 太简单的任务（对话 turns < N）不提取 */
    minTaskTurns: number;
    /** 单日最大提取次数（成本控制） */
    maxExtractionsPerDay: number;
  };
  /** 技能匹配配置 */
  matching: {
    /** 是否启用自动匹配 */
    enabled: boolean;
    /** 匹配策略 */
    strategy: "keyword" | "semantic" | "hybrid";
    /** 最低匹配分数 */
    minScore: number;
  };
  /** 技能进化配置 */
  evolution: {
    /** 升级到 proven 所需的成功次数 */
    provenThreshold: number;
    /** 归档阈值（天数未使用） */
    archiveDays: number;
    /** 失败率降级阈值 */
    degradeFailRate: number;
  };
};
```

## 6. 开发计划

### Phase 0: 基础设施准备 (预计 2-3 天)

- [ ] **P0-1** 在 `src/agents/skills/auto-evolve/` 创建模块目录结构
- [ ] **P0-2** 在 `OpenClawConfig` 的 `skills` 段新增 `autoEvolve` 配置定义和 schema
- [ ] **P0-3** 在 managed skills dir（`~/.config/openclaw/skills/`）中约定自动生成技能的子目录 `_auto/`
- [ ] **P0-4** 扩展现有 `SkillEntry` 类型，新增 `stats` 和 `triggerPatterns` 字段
- [ ] **P0-5** 编写 `_index.md` 的读写工具函数

### Phase 1: 任务完成检测 (预计 3-4 天)

- [ ] **P1-1** 实现 `TaskCompletionDetector`，集成为 `postSamplingHook`
- [ ] **P1-2** 实现 `<task_signal>` 标记的注入（system prompt 追加）和解析（后处理剥离）
- [ ] **P1-3** 实现 turn 范围标注算法（区分多轮中的任务边界）
- [ ] **P1-4** 编写单元测试：各类对话场景下的完成信号检测
- [ ] **P1-5** 可配置的节流：同一会话中两次提取之间的最小间隔

### Phase 2: 技能提取后台 Agent (预计 5-7 天)

- [ ] **P2-1** 实现 `SkillExtractor` 后台 Agent，复用现有 `extractMemories` 的异步派生模式
- [ ] **P2-2** 编写提取 Prompt（去噪 + 最佳路径提炼 + SKILL.md 格式化）
- [ ] **P2-3** 实现"已有技能去重检查"：提取前扫描现有技能索引，检测相似技能
- [ ] **P2-4** 实现提取结果的文件写入：`SKILL.md` + `steps.md` + `_index.md` 更新
- [ ] **P2-5** 实现合并更新逻辑：当检测到类似技能时，合并而非新建
- [ ] **P2-6** 编写集成测试：模拟完整对话 → 触发提取 → 验证产出文件
- [ ] **P2-7** 实现 Web 端通知：提取完成后通过 Gateway 事件推送到 Web 页面

### Phase 3: 技能自动匹配 (预计 4-5 天)

- [ ] **P3-1** 实现 `SkillMatcher` 的关键词匹配引擎
- [ ] **P3-2** 集成现有 memory embedding 管线实现语义匹配
- [ ] **P3-3** 实现匹配结果到会话上下文的注入机制（`appendSystemMessage`）
- [ ] **P3-4** 实现 `steps.md` 的懒加载（仅在匹配命中时读取）
- [ ] **P3-5** 编写测试：关键词匹配、语义匹配、混合匹配的准确率验证

### Phase 4: 技能编排 (预计 3-4 天)

- [ ] **P4-1** 扩展 SKILL.md frontmatter 支持 `depends-on` 声明
- [ ] **P4-2** 实现 `SkillOrchestrator` 的 DAG 解析和执行排序
- [ ] **P4-3** 实现并行子技能的上下文合并
- [ ] **P4-4** 编写测试：顺序执行、并行执行、循环依赖检测

### Phase 5: 技能进化与反馈循环 (预计 3-4 天)

- [ ] **P5-1** 实现 `SkillEvolution` 的统计追踪（使用/成功/失败计数）
- [ ] **P5-2** 实现信心等级自动升降级逻辑
- [ ] **P5-3** 实现"用户修正触发重新提取"的检测和合并更新
- [ ] **P5-4** 集成做梦系统：在 Light/Deep/REM 阶段添加技能维护任务
- [ ] **P5-5** 编写测试：进化生命周期全链路

### Phase 6: Web 端集成与可视化 (预计 3-4 天)

- [ ] **P6-1** 在 Gateway `doctor` API 中暴露自动技能的健康数据
- [ ] **P6-2** Web 面板：技能列表（含置信度、使用统计、来源会话）
- [ ] **P6-3** Web 面板：技能详情查看/手动编辑/手动归档
- [ ] **P6-4** Web 面板：技能进化时间线可视化

### Phase 7: 端到端验证与优化 (预计 2-3 天)

- [ ] **P7-1** 端到端场景测试：从对话到技能生成到自动调用的完整链路
- [ ] **P7-2** 成本分析：监控提取 Agent 的 Token 消耗，调优节流参数
- [ ] **P7-3** 编写用户文档：如何启用、配置和管理自动进化技能

---

**总预估工期**：约 25-30 个工作日（单人全职）

## 7. 风险与缓解

| 风险                       | 影响                            | 缓解                                                                             |
| -------------------------- | ------------------------------- | -------------------------------------------------------------------------------- |
| 提取 Agent 的 LLM 成本过高 | 每次任务完成都触发一次 LLM 调用 | `minTaskTurns` 过滤琐碎任务；`maxExtractionsPerDay` 每日上限；允许使用低成本模型 |
| 提取的技能质量不稳定       | 低质量技能可能误导后续对话      | `draft` 状态 + 信心升级机制；首次使用不自动注入而是建议性展示                    |
| 技能膨胀导致索引过大       | 生成大量碎片化技能              | `archiveDays` 自动归档；做梦阶段合并相似技能                                     |
| 触发条件误匹配             | 错误地加载不相关技能            | `minScore` 匹配阈值 + 可选 LLM 确认层；用户可通过配置禁用自动匹配                |
| 多技能编排复杂度           | 循环依赖、步骤冲突              | DAG 拓扑排序 + 循环检测；Phase 4 可作为后期增强，初版不实现                      |

## 8. 不在范围内 (Out of Scope)

- 跨用户的技能共享市场（ClaHub Skill Marketplace）— 后期独立立项
- 技能的版本控制与回滚（Git-style）— 后期独立立项
- 技能的沙箱化执行（Security sandbox）— 依赖现有 sandbox 基础设施
