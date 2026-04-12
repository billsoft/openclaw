import type { AgentMessage } from "@mariozechner/pi-agent-core";
// Import internal event system for notification delivery (avoids Gateway pairing)
import { queueEmbeddedPiMessage } from "../subagent-announce-delivery.runtime.js";
import { createIsolatedSpawnContext } from "../subagent-isolation.js";
import { getForkRegistry, startForkRegistryCleanup, type ForkSession } from "./fork-registry.js";
import {
  executeForkTask,
  isForkSubagentEnabled,
  isForkExecutionActive,
  resolveForkConfig,
  checkForkDepthLimits,
  FORK_BOILERPLATE_TAG,
  NEVER_ABORT_CONTROLLER,
  type ForkResult,
  type ForkExecutionHooks,
} from "./fork-subagent-core.js";

let cleanupStarted = false;

// ============================================================================
// Notification Tracking - Prevents lost task completion notifications
// ============================================================================

interface NotificationPayload {
  taskId: string;
  status: "completed" | "failed" | "cancelled" | "timeout";
  summary: string;
  result: string;
  usage: {
    total_tokens: number;
    duration_ms: number;
  };
  timestamp: number;
  retryCount?: number;
}

interface PendingNotification {
  payload: NotificationPayload;
  deliveredAt?: number;
  attempts: number;
  lastAttempt: number;
}

interface UnconfirmedNotification {
  taskId: string;
  payload: NotificationPayload;
  timeSinceDelivery: number;
}

class NotificationTracker {
  private pendingNotifications = new Map<string, PendingNotification>();

  registerNotification(payload: NotificationPayload): void {
    this.pendingNotifications.set(payload.taskId, {
      payload,
      attempts: 0,
      lastAttempt: Date.now(),
    });
  }

  confirmDelivery(taskId: string): void {
    const notification = this.pendingNotifications.get(taskId);
    if (notification) {
      notification.deliveredAt = Date.now();
    }
  }

  getUnconfirmedNotifications(olderThanMs: number = 30000): UnconfirmedNotification[] {
    const now = Date.now();
    const unconfirmed: UnconfirmedNotification[] = [];

    for (const [taskId, notification] of this.pendingNotifications) {
      if (!notification.deliveredAt && now - notification.lastAttempt > olderThanMs) {
        unconfirmed.push({
          taskId,
          payload: notification.payload,
          timeSinceDelivery: now - notification.lastAttempt,
        });
      }
    }

    return unconfirmed;
  }

  cleanup(maxAgeMs: number = 300_000): number {
    const now = Date.now();
    let cleaned = 0;

    for (const [taskId, notification] of this.pendingNotifications) {
      const age = notification.deliveredAt
        ? now - notification.deliveredAt
        : now - notification.lastAttempt;

      if (age > maxAgeMs) {
        this.pendingNotifications.delete(taskId);
        cleaned++;
      }
    }

    return cleaned;
  }
}

const notificationTracker = new NotificationTracker();

// ============================================================================
// Reliable Notification Delivery with Retry
// ============================================================================

