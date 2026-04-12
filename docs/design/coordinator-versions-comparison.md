# Coordinator 版本对比：简化版 vs 完整版

## 问题核心

**用户问**：为什么不直接完整复制 @[claude-code] 的代码？

**答案**：因为 **架构差异** 和 **依赖缺失**，完整移植需要大量适配工作。

---

## 对比表

| 特性 | Claude Code | OpenClaw 简化版 | OpenClaw 完整版 |
|------|-------------|----------------|----------------|
| **代码量** | ~800 行 + 依赖 | ~300 行 | ~400 行 + 适配层 |
| **Bun 依赖** | 必需 (bun:bundle) | 无 | 无 |
| **Feature Gate** | growthbook.js | 无 | 无 |
| **Analytics** | 内置 | 无 | 可选 |
| **工具链** | 复杂 (Team/Synthetic) | 基础 | 基础 |
| **依赖注入** | QueryEngine.ts | 无 | 简化 |
| **权限继承** | 复杂权限系统 | 基础 | 中等 |
| **移植难度** | N/A | 低 | 中等 |

---

## Claude Code 完整 Coordinator 架构

```
┌─────────────────────────────────────────────┐
│           Claude Code Coordinator           │
├─────────────────────────────────────────────┤
│  1. isCoordinatorMode() - 环境变量检查      │
│  2. matchSessionMode() - 会话模式切换       │
│  3. Feature Gate (growthbook.js)          │
│  4. Analytics (logEvent)                   │
│  5. 复杂工具过滤 (ASYNC_AGENT_ALLOWED_TOOLS)│
│  6. QueryEngine.ts 依赖注入               │
│  7. CacheSafeParams 管理                  │
└─────────────────────────────────────────────┘
                    │
        ┌──────────┴──────────┐
        │                     │
   Bun Runtime            Node Runtime
   (必需)                 (需要适配层)
```

---

## 为什么不能直接复制？

### 1. Bun 特性依赖

**Claude Code 代码**：
```typescript
import { feature } from 'bun:bundle'  // ❌ Bun 特有

if (feature('COORDINATOR_MODE')) {    // ❌ 无法运行在 Node
  // ...
}
```

**OpenClaw 适配**：
```typescript
// 移除 Bun 特性，改用环境变量
const mode = process.env.OPENCLAW_COORDINATOR_MODE;
```

### 2. Feature Gate 系统

**Claude Code 代码**：
```typescript
import { checkStatsigFeatureGate_CACHED_MAY_BE_STALE } from '../services/analytics/growthbook.js';

function isEnabled() {
  return checkStatsigFeatureGate_CACHED_MAY_BE_STALE('tengu_scratch');
}
```

**问题**：
- OpenClaw 没有 Statsig/Growthbook 基础设施
- 需要额外集成分析系统
- 复杂度不值得（仅用于一个功能开关）

### 3. 依赖注入架构

**Claude Code 代码**：
```typescript
export function getCoordinatorUserContext(
  params: {
    scratchpadDir: string;
    cacheSafeParams: CacheSafeParams;  // ❌ OpenClaw 没有此类型
    // ...
  },
  context: QueryEngineContext,  // ❌ OpenClaw 架构不同
): CoordinatorContext {
  // ...
}
```

**OpenClaw 差异**：
- OpenClaw 使用 `ForkSpawnContext` 而非 `CacheSafeParams`
- OpenClaw 没有 `QueryEngine.ts` 依赖注入
- 需要重写所有类型映射

### 4. 工具链差异

**Claude Code 工具**：
```typescript
const INTERNAL_WORKER_TOOLS = new Set([
  TEAM_CREATE_TOOL_NAME,      // ❌ OpenClaw 无团队功能
  TEAM_DELETE_TOOL_NAME,
  SEND_MESSAGE_TOOL_NAME,     // ⚠️ 功能不同
  SYNTHETIC_OUTPUT_TOOL_NAME, // ❌ OpenClaw 无此工具
]);
```

**OpenClaw 工具**：
```typescript
// 基础工具：read, write, edit, bash
// 无 Team/Synthetic 等高级工具
```

---

## 简化版 vs 完整版代码对比

### 简化版 SimpleCoordinator

**优点**：
- ✅ 200+ 行，易于维护
- ✅ 零外部依赖
- ✅ 直接使用现有 fork 系统
- ✅ 立即可用

**缺点**：
- ❌ 无自动重试
- ❌ 无复杂权限管理
- ❌ 无 Feature Gate

```typescript
// 使用示例
const coordinator = new SimpleCoordinator({ maxConcurrent: 5 });
coordinator.addTask("task-1", "Fix bug");
// 等待完成...
console.log(coordinator.synthesizeResults());
```

### 完整版 FullCoordinator

**优点**：
- ✅ 自动重试（指数退避）
- ✅ 任务状态管理（pending/running/completed/failed/retrying）
- ✅ 工具白名单
- ✅ 更详细的统计

**缺点**：
- ⚠️ 400+ 行，更复杂
- ⚠️ 需要适配层（概念映射）
- ⚠️ 部分 Claude Code 功能缺失（Feature Gate 等）

```typescript
// 使用示例
const coordinator = createCoordinator({
  mode: "enabled",
  maxConcurrent: 5,
  autoRetry: true,
  maxRetries: 2,
  allowedTools: ["read", "write", "edit"],
});

const tasks = coordinator.createTasks([
  "Fix auth bug",
  "Update tests",
  "Refactor utils",
]);

await coordinator.runAll(parentSessionKey, tasks);
console.log(coordinator.synthesizeResults());
```

---

## 实际建议

### 场景 1：快速使用（推荐简化版）

```typescript
import { SimpleCoordinator } from "./fork/index.js";

const coordinator = new SimpleCoordinator({ maxConcurrent: 5 });
```

**适用**：
- 大多数并行任务场景
- 不需要自动重试
- 立即需要可用

### 场景 2：生产环境（推荐完整版）

```typescript
import { FullCoordinator, createCoordinator } from "./coordinator/full-coordinator.js";

const coordinator = createCoordinator({
  autoRetry: true,
  maxRetries: 2,
});
```

**适用**：
- 需要高可靠性
- 网络不稳定环境
- 长时间运行的任务

---

## 未来增强路线图

如果需要更多 Claude Code 功能，可以逐步添加：

1. **Phase 1**（已完成）：基础 Coordinator ✅
2. **Phase 2**（可选）：自动重试 ✅
3. **Phase 3**（可选）：Feature Gate 集成
4. **Phase 4**（可选）：Analytics 集成
5. **Phase 5**（可选）：复杂权限继承

---

## 总结

| 需求 | 推荐版本 | 原因 |
|------|---------|------|
| 立即使用 | 简化版 | 已测试，零依赖 |
| 自动重试 | 完整版 | 已移植 |
| Feature Gate | 暂不推荐 | 需要额外基础设施 |
| 完整 Claude Code 功能 | 需要评估 | 大量适配工作 |

**核心原则**：OpenClaw 的架构与 Claude Code 不同，直接复制会导致大量未解析的依赖。简化版在保持核心功能的同时，确保可用性和可维护性。
