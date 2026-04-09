/**
 * State isolation utilities for parallel subagent execution.
 * Ensures subagents don't interfere with each other or pollute parent state.
 * Adapted from claude-code/utils/forkedAgent.ts
 */

import path from "node:path";

/**
 * Isolated execution context for a parallel worker.
 * Ensures state isolation between concurrent workers.
 */
export type IsolatedSpawnContext = {
  /** Clone of parent's abort controller, linked for propagation */
  abortController: AbortController;
  /** Isolated scratchpad sub-directory for this specific task */
  taskScratchDir?: string;
  /** Prevents writes to parent session store */
  readOnlyParentState: boolean;
  /** Task-specific identifier for tracking */
  taskId: string;
};

/**
 * Create an isolated execution context for a parallel worker.
 * 
 * @param parentAbort - Parent's abort controller (for propagation)
 * @param taskId - Unique identifier for this task
 * @param scratchpadDir - Shared scratchpad directory (optional)
 * @returns Isolated context for this worker
 */
export function createIsolatedSpawnContext(
  parentAbort: AbortController,
  taskId: string,
  scratchpadDir?: string,
): IsolatedSpawnContext {
  // Create child abort controller
  const childAbort = new AbortController();

  // Parent abort propagates to child
  // This ensures that if the parent (coordinator) is cancelled,
  // all child workers are also cancelled
  parentAbort.signal.addEventListener(
    "abort",
    () => {
      childAbort.abort();
    },
    { once: true },
  );

  // Create task-specific scratchpad subdirectory
  // Each task gets its own isolated workspace within the shared scratchpad
  const taskScratchDir = scratchpadDir ? path.join(scratchpadDir, taskId) : undefined;

  return {
    abortController: childAbort,
    taskScratchDir,
    readOnlyParentState: true,
    taskId,
  };
}

/**
 * Cleanup isolation context after worker completes.
 * This is a best-effort operation and won't throw on errors.
 * 
 * @param context - The isolation context to clean up
 */
export function cleanupIsolatedContext(_context: IsolatedSpawnContext): void {
  // Abort signal cleanup is automatic via GC
  // Task scratch directory cleanup is handled by scratchpad.ts
  // This function exists for future extension points
}

/**
 * Check if an abort signal is already aborted.
 * Utility for early-exit checks in worker code.
 */
export function isAborted(signal?: AbortSignal): boolean {
  return signal?.aborted === true;
}

/**
 * Create a promise that rejects when the signal is aborted.
 * Useful for racing with long-running operations.
 * 
 * @param signal - Abort signal to watch
 * @param message - Error message to use when aborted
 */
export function createAbortPromise(signal: AbortSignal, message = "Operation aborted"): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) {
      reject(new Error(message));
      return;
    }
    signal.addEventListener("abort", () => reject(new Error(message)), { once: true });
  });
}

/**
 * Race a promise against an abort signal.
 * If the signal is aborted before the promise resolves, this throws.
 * 
 * @param promise - The operation to race
 * @param signal - Abort signal to race against
 * @param message - Error message if aborted
 */
export async function raceWithAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  message?: string,
): Promise<T> {
  return Promise.race([promise, createAbortPromise(signal, message)]);
}
