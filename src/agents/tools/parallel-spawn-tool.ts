import { Type } from "@sinclair/typebox";
import { executeParallelTasks } from "../subagent-parallel.js";
import type {
  ParallelMergeResult,
  ParallelSpawnConfig,
  ParallelTaskDecomposition,
} from "../subagent-parallel.js";
import type { SubagentRunOutcome } from "../subagent-registry.types.js";
import { spawnSubagentDirect } from "../subagent-spawn.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readNumberParam, readStringParam } from "./common.js";

const PARALLEL_SPAWN_TOOL_DISPLAY_SUMMARY =
  "Execute multiple sub-agents in parallel with automatic result merging";

function describeParallelSpawnTool(): string {
  return [
    "Decompose a complex task into multiple sub-tasks,",
    "execute them in parallel, and merge the results.",
    "",
    "Use this when:",
    "- A task can be naturally split into independent parts (e.g., analyze files A, B, C in parallel)",
    "- You need to speed up multi-step workflows by running steps concurrently",
    "- You want to compare results from different approaches simultaneously",
    "",
    "The tool handles concurrency limiting, dependency ordering, timeout control, and result merging.",
  ].join("\n");
}

const ParallelSpawnToolSchema = Type.Object({
  tasks: Type.Array(
    Type.Object({
      id: Type.String(),
      description: Type.Optional(Type.String()),
      task: Type.String({ minLength: 1 }),
      model: Type.Optional(Type.String()),
      thinking: Type.Optional(Type.String()),
      priority: Type.Optional(
        Type.Union([Type.Literal("high"), Type.Literal("medium"), Type.Literal("low")]),
      ),
      dependencies: Type.Optional(Type.Array(Type.String())),
      expectedOutputFormat: Type.Optional(
        Type.Union([
          Type.Literal("text"),
          Type.Literal("json"),
          Type.Literal("code"),
          Type.Literal("diff"),
        ]),
      ),
    }),
    { minItems: 1 },
  ),
  config: Type.Optional(
    Type.Object({
      maxConcurrency: Type.Optional(Type.Number({ minimum: 1, maximum: 5 })),
      mergeStrategy: Type.Optional(
        Type.Union([
          Type.Literal("concatenate"),
          Type.Literal("structured"),
          Type.Literal("llm-summary"),
        ]),
      ),
      failFast: Type.Optional(Type.Boolean()),
      timeoutPerTaskMs: Type.Optional(Type.Number({ minimum: 5000 })),
      totalTimeoutMs: Type.Optional(Type.Number({ minimum: 10000 })),
      sharedContext: Type.Optional(Type.String()),
      lightContext: Type.Optional(Type.Boolean()),
    }),
  ),
});

type SpawnedToolContext = {
  agentSessionKey?: string;
  agentChannel?: string;
  agentAccountId?: string;
  agentTo?: string;
  agentThreadId?: string | number;
  agentGroupId?: string | null;
  agentGroupChannel?: string | null;
  agentGroupSpace?: string | null;
  sandboxed?: boolean;
  requesterAgentIdOverride?: string;
  workspaceDir?: string;
};

