import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { createIsolatedSpawnContext } from "../subagent-isolation.js";
import { getForkRegistry, startForkRegistryCleanup, type ForkSession } from "./fork-registry.js";
import {
  buildForkedMessages,
  executeForkTask,
  isForkSubagentEnabled,
  resolveForkConfig,
  checkForkDepthLimits,
  FORK_BOILERPLATE_TAG,
  NEVER_ABORT_CONTROLLER,
  type ForkResult,
  type ForkExecutionHooks,
} from "./fork-subagent-core.js";

let cleanupStarted = false;

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
    const forkMessages = buildForkedMessages({
      assistantMessage: ctx.assistantMessage,
      directive: ctx.directive,
      taskContext: ctx.taskContext,
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
            announceResult = await announceForkCompletion({
              parentSessionKey: ctx.parentSessionKey,
              childSessionKey: `fork:${forkSession.forkId}`,
              taskId: ctx.taskId,
              directive: ctx.directive,
              output: result.output ?? "",
              status: result.status,
              durationMs: result.durationMs,
              tokenUsage: result.tokenUsage,
            });
          } catch (announceErr) {
            announceResult = {
              announced: false,
              error: announceErr instanceof Error ? announceErr.message : String(announceErr),
            };
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

    const statsLine = [
      `duration=${((params.durationMs ?? 0) / 1000).toFixed(1)}s`,
      params.tokenUsage
        ? `tokens=${params.tokenUsage.input + params.tokenUsage.output}`
        : undefined,
    ]
      .filter(Boolean)
      .join(", ");

    const triggerMessage = [
      `[Fork Task Complete]`,
      ``,
      `**Task**: ${params.taskId}`,
      `**Directive**: ${params.directive.slice(0, 200)}${params.directive.length > 200 ? "..." : ""}`,
      `**Status**: ${params.status}`,
      statsLine ? `**Stats**: ${statsLine}` : "",
      ``,
      `---`,
      ``,
      params.output || "(no output)",
    ]
      .filter(Boolean)
      .join("\n");

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
