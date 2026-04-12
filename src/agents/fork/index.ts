export {
  isForkSubagentEnabled,
  isForkExecutionActive,
  isCacheSharingEnabled,
  getForkMaxConcurrent,
  getForkIsolationMode,
  resolveForkConfig,
  checkForkDepthLimits,
  FORK_PLACEHOLDER_RESULT,
  FORK_BOILERPLATE_TAG,
  DEFAULT_FORK_MAX_SPAWN_DEPTH,
  DEFAULT_FORK_MAX_CHILDREN,
  DEFAULT_FORK_TIMEOUT_MS,
  buildForkChildMessage,
  buildForkedMessages,
  executeForkTask,
  type ForkResult,
  type ForkTaskConfig,
  type ForkExecutionHooks,
} from "./fork-subagent-core.js";

export {
  getForkRegistry,
  startForkRegistryCleanup,
  stopForkRegistryCleanup,
  type ForkSession,
  type ForkSessionStatus,
  type ForkLifecyclePhase,
  type ForkLifecycleEvent,
} from "./fork-registry.js";

export {
  createAgentWorktree,
  removeAgentWorktree,
  listAgentWorktrees,
  cleanupStaleWorktrees,
  type WorktreeInfo,
} from "./fork-worktree.js";

export {
  spawnForkSubagent,
  spawnForkSubagents,
  getForkStatus,
  getForksForParent,
  getActiveForkCount,
  cancelFork,
  cancelAllForks,
  parseForkOutput,
  // Context isolation - prevents task scope confusion
  buildIsolatedForkMessages,
  extractRelevantFiles,
  type IsolatedForkContext,
  // Heartbeat monitoring - detects stuck tasks
  startTaskHeartbeatMonitoring,
  stopTaskHeartbeatMonitoring,
  type ForkSpawnContext,
  type ForkSpawnResult,
} from "./fork-spawn-adapter.js";

// Agent result parsing - structured output parsing
export {
  parseAgentResult,
  validateAgentResult,
  synthesizeAgentResults,
  type ParsedAgentResult,
} from "./agent-result-parser.js";

// Simple coordinator - manages multiple fork tasks
export {
  SimpleCoordinator,
  createCoordinator,
  type TaskInfo,
  type CoordinatorOptions,
} from "./simple-coordinator.js";
