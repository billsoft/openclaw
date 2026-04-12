/**
 * 简化的 Coordinator 状态机
 *
 * 设计原则：
 * 1. 基于 fork 模式，不创建新 Gateway 连接
 * 2. 使用内部事件系统（queueEmbeddedPiMessage）
 * 3. 轮询等待任务完成，而非复杂状态机
 */

import {
  parseAgentResult,
  type ParsedAgentResult,
  synthesizeAgentResults,
} from "./agent-result-parser.js";

export interface TaskInfo {
  taskId: string;
  directive: string;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  result?: ParsedAgentResult;
  rawOutput?: string;
  error?: string;
  forkId?: string;
  startedAt: number;
  completedAt?: number;
  durationMs?: number;
  tokenUsage?: { input: number; output: number };
}

export interface CoordinatorOptions {
  maxConcurrent: number;
  timeoutMs: number;
  onTaskComplete?: (task: TaskInfo) => void;
  onAllComplete?: (tasks: TaskInfo[]) => void;
}

/**
 * 简化的 Coordinator - 管理多个 fork 任务
 *
 * 不同于 Claude Code 的复杂状态机，我们使用简单的轮询模型：
 * 1. 启动所有 fork 任务（受 maxConcurrent 限制）
 * 2. 等待内部事件通知
 * 3. 合成最终结果
 */
export class SimpleCoordinator {
  private tasks = new Map<string, TaskInfo>();
  private options: CoordinatorOptions;

  constructor(options: Partial<CoordinatorOptions> = {}) {
    this.options = {
      maxConcurrent: options.maxConcurrent ?? 5,
      timeoutMs: options.timeoutMs ?? 300_000,
      onTaskComplete: options.onTaskComplete,
      onAllComplete: options.onAllComplete,
    };
  }

  /**
   * 添加任务到协调器
   */
  addTask(taskId: string, directive: string): void {
    this.tasks.set(taskId, {
      taskId,
      directive,
      status: "pending",
      startedAt: Date.now(),
    });
  }

  /**
   * 批量添加任务
   */
  addTasks(tasks: Array<{ taskId: string; directive: string }>): void {
    for (const { taskId, directive } of tasks) {
      this.addTask(taskId, directive);
    }
  }

  /**
   * 更新任务状态
   */
  updateTaskStatus(
    taskId: string,
    status: TaskInfo["status"],
    output?: string,
    error?: string,
    metadata?: {
      durationMs?: number;
      tokenUsage?: { input: number; output: number };
    },
  ): void {
    const task = this.tasks.get(taskId);
    if (!task) {
      return;
    }

    task.status = status;
    task.completedAt = Date.now();

    if (output && status === "completed") {
      task.rawOutput = output;
      task.result = parseAgentResult(output);
    }

    if (error) {
      task.error = error;
    }

    if (metadata) {
      task.durationMs = metadata.durationMs;
      task.tokenUsage = metadata.tokenUsage;
    }

    this.options.onTaskComplete?.(task);

    // 检查是否所有任务完成
    if (this.allTasksComplete()) {
      this.options.onAllComplete?.(Array.from(this.tasks.values()));
    }
  }

  /**
   * 获取任务信息
   */
  getTask(taskId: string): TaskInfo | undefined {
    return this.tasks.get(taskId);
  }

  /**
   * 获取所有任务
   */
  getAllTasks(): TaskInfo[] {
    return Array.from(this.tasks.values());
  }

  /**
   * 获取未完成的任务
   */
  getPendingTasks(): TaskInfo[] {
    return this.getAllTasks().filter(
      (t) => t.status === "pending" || t.status === "running",
    );
  }

  /**
   * 获取已完成的任务
   */
  getCompletedTasks(): TaskInfo[] {
    return this.getAllTasks().filter((t) => t.status === "completed");
  }

  /**
   * 获取失败的任务
   */
  getFailedTasks(): TaskInfo[] {
    return this.getAllTasks().filter(
      (t) => t.status === "failed" || t.status === "cancelled",
    );
  }

