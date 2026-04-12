import { Type } from "@sinclair/typebox";
import { isForkSubagentEnabled, spawnForkSubagents, parseForkOutput } from "../fork/index.js";
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
  "Execute multiple sub-agents in parallel with automatic result merging (fork mode by default)";

function describeParallelSpawnTool(): string {
  return [
    "Decompose a complex task into multiple sub-tasks,",
    "execute them in parallel, and merge the results.",
    "",
    "**Execution Mode (auto-selected):**",
    "- Fork mode (default, in-process): Bypasses Gateway pairing, uses prompt cache sharing via parent history cloning.",
    "- Legacy subagent mode (fallback): Uses Gateway RPC with announce-based result delivery.",
    "",
    "⚠️ WARNING FOR COORDINATOR MODE ⚠️",
    "This tool is SYNCHRONOUS and BLOCKING. If you use it, you will hang and be unable to speak to the user until all tasks finish.",
    "For complex orchestration, DO NOT use this tool. Instead, call `sessions_spawn` multiple times in parallel to spawn fully async workers.",
    "ONLY use this tool for trivial, fast, read-only batch queries where you absolutely must have the merged results immediately in a single turn.",
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
      useFork: Type.Optional(Type.Boolean()),
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
  scratchpadDir?: string;
};

export function createParallelSpawnTool(opts?: SpawnedToolContext): AnyAgentTool {
  return {
    label: "Parallel Spawn",
    name: "parallel_spawn",
    displaySummary: PARALLEL_SPAWN_TOOL_DISPLAY_SUMMARY,
    description: describeParallelSpawnTool(),
    parameters: ParallelSpawnToolSchema,
    execute: async (_toolCallId: string, args: unknown) => {
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
      const maxConcurrency = Math.min(readNumberParam(rawConfig ?? {}, "maxConcurrency") ?? 3, 5);

      const forceUseFork = rawConfig?.useFork === true;
      const forkAvailable = isForkSubagentEnabled();

      if ((forceUseFork || (!forceUseFork && forkAvailable)) && opts?.agentSessionKey) {
        try {
          return await executeViaFork(tasks, rawConfig, opts);
        } catch (forkError) {
          if (forceUseFork) {
            return jsonResult({
              status: "error",
              error: `Fork execution failed: ${String(forkError)}`,
            });
          }
        }
      }

      const config: ParallelSpawnConfig & {
        spawnFn: (
          task: ParallelTaskDecomposition,
          isolatedContext: import("../subagent-isolation.js").IsolatedSpawnContext,
        ) => Promise<{
          runId: string;
          outcome?: SubagentRunOutcome;
          error?: string;
        }>;
      } = {
        maxConcurrency,
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

        spawnFn: async (task, isolatedContext) => {
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
                scratchpadDir: isolatedContext.taskScratchDir ?? opts?.scratchpadDir,
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
          executionMode: "legacy-subagent",
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

async function executeViaFork(
  tasks: ParallelTaskDecomposition[],
  rawConfig: Record<string, unknown> | undefined,
  opts: SpawnedToolContext,
) {
  const timeoutPerTaskMs = readNumberParam(rawConfig ?? {}, "timeoutPerTaskMs");
  const sharedContext = readStringParam(rawConfig ?? {}, "sharedContext");

  const forkCtxs = tasks.map((task) => ({
    parentSessionKey: opts.agentSessionKey!,
    assistantMessage: {
      role: "assistant" as const,
      content: [],
    } as unknown as import("@mariozechner/pi-agent-core").AgentMessage,
    taskId: task.id,
    directive: task.task,
    taskContext: sharedContext ?? undefined,
    scratchpadDir: opts.scratchpadDir,
    workspaceDir: opts.workspaceDir,
    depth: 0,
    model: task.model,
    thinking: task.thinking,
    priority:
      task.priority === "high" || task.priority === "medium" || task.priority === "low"
        ? task.priority
        : ("medium" as const),
    timeoutMs: timeoutPerTaskMs,
    announceOnComplete: false,
  }));

  const results = await spawnForkSubagents(forkCtxs);

  const completed = results.filter((r: { success: boolean }) => r.success);
  const failed = results.filter((r: { success: boolean }) => !r.success);

  const structuredResults = results.map(
    (r: {
      taskId?: string;
      output?: string;
      status?: string;
      durationMs?: number;
      error?: string;
    }) => ({
      taskId: r.taskId ?? "unknown",
      output: r.output ? parseForkOutput(r.output) : undefined,
      rawOutput: r.output,
      status: r.status ?? "failed",
      durationMs: r.durationMs,
      error: r.error,
    }),
  );

  const mergedParts = completed
    .map((r: { taskId?: string; output?: string }) => `[${r.taskId}]\n${r.output ?? "(no output)"}`)
    .join("\n\n---\n\n");

  return jsonResult({
    status: "ok",
    executionMode: "fork",
    summary: `${completed.length}/${tasks.length} tasks completed via fork mode`,
    mergedContent:
      mergedParts.slice(0, 8000) + (mergedParts.length > 8000 ? "\n...[truncated]" : ""),
    structuredResults,
    taskCount: tasks.length,
    completedCount: completed.length,
    failedCount: failed.length,
    taskDetails: results.map(
      (r: {
        taskId?: string;
        status?: string;
        durationMs?: number;
        announced?: boolean;
        error?: string;
      }) => ({
        taskId: r.taskId,
        status: r.status,
        durationMs: r.durationMs,
        announced: r.announced,
        error: r.error,
      }),
    ),
  });
}

type MergeStrategy = "concatenate" | "structured" | "llm-summary";