async function deliverNotificationWithRetry(
  parentSessionKey: string,
  payload: NotificationPayload,
): Promise<{ delivered: boolean; error?: string; retryCount: number }> {
  const MAX_RETRIES = 3;
  const RETRY_DELAYS = [1000, 2000, 4000];

  notificationTracker.registerNotification(payload);

  // Strategy 1: Try internal event system first (no Gateway pairing required)
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const message = buildNotificationMessage({ ...payload, retryCount: attempt });

      // Parse sessionId from sessionKey
      const sessionId = parseSessionIdFromKey(parentSessionKey);

      if (sessionId) {
        // Use internal event queue - no Gateway connection needed
        const steered = queueEmbeddedPiMessage(sessionId, message);
        if (steered) {
          notificationTracker.confirmDelivery(payload.taskId);
          return { delivered: true, retryCount: attempt };
        }
      }

      // If steer failed and not last attempt, wait and retry
      if (attempt < MAX_RETRIES) {
        const delay = RETRY_DELAYS[attempt] || RETRY_DELAYS[RETRY_DELAYS.length - 1];
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    } catch {
      // Continue to retry
      if (attempt < MAX_RETRIES) {
        const delay = RETRY_DELAYS[attempt] || RETRY_DELAYS[RETRY_DELAYS.length - 1];
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  // Strategy 2: Fallback to announceForkCompletion (uses existing Gateway connection)
  try {
    const registry = getForkRegistry();
    const forks = registry.getForksForParent(parentSessionKey);
    const fork = forks.find((f) => f.taskId === payload.taskId);

    if (fork) {
      const result = await announceForkCompletion({
        parentSessionKey,
        childSessionKey: `fork:${fork.forkId}`,
        taskId: payload.taskId,
        directive: payload.summary,
        output: payload.result,
        status: payload.status,
        durationMs: payload.usage.duration_ms,
      });

      if (result.announced) {
        notificationTracker.confirmDelivery(payload.taskId);
        return { delivered: true, retryCount: MAX_RETRIES };
      }
    }
  } catch {
    // Fallback also failed
  }

  return {
    delivered: false,
    error: "Failed to deliver notification via all channels",
    retryCount: MAX_RETRIES,
  };
}

/**
 * Parse sessionId from sessionKey for internal event delivery
 */
function parseSessionIdFromKey(sessionKey: string): string | undefined {
  // Try to extract sessionId from various formats
  const match1 = sessionKey.match(/session:([^:]+)/);
  if (match1) {
    return match1[1];
  }

  const match2 = sessionKey.match(/:session:([^:]+)/);
  if (match2) {
    return match2[1];
  }

  const match3 = sessionKey.match(/session-([^\s:]+)/);
  if (match3) {
    return match3[1];
  }

  return undefined;
}

function buildNotificationMessage(payload: NotificationPayload): string {
  const { taskId, status, summary, result, usage, retryCount } = payload;

  return [
    "<task-notification>",
    `<task-id>${taskId}</task-id>`,
    `<status>${status}</status>`,
    `<summary>${summary}${retryCount ? ` (retry ${retryCount})` : ""}</summary>`,
    "<result>",
    result || "(no output)",
    "</result>",
    "<usage>",
    `<total_tokens>${usage.total_tokens}</total_tokens>`,
    `<duration_ms>${usage.duration_ms}</duration_ms>`,
    `<timestamp>${payload.timestamp}</timestamp>`,
    "</usage>",
    "</task-notification>",
  ].join("\n");
}

export interface ForkSpawnContext {
  parentSessionKey: string;
  assistantMessage: AgentMessage;
  taskId: string;
  directive: string;
  taskContext?: string;
  scratchpadDir?: string;
  workspaceDir?: string;
  depth?: number;
  model?: string;
  thinking?: string;
  priority?: "high" | "medium" | "low";
  timeoutMs?: number;
  parentAbortSignal?: AbortSignal;
  announceOnComplete?: boolean;
}

export interface ForkSpawnResult {
  success: boolean;
  forkId?: string;
  taskId?: string;
  output?: string;
  error?: string;
  status?: ForkResult["status"];
  durationMs?: number;
  announced?: boolean;
}

export async function spawnForkSubagent(ctx: ForkSpawnContext): Promise<ForkSpawnResult> {
  if (!isForkSubagentEnabled()) {
    return {
      success: false,
      taskId: ctx.taskId,
      error: "Fork subagent is disabled (OPENCLAW_ENABLE_FORK_SUBAGENT=0)",
    };
  }

  // Recursion guard: fork children must not spawn nested forks (same as claude-code's isInForkChild check).
  // isForkExecutionActive() is true whenever this process is currently inside an executeForkTask() call.
  if (isForkExecutionActive()) {
    return {
      success: false,
      taskId: ctx.taskId,
      error:
        "Fork nesting is not allowed. You are already running inside a fork worker. Execute tasks directly instead of spawning nested agents.",
    };
  }

  if (!cleanupStarted) {
    startForkRegistryCleanup();
    cleanupStarted = true;
  }

  const cfg = resolveForkConfig();
  const currentDepth = ctx.depth ?? 0;
  const registry = getForkRegistry();

  const activeChildren = registry.getActiveForkCount(ctx.parentSessionKey);

  const limitCheck = checkForkDepthLimits({
    currentDepth,
    parentSessionKey: ctx.parentSessionKey,
    activeChildCount: activeChildren,
  });

  if (!limitCheck.allowed) {
    return {
      success: false,
      taskId: ctx.taskId,
      error: limitCheck.error ?? "Depth or children limit exceeded",
    };
  }

  const isolatedCtx = createIsolatedSpawnContext(
    new AbortController(),
    ctx.taskId,
    ctx.scratchpadDir,
  );

  const forkSession = registry.registerFork({
    parentSessionKey: ctx.parentSessionKey,
    taskId: ctx.taskId,
    depth: currentDepth + 1,
  });

  let announceResult: { announced: boolean; error?: string } | null = null;

  try {
    // Use isolated context to prevent task scope confusion
    const forkMessages = buildIsolatedForkMessages({
      directive: ctx.directive,
      taskContext: ctx.taskContext,
      sessionMeta: {
        taskId: ctx.taskId,
        parentSessionKey: ctx.parentSessionKey,
        createdAt: Date.now(),
      },
    });

    registry.updateForkStatus(forkSession.forkId, "running");

    const hooks: ForkExecutionHooks = {
      onLifecycleEvent: (evt) => {
        registry.recordLifecycleEvent(forkSession.forkId, evt);
      },
      onComplete: async (result) => {
        registry.updateForkStatus(forkSession.forkId, result.status as ForkSession["status"], {
          result: result.output,
          error: result.error,
          tokenUsage: result.tokenUsage,
          durationMs: result.durationMs,
        });

        if (ctx.announceOnComplete !== false && result.status === "completed") {
          try {
            // Use reliable notification with retry
            const totalTokens = result.tokenUsage
              ? result.tokenUsage.input + result.tokenUsage.output
              : 0;
            const notificationResult = await deliverNotificationWithRetry(ctx.parentSessionKey, {
              taskId: ctx.taskId,
              status: result.status,
              summary: `Agent "${ctx.directive.slice(0, 120)}${ctx.directive.length > 120 ? "..." : ""}" completed`,
              result: result.output ?? "",
              usage: {
                total_tokens: totalTokens,
                duration_ms: result.durationMs ?? 0,
              },
              timestamp: Date.now(),
            });
            announceResult = {
              announced: notificationResult.delivered,
              error: notificationResult.error,
            };
            if (!notificationResult.delivered) {
              console.error(
                `[fork-spawn-adapter] Failed to deliver notification after ${notificationResult.retryCount} retries:`,
                notificationResult.error,
              );
            }
          } catch (err) {
            console.error(
              `[fork-spawn-adapter] Failed to announce completion for task ${ctx.taskId}:`,
              err,
            );
          }
        }
      },
    };

    const combinedSignal = AbortSignal.any([
      isolatedCtx.abortController.signal,
      ctx.parentAbortSignal ?? NEVER_ABORT_CONTROLLER.signal,
    ]);

    const result = await executeForkTask(
      {
        id: ctx.taskId,
        directive: ctx.directive,
        taskContext: ctx.taskContext,
        priority: ctx.priority,
        timeoutMs: ctx.timeoutMs ?? cfg.defaultTimeoutMs,
        depth: currentDepth + 1,
        parentSessionKey: ctx.parentSessionKey,
        model: ctx.model,
        thinking: ctx.thinking,
        workspaceDir: ctx.workspaceDir,
        scratchpadDir: isolatedCtx.taskScratchDir,
      },
      forkMessages,
      combinedSignal,
      hooks,
    );

    return {
      success: result.status === "completed",
      forkId: forkSession.forkId,
      taskId: ctx.taskId,
      output: result.output,
      error: result.error,
      status: result.status,
      durationMs: result.durationMs,
      announced:
        (announceResult as { announced: boolean; error?: string } | null)?.announced ?? false,
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);

    registry.updateForkStatus(forkSession.forkId, "failed", { error: errorMsg });
    registry.recordLifecycleEvent(forkSession.forkId, {
      phase: "error",
      taskId: ctx.taskId,
      data: { error: errorMsg },
    });

    return {
      success: false,
      forkId: forkSession.forkId,
      taskId: ctx.taskId,
      error: errorMsg,
    };
  }
}

async function announceForkCompletion(params: {
  parentSessionKey: string;
  childSessionKey: string;
  taskId: string;
  directive: string;
  output: string;
  status: ForkResult["status"];
  durationMs: number;
  tokenUsage?: { input: number; output: number };
}): Promise<{ announced: boolean; error?: string }> {
  try {
    const { callGateway } = await import("../subagent-announce-delivery.runtime.js").catch(() => ({
      callGateway: null,
    }));

    if (!callGateway) {
      return { announced: false, error: "Gateway delivery not available" };
    }

    const totalTokens = params.tokenUsage ? params.tokenUsage.input + params.tokenUsage.output : 0;

    // Use claude-code-compatible <task-notification> XML format so the coordinator
    // system prompt's "Worker Results" section matches actual delivery format.
    const triggerMessage = [
      `<task-notification>`,
      `<task-id>${params.taskId}</task-id>`,
      `<status>${params.status}</status>`,
      `<summary>Agent "${params.directive.slice(0, 120)}${params.directive.length > 120 ? "..." : ""}" ${params.status === "completed" ? "completed" : `failed: ${params.status}`}</summary>`,
      `<result>`,
      params.output || "(no output)",
      `</result>`,
      `<usage>`,
      `<total_tokens>${totalTokens}</total_tokens>`,
      `<duration_ms>${params.durationMs ?? 0}</duration_ms>`,
      `</usage>`,
      `</task-notification>`,
    ].join("\n");

    await callGateway({
      method: "agent",
      params: {
        sessionKey: params.parentSessionKey,
        message: triggerMessage,
      },
    });

    return { announced: true };
  } catch (err) {
    return {
      announced: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function spawnForkSubagents(
  contexts: ForkSpawnContext[],
  maxConcurrent?: number,
): Promise<ForkSpawnResult[]> {
  if (!isForkSubagentEnabled()) {
    return contexts.map((ctx) => ({
      success: false,
      taskId: ctx.taskId,
      error: "Fork subagent is disabled",
    }));
  }

  if (!cleanupStarted) {
    startForkRegistryCleanup();
    cleanupStarted = true;
  }

  const concurrencyLimit = maxConcurrent ?? resolveForkConfig().maxWorkers;
  const results: ForkSpawnResult[] = Array.from({ length: contexts.length });
  let nextIndex = 0;

  const executing = new Set<Promise<void>>();

  async function processNext(): Promise<void> {
    while (nextIndex < contexts.length) {
      const idx = nextIndex++;

      if (executing.size >= concurrencyLimit) {
        await Promise.race(executing);
      }

      const p = spawnForkSubagent(contexts[idx])
        .then((r) => {
          results[idx] = r;
        })
        .finally(() => {
          executing.delete(p);
        });

      executing.add(p);
    }
  }

  await processNext();

  if (executing.size > 0) {
    await Promise.all(executing);
  }

  return results;
}

export function getForkStatus(forkId: string): ForkSession | undefined {
  return getForkRegistry().getFork(forkId);
}

export function getForksForParent(parentSessionKey: string): ForkSession[] {
  return getForkRegistry().getForksForParent(parentSessionKey);
}

export function getActiveForkCount(parentSessionKey: string): number {
  return getForkRegistry().getActiveForkCount(parentSessionKey);
}

export function cancelFork(forkId: string): boolean {
  return getForkRegistry().abortFork(forkId);
}

export function cancelAllForks(parentSessionKey: string): number {
  return getForkRegistry().abortAllForParent(parentSessionKey);
}

export function parseForkOutput(raw: string): {
  scope?: string;
  result?: string;
  keyFiles?: string;
  filesChanged?: string;
  issues?: string;
} {
  const clean = raw
    .replace(new RegExp(`<${FORK_BOILERPLATE_TAG}>[\\s\\S]*?</${FORK_BOILERPLATE_TAG}>`, "g"), "")
    .trim();

  const scopeMatch = clean.match(/^Scope:\s*(.+?)(?:\n\n|\nResult:|$)/s);
  const resultMatch = clean.match(
    /(?:^|\n)Result:\s*([\s\S]*?)(?=\n\n(?:Key files|Files changed|Issues)|$)/s,
  );
  const keyFilesMatch = clean.match(/(?:^|\n)Key files:\s*(.+?)(?:\n\n|\nFiles changed|$)/s);
  const filesChangedMatch = clean.match(/(?:^|\n)Files changed:\s*(.+?)(?:\n\n|\nIssues|$)/s);
  const issuesMatch = clean.match(/(?:^|\n)Issues:\s*([\s\S]*)$/);

  return {
    scope: scopeMatch?.[1]?.trim(),
    result: resultMatch?.[1]?.trim(),
    keyFiles: keyFilesMatch?.[1]?.trim(),
    filesChanged: filesChangedMatch?.[1]?.trim(),
    issues: issuesMatch?.[1]?.trim(),
  };
}

export const __testing = {
  spawnForkSubagent,
  spawnForkSubagents,
  getForkStatus,
  getForksForParent,
  announceForkCompletion,
  parseForkOutput,
};

// ============================================================================
// Heartbeat Monitoring - Detects stuck or lost tasks
// ============================================================================

let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

export function startTaskHeartbeatMonitoring(): void {
  if (heartbeatTimer) {
    return;
  }

  const STUCK_THRESHOLD = 300_000; // 5 minutes
  const HEARTBEAT_INTERVAL = 30_000; // 30 seconds

  heartbeatTimer = setInterval(() => {
    try {
      const registry = getForkRegistry();
      const stuckForks = registry.findStuckForks(STUCK_THRESHOLD);

      for (const stuckTask of stuckForks) {
        console.warn(`[ForkHeartbeat] Found stuck task: ${stuckTask.taskId} (${stuckTask.status})`);

        // Check if we have an unconfirmed notification
        const unconfirmed = notificationTracker.getUnconfirmedNotifications();
        const hasUnconfirmedNotification = unconfirmed.some((n) => n.taskId === stuckTask.taskId);

        if (hasUnconfirmedNotification) {
          // Try to redeliver the notification
          const notification = unconfirmed.find((n) => n.taskId === stuckTask.taskId);
          if (notification) {
            console.log(
              `[ForkHeartbeat] Attempting to redeliver notification for stuck task: ${stuckTask.taskId}`,
            );
            void deliverNotificationWithRetry(stuckTask.parentSessionKey, notification.payload);
          }
        } else {
          // Abort the stuck task
          console.log(`[ForkHeartbeat] Aborting stuck task: ${stuckTask.taskId}`);
          registry.abortFork(stuckTask.forkId);
        }
      }

      // Cleanup old notifications
      notificationTracker.cleanup();
    } catch (err) {
      console.error("[ForkHeartbeat] Error during heartbeat check:", err);
    }
  }, HEARTBEAT_INTERVAL);

  if (heartbeatTimer.unref) {
    heartbeatTimer.unref();
  }
}

export function stopTaskHeartbeatMonitoring(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

// ============================================================================
// Context Isolation - Prevents task scope confusion
// ============================================================================

export interface IsolatedForkContext {
  directive: string;
  taskContext?: string;
  sessionMeta: {
    taskId: string;
    parentSessionKey: string;
    createdAt: number;
  };
}

/**
 * Builds isolated fork messages to prevent context confusion
 * Replaces full conversation context with clean task-specific messages
 */
export function buildIsolatedForkMessages(context: IsolatedForkContext): AgentMessage[] {
  const { directive, taskContext, sessionMeta } = context;

  const taskHeader = [
    `=== TASK ${sessionMeta.taskId} ===`,
    `Session: ${sessionMeta.parentSessionKey}`,
    `Created: ${new Date(sessionMeta.createdAt).toISOString()}`,
    "",
    taskContext ? `CONTEXT: ${taskContext}\n` : "",
    "DIRECTIVE:",
    directive,
    "",
    "SCOPE LIMITATIONS:",
    "- Execute ONLY the directive above",
    "- Do NOT reference or continue any previous work",
    "- Do NOT assume context from other tasks",
    "- Report completion and stop",
  ].join("\n");

  const cleanUserMessage: AgentMessage = {
    role: "user",
    content: [{ type: "text", text: taskHeader }],
  } as AgentMessage;

  return [cleanUserMessage];
}

/**
 * Extracts relevant file paths from a directive for scope validation
 */
export function extractRelevantFiles(directive: string): string[] {
  const filePatterns = [
    /[`']([^`']+\.(ts|js|tsx|jsx|py|go|rs|java|cpp|c|h|json|yaml|yml|md|txt|sh|ps1|bat))[`']/g,
    /["']([^"']+\.(ts|js|tsx|jsx|py|go|rs|java|cpp|c|h|json|yaml|yml|md|txt|sh|ps1|bat))["']/g,
    /(\b(?:src|lib|app|components|utils|tests|docs|config|scripts)\/[^/\s]+\.(?:ts|js|tsx|jsx|py|go|rs|java|cpp|c|h|json|yaml|yml|md|txt|sh|ps1|bat)\b)/g,
  ];

  const files = new Set<string>();

  for (const pattern of filePatterns) {
    const matches = directive.match(pattern);
    if (matches) {
      for (const match of matches) {
        const filePath = match.replace(/['"`]/g, "");
        if (filePath.includes(".")) {
          files.add(filePath);
        }
      }
    }
  }

  return Array.from(files);
}
