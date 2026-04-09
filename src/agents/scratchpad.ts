/**
 * Scratchpad directory management for cross-worker file exchange in coordinator mode.
 * Allows workers spawned by the same coordinator to share intermediate results via files.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import type { OpenClawConfig } from "../config/config.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";

/**
 * Resolve the scratchpad directory for a coordinator run.
 * Default: {workspaceDir}/.openclaw/scratchpad/{coordinatorRunId}/
 */
export function resolveScratchpadDir(params: {
  cfg: OpenClawConfig;
  workspaceDir: string;
  coordinatorRunId: string;
}): string {
  // Check if config specifies a custom scratchpad dir
  const coordinatorConfig = (
    params.cfg as {
      agents?: { defaults?: { coordinator?: { scratchpadDir?: unknown } } };
    }
  ).agents?.defaults?.coordinator;

  const configDir = normalizeOptionalString(coordinatorConfig?.scratchpadDir);
  if (configDir) {
    return path.join(configDir, params.coordinatorRunId);
  }

  // Default: workspace/.openclaw/scratchpad/{runId}
  return path.join(params.workspaceDir, ".openclaw", "scratchpad", params.coordinatorRunId);
}

/**
 * Check if scratchpad is enabled for the coordinator.
 */
export function isScratchpadEnabled(cfg: OpenClawConfig): boolean {
  const coordinatorConfig = (
    cfg as {
      agents?: { defaults?: { coordinator?: { scratchpad?: unknown } } };
    }
  ).agents?.defaults?.coordinator;

  return coordinatorConfig?.scratchpad === true;
}

/**
 * Ensure the scratchpad directory exists.
 * Creates the directory and any necessary parent directories.
 */
export async function ensureScratchpadDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

/**
 * Clean up the scratchpad directory after coordinator completes.
 * Removes the entire directory tree.
 */
export async function cleanupScratchpadDir(dir: string): Promise<void> {
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch (err) {
    // Best-effort cleanup - don't throw if directory doesn't exist or can't be removed
  }
}

/**
 * Get scratchpad directory path hint for system prompt.
 * Returns the path relative to workspace if possible, otherwise absolute.
 */
export function getScratchpadPathHint(params: {
  scratchpadDir: string;
  workspaceDir: string;
}): string {
  // Try to make it relative for cleaner prompts
  if (params.scratchpadDir.startsWith(params.workspaceDir)) {
    const relative = path.relative(params.workspaceDir, params.scratchpadDir);
    if (relative && !relative.startsWith("..")) {
      return relative;
    }
  }
  return params.scratchpadDir;
}

/**
 * Build system prompt hint for scratchpad usage.
 */
export function buildScratchpadHint(params: {
  scratchpadDir: string;
  workspaceDir: string;
}): string {
  const pathHint = getScratchpadPathHint(params);
  return [
    "## Shared Scratchpad",
    "",
    `Path: ${pathHint}`,
    "",
    "This directory is shared across all workers spawned by your coordinator.",
    "Use it to exchange intermediate results, findings, or data between workers.",
    "Workers can read and write files here without permission prompts.",
    "",
    "Example usage:",
    "- Worker A: writes research findings to scratchpad/findings.json",
    "- Worker B: reads findings.json and implements based on it",
    "- Coordinator: reads final results from scratchpad/results.md",
    "",
  ].join("\n");
}
