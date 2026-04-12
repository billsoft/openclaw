/**
 * Coordinator mode detection and configuration for OpenClaw.
 * Adapted from claude-code/coordinator/coordinatorMode.ts
 */

import type { OpenClawConfig } from "../../config/config.js";
import { normalizeOptionalLowercaseString } from "../../shared/string-coerce.js";

/**
 * Check if coordinator mode should be enabled for this agent.
 * Coordinator mode is enabled when:
 * - depth === 0 (main agent, not a subagent)
 * - config.agents.defaults.coordinator.enabled === true
 */
export function isCoordinatorMode(params: {
  cfg: OpenClawConfig;
  depth: number;
  sessionKey?: string;
}): boolean {
  // Only enable for main agents (depth 0), never for subagents
  if (params.depth > 0) {
    return false;
  }

  // Check config flag
  const coordinatorConfig = (
    params.cfg as {
      agents?: { defaults?: { coordinator?: { enabled?: unknown } } };
    }
  ).agents?.defaults?.coordinator;

  return coordinatorConfig?.enabled === true;
}

/**
 * Get coordinator user context (scratchpad info, worker tools list, etc.)
 * This gets injected into the user context section of the system prompt.
 */
export function getCoordinatorUserContext(params: {
  scratchpadDir?: string;
  mcpClients?: ReadonlyArray<{ name: string }>;
  maxWorkers?: number;
}): { [k: string]: string } {
  const parts: string[] = [];

  if (params.scratchpadDir) {
    parts.push(`Scratchpad directory: ${params.scratchpadDir}`);
    parts.push(
      "Workers can read and write here without permission prompts. Use this for durable cross-worker knowledge — structure files however fits the work.",
    );
  }

  if (params.mcpClients && params.mcpClients.length > 0) {
    const serverNames = params.mcpClients.map((c) => c.name).join(", ");
    parts.push(`Workers have access to MCP tools from connected MCP servers: ${serverNames}`);
  }

  if (params.maxWorkers) {
    parts.push(`Maximum concurrent workers: ${params.maxWorkers}`);
  }

  return parts.length > 0 ? { coordinatorContext: parts.join("\n\n") } : {};
}

/**
 * Resolve the maximum number of concurrent workers for coordinator mode.
 */
export function resolveCoordinatorMaxWorkers(cfg: OpenClawConfig): number {
  const coordinatorConfig = (
    cfg as {
      agents?: { defaults?: { coordinator?: { maxWorkers?: unknown } } };
    }
  ).agents?.defaults?.coordinator;

  const maxWorkers =
    typeof coordinatorConfig?.maxWorkers === "number" && coordinatorConfig.maxWorkers > 0
      ? Math.floor(coordinatorConfig.maxWorkers)
      : undefined;

  return maxWorkers ?? 3; // Default to 3 concurrent workers
}

/**
 * Get list of worker tool names for coordinator prompt.
 * These are the tools available to spawned workers.
 */
export function getWorkerToolNames(params: {
  cfg: OpenClawConfig;
  allToolNames?: string[];
}): string[] {
  // If explicit list provided, use it
  if (params.allToolNames && params.allToolNames.length > 0) {
    return params.allToolNames;
  }

  // Default worker tools (can be extended via config)
  const defaultTools = [
    "exec",
    "read",
    "write",
    "edit",
    "grep_search",
    "find_by_name",
    "list_dir",
    "agent", // Preferred: fork-mode in-process worker spawning
    "sessions_spawn", // Legacy: kept for ACP/thread mode compat
    "subagents", // Workers can manage their children
  ];

  return defaultTools;
}
