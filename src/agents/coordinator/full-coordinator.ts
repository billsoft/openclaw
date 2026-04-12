/**
 * 完整版 Coordinator - 基于 Claude Code 设计
 *
 * 包含适配层，将 Claude Code 概念映射到 OpenClaw 架构
 */

import {
  spawnForkSubagent,
  type ForkSpawnContext,
  type ForkSpawnResult,
  SimpleCoordinator,
} from "../fork/index.js";

// ============================================================================
// 适配层：Claude Code 概念 → OpenClaw 概念
// ============================================================================

/**
 * Claude Code: AgentTool.runAgent() → OpenClaw: spawnForkSubagent()
 */
type _AgentToolParams = {
  prompt: string;
  tools?: string[];
  parentTools?: string[];
  description?: string;
  inheritPermissions?: boolean;
};

/**
 * Claude Code: Coordinator 模式开关
 * 在 OpenClaw 中对应 fork 子 agent 模式
 */
export type CoordinatorMode = "disabled" | "enabled" | "auto";

/**
 * Claude Code: CacheSafeParams → OpenClaw: ForkSpawnContext
 * 简化为 fork 需要的参数
 */
export interface CoordinatorTaskConfig {
  taskId: string;
  directive: string;
  taskContext?: string;
  tools?: string[]; // 允许的工具列表
  scratchpadDir?: string;
  timeoutMs?: number;
  priority?: "high" | "medium" | "low";
}

// ============================================================================
// 完整版 Coordinator 实现
// ============================================================================

export interface FullCoordinatorOptions {
  mode: CoordinatorMode;
  maxConcurrent: number;
  timeoutMs: number;
  /** 是否继承父 agent 的工具权限 */
  inheritPermissions: boolean;
  /** 允许的子 agent 工具 */
  allowedTools: string[];
  /** 自动重试失败任务 */
  autoRetry: boolean;
  maxRetries: number;
}

export interface CoordinatorTask {
  id: string;
  config: CoordinatorTaskConfig;
  status: "pending" | "running" | "completed" | "failed" | "retrying";
  attempt: number;
  result?: string;
  error?: string;
  forkId?: string;
  startedAt?: number;
  completedAt?: number;
  tokenUsage?: { input: number; output: number };
}

/**
 * 完整版 Coordinator
 *
 * 功能对标 Claude Code 的 coordinatorMode.ts：
 * - 任务队列管理
 * - 并发控制
 * - 自动重试
 * - 结果合成
 * - 权限继承
 */
export class FullCoordinator {
  private options: FullCoordinatorOptions;
  private tasks = new Map<string, CoordinatorTask>();
  private simpleCoordinator: SimpleCoordinator;
  private running = false;

  constructor(options: Partial<FullCoordinatorOptions> = {}) {
    this.options = {
      mode: options.mode ?? "auto",
      maxConcurrent: options.maxConcurrent ?? 5,
      timeoutMs: options.timeoutMs ?? 300_000,
      inheritPermissions: options.inheritPermissions ?? true,
      allowedTools: options.allowedTools ?? ["read", "write", "edit", "bash"],
      autoRetry: options.autoRetry ?? true,
      maxRetries: options.maxRetries ?? 2,
    };

    // 使用 SimpleCoordinator 作为底层
    this.simpleCoordinator = new SimpleCoordinator({
      maxConcurrent: this.options.maxConcurrent,
      timeoutMs: this.options.timeoutMs,
      onTaskComplete: (task) => this.handleTaskComplete(task),
      onAllComplete: () => this.handleAllComplete(),
    });
  }

