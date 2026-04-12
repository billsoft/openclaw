import crypto from "node:crypto";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { loadConfig } from "../../config/config.js";
import { createAgentWorktree, removeAgentWorktree } from "./fork-worktree.js";

export const FORK_ENABLED = process.env.OPENCLAW_ENABLE_FORK_SUBAGENT !== "0";
export const CACHE_SHARING_ENABLED = process.env.OPENCLAW_ENABLE_FORK_CACHE_SHARING !== "0";
export const FORK_MAX_CONCURRENT = parseInt(process.env.OPENCLAW_FORK_MAX_CONCURRENT ?? "5", 10);
export const FORK_ISOLATION_MODE = process.env.OPENCLAW_FORK_ISOLATION_MODE ?? "sandbox";

// ============================================================================
// Prompt Cache Statistics & Monitoring
// ============================================================================

interface CacheStats {
  totalForkSpawns: number;
  cacheSharingEnabled: number;
  cacheHit: number;
  cacheMiss: number;
  totalTokensSaved: number;
  lastCacheHitTime?: number;
  lastCacheMissTime?: number;
}

const cacheStats: CacheStats = {
  totalForkSpawns: 0,
  cacheSharingEnabled: 0,
  cacheHit: 0,
  cacheMiss: 0,
  totalTokensSaved: 0,
};

/**
 * Records a prompt cache sharing event (hit or miss).
 * Call this when a fork child is spawned with or without parent context.
 */
export function recordCacheEvent(params: {
  hadParentSystemPrompt: boolean;
  tokensSaved?: number;
}): void {
  cacheStats.totalForkSpawns++;

  if (params.hadParentSystemPrompt) {
    cacheStats.cacheSharingEnabled++;
    cacheStats.cacheHit++;
    cacheStats.lastCacheHitTime = Date.now();
    if (params.tokensSaved) {
      cacheStats.totalTokensSaved += params.tokensSaved;
    }
  } else {
    cacheStats.cacheMiss++;
    cacheStats.lastCacheMissTime = Date.now();
  }

  // Log cache statistics periodically (every 10 spawns)
  if (cacheStats.totalForkSpawns % 10 === 0) {
    const hitRate =
      cacheStats.totalForkSpawns > 0
        ? ((cacheStats.cacheHit / cacheStats.totalForkSpawns) * 100).toFixed(1)
        : "0.0";
    console.log(
      `[fork-cache] Stats: ${cacheStats.totalForkSpawns} spawns, ` +
        `sharing enabled: ${cacheStats.cacheSharingEnabled}, ` +
        `hit rate: ${hitRate}%, ` +
        `tokens saved: ~${cacheStats.totalTokensSaved}`,
    );
  }
}

/**
 * Returns current prompt cache statistics for monitoring/debugging.
 */
export function getCacheStats(): Readonly<CacheStats> {
  return { ...cacheStats };
}

/**
 * Resets cache statistics (useful for testing or manual monitoring reset).
 */
export function resetCacheStats(): void {
  cacheStats.totalForkSpawns = 0;
  cacheStats.cacheSharingEnabled = 0;
  cacheStats.cacheHit = 0;
  cacheStats.cacheMiss = 0;
  cacheStats.totalTokensSaved = 0;
  cacheStats.lastCacheHitTime = undefined;
  cacheStats.lastCacheMissTime = undefined;
}

/**
 * System-level directive injected into fork child agents to prevent infinite
 * recursion and enforce worker behavior (no sub-agent spawning, direct execution).
 */
const FORK_CHILD_SYSTEM_DIRECTIVE = [
  "[FORK CHILD DIRECTIVE — NON-NEGOTIABLE]",
  "You are a forked worker subprocess, NOT the main agent or coordinator.",
  "",
  "## IDENTITY & SCOPE",
  "- You are an isolated worker with a SINGLE specific task.",
  "- You CANNOT see the user's conversation history or the coordinator's reasoning.",
  "- Your ONLY context is the task directive below. Work within it exclusively.",
  "- Do NOT expand scope, do 'bonus work', or add features beyond your directive.",
  "",
  "## EXECUTION RULES",
  "- Do NOT spawn sub-agents or call the Agent tool. Execute tasks directly with tools (Read, Write, Edit, Bash, etc.).",
  "- Do NOT ask questions or suggest next steps. Use tools silently without narration.",
  "- Do NOT engage in conversation or meta-commentary about your process.",
  "- If you modify files, commit BEFORE reporting results. Include the commit hash.",
  "- Stay strictly within your assigned task scope. Ignore everything else in context.",
  "",
  "## SHARED RESOURCES (if available)",
  "- **Scratchpad**: If a scratchpad directory is provided, you can read/write files there to share intermediate results with other workers.",
  "- **Tool Restrictions**: You may only have access to a subset of tools (e.g. read/write/exec). Use only what is listed in your available tools.",
  "",
  "## OUTPUT FORMAT (REQUIRED)",
  "Your response MUST follow this exact structure:",
  "  Scope: <one sentence echoing your assigned scope, max 100 chars>",
  "  Result: <what was done or key findings, max 300 words>",
  "  Key files: <comma-separated paths, or 'none'>",
  "  Files changed: <paths with commit hashes, or 'none'>",
  "  Issues: <blockers or problems, or 'none'>",
  "",
  "## ERROR HANDLING",
  "- If you encounter an error, try to fix it yourself first (max 2 retry attempts).",
  "- If you cannot fix it, report the error clearly in the 'Issues' field with this format:",
  "  Issues: <error_type>:<file_path>:<line_number>:<error_message>",
  "  Examples:",
  "    Issues: TypeError:src/auth/validate.ts:42:Cannot read property 'id' of null",
  "    Issues: PermissionError:/etc/config.json:Access denied - check file permissions",
  "    Issues: DependencyError:package.json:Missing required dependency 'lodash'",
  "- Do NOT give up silently — always report what you tried and what failed.",
  "",
  "## TIME AWARENESS",
  "- You are running under a timeout. Work efficiently and prioritize completion over perfection.",
  "- If your task is large, focus on the MOST CRITICAL part and report progress.",
  "- Prefer working code over perfect code when time-constrained.",
  "",
  "## TOOL USAGE",
  "- Use the minimum number of tool calls needed to complete the task.",
  "- Batch related operations when possible (e.g., read multiple files in one pass).",
  "- Avoid redundant reads of files you've already seen.",
].join("\n");

