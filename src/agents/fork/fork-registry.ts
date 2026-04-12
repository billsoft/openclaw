import crypto from "node:crypto";

export type ForkSessionStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "timeout";

export type ForkLifecyclePhase = "start" | "end" | "error";

export interface ForkLifecycleEvent {
  phase: ForkLifecyclePhase;
  forkId: string;
  taskId: string;
  timestamp: number;
  data?: Record<string, unknown>;
}

export interface ForkSession {
  forkId: string;
  parentSessionKey: string;
  taskId: string;
  status: ForkSessionStatus;
  depth?: number;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  result?: string;
  error?: string;
  cacheKey?: string;
  tokenUsage?: { input: number; output: number };
  durationMs?: number;
  abortController?: AbortController;
  lifecycleEvents: ForkLifecycleEvent[];
}

export interface ForkRegistryOptions {
  maxHistorySize?: number;
  defaultTtlMs?: number;
  onSessionComplete?: (session: ForkSession) => void;
  onSessionTimeout?: (session: ForkSession) => void;
}

const DEFAULT_MAX_HISTORY = 1000;
const DEFAULT_TTL_MS = 3_600_000;

class ForkRegistry {
  private sessions = new Map<string, ForkSession>();
  private parentToForks = new Map<string, Set<string>>();
  private options: Required<ForkRegistryOptions>;

  constructor(options?: ForkRegistryOptions) {
    this.options = {
      maxHistorySize: options?.maxHistorySize ?? DEFAULT_MAX_HISTORY,
      defaultTtlMs: options?.defaultTtlMs ?? DEFAULT_TTL_MS,
      onSessionComplete: options?.onSessionComplete ?? (() => {}),
      onSessionTimeout: options?.onSessionTimeout ?? (() => {}),
    };
  }

  registerFork(params: {
    parentSessionKey: string;
    taskId: string;
    cacheKey?: string;
    depth?: number;
  }): ForkSession {
    if (this.sessions.size >= this.options.maxHistorySize) {
      this.evictOldestCompleted();
    }

    const forkId = `fork:${crypto.randomUUID()}`;
    const now = Date.now();

    const session: ForkSession = {
      forkId,
      parentSessionKey: params.parentSessionKey,
      taskId: params.taskId,
      status: "pending",
      createdAt: now,
      cacheKey: params.cacheKey,
      depth: params.depth,
      abortController: new AbortController(),
      lifecycleEvents: [{ phase: "start", forkId, taskId: params.taskId, timestamp: now }],
    };

    this.sessions.set(forkId, session);

    let forks = this.parentToForks.get(params.parentSessionKey);
    if (!forks) {
      forks = new Set();
      this.parentToForks.set(params.parentSessionKey, forks);
    }
    forks.add(forkId);

    return session;
  }

  updateForkStatus(
    forkId: string,
    status: ForkSessionStatus,
    extra?: Partial<
      Omit<ForkSession, "forkId" | "parentSessionKey" | "taskId" | "createdAt" | "lifecycleEvents">
    >,
  ): void {
    const session = this.sessions.get(forkId);
    if (!session) {
      return;
    }

    const prevStatus = session.status;
    session.status = status;

    const now = Date.now();

    if (status === "running" && !session.startedAt) {
      session.startedAt = now;
      session.lifecycleEvents.push({
        phase: "start",
        forkId,
        taskId: session.taskId,
        timestamp: now,
        data: { reason: "execution_started" },
      });
    }

    if (
      (status === "completed" ||
        status === "failed" ||
        status === "cancelled" ||
        status === "timeout") &&
      prevStatus !== "completed" &&
      prevStatus !== "failed" &&
      prevStatus !== "cancelled" &&
      prevStatus !== "timeout"
    ) {
      session.endedAt = now;
      session.durationMs = now - (session.startedAt ?? session.createdAt);

      const phase: ForkLifecyclePhase =
        status === "completed" ? "end" : status === "timeout" ? "error" : "error";

      session.lifecycleEvents.push({
        phase,
        forkId,
        taskId: session.taskId,
        timestamp: now,
        data: { status, durationMs: session.durationMs },
      });

      if (status === "completed") {
        this.options.onSessionComplete(session);
      } else if (status === "timeout") {
        this.options.onSessionTimeout(session);
      }
    }

    if (extra) {
      Object.assign(session, extra);
    }
  }

  recordLifecycleEvent(
    forkId: string,
    event: Omit<ForkLifecycleEvent, "forkId" | "timestamp">,
  ): void {
    const session = this.sessions.get(forkId);
    if (!session) {
      return;
    }

    session.lifecycleEvents.push({
      ...event,
      forkId,
      timestamp: Date.now(),
    });
  }

  getAbortController(forkId: string): AbortController | undefined {
    return this.sessions.get(forkId)?.abortController;
  }

  abortFork(forkId: string): boolean {
    const session = this.sessions.get(forkId);
    if (!session) {
      return false;
    }

    if (
      session.status === "completed" ||
      session.status === "failed" ||
      session.status === "cancelled" ||
      session.status === "timeout"
    ) {
      return false;
    }

    session.abortController?.abort();
    this.updateForkStatus(forkId, "cancelled", {
      error: "Aborted by parent or timeout",
    });

    return true;
  }

