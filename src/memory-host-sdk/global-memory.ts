/**
 * Global memory layer — shared across all agents and workspaces.
 *
 * Per-agent memory lives at {agentWorkspaceDir}/MEMORY.md. The global layer
 * lives at {stateDir}/global-memory/MEMORY.md and is injected into every
 * agent's system prompt via a prompt supplement, providing a single place for
 * cross-agent user preferences, facts, and references.
 *
 * Read pattern mirrors extensions/memory-core/src/memory-entrypoint.ts:
 * dual truncation (200 lines OR 25 KB) so injection size is bounded.
 */

import fs from "node:fs";
import path from "node:path";

export const GLOBAL_MEMORY_SUBDIR = "global-memory";

const GLOBAL_MEMORY_FILENAME = "MEMORY.md";
const MAX_ENTRYPOINT_LINES = 200;
const MAX_ENTRYPOINT_BYTES = 25_000;

export type GlobalMemoryReadResult = {
  /** Truncated (or full) content, ready for prompt injection. */
  content: string;
  /** True when file is absent or blank. */
  isEmpty: boolean;
  /** True when any truncation was applied. */
  wasTruncated: boolean;
};

/** Absolute path to the global memory directory. */
export function resolveGlobalMemoryDir(stateDir: string): string {
  return path.join(stateDir, GLOBAL_MEMORY_SUBDIR);
}

/** Absolute path to the global MEMORY.md entrypoint file. */
export function resolveGlobalMemoryEntrypoint(stateDir: string): string {
  return path.join(stateDir, GLOBAL_MEMORY_SUBDIR, GLOBAL_MEMORY_FILENAME);
}

function truncateGlobalMemory(raw: string): { content: string; wasTruncated: boolean } {
  const trimmed = raw.trim();
  const lines = trimmed.split("\n");
  const lineTrunc = lines.length > MAX_ENTRYPOINT_LINES;
  const byteTrunc = trimmed.length > MAX_ENTRYPOINT_BYTES;

  if (!lineTrunc && !byteTrunc) {
    return { content: trimmed, wasTruncated: false };
  }

  let result = lineTrunc ? lines.slice(0, MAX_ENTRYPOINT_LINES).join("\n") : trimmed;
  if (result.length > MAX_ENTRYPOINT_BYTES) {
    const cut = result.lastIndexOf("\n", MAX_ENTRYPOINT_BYTES);
    result = result.slice(0, cut > 0 ? cut : MAX_ENTRYPOINT_BYTES);
  }

  return {
    content:
      result +
      `\n\n> WARNING: Global MEMORY.md was truncated. Keep entries to one line under ~200 chars.`,
    wasTruncated: true,
  };
}

/**
 * Read the global MEMORY.md with dual truncation (line + byte caps).
 * Synchronous — mirrors readMemoryEntrypoint in memory-entrypoint.ts.
 * Returns isEmpty=true when the file is absent or blank (normal for new installs).
 */
export function readGlobalMemoryEntrypoint(stateDir: string): GlobalMemoryReadResult {
  const entrypointPath = resolveGlobalMemoryEntrypoint(stateDir);
  let raw = "";
  try {
    // eslint-disable-next-line custom-rules/no-sync-fs
    raw = fs.readFileSync(entrypointPath, { encoding: "utf-8" });
  } catch {
    // No global MEMORY.md yet — normal for new installations.
  }

  if (!raw.trim()) {
    return { content: "", isEmpty: true, wasTruncated: false };
  }

  const { content, wasTruncated } = truncateGlobalMemory(raw);
  return { content, isEmpty: false, wasTruncated };
}