export function createParallelSpawnTool(opts?: SpawnedToolContext): AnyAgentTool {
  return {
    label: "Parallel Spawn",
    name: "parallel_spawn",
    displaySummary: PARALLEL_SPAWN_TOOL_DISPLAY_SUMMARY,
    description: describeParallelSpawnTool(),
    parameters: ParallelSpawnToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const rawTasks = params.tasks as Array<Record<string, unknown>>;

      if (!Array.isArray(rawTasks) || rawTasks.length === 0) {
        return jsonResult({
          status: "error",
          error: "tasks must be a non-empty array of task objects.",
        });
      }

      if (rawTasks.length > 5) {
        return jsonResult({
          status: "error",
          error: "Maximum 5 parallel tasks allowed per invocation.",
        });
      }

      const tasks: ParallelTaskDecomposition[] = rawTasks.map((t, idx) => ({
        id: readStringParam(t, "id") ?? `task-${idx + 1}`,
        description: readStringParam(t, "description") ?? "",
        task: readStringParam(t, "task", { required: true }),
        model: readStringParam(t, "model"),
        thinking: readStringParam(t, "thinking"),
        priority:
          t.priority === "high" || t.priority === "medium" || t.priority === "low"
            ? t.priority
            : "medium",
        dependencies: Array.isArray(t.dependencies) ? (t.dependencies as string[]) : [],
        expectedOutputFormat:
          t.expectedOutputFormat === "text" ||
          t.expectedOutputFormat === "json" ||
          t.expectedOutputFormat === "code" ||
          t.expectedOutputFormat === "diff"
            ? t.expectedOutputFormat
            : "text",
      }));

      const rawConfig = params.config as Record<string, unknown> | undefined;
      const config: ParallelSpawnConfig & {
        spawnFn: (task: ParallelTaskDecomposition) => Promise<{
          runId: string;
          outcome?: SubagentRunOutcome;
          error?: string;
        }>;
      } = {
        maxConcurrency: Math.min(readNumberParam(rawConfig ?? {}, "maxConcurrency") ?? 3, 5),
        mergeStrategy: (rawConfig?.mergeStrategy === "concatenate" ||
        rawConfig?.mergeStrategy === "structured" ||
        rawConfig?.mergeStrategy === "llm-summary"
          ? rawConfig.mergeStrategy
          : "concatenate") as MergeStrategy,
        failFast: rawConfig?.failFast === true,
        timeoutPerTaskMs: readNumberParam(rawConfig ?? {}, "timeoutPerTaskMs"),
        totalTimeoutMs: readNumberParam(rawConfig ?? {}, "totalTimeoutMs"),
        sharedContext: readStringParam(rawConfig ?? {}, "sharedContext"),
        lightContext: rawConfig?.lightContext === true,

        spawnFn: async (task) => {
          try {
            const result = await spawnSubagentDirect(
              {
                task: task.task,
                label: `[P] ${task.id}`,
                model: task.model,
                thinking: task.thinking,
                mode: "run",
                cleanup: "delete",
                sandbox: opts?.sandboxed === true ? "require" : "inherit",
                lightContext: config.lightContext,
                expectsCompletionMessage: true,
              },
              {
                agentSessionKey: opts?.agentSessionKey,
                agentChannel: opts?.agentChannel,
                agentAccountId: opts?.agentAccountId,
                agentTo: opts?.agentTo,
                agentThreadId: opts?.agentThreadId,
                agentGroupId: opts?.agentGroupId,
                agentGroupChannel: opts?.agentGroupChannel,
                agentGroupSpace: opts?.agentGroupSpace,
                requesterAgentIdOverride: opts?.requesterAgentIdOverride,
                workspaceDir: opts?.workspaceDir,
              },
            );

            const outcome = (result as Record<string, unknown>).outcome as
              | SubagentRunOutcome
              | undefined;

            return {
              runId: ((result as Record<string, unknown>).runId as string) ?? "",
              outcome,
              error: undefined,
            };
          } catch (error) {
            return {
              runId: "",
              outcome: undefined,
              error: String(error),
            };
          }
        },
      };

      try {
        const mergeResult: ParallelMergeResult = await executeParallelTasks(tasks, config);

        return jsonResult({
          status: "ok",
          summary: mergeResult.summary,
          mergedContent:
            mergeResult.mergedContent.slice(0, 8000) +
            (mergeResult.mergedContent.length > 8000 ? "\n...[truncated]" : ""),
          structuredResults: mergeResult.structuredResults,
          taskCount: tasks.length,
          completedCount: mergeResult.taskResults.filter((r) => r.status === "completed").length,
          failedCount: mergeResult.taskResults.filter((r) => r.status !== "completed").length,
          totalDurationMs: mergeResult.totalDurationMs,
          savingsEstimate: mergeResult.savingsEstimate,
          taskDetails: mergeResult.taskResults.map((r) => ({
            taskId: r.taskId,
            status: r.status,
            durationMs: r.durationMs,
            error: r.error,
          })),
        });
      } catch (error) {
        return jsonResult({
          status: "error",
          error: `Parallel execution failed: ${String(error)}`,
        });
      }
    },
  };
}

type MergeStrategy = "concatenate" | "structured" | "llm-summary";
