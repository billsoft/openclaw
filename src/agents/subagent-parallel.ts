import { logDebug, logWarn } from "../logger.js";
import type { SubagentRunOutcome } from "./subagent-registry.types.js";

export type ParallelTaskDecomposition = {
  id: string;
  description: string;
  task: string;
  model?: string;
  thinking?: string;
  priority: "high" | "medium" | "low";
  dependencies: string[];
  expectedOutputFormat: "text" | "json" | "code" | "diff";
};

export type MergeStrategy = "concatenate" | "structured" | "llm-summary";

export type ParallelSpawnConfig = {
  maxConcurrency?: number;
  mergeStrategy?: MergeStrategy;
  failFast?: boolean;
  timeoutPerTaskMs?: number;
  totalTimeoutMs?: number;
  sharedContext?: string;
  lightContext?: boolean;
};

export type ParallelExecutionResult = {
  taskId: string;
  status: "completed" | "failed" | "timeout" | "cancelled";
  result?: SubagentRunOutcome;
  error?: string;
  durationMs: number;
  outputTokens?: number;
};

export type ParallelMergeResult = {
  mergedContent: string;
  structuredResults: Record<string, unknown>;
  summary: string;
  taskResults: ParallelExecutionResult[];
  totalDurationMs: number;
  savingsEstimate: {
    sequentialMs: number;
    parallelMs: number;
    speedup: number;
  };
};

const DEFAULT_MAX_CONCURRENCY = 3;
const DEFAULT_TASK_TIMEOUT_MS = 300_000;

function topologicalSort(tasks: ParallelTaskDecomposition[]): ParallelTaskDecomposition[] {
  const taskMap = new Map(tasks.map((t) => [t.id, t]));
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const sorted: ParallelTaskDecomposition[] = [];

  function visit(id: string) {
    if (visited.has(id)) {
      return;
    }
    if (visiting.has(id)) {
      logWarn(`parallel-spawn: circular dependency detected at ${id}`);
      return;
    }
    visiting.add(id);
    const task = taskMap.get(id);
    if (!task) {
      return;
    }
    for (const dep of task.dependencies) {
      visit(dep);
    }
    visiting.delete(id);
    visited.add(id);
    sorted.push(task);
  }

  for (const task of tasks) {
    visit(task.id);
  }

  return sorted;
}

async function executeSingleTask(
  spawnFn: (
    task: ParallelTaskDecomposition,
  ) => Promise<{ runId: string; outcome?: SubagentRunOutcome; error?: string }>,
  task: ParallelTaskDecomposition,
  config: ParallelSpawnConfig,
  signal?: AbortSignal,
): Promise<ParallelExecutionResult> {
  const startTime = Date.now();

  if (signal?.aborted) {
    return {
      taskId: task.id,
      status: "cancelled",
      durationMs: Date.now() - startTime,
    };
  }

  const timeout = config.timeoutPerTaskMs ?? DEFAULT_TASK_TIMEOUT_MS;

  try {
    const racePromise = Promise.race([
      spawnFn(task),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), timeout)),
    ]);

    const result = await racePromise;

    if (signal?.aborted) {
      return {
        taskId: task.id,
        status: "cancelled",
        result: result.outcome,
        durationMs: Date.now() - startTime,
      };
    }

    return {
      taskId: task.id,
      status: "completed",
      result: result.outcome,
      durationMs: Date.now() - startTime,
    };
  } catch (error) {
    const errorMsg = String(error);
    if (errorMsg.includes("timeout")) {
      return {
        taskId: task.id,
        status: "timeout",
        error: `Task timed out after ${timeout}ms`,
        durationMs: Date.now() - startTime,
      };
    }

    return {
      taskId: task.id,
      status: "failed",
      error: errorMsg,
      durationMs: Date.now() - startTime,
    };
  }
}

