import crypto from "node:crypto";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { loadConfig } from "../../config/config.js";
import { createAgentWorktree, removeAgentWorktree } from "./fork-worktree.js";

export const FORK_ENABLED = process.env.OPENCLAW_ENABLE_FORK_SUBAGENT !== "0";
export const CACHE_SHARING_ENABLED = process.env.OPENCLAW_ENABLE_FORK_CACHE_SHARING !== "0";
export const FORK_MAX_CONCURRENT = parseInt(process.env.OPENCLAW_FORK_MAX_CONCURRENT ?? "5", 10);
export const FORK_ISOLATION_MODE = process.env.OPENCLAW_FORK_ISOLATION_MODE ?? "sandbox";

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
};

export type ForkTaskConfig = {
  id: string;
  directive: string;
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
};

export type ForkSpawnContext = {
  parentSessionKey: string;
  assistantMessage: AgentMessage;
  taskId: string;
  directive: string;
  taskContext?: string;
  workspaceDir?: string;
  scratchpadDir?: string;
  depth?: number;
  model?: string;
  thinking?: string;
  priority?: "high" | "medium" | "low";
  timeoutMs?: number;
  parentAbortSignal?: AbortSignal;
  announceOnComplete?: boolean;
  /** Optional isolated messages to use instead of building from assistantMessage */
  messages?: AgentMessage[];
  /** Parent's rendered system prompt for prompt cache sharing */
  parentSystemPrompt?: string;
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

  hooks?.onLifecycleEvent?.({ phase: "start", taskId: task.id });

  const timeoutMs = task.timeoutMs ?? resolveForkConfig().defaultTimeoutMs;
  const timeoutController = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  // Progress heartbeat: report task is still running every 30s
  const PROGRESS_HEARTBEAT_MS = 30_000;
  let progressId: ReturnType<typeof setInterval> | null = null;

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

    forkExecutionDepth++;
    try {
      if (
        runnerModule &&
        typeof (runnerModule as Record<string, unknown>).runEmbeddedPiAgent === "function"
      ) {
        result = await executeViaEmbeddedRunner(task, forkMessages, combinedAbort, runnerModule);
      } else {
        result = await executeViaSubprocess(task, combinedAbort);
      }
    } finally {
      forkExecutionDepth--;
    }

    cleanupTimeout();
    cleanupProgress();

    hooks?.onLifecycleEvent?.({
      phase: result.status === "completed" ? "end" : "error",
      taskId: task.id,
      data: { status: result.status, durationMs: result.durationMs },
    });
    hooks?.onComplete?.(result);

    return result;
  } catch (err) {
    cleanupTimeout();
    cleanupProgress();

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
): Promise<ForkResult> {
  const startTime = Date.now();

  try {
    const runEmbeddedPiAgent = (runnerModule as Record<string, unknown>).runEmbeddedPiAgent as (
      params: Record<string, unknown>,
    ) => Promise<Record<string, unknown>>;

    const childSessionKey = `agent:fork:${task.id}:${crypto.randomUUID()}`;

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

    const sessionResult = await runEmbeddedPiAgent({
      sessionKey: childSessionKey,
      prompt: promptParts.join("\n\n"),
      mode: "run",
      model: task.model,
      thinking: task.thinking,
      workspaceDir: task.workspaceDir ?? process.cwd(),
      sandbox: useSandbox,
      abortSignal,
      trigger: "manual" as const,
      // Pass parent's system prompt for cache-identical API prefix when available
      ...(task.parentSystemPrompt ? { extraSystemPrompt: task.parentSystemPrompt } : {}),
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

  try {
    const isolationMode = getForkIsolationMode();

    const worktreeInfo = await createAgentWorktree({
      repoPath: task.workspaceDir ?? process.cwd(),
      worktreeName: `fork-${task.id}`,
    });

    try {
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const execFileAsync = promisify(execFile);

      const taskPrompt = buildSubprocessPrompt(task.directive, task.taskContext);

      const controller = new AbortController();
      const abortHandler = () => controller.abort();
      abortSignal.addEventListener("abort", abortHandler, { once: true });

      try {
        const { stdout, stderr } = await execFileAsync(
          process.argv[0] ?? "node",
          [process.argv[1] ?? "openclaw", "dev", "--eval", taskPrompt],
          {
            cwd: worktreeInfo.path,
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
      } finally {
        abortSignal.removeEventListener("abort", abortHandler);
      }
    } finally {
      if (worktreeInfo.isNew && isolationMode !== "none") {
        try {
          await removeAgentWorktree({
            repoPath: task.workspaceDir ?? process.cwd(),
            worktreeName: `fork-${task.id}`,
            force: true,
          });
        } catch {
          // best-effort cleanup
        }
      }
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
