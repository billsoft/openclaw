/**
 * SendMessage tool - allows main agent to communicate with running fork workers.
 *
 * This tool enables the coordinator (main agent) to:
 * - Send intervention messages to running workers ("pause", "prioritize this bug")
 * - Query worker status and progress
 * - Cancel stuck or misdirected tasks
 * - Inject new context into running tasks
 *
 * Integration points:
 * - Uses fork-registry to find active tasks
 * - Injects messages into the task's message queue
 * - Returns status and acknowledgment
 */

import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import {
  getForkRegistry,
  getForksForParent,
  cancelFork,
  isForkSubagentEnabled,
  type ForkSession,
} from "../fork/index.js";
import { loadSessionEntryByKey } from "../subagent-announce-delivery.js";
import { queueEmbeddedPiMessage } from "../subagent-announce-delivery.runtime.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam, ToolInputError } from "./common.js";

type SendMessageToolContext = {
  agentSessionKey?: string;
  runId?: string;
};

interface WorkerMessage {
  taskId: string;
  message: string;
  type: "intervention" | "query" | "cancel" | "context_update";
  timestamp: number;
  sourceSessionKey: string;
}

const SendMessageToolSchema = Type.Object({
  task_id: Type.String({
    description:
      "The ID of the target fork task (from agent tool response or task-notification). Use 'all' to broadcast to all running workers.",
  }),
  message: Type.String({
    description:
      "Message content to send to the worker. For interventions, be specific about what should change.",
    minLength: 1,
  }),
  message_type: Type.Optional(
    Type.String({
      description:
        "Type of message: 'intervention' (change direction), 'query' (ask for status), 'cancel' (stop task), 'context_update' (add new info). Default: 'intervention'.",
    }),
  ),
});

function describeSendMessageTool(): string {
  return [
    "Send a message to a running fork worker or query its status.",
    "",
    "**Use cases:**",
    "- Intervention: Redirect a worker that's going down the wrong path",
    "- Priority change: Ask a worker to pause and focus on a critical bug",
    "- Status check: Query progress of a long-running task",
    "- Cancellation: Stop a stuck or no-longer-needed task",
    "- Context injection: Add new information discovered after task launch",
    "",
    "**Message types:**",
    "- `intervention` (default): Change the worker's direction or priority",
    "- `query`: Ask the worker to report current status and progress",
    "- `cancel`: Request the worker to stop gracefully",
    "- `context_update`: Inject additional context without changing direction",
    "",
    "**Finding task IDs:**",
    "- From the initial agent tool response (`taskId` field)",
    "- From task-notification XML (`<task-id>` element)",
    "- Use 'all' to broadcast to all running workers under your session",
    "",
    "**Response format:**",
    "```json",
    "{",
    '  "success": true,',
    '  "taskId": "agent-refactor-auth-1234567890",',
    '  "workerStatus": "running",',
    '  "messageDelivered": true,',
    '  "response": "Worker acknowledged: pausing current work to address new priority"',
    "}",
    "```",
  ].join("\n");
}

export function createSendMessageTool(opts?: SendMessageToolContext): AnyAgentTool {
  return {
    label: "SendMessage",
    name: "send_message_to_worker",
    displaySummary: "Send messages to running fork workers",
    description: describeSendMessageTool(),
    parameters: SendMessageToolSchema,
    execute: async (_toolCallId: string, args: unknown) => {
      const params = args as Record<string, unknown>;

      const taskId = readStringParam(params, "task_id", { required: true });
      const message = readStringParam(params, "message", { required: true });
      const messageType = (params.message_type as string) || "intervention";

      if (!isForkSubagentEnabled()) {
        return jsonResult({
          success: false,
          error: "Send Message tool requires fork subagent mode (OPENCLAW_ENABLE_FORK_SUBAGENT=1).",
          taskId,
        });
      }

      if (!opts?.agentSessionKey) {
        return jsonResult({
          success: false,
          error:
            "Send Message tool requires an active session context (agentSessionKey not available).",
          taskId,
        });
      }

      const validTypes = ["intervention", "query", "cancel", "context_update"];
      if (!validTypes.includes(messageType)) {
        throw new ToolInputError(
          `Invalid message_type "${messageType}". Must be one of: ${validTypes.join(", ")}`,
        );
      }

      try {
        const registry = getForkRegistry();

        if (taskId === "all" || taskId === "*") {
          return await handleBroadcast(registry, opts.agentSessionKey, message, messageType, opts);
        }

        return await handleSingleWorker(
          registry,
          opts.agentSessionKey,
          taskId,
          message,
          messageType as WorkerMessage["type"],
          opts,
        );
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        console.error(`[send-message] Failed to send message to task ${taskId}: ${errorMsg}`);

        return jsonResult({
          success: false,
          taskId,
          error: errorMsg,
        });
      }
    },
  };
}