  abortAllForParent(parentSessionKey: string): number {
    const forks = this.getForksForParent(parentSessionKey).filter(
      (s) => s.status === "pending" || s.status === "running",
    );
    let aborted = 0;
    for (const fork of forks) {
      if (this.abortFork(fork.forkId)) {
        aborted++;
      }
    }
    return aborted;
  }

  getFork(forkId: string): ForkSession | undefined {
    return this.sessions.get(forkId);
  }

  getForksForParent(parentSessionKey: string): ForkSession[] {
    const forkIds = this.parentToForks.get(parentSessionKey);
    if (!forkIds) {
      return [];
    }
    return Array.from(forkIds)
      .map((id) => this.sessions.get(id))
      .filter((s): s is ForkSession => s !== undefined);
  }

  getActiveForkCount(parentSessionKey: string): number {
    return this.getForksForParent(parentSessionKey).filter(
      (s) => s.status === "pending" || s.status === "running",
    ).length;
  }

  getGlobalActiveCount(): number {
    let count = 0;
    for (const session of this.sessions.values()) {
      if (session.status === "pending" || session.status === "running") {
        count++;
      }
    }
    return count;
  }

  removeFork(forkId: string): void {
    const session = this.sessions.get(forkId);
    if (!session) {
      return;
    }

    session.abortController?.abort();
    this.sessions.delete(forkId);

    const forks = this.parentToForks.get(session.parentSessionKey);
    if (forks) {
      forks.delete(forkId);
      if (forks.size === 0) {
        this.parentToForks.delete(session.parentSessionKey);
      }
    }
  }

  cleanup(maxAgeMs?: number): number {
    const ttl = maxAgeMs ?? this.options.defaultTtlMs;
    const now = Date.now();
    let removed = 0;

    for (const [forkId, session] of this.sessions) {
      const isTerminal =
        session.status === "completed" ||
        session.status === "failed" ||
        session.status === "cancelled" ||
        session.status === "timeout";

      if (isTerminal && session.endedAt && now - session.endedAt > ttl) {
        this.removeFork(forkId);
        removed++;
      }
    }

    return removed;
  }

  private evictOldestCompleted(): void {
    let oldestId: string | null = null;
    let oldestTime = Infinity;

    for (const [id, session] of this.sessions) {
      const isTerminal =
        session.status === "completed" ||
        session.status === "failed" ||
        session.status === "cancelled" ||
        session.status === "timeout";

      if (isTerminal && session.endedAt && session.endedAt < oldestTime) {
        oldestTime = session.endedAt;
        oldestId = id;
      }
    }

    if (oldestId) {
      this.removeFork(oldestId);
    }
  }

  getAllActive(): ForkSession[] {
    return Array.from(this.sessions.values()).filter(
      (s) => s.status === "pending" || s.status === "running",
    );
  }

  getAll(): ForkSession[] {
    return Array.from(this.sessions.values());
  }

  getStats(): {
    total: number;
    active: number;
    completed: number;
    failed: number;
    cancelled: number;
    timeout: number;
    totalDurationMs: number;
    avgDurationMs: number;
  } {
    let completed = 0;
    let failed = 0;
    let cancelled = 0;
    let timedOut = 0;
    let totalDuration = 0;
    let finishedCount = 0;

    for (const session of this.sessions.values()) {
      switch (session.status) {
        case "completed":
          completed++;
          break;
        case "failed":
          failed++;
          break;
        case "cancelled":
          cancelled++;
          break;
        case "timeout":
          timedOut++;
          break;
      }

      if (session.durationMs !== undefined) {
        totalDuration += session.durationMs;
        finishedCount++;
      }
    }

    const active = this.getAllActive().length;

    return {
      total: this.sessions.size,
      active,
      completed,
      failed,
      cancelled,
      timeout: timedOut,
      totalDurationMs: totalDuration,
      avgDurationMs: finishedCount > 0 ? Math.round(totalDuration / finishedCount) : 0,
    };
  }

  findStuckForks(stuckThresholdMs = 600_000): ForkSession[] {
    const now = Date.now();
    const stuck: ForkSession[] = [];

    for (const session of this.sessions.values()) {
      if (session.status === "running" && session.startedAt) {
        if (now - session.startedAt > stuckThresholdMs) {
          stuck.push(session);
        }
      } else if (session.status === "pending") {
        if (now - session.createdAt > stuckThresholdMs) {
          stuck.push(session);
        }
      }
    }

    return stuck;
  }
}

const forkRegistry = new ForkRegistry();

export function getForkRegistry(): ForkRegistry {
  return forkRegistry;
}

let cleanupTimer: ReturnType<typeof setInterval> | null = null;

export function startForkRegistryCleanup(intervalMs = 60_000): void {
  if (cleanupTimer) {
    return;
  }

  cleanupTimer = setInterval(() => {
    try {
      const removed = forkRegistry.cleanup();
      const stuck = forkRegistry.findStuckForks();

      for (const s of stuck) {
        forkRegistry.abortFork(s.forkId);
      }

      if (removed > 0 || stuck.length > 0) {
        // Silent cleanup - only log in debug mode
      }
    } catch {
      // Best-effort cleanup
    }
  }, intervalMs);

  if (cleanupTimer.unref) {
    cleanupTimer.unref();
  }
}

export function stopForkRegistryCleanup(): void {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
}
