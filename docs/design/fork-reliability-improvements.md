# Fork Reliability Improvements

## 概述

本文档描述了对 OpenClaw 多agent系统的关键可靠性改进，解决了两个核心问题：
1. **任务范围混淆** - 子agent执行错误的工作范围
2. **通知丢失** - 子agent完成但主agent未收到通知

## 问题分析

### 问题1：任务范围混淆

**症状**：
- 对话1已完成，对话2启动多agent时，个别agent执行了对话1的未完成工作
- LLM难以区分当前任务与之前对话的上下文

**根本原因**：
- `buildForkedMessages()` 传递完整的 `assistantMessage`，包含之前对话的所有工具调用
- 虽然有指令要求"忽略其他内容"，但LLM仍可能被上下文误导

### 问题2：通知丢失

**症状**：
- 子agent工作完成后，主agent永远收不到完成通知
- 主agent会无限等待，导致任务卡死

**根本原因**：
- `announceForkCompletion()` 使用"fire-and-forget"机制
- 如果 `callGateway` 失败，没有重试机制
- 缺少通知确认和心跳检测

## 解决方案

### 1. 上下文隔离 (Context Isolation)

#### 新增文件
- `src/agents/fork/fork-context-isolation.ts`

#### 核心改进
```typescript
// 构建干净的消息上下文，只包含任务相关信息
export function buildIsolatedForkMessages(context: IsolatedForkContext): AgentMessage[]

// 从指令中提取相关文件路径
export function extractRelevantFiles(directive: string): string[]

// 验证输出是否在允许范围内
export function validateForkOutputScope(output: string, allowedFiles: string[])
```

#### 关键特性
- **干净上下文**：只传递当前任务的指令和上下文
- **任务ID强化**：在消息中嵌入唯一任务ID和时间戳
- **范围验证**：检查子agent是否访问了未授权的文件

### 2. 可靠通知系统 (Reliable Notification)

#### 新增文件
- `src/agents/fork/reliable-notification.ts`

#### 核心改进
```typescript
// 带重试的通知发送
export class ReliableNotification {
  static async deliverNotification(parentSessionKey: string, payload: NotificationPayload)
}

// 通知跟踪器
export class NotificationTracker {
  registerNotification(payload: NotificationPayload)
  confirmDelivery(taskId: string)
  getUnconfirmedNotifications()
}

// 心跳检测
export class TaskHeartbeat {
  static startMonitoring(checkStuckTasks: () => Promise<void>)
  static isTaskStuck(session: ForkSession): boolean
}
```

#### 关键特性
- **重试机制**：失败时自动重试（最多3次，指数退避）
- **通知确认**：跟踪通知的发送和确认状态
- **心跳检测**：定期检查长时间未完成的任务
- **超时保护**：自动清理卡死的任务

### 3. 增强的 Spawn Adapter

#### 新增文件
- `src/agents/fork/fork-spawn-adapter-v2.ts`

#### 集成改进
```typescript
// 使用隔离的消息上下文
const isolatedContext: IsolatedForkContext = {
  directive: ctx.directive,
  taskContext: ctx.taskContext,
  relevantFiles: extractRelevantFiles(ctx.directive),
  sessionMeta: { taskId, parentSessionKey, createdAt: Date.now() }
};

const forkMessages = buildIsolatedForkMessages(isolatedContext);

// 可靠的通知发送
const announced = await deliverReliableNotification(parentSessionKey, payload);
```

## 集成指南

### 步骤1：替换现有的 fork-spawn-adapter

```typescript
// 替换导入
import { spawnForkSubagent } from "./fork-spawn-adapter-v2.js";
// 而不是
// import { spawnForkSubagent } from "./fork-spawn-adapter.js";
```

### 步骤2：更新 agent-tool.ts

```typescript
// 在 createAgentTool 中使用新的 adapter
import { spawnForkSubagent } from "../fork/fork-spawn-adapter-v2.js";
```

### 步骤3：添加心跳监控

```typescript
// 在应用启动时
import { TaskHeartbeat } from "../fork/reliable-notification.js";

TaskHeartbeat.startMonitoring(async () => {
  // 检查卡死的任务并尝试恢复
});
```

## 测试验证

### 测试文件
- `src/agents/fork/fork-reliability.test.ts`

### 测试覆盖
1. **上下文隔离测试**
   - 验证干净消息构建
   - 文件提取准确性
   - 输出范围验证

2. **可靠通知测试**
   - 通知跟踪功能
   - 未确认通知检测
   - 旧通知清理

3. **心跳检测测试**
   - 卡死任务识别
   - 不同状态的任务处理

4. **集成场景测试**
   - 现实场景的上下文隔离
   - 范围违规检测

## 性能影响

### 内存使用
- **通知跟踪器**：每个任务约 200B，可配置清理
- **上下文隔离**：减少内存使用（不传递完整对话历史）

### 网络开销
- **重试机制**：最多增加 3 次通知尝试
- **心跳检测**：仅内部检查，无网络开销

### CPU 开销
- **文件提取**：正则表达式匹配，开销极小
- **范围验证**：字符串匹配，开销可忽略

## 配置选项

### 通知配置
```typescript
// 在 reliable-notification.ts 中
private static readonly MAX_RETRIES = 3;
private static readonly RETRY_DELAYS = [1000, 2000, 4000];
private static readonly NOTIFICATION_TIMEOUT = 5000;
```

### 心跳配置
```typescript
private static readonly HEARTBEAT_INTERVAL = 30_000; // 30秒
private static readonly STUCK_THRESHOLD = 300_000; // 5分钟
```

### 清理配置
```typescript
// 通知清理时间
tracker.cleanup(300_000); // 5分钟

// Fork 注册表清理
registry.cleanup(3_600_000); // 1小时
```

## 监控和调试

### 日志示例
```
[ForkAdapter] Found stuck task: task-123 (running)
[ForkAdapter] Attempting to redeliver notification for stuck task: task-123
[ForkAdapter] Failed to deliver notification for task task-456: Gateway timeout
```

### 调试工具
```typescript
// 检查未确认的通知
const unconfirmed = notificationTracker.getUnconfirmedNotifications();

// 查找卡死的任务
const stuckTasks = registry.findStuckForks();

// 获取统计信息
const stats = registry.getStats();
```

## 向后兼容性

- **API 兼容**：`spawnForkSubagent` 签名保持不变
- **消息格式**：`<task-notification>` XML 格式不变
- **配置**：现有配置继续有效

## 部署建议

1. **渐进式部署**：先在测试环境验证
2. **监控指标**：跟踪通知失败率和任务卡死率
3. **回滚计划**：保留原始 adapter 作为备份
4. **性能基线**：记录部署前的性能指标

## 未来改进

1. **智能范围检测**：基于代码依赖关系自动确定相关文件
2. **分布式通知**：支持多实例环境的通知确认
3. **自适应重试**：基于网络状况动态调整重试策略
4. **可视化监控**：提供任务状态的可视化界面