export const DEFAULT_FORK_MAX_SPAWN_DEPTH = 3;
export const DEFAULT_FORK_MAX_CHILDREN = 5;
export const DEFAULT_FORK_TIMEOUT_MS = 300_000;

export function isForkSubagentEnabled(): boolean {
  return FORK_ENABLED;
}

export function isCacheSharingEnabled(): boolean {
  return CACHE_SHARING_ENABLED;
}

export function getForkMaxConcurrent(): number {
  return Math.max(1, Math.min(FORK_MAX_CONCURRENT, 10));
}

export function getForkIsolationMode(): "worktree" | "sandbox" | "none" {
  if (FORK_ISOLATION_MODE === "worktree" || FORK_ISOLATION_MODE === "none") {
    return FORK_ISOLATION_MODE;
  }
  return "sandbox";
}

export function resolveForkConfig() {
  const cfg = loadConfig();
  const subagents = cfg.agents?.defaults?.subagents;
  const coordinator = cfg.agents?.defaults?.coordinator;

  return {
    maxSpawnDepth: subagents?.maxSpawnDepth ?? DEFAULT_FORK_MAX_SPAWN_DEPTH,
    maxChildrenPerAgent: subagents?.maxChildrenPerAgent ?? DEFAULT_FORK_MAX_CHILDREN,
    defaultTimeoutMs: DEFAULT_FORK_TIMEOUT_MS,
    coordinatorEnabled: coordinator?.enabled === true,
    maxWorkers: coordinator?.maxWorkers ?? 3,
  };
}

export function checkForkDepthLimits(params: {
  currentDepth: number;
  parentSessionKey?: string;
  activeChildCount?: number;
}): { allowed: boolean; error?: string } {
  const cfg = resolveForkConfig();

  if (params.currentDepth >= cfg.maxSpawnDepth) {
    return {
      allowed: false,
      error: `Fork spawn not allowed at depth ${params.currentDepth} (max: ${cfg.maxSpawnDepth})`,
    };
  }

  if (params.activeChildCount !== undefined && params.activeChildCount >= cfg.maxChildrenPerAgent) {
    return {
      allowed: false,
      error: `Max active fork children reached (${params.activeChildCount}/${cfg.maxChildrenPerAgent})`,
    };
  }

  return { allowed: true };
}

export const FORK_PLACEHOLDER_RESULT = "Fork started — processing in background";

export const FORK_BOILERPLATE_TAG = "fork-boilerplate";

export function buildForkChildMessage(directive: string): string {
  return `<${FORK_BOILERPLATE_TAG}>
STOP. READ THIS FIRST. You are a forked worker process. You are NOT the main agent.

HARD RULES (non-negotiable):
1. TASK SCOPE: Execute ONLY the directive below. Ignore everything else in context.
   Do NOT continue, restart, or resume any work from prior messages.
2. NO SPAWNING: Do NOT call the agent tool or spawn sub-agents. Execute directly with your tools (Bash, Read, Write, Edit, etc.).
3. NO CONVERSATION: Do not ask questions, suggest next steps, or add meta-commentary.
4. SILENT EXECUTION: Do not narrate tool calls. Use tools, then report once at the end.
5. SCOPE BOUNDARY: Stay strictly within your directive. Do not expand scope or do "bonus" work.
6. COMMIT CHANGES: If you modify files, commit before reporting. Include the commit hash.
7. STRUCTURED OUTPUT: Your response MUST follow the REQUIRED FORMAT below exactly.

REQUIRED OUTPUT FORMAT - Your response will be parsed programmatically:
  Scope: <one sentence echoing your assigned scope, max 100 chars>
  Result: <what was done or key findings, max 300 words>
  Key files: <comma-separated list of relevant file paths, or "none">
  Files changed: <comma-separated list with commit hash format "path (hash)", or "none">
  Issues: <comma-separated list of blockers, or "none">

IMPORTANT:
- Each field MUST be on its own line starting with the label (Scope:, Result:, etc.)
- Do NOT add extra text before "Scope:" or after the last field
- Use "none" (lowercase) for empty lists
- If you modified files, ALWAYS commit and include the hash in Files changed
</${FORK_BOILERPLATE_TAG}>

[FORK_DIRECTIVE]: ${directive}`;
}

