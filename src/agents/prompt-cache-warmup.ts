import { logDebug } from "../logger.js";
import type { WarmupResult } from "./prompt-cache-shared.js";

export type WarmupParams = {
  sessionIds: string[];
  sharedContext: {
    systemPrompt: string;
    toolNames: string[];
    provider: string;
    modelId: string;
  };
  retention?: "short" | "long";
};

export async function warmupSharedCaches(params: WarmupParams): Promise<WarmupResult> {
  const { getSharedPromptCacheManager } = await import("./prompt-cache-shared.js");
  const manager = getSharedPromptCacheManager();

  const retention = params.retention ?? "short";
  let warmedEntries = 0;
  let reusedEntries = 0;
  let newEntries = 0;

  for (const sessionId of params.sessionIds) {
    try {
      const entry = await manager.getOrCreate({
        provider: params.sharedContext.provider,
        modelId: params.sharedContext.modelId,
        systemPrompt: params.sharedContext.systemPrompt,
        toolNames: params.sharedContext.toolNames,
        retention,
      });

      if (entry.hitCount === 1) {
        newEntries++;
      } else {
        reusedEntries++;
      }

      manager.acquire(sessionId, entry);
      warmedEntries++;

      logDebug(
        `prompt-cache-warmup: warmed ${entry.cacheKey.slice(0, 16)}... for session ${sessionId}`,
      );
    } catch (error) {
      logDebug(`prompt-cache-warmup: failed for session ${sessionId}: ${String(error)}`);
    }
  }

  const stats = manager.getStats();

  return {
    warmedEntries,
    reusedEntries,
    newEntries,
    estimatedPreWarmingSavingsUsd: stats.totalSavedUsd,
  };
}

export async function prewarmBeforeParallelSpawn(
  sessionIds: string[],
  systemPrompt: string,
  toolNames: string[],
  provider: string,
  modelId: string,
): Promise<WarmupResult> {
  return warmupSharedCaches({
    sessionIds,
    sharedContext: {
      systemPrompt,
      toolNames,
      provider,
      modelId,
    },
    retention: "long",
  });
}
