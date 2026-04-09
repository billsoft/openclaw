import crypto from "node:crypto";
import { logDebug } from "../logger.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

export type SharedPromptCacheEntry = {
  cacheKey: string;
  provider: string;
  modelId: string;
  systemPromptHash: string;
  toolDefinitionsHash: string;
  cachedContentRef: string;
  createdAt: number;
  lastUsedAt: number;
  hitCount: number;
  estimatedSavingsUsd: number;
  ttlExpiresAt: number;
  retention: "short" | "long";
  sessionIds: Set<string>;
};

export type SharedPromptCacheStats = {
  totalEntries: number;
  activeEntries: number;
  totalHits: number;
  totalSavedUsd: number;
  hitRate: number;
};

export type SharedPromptCacheManager = {
  getOrCreate(params: {
    provider: string;
    modelId: string;
    systemPrompt: string;
    toolNames: string[];
    retention?: "none" | "short" | "long";
  }): Promise<SharedPromptCacheEntry>;

  acquire(sessionId: string, entry: SharedPromptCacheEntry): void;
  release(sessionId: string, cacheKey: string): void;

  /**
   * Record actual cache-read tokens returned by the provider for a given session.
   * Accumulates `estimatedSavingsUsd` on every active entry that session holds.
   * Call once per LLM turn, after receiving the usage object from the API response.
   */
  recordCacheRead(sessionId: string, cacheReadTokens: number): void;

  invalidate(cacheKey: string): void;
  invalidateBySession(sessionId: string): void;

  getStats(): SharedPromptCacheStats;

  startCleanup(intervalMs?: number): void;
  stopCleanup(): void;
  dispose(): Promise<void>;
};

const SHORT_TTL_MS = 300_000;
const LONG_TTL_MS = 3_600_000;
const CLEANUP_INTERVAL_MS = 60_000;
const MAX_ENTRIES = 200;

const COST_PER_1M_INPUT_TOKENS_USD: Record<string, number> = {
  anthropic: 3.0,
  "anthropic-vertex": 3.0,
  "amazon-bedrock": 2.8,
  google: 0.125,
  "google-generative-ai": 0.125,
  openai: 2.5,
};

function computeHash(data: string): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function generateCacheKey(params: {
  provider: string;
  modelId: string;
  systemPromptHash: string;
  toolDefinitionsHash: string;
}): string {
  const raw = `${params.provider}|${params.modelId}|${params.systemPromptHash}|${params.toolDefinitionsHash}`;
  return computeHash(raw);
}

const SHARED_CACHE_MANAGER_KEY = Symbol.for("openclaw.sharedPromptCacheManager");