export function buildForkedMessages(params: {
  assistantMessage: AgentMessage;
  directive: string;
  taskContext?: string;
}): AgentMessage[] {
  const { assistantMessage, directive, taskContext } = params;

  const rawContent = (assistantMessage as { content?: unknown }).content;
  const contentBlocks = Array.isArray(rawContent) ? rawContent : [];

  const fullAssistantMessage: AgentMessage = {
    ...assistantMessage,
    content: [...contentBlocks],
  } as AgentMessage;

  type ToolUseBlock = { type: "tool_use"; id: string; input: unknown; name: string };
  const toolUseBlocks = contentBlocks.filter(
    (block): block is ToolUseBlock =>
      typeof block === "object" &&
      block !== null &&
      (block as Record<string, unknown>).type === "tool_use",
  );

  const userContent: Array<{ type: "text"; text: string }> = [];

  if (taskContext) {
    userContent.push({ type: "text", text: taskContext });
    userContent.push({ type: "text", text: "" });
  }

  userContent.push({ type: "text", text: buildForkChildMessage(directive) });

  if (toolUseBlocks.length === 0) {
    return [
      fullAssistantMessage,
      {
        role: "user",
        content: userContent,
      } as unknown as AgentMessage,
    ];
  }

  const toolResultBlocks = toolUseBlocks.map((block: ToolUseBlock) => ({
    type: "tool_result" as const,
    tool_use_id: block.id,
    content: [
      {
        type: "text" as const,
        text: FORK_PLACEHOLDER_RESULT,
      },
    ],
  }));

  const toolResultMessage: AgentMessage = {
    role: "user",
    content: [...toolResultBlocks, ...userContent],
  } as unknown as AgentMessage;

  return [fullAssistantMessage, toolResultMessage];
}

export type ForkResult = {
  status: "completed" | "failed" | "cancelled" | "timeout";
  taskId: string;
  output?: string;
  error?: string;
  durationMs: number;
  tokenUsage?: { input: number; output: number };
  /**
   * Detailed breakdown of token usage across retry attempts (if retries occurred).
   * Each entry represents one attempt's token consumption.
   */
  tokenUsageHistory?: Array<{ input: number; output: number; attempt: number }>;
  /**
   * Number of retry attempts before success or final failure.
   * 0 means succeeded on first try.
   */
  retryCount?: number;
};

export type ForkTaskConfig = {
  id: string;
  directive: string;
  /**
   * Identifies the parent conversation turn (e.g. runId) that spawned this fork.
   * Prevents task scope bleed by isolating tasks to specific conversation turns.
   */
  conversationTurnId?: string;
  taskContext?: string;
  priority?: "high" | "medium" | "low";
  dependencies?: string[];
  timeoutMs?: number;
  depth?: number;
  parentSessionKey?: string;
  model?: string;
  thinking?: string;
  workspaceDir?: string;
  scratchpadDir?: string;
  /** Parent's rendered system prompt for prompt cache sharing (byte-identical prefix) */
  parentSystemPrompt?: string;
  /**
   * Optional tool allow-list inherited from parent agent.
   * When set, the fork child will only have access to these specific tools,
   * ensuring tool pool consistency with the parent context.
   */
  toolsAllow?: string[];
};

export type ForkExecutionHooks = {
  onLifecycleEvent?: (params: {
    phase: "start" | "progress" | "end" | "error";
    taskId: string;
    data?: Record<string, unknown>;
  }) => void;
  onComplete?: (result: ForkResult) => void;
};

export const NEVER_ABORT_CONTROLLER = new AbortController();
NEVER_ABORT_CONTROLLER.abort();

// Retry configuration for transient failures
const MAX_RETRIES = 3;
const RETRY_DELAYS = [1000, 2000, 4000]; // Exponential backoff: 1s, 2s, 4s

/**
 * Classifies errors into retryable vs non-retryable categories.
 * Retryable: network issues, rate limits, overloaded, timeouts
 * Non-retryable: auth failures, invalid params, permission denied
 */
function classifyError(error: string): { retryable: boolean; category: string; reason: string } {
  const lower = error.toLowerCase();

  // Network-related (retryable)
  if (
    lower.includes("network") ||
    lower.includes("econnrefused") ||
    lower.includes("econnreset") ||
    lower.includes("socket hang up")
  ) {
    return { retryable: true, category: "network", reason: "Transient network error" };
  }

  // Rate limit / overload (retryable with backoff)
  if (
    lower.includes("rate limit") ||
    lower.includes("too many requests") ||
    lower.includes("429") ||
    lower.includes("overloaded")
  ) {
    return {
      retryable: true,
      category: "rate_limit",
      reason: "Rate limited or service overloaded",
    };
  }

  // Timeout (retryable)
  if (lower.includes("timed out") || lower.includes("timeout")) {
    return { retryable: true, category: "timeout", reason: "Operation timed out" };
  }

  // Auth failures (non-retryable)
  if (
    lower.includes("unauthorized") ||
    lower.includes("401") ||
    lower.includes("authentication") ||
    lower.includes("invalid api key")
  ) {
    return { retryable: false, category: "auth", reason: "Authentication failed - check API key" };
  }

  // Permission/Access (non-retryable)
  if (
    lower.includes("forbidden") ||
    lower.includes("403") ||
    lower.includes("permission denied") ||
    lower.includes("access denied")
  ) {
    return {
      retryable: false,
      category: "permission",
      reason: "Permission denied - check access rights",
    };
  }

  // Invalid parameters (non-retryable)
  if (
    lower.includes("invalid") &&
    (lower.includes("parameter") || lower.includes("argument") || lower.includes("request"))
  ) {
    return { retryable: false, category: "invalid_params", reason: "Invalid request parameters" };
  }

  // Default: treat as potentially retryable for resilience
  return { retryable: true, category: "unknown", reason: "Unknown error - attempting retry" };
}

