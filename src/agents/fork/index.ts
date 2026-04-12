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
  type ForkSpawnContext,
  type ForkSpawnResult,
} from "./fork-spawn-adapter.js";