async function handleSingleWorker(
  registry: ReturnType<typeof getForkRegistry>,
  sessionKey: string,
  taskId: string,
  message: string,
  type: WorkerMessage["type"],
  opts: SendMessageToolContext,
): Promise<AgentToolResult<unknown>> {
  const parentForks = getForksForParent(sessionKey);
  const matchingFork = parentForks.find(
    (f: ForkSession) =>
      (f.taskId.includes(taskId) || taskId.includes(f.taskId)) &&
      (opts?.runId ? f.conversationTurnId === opts.runId : true),
  );

  if (!matchingFork) {
    return jsonResult({
      success: false,
      taskId,
      error: `Task "${taskId}" not found in current conversation turn. It may have completed, failed, or belongs to a different turn.`,
      workerStatus: "not_found",
    });
  }

  return jsonResult(processMessage(matchingFork, sessionKey, message, type));
}

async function handleBroadcast(
  registry: ReturnType<typeof getForkRegistry>,
  sessionKey: string,
  message: string,
  type: string,
  opts: SendMessageToolContext,
): Promise<AgentToolResult<unknown>> {
  const activeForks = getForksForParent(sessionKey).filter(
    (f: ForkSession) =>
      (f.status === "running" || f.status === "pending") &&
      (opts?.runId ? f.conversationTurnId === opts.runId : true),
  );

  if (activeForks.length === 0) {
    return jsonResult({
      success: false,
      taskId: "all",
      error: "No running workers found for broadcast. All tasks may have completed.",
      activeWorkerCount: 0,
    });
  }

  console.log(
    `[send-message] Broadcasting ${type} message to ${activeForks.length} worker(s): "${message.slice(0, 100)}"`,
  );

  const results = activeForks.map((fork: ForkSession) =>
    processMessage(fork, sessionKey, message, type as WorkerMessage["type"]),
  );

  const successful = results.filter((r: Record<string, unknown>) => r.success).length;
  const failed = results.length - successful;

  return jsonResult({
    success: successful > 0,
    taskId: "all",
    messageDelivered: successful,
    totalWorkers: activeForks.length,
    successfulDeliveries: successful,
    failedDeliveries: failed,
    results: results.map((r: Record<string, unknown>, idx: number) => ({
      taskId: activeForks[idx].taskId,
      ...(r.success ? r : { success: false, error: "Processing failed" }),
    })),
  });
}

function processMessage(
  fork: ForkSession,
  sessionKey: string,
  message: string,
  type: WorkerMessage["type"],
): Record<string, unknown> {
  const workerMessage: WorkerMessage = {
    taskId: fork.taskId,
    message,
    type,
    timestamp: Date.now(),
    sourceSessionKey: sessionKey,
  };

  console.log(
    `[send-message] Sending ${type} to task ${fork.taskId} (status=${fork.status}, depth=${fork.depth}):`,
    message.slice(0, 200),
  );

  switch (type) {
    case "cancel":
      return handleCancel(fork, workerMessage);

    case "query":
      return handleQuery(fork, workerMessage);

    case "intervention":
    case "context_update":
    default:
      return handleIntervention(fork, workerMessage);
  }
}

