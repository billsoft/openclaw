/**
 * Unified `agent` tool — aligned to claude-code's Agent tool design.
 *
 * Replaces `parallel_spawn` and serves as the primary multi-agent entry point.
 * `sessions_spawn` is kept for backward compat (existing callers, ACP, thread mode)
 * but new coordinator prompts should use `agent`.
 *
 * Execution model:
 *   run_in_background: true  (default) — fire-and-forget fork; returns immediately,
 *                                        result delivered via <task-notification> XML.
 *   run_in_background: false           — blocking fork; waits for result inline.
 *                                        Max 5 tasks per call (synchronous array).
 *
 * Fork recursion guard: fork children cannot spawn nested agents.
 */

import { Type } from "@sinclair/typebox";
import {
  isForkExecutionActive,
  isForkSubagentEnabled,
  spawnForkSubagent,
  spawnForkSubagents,
  SimpleCoordinator,
  parseAgentResult,
  type ForkSpawnContext,
} from "../fork/index.js";
import type { SpawnedToolContext as BaseSpawnedToolContext } from "../spawned-context.js";
import type { AnyAgentTool } from "./common.js";

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
} & BaseSpawnedToolContext;
import { AGENT_TOOL_DISPLAY_SUMMARY } from "../tool-description-presets.js";
import { jsonResult, readNumberParam, readStringParam } from "./common.js";

function describeAgentTool(): string {
  return [
    "Spawn one or more isolated agent tasks using fork mode (in-process, no Gateway pairing required).",
    "",
    "**run_in_background: true** (default for single task)",
    "Fire-and-forget. Returns immediately with an accepted status.",
    "The worker executes in parallel and delivers results back automatically as a <task-notification> XML event.",
    "To launch multiple async workers, call `agent` multiple times in a single message.",
    "",
    "**run_in_background: false** (synchronous, for tasks array only)",
    "Blocks until all tasks complete and returns results inline.",
    "ONLY use for trivial, fast, read-only queries where you need results immediately in one turn.",
    "Maximum 5 tasks per call.",
    "",
    "**Fork recursion guard**: Workers running inside a fork CANNOT spawn nested agents.",
    "Execute tasks directly with your tools instead.",
    "",
    "**Task scope**: Each worker receives only its own self-contained prompt.",
    "Workers do NOT see your conversation history.",
    "Write complete, specific prompts with file paths, line numbers, and exact scope.",
    "",
    "**Notification format**: When a background worker completes, you will receive:",
    "```",
    "<task-notification>",
    "  <task-id>...</task-id>",
    "  <status>completed|failed|timeout</status>",
    "  <summary>...</summary>",
    "  <result>worker output</result>",
    "  <usage><total_tokens>N</total_tokens><duration_ms>N</duration_ms></usage>",
    "</task-notification>",
    "```",
  ].join("\n");
}

const AgentToolSchema = Type.Object({
  description: Type.String({
    description: "Short (3-5 word) description of this task for tracking purposes.",
  }),
  prompt: Type.String({
    description:
      "Complete, self-contained task prompt. Workers cannot see your conversation history. Include file paths, line numbers, exact scope, and what 'done' looks like.",
    minLength: 1,
  }),
  run_in_background: Type.Optional(
    Type.Boolean({
      description:
        "true (default): fire-and-forget, result delivered via task-notification XML. false: blocking, returns result inline (use only for trivial read-only queries).",
    }),
  ),
  model: Type.Optional(
    Type.String({
      description: "Model override. Leave unset to use the default model.",
    }),
  ),
  thinking: Type.Optional(
    Type.String({
      description: "Thinking level override (e.g. 'low', 'medium', 'high').",
    }),
  ),
  timeout_seconds: Type.Optional(
    Type.Number({
      minimum: 5,
      description: "Task timeout in seconds. Default: 300s.",
    }),
  ),
  // Batch synchronous variant: tasks array for run_in_background: false
  tasks: Type.Optional(
    Type.Array(
      Type.Object({
        id: Type.String(),
        description: Type.Optional(Type.String()),
        task: Type.String({ minLength: 1 }),
        model: Type.Optional(Type.String()),
        thinking: Type.Optional(Type.String()),
        timeout_seconds: Type.Optional(Type.Number({ minimum: 5 })),
      }),
      { minItems: 1, maxItems: 5 },
    ),
  ),
});