  /**
   * 检查是否所有任务完成
   */
  allTasksComplete(): boolean {
    return this.getAllTasks().every(
      (t) =>
        t.status === "completed" ||
        t.status === "failed" ||
        t.status === "cancelled",
    );
  }

  /**
   * 计算总体统计数据
   */
  getStats(): {
    total: number;
    pending: number;
    running: number;
    completed: number;
    failed: number;
    totalDurationMs: number;
    totalTokens: number;
  } {
    const tasks = this.getAllTasks();
    const completed = tasks.filter((t) => t.status === "completed");

    return {
      total: tasks.length,
      pending: tasks.filter((t) => t.status === "pending").length,
      running: tasks.filter((t) => t.status === "running").length,
      completed: completed.length,
      failed: tasks.filter(
        (t) => t.status === "failed" || t.status === "cancelled",
      ).length,
      totalDurationMs: completed.reduce(
        (sum, t) => sum + (t.durationMs ?? 0),
        0,
      ),
      totalTokens: completed.reduce((sum, t) => {
        const tokens = t.tokenUsage;
        return sum + (tokens ? tokens.input + tokens.output : 0);
      }, 0),
    };
  }

  /**
   * 合成最终结果报告
   */
  synthesizeResults(): string {
    const tasks = this.getAllTasks();
    const results = tasks.map((t) => ({
      taskId: t.taskId,
      result: t.result ?? {
        scope: "",
        result: t.error ?? "No result",
        keyFiles: [],
        filesChanged: [],
        issues: [],
      },
      status: t.status,
    }));

    return synthesizeAgentResults(results);
  }

  /**
   * 生成任务执行摘要（用于快速查看）
   */
  generateSummary(): string {
    const stats = this.getStats();
    const parts: string[] = [];

    parts.push("## Coordinator Summary");
    parts.push("");
    parts.push(`Total Tasks: ${stats.total}`);
    parts.push(
      `- Pending: ${stats.pending}, Running: ${stats.running}, Completed: ${stats.completed}, Failed: ${stats.failed}`,
    );

    if (stats.completed > 0) {
      parts.push(
        `- Total Duration: ${(stats.totalDurationMs / 1000).toFixed(1)}s`,
      );
      parts.push(`- Total Tokens: ${stats.totalTokens.toLocaleString()}`);
    }

    // 显示完成的任务
    const completed = this.getCompletedTasks();
    if (completed.length > 0) {
      parts.push("");
      parts.push("### Completed Tasks");
      for (const task of completed) {
        const duration = task.durationMs
          ? ` (${(task.durationMs / 1000).toFixed(1)}s)`
          : "";
        const scope = task.result?.scope
          ? `: ${task.result.scope.slice(0, 60)}${task.result.scope.length > 60 ? "..." : ""}`
          : "";
        parts.push(`- ${task.taskId}${duration}${scope}`);
      }
    }

    // 显示失败的任务
    const failed = this.getFailedTasks();
    if (failed.length > 0) {
      parts.push("");
      parts.push("### Failed Tasks");
      for (const task of failed) {
        const error = task.error
          ? `: ${task.error.slice(0, 60)}${task.error.length > 60 ? "..." : ""}`
          : "";
        parts.push(`- ${task.taskId}${error}`);
      }
    }

    return parts.join("\n");
  }

  /**
   * 清理所有任务
   */
  clear(): void {
    this.tasks.clear();
  }

  /**
   * 导出任务状态（用于持久化）
   */
  exportState(): {
    tasks: TaskInfo[];
    timestamp: number;
  } {
    return {
      tasks: this.getAllTasks(),
      timestamp: Date.now(),
    };
  }

  /**
   * 导入任务状态（用于恢复）
   */
  importState(state: { tasks: TaskInfo[] }): void {
    this.tasks.clear();
    for (const task of state.tasks) {
      this.tasks.set(task.taskId, task);
    }
  }
}

/**
 * 创建 Coordinator 的工厂函数
 */
export function createCoordinator(
  options?: Partial<CoordinatorOptions>,
): SimpleCoordinator {
  return new SimpleCoordinator(options);
}