function handleCancel(fork: ForkSession, _msg: WorkerMessage): Record<string, unknown> {
  if (fork.status === "completed" || fork.status === "failed" || fork.status === "cancelled") {
    return {
      success: false,
      taskId: fork.taskId,
      workerStatus: fork.status,
      error: `Cannot cancel task in "${fork.status}" state.`,
    };
  }

  const cancelled = cancelFork(fork.forkId);

  if (cancelled) {
    console.log(`[send-message] Successfully cancelled task ${fork.taskId}`);
    return {
      success: true,
      taskId: fork.taskId,
      workerStatus: "cancelling",
      messageDelivered: true,
      response: "Cancellation signal sent. Task will stop gracefully.",
    };
  }

  return {
    success: false,
    taskId: fork.taskId,
    workerStatus: fork.status,
    error: "Failed to send cancellation signal. The task may have already completed.",
  };
}

function handleQuery(fork: ForkSession, _msg: WorkerMessage): Record<string, unknown> {
  const statusInfo = {
    taskId: fork.taskId,
    status: fork.status,
    depth: fork.depth,
    createdAt: fork.createdAt,
    startedAt: fork.startedAt,
    updatedAt: fork.updatedAt,
    lifecycleEvents: fork.lifecycleEvents?.slice(-5),
    result: fork.result
      ? `${fork.result.slice(0, 200)}${fork.result.length > 200 ? "..." : ""}`
      : undefined,
    error: fork.error,
    durationMs: fork.startedAt ? Date.now() - fork.startedAt : undefined,
  };

  return {
    success: true,
    taskId: fork.taskId,
    workerStatus: fork.status,
    messageDelivered: true,
    response: JSON.stringify(statusInfo, null, 2),
  };
}

function handleIntervention(fork: ForkSession, msg: WorkerMessage): Record<string, unknown> {
  if (fork.status === "completed" || fork.status === "failed" || fork.status === "cancelled") {
    return {
      success: false,
      taskId: fork.taskId,
      workerStatus: fork.status,
      error: `Cannot send ${msg.type} to task in "${fork.status}" state. The task has already finished.`,
    };
  }

  if (fork.status !== "running" && fork.status !== "pending") {
    return {
      success: false,
      taskId: fork.taskId,
      workerStatus: fork.status,
      error: `Task is in unexpected state "${fork.status}". Only running/pending tasks accept interventions.`,
    };
  }

  const registry = getForkRegistry();
  // Record intervention in lifecycle events for tracking and debugging.
  // NOTE: Fork workers run independently and do NOT actively poll for interventions.
  // The message is persisted in the registry for:
  // - Post-mortem analysis (what messages were sent)
  // - Future enhancement (if workers are updated to check for pending interventions)
  registry.recordLifecycleEvent(fork.forkId, {
    phase: "progress",
    taskId: fork.taskId,
    data: {
      intervention: {
        type: msg.type,
        message: msg.message,
        timestamp: msg.timestamp,
        source: msg.sourceSessionKey,
      },
    },
  });

  console.log(
    `[send-message] Intervention recorded for task ${fork.taskId}: ${msg.type}. ` +
      `NOTE: Worker may not receive this message until it completes its current tool call. ` +
      `For urgent changes, consider cancelling and re-spawning the task.`,
  );

  let injected = false;
  if (fork.childSessionKey) {
    try {
      const entry = loadSessionEntryByKey(fork.childSessionKey);
      if (entry?.sessionId) {
        const injectedMessage = `[Coordinator ${msg.type === "context_update" ? "Context Update" : "Intervention"}]: ${msg.message}`;
        injected = queueEmbeddedPiMessage(entry.sessionId, injectedMessage);
      }
    } catch (e) {
      console.warn(
        `[send-message] Failed to inject message into embedded session ${fork.childSessionKey}`,
        e,
      );
    }
  }

  return {
    success: true,
    taskId: fork.taskId,
    workerStatus: fork.status,
    messageDelivered: true, // Message is recorded in registry
    messageReceivedByWorker: injected,
    response: injected
      ? `Message successfully injected into running worker "${fork.taskId}".`
      : msg.type === "intervention"
        ? `Intervention recorded for task "${fork.taskId}". The intervention is persisted in the task's lifecycle events. NOTE: The worker runs independently and may not see this message until it finishes its current operation. For urgent changes, use 'cancel' then re-spawn the task.`
        : `Context update recorded for task "${fork.taskId}". The new information is persisted and will be available when the worker checks its lifecycle events (if implemented).`,
  };
}