function buildMergeContent(
  results: ParallelExecutionResult[],
  strategy: MergeStrategy,
): { content: string; structured: Record<string, unknown>; summary: string } {
  switch (strategy) {
    case "concatenate": {
      const sections = results
        .filter((r) => r.status === "completed" && r.result)
        .map((r) => {
          const outcome = r.result!;
          return `[Task ${r.taskId}] (${r.durationMs}ms)\n${JSON.stringify(outcome).slice(0, 2000)}`;
        });

      const failed = results
        .filter((r) => r.status !== "completed")
        .map((r) => `[Task ${r.taskId}] FAILED: ${r.status} — ${r.error}`);

      const allSections = [...sections, ...failed];
      return {
        content: allSections.join("\n\n---\n\n"),
        structured: Object.fromEntries(
          results.map((r) => [r.taskId, r.result ?? { error: r.error }]),
        ),
        summary: `${results.filter((r) => r.status === "completed").length}/${results.length} tasks completed`,
      };
    }

    case "structured": {
      const structured: Record<string, unknown> = {};
      for (const r of results) {
        structured[r.taskId] =
          r.status === "completed" ? r.result : { _status: r.status, _error: r.error };
      }
      return {
        content: JSON.stringify(structured, null, 2),
        structured,
        summary: `Structured merge: ${results.length} tasks, ${
          results.filter((r) => r.status === "completed").length
        } succeeded`,
      };
    }

    case "llm-summary": {
      // "llm-summary" falls back to concatenate — the parent agent (LLM) that
      // called parallel_spawn will synthesize the results naturally from the
      // concatenated output without a separate LLM call overhead.
      const completed = results.filter((r) => r.status === "completed");
      const sections = completed.map((r) => {
        const outcome = r.result!;
        return `[Task ${r.taskId}] (${r.durationMs}ms)\n${JSON.stringify(outcome).slice(0, 2000)}`;
      });
      const failed = results
        .filter((r) => r.status !== "completed")
        .map((r) => `[Task ${r.taskId}] ${r.status.toUpperCase()}: ${r.error}`);
      return {
        content: [...sections, ...failed].join("\n\n---\n\n"),
        structured: Object.fromEntries(
          results.map((r) => [r.taskId, r.result ?? { error: r.error }]),
        ),
        summary: `${completed.length}/${results.length} tasks completed`,
      };
    }

    default:
      return {
        content: "",
        structured: {},
        summary: "",
      };
  }
}

export async function executeParallelTasks(
  tasks: ParallelTaskDecomposition[],
  config: ParallelSpawnConfig & {
    spawnFn: (task: ParallelTaskDecomposition) => Promise<{
      runId: string;
      outcome?: SubagentRunOutcome;
      error?: string;
    }>;
  },
): Promise<ParallelMergeResult> {
  const overallStart = Date.now();
  const sortedTasks = topologicalSort(tasks);

  const maxConcurrency = Math.min(config.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY, 5);

  const abortController = new AbortController();

  let totalTimeoutTimer: ReturnType<typeof setTimeout> | undefined;
  if (config.totalTimeoutMs) {
    totalTimeoutTimer = setTimeout(() => {
      abortController.abort();
    }, config.totalTimeoutMs);
  }

  const completedResults = new Map<string, ParallelExecutionResult>();

  // Semaphore: serialize task launches so concurrency limit is enforced even
  // when all tasks are started simultaneously via Promise.all.
  // Each task chains onto the previous "slot" promise, releasing it when done.
  let semaphoreSlots: Promise<void>[] = Array.from({ length: maxConcurrency }, () =>
    Promise.resolve(),
  );
  let slotIndex = 0;

  async function runWithConcurrencyLimit(task: ParallelTaskDecomposition): Promise<void> {
    // Acquire a slot: wait until the oldest slot is free, then claim it.
    const slot = slotIndex++ % maxConcurrency;
    const acquired = semaphoreSlots[slot]!.then(async () => {
      const depMissing = task.dependencies.find((dep) => !completedResults.has(dep));
      if (depMissing) {
        completedResults.set(task.id, {
          taskId: task.id,
          status: "failed",
          error: `Dependency "${depMissing}" not satisfied`,
          durationMs: 0,
        });
        return;
      }

      const result = await executeSingleTask(
        config.spawnFn,
        task,
        config,
        abortController.signal,
      );
      completedResults.set(task.id, result);
      if (config.failFast && result.status !== "completed") {
        abortController.abort();
      }
    });

    // Replace the slot with this task's completion so the next task waits for it.
    semaphoreSlots[slot] = acquired.catch(() => {});
    await acquired;
  }

  await Promise.all(sortedTasks.map(runWithConcurrencyLimit));

  if (totalTimeoutTimer) {
    clearTimeout(totalTimeoutTimer);
  }

  const taskResults = Array.from(completedResults.values()).toSorted((a, b) =>
    a.taskId.localeCompare(b.taskId),
  );

  const totalDuration = Date.now() - overallStart;
  const sequentialEstimate = taskResults.reduce((sum, r) => sum + r.durationMs, 0);
  const speedup =
    sequentialEstimate > 0 ? Math.round((sequentialEstimate / totalDuration) * 100) / 100 : 1;

  const merged = buildMergeContent(taskResults, config.mergeStrategy ?? "concatenate");

  logDebug(
    `parallel-spawn: ${tasks.length} tasks, ${taskResults.filter((r) => r.status === "completed").length} completed, speedup=${speedup}x`,
  );

  return {
    mergedContent: merged.content,
    structuredResults: merged.structured,
    summary: merged.summary,
    taskResults,
    totalDurationMs: totalDuration,
    savingsEstimate: {
      sequentialMs: sequentialEstimate,
      parallelMs: totalDuration,
      speedup,
    },
  };
}