// Recursion guard: tracks how many fork tasks are currently executing in this process.
// Any code running while this counter > 0 is inside a fork child and must not spawn new forks.
let forkExecutionDepth = 0;

export function isForkExecutionActive(): boolean {
  return forkExecutionDepth > 0;
}

let embeddedRunnerResolve: (() => unknown) | null = null;

async function getEmbeddedRunner() {
  if (!embeddedRunnerResolve) {
    try {
      const mod = await import("../pi-embedded-runner/run.js");
      embeddedRunnerResolve = () => mod;
    } catch {
      embeddedRunnerResolve = () => null;
    }
  }
  return Promise.resolve(embeddedRunnerResolve());
}

export async function executeForkTask(
  task: ForkTaskConfig,
  forkMessages: AgentMessage[],
  abortSignal?: AbortSignal,
  hooks?: ForkExecutionHooks,
): Promise<ForkResult> {
  const startTime = Date.now();

  if (abortSignal?.aborted) {
    return {
      status: "cancelled",
      taskId: task.id,
      error: "Aborted before start",
      durationMs: Date.now() - startTime,
    };
  }

  if (!task.id || typeof task.id !== "string" || task.id.trim().length === 0) {
    return {
      status: "failed",
      taskId: task.id ?? "unknown",
      error: "Invalid task ID: must be a non-empty string",
      durationMs: Date.now() - startTime,
    };
  }

  if (!task.directive || typeof task.directive !== "string" || task.directive.trim().length === 0) {
    return {
      status: "failed",
      taskId: task.id,
      error: "Invalid directive: must be a non-empty string describing the task",
      durationMs: Date.now() - startTime,
    };
  }

  if (task.toolsAllow && (!Array.isArray(task.toolsAllow) || task.toolsAllow.length === 0)) {
    console.warn(
      `[fork-subagent] Task ${task.id}: toolsAllow should be a non-empty array of tool names. Ignoring empty/invalid toolsAllow.`,
    );
  }

  const timeoutMs = Math.max(1000, task.timeoutMs ?? resolveForkConfig().defaultTimeoutMs);
  const timeoutController = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  // Progress heartbeat: report task is still running every 30s
  const PROGRESS_HEARTBEAT_MS = 30_000;
  let progressId: ReturnType<typeof setInterval> | null = null;

  hooks?.onLifecycleEvent?.({ phase: "start", taskId: task.id });

  const cleanupTimeout = () => {
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
  };

  const cleanupProgress = () => {
    if (progressId !== null) {
      clearInterval(progressId);
      progressId = null;
    }
  };

  const _timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      timeoutController.abort();
      reject(new Error(`Fork task timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  const combinedAbort = AbortSignal.any([
    abortSignal ?? NEVER_ABORT_CONTROLLER.signal,
    timeoutController.signal,
  ]);

  // Worktree isolation
  const isolationMode = getForkIsolationMode();
  const effectiveWorkspaceDir = task.workspaceDir ?? process.cwd();
  let worktreeInfo: { path: string; name: string; isNew: boolean } | undefined;

  if (isolationMode !== "none") {
    try {
      worktreeInfo = await createAgentWorktree({
        repoPath: effectiveWorkspaceDir,
        worktreeName: `fork-${task.id}`,
      });
      console.log(
        `[fork-subagent] Worktree created for task ${task.id}: ${worktreeInfo.path} (isolation=${isolationMode})`,
      );
      task.workspaceDir = worktreeInfo.path;
    } catch (wtErr) {
      console.warn(
        `[fork-subagent] Worktree creation failed for task ${task.id}, using parent workspace directly: ${wtErr instanceof Error ? wtErr.message : String(wtErr)}`,
      );
    }
  }

  try {
    await import("node:fs").then((fs) => fs.promises.access(task.workspaceDir ?? process.cwd()));
  } catch {
    console.warn(
      `[fork-subagent] Workspace dir not accessible: ${task.workspaceDir}, falling back to cwd`,
    );
    task.workspaceDir = process.cwd();
  }

  // Start progress heartbeat
  progressId = setInterval(() => {
    hooks?.onLifecycleEvent?.({
      phase: "progress",
      taskId: task.id,
      data: { elapsed: Date.now() - startTime },
    });
  }, PROGRESS_HEARTBEAT_MS);
  if (progressId.unref) {
    progressId.unref();
  }

  try {
    const runnerModule = await getEmbeddedRunner();

    let result: ForkResult;
    let lastError: string | undefined;
    const tokenUsageHistory: Array<{ input: number; output: number; attempt: number }> = [];

    // Initialize with a default failed result to satisfy TypeScript's definite assignment
    result = {
      status: "failed",
      taskId: task.id,
      error: "Not executed",
      durationMs: 0,
    };

    // Retry loop with exponential backoff for transient failures
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        forkExecutionDepth++;
        try {
          if (
            runnerModule &&
            typeof (runnerModule as Record<string, unknown>).runEmbeddedPiAgent === "function"
          ) {
            result = await executeViaEmbeddedRunner(
              task,
              forkMessages,
              combinedAbort,
              runnerModule,
              hooks,
            );
          } else {
            result = await executeViaSubprocess(task, combinedAbort);
          }
        } finally {
          forkExecutionDepth--;
        }

        // Record token usage for this attempt (if available)
        if (result.tokenUsage) {
          tokenUsageHistory.push({
            input: result.tokenUsage.input,
            output: result.tokenUsage.output,
            attempt,
          });
        }

        // Emit progress event with token information
        if (result.tokenUsage) {
          hooks?.onLifecycleEvent?.({
            phase: "progress",
            taskId: task.id,
            data: {
              elapsed: Date.now() - startTime,
              tokenUsage: result.tokenUsage,
              totalTokens: result.tokenUsage.input + result.tokenUsage.output,
              attemptNumber: attempt + 1,
            },
          });
        }

        // Success - break out of retry loop
        if (result.status === "completed") {
          break;
        }

        // If non-completion status and we have retries left, check if error is retryable
        if (attempt < MAX_RETRIES && result.error) {
          const classification = classifyError(result.error);
          if (classification.retryable) {
            lastError = result.error;
            const delay = RETRY_DELAYS[attempt] || RETRY_DELAYS[RETRY_DELAYS.length - 1];
            console.warn(
              `[fork-subagent] Attempt ${attempt + 1}/${MAX_RETRIES + 1} failed for task ${task.id}: ${classification.category} - ${classification.reason}. Retrying in ${delay}ms...`,
            );
            hooks?.onLifecycleEvent?.({
              phase: "progress",
              taskId: task.id,
              data: {
                elapsed: Date.now() - startTime,
                retryAttempt: attempt + 1,
                maxRetries: MAX_RETRIES,
                errorCategory: classification.category,
              },
            });
            await new Promise((resolve) => setTimeout(resolve, delay));
            continue;
          }
        }

        // Non-retryable error or out of retries - use current result
        break;
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);

        // Check if abort signal was triggered (don't retry)
        if (combinedAbort.aborted) {
          const status: ForkResult["status"] =
            errorMsg.includes("timed out") || errorMsg === "The operation was aborted"
              ? "timeout"
              : "cancelled";
          cleanupTimeout();
          cleanupProgress();

          if (worktreeInfo?.isNew) {
            try {
              await removeAgentWorktree({
                repoPath: effectiveWorkspaceDir,
                worktreeName: `fork-${task.id}`,
                force: true,
              });
            } catch {
              // best effort cleanup
            }
          }

          return {
            status,
            taskId: task.id,
            error: errorMsg,
            durationMs: Date.now() - startTime,
          };
        }

        // Classify error for retry decision
        const classification = classifyError(errorMsg);
        lastError = errorMsg;

        if (attempt < MAX_RETRIES && classification.retryable) {
          const delay = RETRY_DELAYS[attempt] || RETRY_DELAYS[RETRY_DELAYS.length - 1];
          console.warn(
            `[fork-subagent] Attempt ${attempt + 1}/${MAX_RETRIES + 1} threw error for task ${task.id}: ${classification.category} - ${classification.reason}. Retrying in ${delay}ms...`,
          );
          hooks?.onLifecycleEvent?.({
            phase: "progress",
            taskId: task.id,
            data: {
              elapsed: Date.now() - startTime,
              retryAttempt: attempt + 1,
              maxRetries: MAX_RETRIES,
              errorCategory: classification.category,
              threw: true,
            },
          });
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }

        // Out of retries or non-retryable error
        const status: ForkResult["status"] =
          errorMsg.includes("timed out") || errorMsg === "The operation was aborted"
            ? "timeout"
            : "failed";

        cleanupTimeout();
        cleanupProgress();

        if (worktreeInfo?.isNew) {
          try {
            await removeAgentWorktree({
              repoPath: effectiveWorkspaceDir,
              worktreeName: `fork-${task.id}`,
              force: true,
            });
          } catch {
            // best effort cleanup
          }
        }

        const finalResult: ForkResult = {
          status,
          taskId: task.id,
          error: `${errorMsg}${lastError && lastError !== errorMsg ? ` (previous: ${lastError})` : ""}`,
          durationMs: Date.now() - startTime,
        };

        hooks?.onLifecycleEvent?.({
          phase: "error",
          taskId: task.id,
          data: { error: finalResult.error, attempts: attempt + 1 },
        });
        hooks?.onComplete?.(finalResult);

        return finalResult;
      }
    }

    cleanupTimeout();
    cleanupProgress();

    // Ensure result is defined (should always be set by this point)
    result = result ?? {
      status: "failed",
      taskId: task.id,
      error: "Unknown error - no result produced after retries",
      durationMs: Date.now() - startTime,
    };

    // Enrich final result with token usage history and retry count
    if (tokenUsageHistory.length > 0) {
      result.tokenUsageHistory = tokenUsageHistory;
      // Calculate total tokens across all attempts
      const totalInput = tokenUsageHistory.reduce((sum, entry) => sum + entry.input, 0);
      const totalOutput = tokenUsageHistory.reduce((sum, entry) => sum + entry.output, 0);
      // Update tokenUsage to reflect cumulative usage (or keep last attempt's usage)
      if (!result.tokenUsage) {
        result.tokenUsage = { input: totalInput, output: totalOutput };
      }
      // Record retry count (number of retries after first attempt)
      result.retryCount = Math.max(0, tokenUsageHistory.length - 1);
    }

    if (worktreeInfo?.isNew) {
      try {
        await removeAgentWorktree({
          repoPath: effectiveWorkspaceDir,
          worktreeName: `fork-${task.id}`,
          force: true,
        });
      } catch {
        // best effort cleanup
      }
    }

    hooks?.onLifecycleEvent?.({
      phase: result.status === "completed" ? "end" : "error",
      taskId: task.id,
      data: {
        status: result.status,
        durationMs: result.durationMs,
        tokenUsage: result.tokenUsage,
        retryCount: result.retryCount ?? 0,
      },
    });
    hooks?.onComplete?.(result);

    return result;
  } catch (err) {
    cleanupTimeout();
    cleanupProgress();

    if (worktreeInfo?.isNew) {
      try {
        await removeAgentWorktree({
          repoPath: effectiveWorkspaceDir,
          worktreeName: `fork-${task.id}`,
          force: true,
        });
      } catch {
        // best effort cleanup
      }
    }

    const errorMsg = err instanceof Error ? err.message : String(err);
    const status: ForkResult["status"] =
      errorMsg.includes("timed out") || errorMsg === "The operation was aborted"
        ? "timeout"
        : "failed";

    const result: ForkResult = {
      status,
      taskId: task.id,
      error: errorMsg,
      durationMs: Date.now() - startTime,
    };

    hooks?.onLifecycleEvent?.({ phase: "error", taskId: task.id, data: { error: errorMsg } });
    hooks?.onComplete?.(result);

    return result;
  }
}

async function executeViaEmbeddedRunner(
  task: ForkTaskConfig,
  forkMessages: AgentMessage[],
  abortSignal: AbortSignal,
  runnerModule: unknown,
  hooks?: ForkExecutionHooks,
): Promise<ForkResult> {
  const startTime = Date.now();

  // Record prompt cache sharing event for statistics
  const hasValidParentPrompt =
    typeof task.parentSystemPrompt === "string" && task.parentSystemPrompt.trim().length > 0;
  recordCacheEvent({
    hadParentSystemPrompt: hasValidParentPrompt,
    tokensSaved: hasValidParentPrompt ? Math.ceil(task.parentSystemPrompt!.length / 4) : undefined,
  });

  try {
    const runEmbeddedPiAgent = (runnerModule as Record<string, unknown>).runEmbeddedPiAgent as (
      params: Record<string, unknown>,
    ) => Promise<Record<string, unknown>>;

    const childSessionKey = `agent:fork:${task.id}:${crypto.randomUUID()}`;

    // Let the registry know the child session key for message injection
    hooks?.onLifecycleEvent?.({
      phase: "progress",
      taskId: task.id,
      data: { childSessionKey },
    });

    // Convert forkMessages (array of AgentMessage) to a flat prompt string.
    // The embedded runner expects `prompt` as a string, not a messages array.
    // We serialize the forked conversation into the prompt to preserve context.
    const promptParts: string[] = [];
    for (const msg of forkMessages) {
      const content = (msg as { content?: unknown }).content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (typeof block === "object" && block !== null) {
            const b = block as Record<string, unknown>;
            if (b.type === "text" && typeof b.text === "string") {
              promptParts.push(b.text);
            } else if (b.type === "tool_use") {
              const name = typeof b.name === "string" ? b.name : "unknown";
              const input = b.input != null ? JSON.stringify(b.input) : "{}";
              promptParts.push(`[ToolUse: ${name}(${input})]`);
            } else if (b.type === "tool_result") {
              const rawContent = b.content;
              let text: string;
              if (Array.isArray(rawContent)) {
                text = (rawContent as Array<Record<string, unknown>>)
                  .filter((c) => c.type === "text")
                  .map((c) => (typeof c.text === "string" ? c.text : ""))
                  .join("\n");
              } else if (typeof rawContent === "string") {
                text = rawContent;
              } else {
                text = rawContent != null ? JSON.stringify(rawContent) : "";
              }
              const toolId = typeof b.tool_use_id === "string" ? b.tool_use_id : "";
              promptParts.push(`[ToolResult for ${toolId}]: ${text.slice(0, 500)}`);
            }
          } else if (typeof block === "string") {
            promptParts.push(block);
          }
        }
      } else if (typeof content === "string") {
        promptParts.push(content);
      }
    }

    const isolationMode = getForkIsolationMode();
    const useSandbox = isolationMode === "sandbox";

    // Detect whether the prompt already contains the fork-boilerplate directive
    // (injected by buildForkChildMessage via buildForkedMessages). If so, skip
    // adding FORK_CHILD_SYSTEM_DIRECTIVE again to avoid duplicate instructions.
    const promptText = promptParts.join("\n\n");
    const promptHasForkDirective = promptText.includes(FORK_BOILERPLATE_TAG);

    const sessionResult = await runEmbeddedPiAgent({
      sessionKey: childSessionKey,
      prompt: promptText,
      mode: "run",
      model: task.model,
      thinking: task.thinking,
      workspaceDir: task.workspaceDir ?? process.cwd(),
      sandbox: useSandbox,
      abortSignal,
      trigger: "manual" as const,
      // Inherit tool pool from parent when available (ensures consistency)
      ...(task.toolsAllow && task.toolsAllow.length > 0 ? { toolsAllow: task.toolsAllow } : {}),
      parentSystemPrompt: task.parentSystemPrompt,
      // extraSystemPrompt: parent's system prompt (for cache prefix sharing) +
      // fork child directive (only if the prompt doesn't already contain it).
      extraSystemPrompt:
        [task.parentSystemPrompt, promptHasForkDirective ? undefined : FORK_CHILD_SYSTEM_DIRECTIVE]
          .filter(Boolean)
          .join("\n\n") || undefined,
    });

    const output = extractStructuredOutput(sessionResult);

    return {
      status: "completed",
      taskId: task.id,
      output,
      durationMs: Date.now() - startTime,
      tokenUsage: sessionResult.tokenUsage as ForkResult["tokenUsage"],
    };
  } catch (err) {
    return {
      status: "failed",
      taskId: task.id,
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - startTime,
    };
  }
}

async function executeViaSubprocess(
  task: ForkTaskConfig,
  abortSignal: AbortSignal,
): Promise<ForkResult> {
  const startTime = Date.now();

  // Record cache event for subprocess path (subprocess doesn't share prompt cache,
  // but we track it for complete statistics)
  recordCacheEvent({
    hadParentSystemPrompt: false, // Subprocess mode: no cache sharing
    tokensSaved: undefined,
  });

  console.warn(
    `[fork-subagent] Using subprocess fallback for task ${task.id}. ` +
      `This is slower than in-process mode and requires the openclaw CLI to be available. ` +
      `Ensure the embedded runner (runEmbeddedPiAgent) is properly configured for optimal performance.`,
  );

  try {
    try {
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const execFileAsync = promisify(execFile);

      const taskPrompt = buildSubprocessPrompt(task.directive, task.taskContext);

      const controller = new AbortController();
      const abortHandler = () => controller.abort();
      abortSignal.addEventListener("abort", abortHandler, { once: true });

      try {
        const nodeBin = process.argv[0] ?? "node";
        const cliEntry = process.argv[1] ?? "openclaw";

        if (!cliEntry || cliEntry === "openclaw") {
          console.error(
            `[fork-subagent] CRITICAL: Cannot resolve CLI entry point for subprocess execution. ` +
              `The embedded runner module may not be available. Falling back to direct execution.`,
          );
          return {
            status: "failed",
            taskId: task.id,
            error:
              "Subprocess fallback failed: unable to resolve CLI entry point. " +
              "Please ensure the embedded runner is properly configured.",
            durationMs: Date.now() - startTime,
          };
        }

        const { stdout, stderr } = await execFileAsync(
          nodeBin,
          [cliEntry, "dev", "--eval", taskPrompt],
          {
            cwd: task.workspaceDir ?? process.cwd(),
            timeout: task.timeoutMs ?? resolveForkConfig().defaultTimeoutMs,
            maxBuffer: 10 * 1024 * 1024,
            signal: controller.signal,
          },
        );

        if (stderr && !stderr.toLowerCase().includes("warning")) {
          return {
            status: "failed",
            taskId: task.id,
            error: stderr.trim(),
            durationMs: Date.now() - startTime,
          };
        }

        return {
          status: "completed",
          taskId: task.id,
          output: parseStructuredOutput(stdout),
          durationMs: Date.now() - startTime,
        };
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") {
          return {
            status: "cancelled",
            taskId: task.id,
            error: "Subprocess was aborted",
            durationMs: Date.now() - startTime,
          };
        }
        throw err;
      } finally {
        abortSignal.removeEventListener("abort", abortHandler);
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      return {
        status: "failed",
        taskId: task.id,
        error: `Subprocess error: ${errorMsg}`,
        durationMs: Date.now() - startTime,
      };
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    return {
      status: errorMsg.includes("aborted") || errorMsg.includes("timed out") ? "timeout" : "failed",
      taskId: task.id,
      error: errorMsg,
      durationMs: Date.now() - startTime,
    };
  }
}

function extractStructuredOutput(sessionResult: Record<string, unknown>): string {
  if (typeof sessionResult.text === "string") {
    return sessionResult.text;
  }
  if (typeof sessionResult.output === "string") {
    return sessionResult.output;
  }
  if (typeof sessionResult.content === "string") {
    return sessionResult.content;
  }
  if (Array.isArray(sessionResult.content)) {
    const textBlocks = sessionResult.content
      .filter(
        (b: unknown) =>
          typeof b === "object" && b !== null && (b as Record<string, unknown>).type === "text",
      )
      .map((b: unknown) => ((b as Record<string, unknown>).text as string) ?? "");
    return textBlocks.join("\n");
  }
  return JSON.stringify(sessionResult);
}

function buildSubprocessPrompt(directive: string, taskContext?: string): string {
  const parts: string[] = [];

  if (taskContext) {
    parts.push(`[Shared Context]\n${taskContext}\n`);
  }

  parts.push(`[Task]\n${directive}\n`);
  parts.push("\nExecute this task and report results:");
  parts.push("Scope: <one sentence>");
  parts.push("Result: <key findings>");
  parts.push("Key files: <paths>");
  parts.push("Files changed: <with commit hash>");
  parts.push("Issues: <any problems>");

  return parts.join("\n");
}

function parseStructuredOutput(raw: string): string {
  const scopeMatch = raw.match(/Scope:\s*(.+?)(?:\n|$)/s);
  const resultMatch = raw.match(/Result:\s*([\s\S]*?)(?=\n(?:Key files|Files changed|Issues)|$)/s);

  if (scopeMatch || resultMatch) {
    const sections: string[] = [];
    if (scopeMatch) {
      sections.push(`Scope: ${scopeMatch[1].trim()}`);
    }
    if (resultMatch) {
      sections.push(`Result: ${resultMatch[1].trim()}`);
    }

    const keyFilesMatch = raw.match(/Key files:\s*(.+?)(?:\n|$)/s);
    if (keyFilesMatch) {
      sections.push(`Key files: ${keyFilesMatch[1].trim()}`);
    }

    const filesChangedMatch = raw.match(/Files changed:\s*(.+?)(?:\n|$)/s);
    if (filesChangedMatch) {
      sections.push(`Files changed: ${filesChangedMatch[1].trim()}`);
    }

    const issuesMatch = raw.match(/Issues:\s*([\s\S]*)$/);
    if (issuesMatch) {
      sections.push(`Issues: ${issuesMatch[1].trim()}`);
    }

    return sections.join("\n\n");
  }

  return raw.slice(0, 8000);
}

export const __testing = {
  buildForkedMessages,
  FORK_PLACEHOLDER_RESULT,
  resolveForkConfig,
  checkForkDepthLimits,
  extractStructuredOutput,
  parseStructuredOutput,
};

// ============================================================================
// Unified Query Interface - Claude Code compatible query() function
// ============================================================================

export type QueryForkParams = {
  directive: string;
  taskContext?: string;
  parentAssistantMessage?: AgentMessage;
  parentSystemPrompt?: string;
  toolsAllow?: string[];
  model?: string;
  thinking?: string;
  workspaceDir?: string;
  scratchpadDir?: string;
  timeoutMs?: number;
  sessionKey?: string;
};

export type QueryForkResult = ForkResult & {
  executionPath: "embedded" | "subprocess";
  cacheSharingEnabled: boolean;
  retryCount: number;
};

/**
 * Unified query function for fork task execution (Claude Code compatible).
 *
 * This function provides a single entry point for executing fork tasks,
 * similar to Claude Code's `query()` function. It handles:
 * - Parameter validation and normalization
 * - Automatic selection of optimal execution path (embedded vs subprocess)
 * - Unified error handling and retry logic
 * - Structured result parsing
 * - Performance monitoring and cache statistics
 *
 * @param params - Query parameters for the fork task
 * @param abortSignal - Optional AbortSignal for cancellation
 * @returns QueryResult with structured output and metadata
 *
 * @example
 * ```typescript
 * const result = await queryForkTask({
 *   directive: "Refactor the auth module",
 *   parentAssistantMessage: currentMessage,
 *   parentSystemPrompt: systemPrompt,
 *   toolsAllow: ["read", "write", "edit", "exec"],
 * });
 *
 * if (result.status === "completed") {
 *   console.log(`Task completed in ${result.durationMs}ms`);
 *   console.log(`Cache sharing: ${result.cacheSharingEnabled}`);
 *   console.log(`Execution path: ${result.executionPath}`);
 * }
 * ```
 */
export async function queryForkTask(
  params: QueryForkParams,
  abortSignal?: AbortSignal,
): Promise<QueryForkResult> {
  const taskId = `query-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const startTime = Date.now();

  console.log(
    `[query-fork] Starting task ${taskId}: "${params.directive.slice(0, 80)}${params.directive.length > 80 ? "..." : ""}"`,
  );

  try {
    const forkMessages = params.parentAssistantMessage
      ? buildForkedMessages({
          assistantMessage: params.parentAssistantMessage,
          directive: params.directive,
          taskContext: params.taskContext,
        })
      : buildIsolatedMessages(params.directive, params.taskContext);

    const taskConfig: ForkTaskConfig = {
      id: taskId,
      directive: params.directive,
      taskContext: params.taskContext,
      model: params.model,
      thinking: params.thinking,
      workspaceDir: params.workspaceDir,
      scratchpadDir: params.scratchpadDir,
      timeoutMs: params.timeoutMs,
      parentSystemPrompt: params.parentSystemPrompt,
      toolsAllow: params.toolsAllow,
    };

    const hooks: ForkExecutionHooks = {
      onLifecycleEvent: (evt) => {
        if (evt.phase === "start") {
          console.log(`[query-fork] Task ${taskId} started (execution path will be determined)`);
        } else if (evt.phase === "progress" && evt.data?.elapsed) {
          const elapsed = evt.data.elapsed as number;
          console.log(
            `[query-fork] Task ${taskId} in progress: ${elapsed}ms elapsed`,
            evt.data.tokenUsage ? `, tokens: ${JSON.stringify(evt.data.tokenUsage)}` : "",
          );
        }
      },
    };

    const result = await executeForkTask(taskConfig, forkMessages, abortSignal, hooks);

    const queryResult: QueryForkResult = {
      ...result,
      executionPath: determineExecutionPath(result),
      cacheSharingEnabled: !!params.parentSystemPrompt,
      retryCount: result.retryCount ?? 0,
    };

    const durationMs = Date.now() - startTime;
    console.log(
      `[query-fork] Task ${taskId} completed: status=${queryResult.status}, ` +
        `duration=${durationMs}ms, path=${queryResult.executionPath}, ` +
        `cache=${queryResult.cacheSharingEnabled}, retries=${queryResult.retryCount}`,
    );

    return queryResult;
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`[query-fork] Task ${taskId} failed with unhandled error: ${errorMsg}`);

    return {
      status: "failed",
      taskId,
      error: errorMsg,
      durationMs: Date.now() - startTime,
      executionPath: "subprocess",
      cacheSharingEnabled: false,
      retryCount: 0,
    };
  }
}

function buildIsolatedMessages(directive: string, taskContext?: string): AgentMessage[] {
  const contentParts: Array<{ type: "text"; text: string }> = [];

  if (taskContext) {
    contentParts.push({ type: "text", text: `[Shared Context]\n${taskContext}\n` });
  }

  contentParts.push({
    type: "text",
    text: `[Task Directive]\n${directive}\n\nExecute this task and report results.`,
  });

  return [{ role: "user", content: contentParts } as unknown as AgentMessage];
}

function determineExecutionPath(result: ForkResult): "embedded" | "subprocess" {
  if (result.error?.includes("subprocess") || result.error?.includes("CLI")) {
    return "subprocess";
  }
  return "embedded";
}