export function createAgentTool(opts?: SpawnedToolContext): AnyAgentTool {
  return {
    label: "Agent",
    name: "agent",
    displaySummary: AGENT_TOOL_DISPLAY_SUMMARY,
    description: describeAgentTool(),
    parameters: AgentToolSchema,
    execute: async (_toolCallId: string, args: unknown) => {
      const params = args as Record<string, unknown>;

      const description = readStringParam(params, "description", { required: true });
      const prompt = readStringParam(params, "prompt");
      const runInBackground = params.run_in_background !== false; // default true
      const modelOverride = readStringParam(params, "model");
      const thinkingOverride = readStringParam(params, "thinking");
      const timeoutSeconds = readNumberParam(params, "timeout_seconds");
      const rawTasks = params.tasks as Array<Record<string, unknown>> | undefined;

      // Recursion guard: fork children cannot spawn nested agents
      if (isForkExecutionActive()) {
        return jsonResult({
          status: "error",
          error:
            "Fork nesting is not allowed. You are running inside a fork worker. Execute tasks directly with your tools instead of spawning agents.",
        });
      }

      if (!isForkSubagentEnabled()) {
        return jsonResult({
          status: "error",
          error:
            "Fork subagent is disabled (OPENCLAW_ENABLE_FORK_SUBAGENT=0). The agent tool requires fork mode.",
        });
      }

      if (!opts?.agentSessionKey) {
        return jsonResult({
          status: "error",
          error: "Agent tool requires an active session context (agentSessionKey not available).",
        });
      }

      // --- Synchronous batch mode (run_in_background: false, tasks array) ---
      if (!runInBackground) {
        const taskList = rawTasks?.length
          ? rawTasks.map((t, idx) => ({
              id: readStringParam(t, "id") ?? `${description}-${idx + 1}`,
              description: readStringParam(t, "description") ?? "",
              task: readStringParam(t, "task", { required: true }),
              model: readStringParam(t, "model") ?? modelOverride,
              thinking: readStringParam(t, "thinking") ?? thinkingOverride,
              timeout_seconds: readNumberParam(t, "timeout_seconds") ?? timeoutSeconds,
            }))
          : prompt
            ? [
                {
                  id: description,
                  description,
                  task: prompt,
                  model: modelOverride,
                  thinking: thinkingOverride,
                  timeout_seconds: timeoutSeconds,
                },
              ]
            : [];

        if (taskList.length === 0) {
          return jsonResult({
            status: "error",
            error: "run_in_background: false requires either a prompt or tasks array.",
          });
        }

        // Use SimpleCoordinator for task management and result parsing
        const coordinator = new SimpleCoordinator({
          maxConcurrent: 5,
        });

        // Add tasks to coordinator
        for (const task of taskList) {
          coordinator.addTask(task.id, task.task);
        }

        const contexts: ForkSpawnContext[] = taskList.map((t) => ({
          parentSessionKey: opts.agentSessionKey!,
          assistantMessage: {
            role: "assistant",
            content: [],
          } as unknown as import("@mariozechner/pi-agent-core").AgentMessage,
          taskId: `agent-sync-${t.id}-${Date.now()}`,
          directive: t.task,
          taskContext: t.description || undefined,
          workspaceDir: opts.workspaceDir,
          scratchpadDir: opts.scratchpadDir,
          depth: 0,
          model: t.model,
          thinking: t.thinking,
          timeoutMs: t.timeout_seconds ? t.timeout_seconds * 1000 : undefined,
          announceOnComplete: false, // inline result
        }));

        const results = await spawnForkSubagents(contexts, 5);

        // Update coordinator with results and parse structured output
        for (let i = 0; i < results.length; i++) {
          const result = results[i];
          const taskId = taskList[i].id;

          if (result.success && result.output) {
            coordinator.updateTaskStatus(taskId, "completed", result.output, undefined, {
              durationMs: result.durationMs,
            });
          } else {
            coordinator.updateTaskStatus(
              taskId,
              "failed",
              undefined,
              result.error ?? "Unknown error",
              { durationMs: result.durationMs },
            );
          }
        }

        // Build results with parsed structured output
        const parsedResults = coordinator.getAllTasks().map((t) => {
          const parsed = t.rawOutput ? parseAgentResult(t.rawOutput) : null;
          return {
            taskId: t.taskId,
            status: t.status,
            output: t.rawOutput ?? t.error ?? "(no output)",
            parsed: parsed
              ? {
                  scope: parsed.scope,
                  result: parsed.result,
                  keyFiles: parsed.keyFiles,
                  filesChanged: parsed.filesChanged,
                  issues: parsed.issues,
                }
              : null,
            durationMs: t.durationMs,
          };
        });

        return jsonResult({
          status: "ok",
          executionMode: "fork-sync",
          summary: coordinator.generateSummary(),
          results: parsedResults,
        });
      }

      // --- Async background mode (default, run_in_background: true) ---
      if (!prompt) {
        return jsonResult({
          status: "error",
          error: "prompt is required for background agent tasks.",
        });
      }

      const taskId = `agent-${description.replace(/\s+/g, "-").toLowerCase().slice(0, 30)}-${Date.now()}`;

      // Fire and forget — result arrives via <task-notification> XML announce
      const ctx: ForkSpawnContext = {
        parentSessionKey: opts.agentSessionKey,
        assistantMessage: {
          role: "assistant",
          content: [],
        } as unknown as import("@mariozechner/pi-agent-core").AgentMessage,
        taskId,
        directive: prompt,
        taskContext: description,
        workspaceDir: opts.workspaceDir,
        scratchpadDir: opts.scratchpadDir,
        depth: 0,
        model: modelOverride,
        thinking: thinkingOverride,
        timeoutMs: timeoutSeconds ? timeoutSeconds * 1000 : undefined,
        announceOnComplete: true,
      };

      void spawnForkSubagent(ctx).catch((err) => {
        // Best-effort: errors during async execution are logged but do not crash the parent.
        // The parent will simply never receive a task-notification for this task.
        console.warn(`[agent-tool] background fork failed for task=${taskId}: ${String(err)}`);
      });

      return jsonResult({
        status: "accepted",
        taskId,
        executionMode: "fork-async",
        message: `Worker "${description}" launched in background. Results will arrive as a <task-notification> event when complete.`,
      });
    },
  };
}