function createSharedPromptCacheManager(): SharedPromptCacheManager {
  const entries = new Map<string, SharedPromptCacheEntry>();
  let cleanupTimer: ReturnType<typeof setInterval> | null = null;
  let disposed = false;

  function evictExpiredEntries(): void {
    const now = Date.now();
    for (const [key, entry] of entries) {
      if (now > entry.ttlExpiresAt && entry.sessionIds.size === 0) {
        entries.delete(key);
        logDebug(`shared-prompt-cache: evicted expired entry ${key}`);
      }
    }

    if (entries.size > MAX_ENTRIES) {
      const sorted = Array.from(entries.entries()).toSorted(
        (a, b) => a[1].lastUsedAt - b[1].lastUsedAt,
      );

      const toEvict = sorted.slice(0, entries.size - MAX_ENTRIES);
      for (const [key, entry] of toEvict) {
        if (entry.sessionIds.size === 0) {
          entries.delete(key);
          logDebug(`shared-prompt-cache: evicted LRU entry ${key}`);
        }
      }
    }
  }

  return {
    async getOrCreate(params) {
      if (disposed) {
        throw new Error("shared prompt cache manager is disposed");
      }

      const retention = params.retention ?? "short";
      if (retention === "none") {
        return {
          cacheKey: "no-cache",
          provider: params.provider,
          modelId: params.modelId,
          systemPromptHash: "",
          toolDefinitionsHash: "",
          cachedContentRef: "",
          createdAt: Date.now(),
          lastUsedAt: Date.now(),
          hitCount: 0,
          estimatedSavingsUsd: 0,
          ttlExpiresAt: 0,
          retention: "short",
          sessionIds: new Set(),
        };
      }

      const systemPromptHash = computeHash(params.systemPrompt);
      const toolDefinitionsHash = computeHash(JSON.stringify([...params.toolNames].toSorted()));

      const cacheKey = generateCacheKey({
        provider: params.provider,
        modelId: params.modelId,
        systemPromptHash,
        toolDefinitionsHash,
      });

      const existing = entries.get(cacheKey);
      if (existing) {
        existing.lastUsedAt = Date.now();
        existing.hitCount += 1;
        return existing;
      }

      const ttlMs = retention === "long" ? LONG_TTL_MS : SHORT_TTL_MS;

      const now = Date.now();

      const entry: SharedPromptCacheEntry = {
        cacheKey,
        provider: params.provider,
        modelId: params.modelId,
        systemPromptHash,
        toolDefinitionsHash,
        cachedContentRef: `shared-${cacheKey.slice(0, 16)}-${now.toString(36)}`,
        createdAt: now,
        lastUsedAt: now,
        hitCount: 1,
        estimatedSavingsUsd: 0,
        ttlExpiresAt: now + ttlMs,
        retention,
        sessionIds: new Set(),
      };

      entries.set(cacheKey, entry);
      logDebug(
        `shared-prompt-cache: created entry ${cacheKey.slice(0, 16)}... for ${params.provider}/${params.modelId}`,
      );

      return entry;
    },

    acquire(sessionId, entry) {
      if (disposed) {
        return;
      }
      entry.sessionIds.add(sessionId);
      entry.lastUsedAt = Date.now();
      entry.hitCount += 1;
    },

    release(sessionId, cacheKey) {
      if (disposed) {
        return;
      }
      const entry = entries.get(cacheKey);
      if (entry) {
        entry.sessionIds.delete(sessionId);
      }
    },

    recordCacheRead(sessionId, cacheReadTokens) {
      if (disposed || cacheReadTokens <= 0) {
        return;
      }
      // Find the entries this session is actively holding and credit savings.
      for (const [, entry] of entries) {
        if (!entry.sessionIds.has(sessionId)) {
          continue;
        }
        const costPerM =
          COST_PER_1M_INPUT_TOKENS_USD[entry.provider] ?? COST_PER_1M_INPUT_TOKENS_USD.anthropic;
        // Cache reads are billed at 10% of normal input price for Anthropic;
        // use a 0.1 multiplier as a conservative cross-provider approximation.
        const savedPerM = costPerM * 0.9; // savings = full cost minus cache-read cost (~10%)
        entry.estimatedSavingsUsd += (cacheReadTokens / 1_000_000) * savedPerM;
        logDebug(
          `shared-prompt-cache: recorded ${cacheReadTokens} cache-read tokens for session ${sessionId} ` +
            `(entry ${entry.cacheKey.slice(0, 16)}..., total saved $${entry.estimatedSavingsUsd.toFixed(4)})`,
        );
      }
    },

    invalidate(cacheKey) {
      const entry = entries.get(cacheKey);
      if (entry) {
        entry.ttlExpiresAt = 0;
        logDebug(`shared-prompt-cache: invalidated ${cacheKey.slice(0, 16)}...`);
      }
    },

    invalidateBySession(sessionId) {
      let count = 0;
      for (const [, entry] of entries) {
        if (entry.sessionIds.has(sessionId)) {
          entry.sessionIds.delete(sessionId);
          count++;
        }
      }
      logDebug(`shared-prompt-cache: invalidated ${count} entries for session ${sessionId}`);
    },

    getStats() {
      let totalHits = 0;
      let totalSaved = 0;
      let activeEntries = 0;

      for (const [, entry] of entries) {
        totalHits += entry.hitCount;
        totalSaved += entry.estimatedSavingsUsd;
        if (entry.sessionIds.size > 0) {
          activeEntries++;
        }
      }

      return {
        totalEntries: entries.size,
        activeEntries,
        totalHits,
        totalSavedUsd: totalSaved,
        hitRate:
          totalHits > 0 ? Math.round(((totalHits - entries.size) / totalHits) * 10000) / 100 : 0,
      };
    },

    startCleanup(intervalMs = CLEANUP_INTERVAL_MS) {
      this.stopCleanup();
      cleanupTimer = setInterval(() => {
        evictExpiredEntries();
      }, intervalMs);
      if (cleanupTimer.unref) {
        cleanupTimer.unref();
      }
    },

    stopCleanup() {
      if (cleanupTimer) {
        clearInterval(cleanupTimer);
        cleanupTimer = null;
      }
    },

    async dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      this.stopCleanup();
      entries.clear();
    },
  };
}

export function getSharedPromptCacheManager(): SharedPromptCacheManager {
  return resolveGlobalSingleton(SHARED_CACHE_MANAGER_KEY, createSharedPromptCacheManager);
}

export function estimateSavings(
  systemPromptLength: number,
  toolsSchemaLength: number,
  hitCount: number,
  provider: string,
): number {
  const totalTokens = Math.ceil((systemPromptLength + toolsSchemaLength) / 4);
  const costPerM = COST_PER_1M_INPUT_TOKENS_USD[provider] ?? COST_PER_1M_INPUT_TOKENS_USD.anthropic;
  return (totalTokens / 1_000_000) * costPerM * hitCount;
}

export type WarmupResult = {
  warmedEntries: number;
  reusedEntries: number;
  newEntries: number;
  estimatedPreWarmingSavingsUsd: number;
};