  /**
   * 创建任务配置（适配 Claude Code 风格）
   */
  createTask(directive: string, options?: Partial<CoordinatorTaskConfig>): CoordinatorTaskConfig {
    return {
      taskId: options?.taskId ?? `task-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      directive,
      taskContext: options?.taskContext,
      tools: options?.tools ?? this.options.allowedTools,
      scratchpadDir: options?.scratchpadDir,
      timeoutMs: options?.timeoutMs ?? this.options.timeoutMs,
      priority: options?.priority ?? "medium",
    };
  }

  /**
   * 批量创建任务（Claude Code 风格的并行任务）
   */
  createTasks(directives: string[]): CoordinatorTaskConfig[] {
    return directives.map((directive, index) =>
      this.createTask(directive, { taskId: `task-${index}` }),
    );
  }

  /**
   * 启动所有任务
   */
  async runAll(
    parentSessionKey: string,
    configs: CoordinatorTaskConfig[],
  ): Promise<CoordinatorTask[]> {
    if (this.running) {
      throw new Error("Coordinator is already running");
    }

    this.running = true;

    // 创建任务记录
    for (const config of configs) {
      const task: CoordinatorTask = {
        id: config.taskId,
        config,
        status: "pending",
        attempt: 0,
      };
      this.tasks.set(config.taskId, task);
      this.simpleCoordinator.addTask(config.taskId, config.directive);
    }

    // 执行所有任务
    const promises = configs.map((config) => this.executeTask(parentSessionKey, config));

    await Promise.allSettled(promises);

    return Array.from(this.tasks.values());
  }

  /**
   * 执行单个任务（带重试）
   */
  private async executeTask(
    parentSessionKey: string,
    config: CoordinatorTaskConfig,
  ): Promise<void> {
    const task = this.tasks.get(config.taskId);
    if (!task) {
      return;
    }

    task.status = "running";
    task.startedAt = Date.now();

    let lastError: string | undefined;

    for (let attempt = 0; attempt <= this.options.maxRetries; attempt++) {
      task.attempt = attempt;

      try {
        const result = await this.spawnAgent(parentSessionKey, config);

        if (result.success && result.output) {
          task.status = "completed";
          task.result = result.output;
          task.completedAt = Date.now();

          // 更新 SimpleCoordinator
          this.simpleCoordinator.updateTaskStatus(
            config.taskId,
            "completed",
            result.output,
            undefined,
            { durationMs: result.durationMs },
          );
          return;
        } else {
          lastError = result.error ?? "Unknown error";
          if (attempt < this.options.maxRetries && this.options.autoRetry) {
            task.status = "retrying";
            await this.delay(1000 * (attempt + 1)); // 指数退避
          }
        }
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        if (attempt < this.options.maxRetries && this.options.autoRetry) {
          task.status = "retrying";
          await this.delay(1000 * (attempt + 1));
        }
      }
    }

    // 所有重试失败
    task.status = "failed";
    task.error = lastError ?? "Max retries exceeded";
    task.completedAt = Date.now();

    this.simpleCoordinator.updateTaskStatus(config.taskId, "failed", undefined, task.error);
  }

  /**
   * 适配层：CoordinatorTaskConfig → ForkSpawnContext
   */
  private async spawnAgent(
    parentSessionKey: string,
    config: CoordinatorTaskConfig,
  ): Promise<ForkSpawnResult> {
    // 构建工具上下文（简化版，Claude Code 有更复杂的工具解析）
    const taskContext = config.taskContext
      ? `Context: ${config.taskContext}\n\nAllowed tools: ${config.tools?.join(", ") ?? "all"}`
      : `Allowed tools: ${config.tools?.join(", ") ?? "all"}`;

    // 构建 assistantMessage（fork 会使用隔离消息覆盖此内容）
    const assistantMessage: import("@mariozechner/pi-agent-core").AgentMessage = {
      role: "assistant",
      content: [],
    } as unknown as import("@mariozechner/pi-agent-core").AgentMessage;

    const spawnContext: ForkSpawnContext = {
      parentSessionKey,
      assistantMessage,
      taskId: config.taskId,
      directive: config.directive,
      taskContext,
      scratchpadDir: config.scratchpadDir,
      timeoutMs: config.timeoutMs,
      priority: config.priority,
      announceOnComplete: false, // Coordinator 自己管理通知
    };

    return await spawnForkSubagent(spawnContext);
  }

  private handleTaskComplete(_task: import("../fork/simple-coordinator.js").TaskInfo): void {
    // 可以在这里添加钩子
  }

  private handleAllComplete(): void {
    this.running = false;
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // ============================================================================
  // 查询接口
  // ============================================================================

  getTask(id: string): CoordinatorTask | undefined {
    return this.tasks.get(id);
  }

  getAllTasks(): CoordinatorTask[] {
    return Array.from(this.tasks.values());
  }

  getCompletedTasks(): CoordinatorTask[] {
    return this.getAllTasks().filter((t) => t.status === "completed");
  }

  getFailedTasks(): CoordinatorTask[] {
    return this.getAllTasks().filter((t) => t.status === "failed");
  }

  isRunning(): boolean {
    return this.running;
  }

  /**
   * 合成最终结果（Claude Code 风格）
   */
  synthesizeResults(): string {
    const simpleResult = this.simpleCoordinator.synthesizeResults();
    const stats = this.getStats();

    return [
      "# Coordinator Execution Report",
      "",
      `**Tasks**: ${stats.total} total, ${stats.completed} completed, ${stats.failed} failed`,
      `**Duration**: ${(stats.totalDurationMs / 1000).toFixed(1)}s`,
      `**Tokens**: ${stats.totalTokens.toLocaleString()}`,
      "",
      simpleResult,
    ].join("\n");
  }

  getStats() {
    const tasks = this.getAllTasks();
    const completed = tasks.filter((t) => t.status === "completed");

    return {
      total: tasks.length,
      pending: tasks.filter((t) => t.status === "pending").length,
      running: tasks.filter((t) => t.status === "running").length,
      completed: completed.length,
      failed: tasks.filter((t) => t.status === "failed").length,
      totalDurationMs: completed.reduce(
        (sum, t) => sum + ((t.completedAt ?? 0) - (t.startedAt ?? 0)),
        0,
      ),
      totalTokens: completed.reduce(
        (sum, t) => sum + (t.tokenUsage ? t.tokenUsage.input + t.tokenUsage.output : 0),
        0,
      ),
    };
  }
}

/**
 * 创建 Coordinator 的工厂函数（Claude Code 风格）
 */
export function createCoordinator(options?: Partial<FullCoordinatorOptions>): FullCoordinator {
  return new FullCoordinator(options);
}

/**
 * 检查是否应该使用 Coordinator 模式（Claude Code 风格）
 */
export function shouldUseCoordinatorMode(
  taskCount: number,
  options?: { threshold?: number },
): boolean {
  const threshold = options?.threshold ?? 2;
  return taskCount >= threshold;
}
