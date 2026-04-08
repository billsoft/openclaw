import fs from "node:fs";
import path from "node:path";

/**
 * MEMORY.md entrypoint reader — ported from claude-code/memdir/memdir.ts.
 *
 * Reads the agent's MEMORY.md index file with dual truncation guards:
 * line cap (200) and byte cap (25 KB). If both caps fire, line-truncates
 * first (natural boundary), then byte-truncates at the last newline before
 * the cap so we never cut mid-line.
 *
 * This is the human-readable index layer that sits on top of the existing
 * vector/SQLite search engine. The two coexist: MEMORY.md is the agent's
 * self-curated entry point; the search engine handles semantic retrieval.
 */

export const MEMORY_ENTRYPOINT_NAME = "MEMORY.md";
export const MAX_ENTRYPOINT_LINES = 200;
/** ~125 chars/line × 200 lines. Catches long-line indexes that slip past the line cap. */
export const MAX_ENTRYPOINT_BYTES = 25_000;

export type EntrypointReadResult = {
  /** Truncated (or full) content, ready for prompt injection. */
  content: string;
  /** Whether the content is empty (no file or blank). */
  isEmpty: boolean;
  /** Whether any truncation was applied. */
  wasTruncated: boolean;
};

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

/**
 * Truncate raw MEMORY.md content to the line AND byte caps.
 * Appends a warning that names which cap fired.
 *
 * Algorithm from claude-code/memdir/memdir.ts — preserves the truncation
 * semantics exactly so agents get consistent behaviour regardless of channel.
 */
function truncateEntrypointContent(raw: string): { content: string; wasTruncated: boolean } {
  const trimmed = raw.trim();
  const contentLines = trimmed.split("\n");
  const lineCount = contentLines.length;
  const byteCount = trimmed.length;

  const wasLineTruncated = lineCount > MAX_ENTRYPOINT_LINES;
  // Check original byte count — long lines are the failure mode the byte cap
  // targets, so post-line-truncation size would understate the warning.
  const wasByteTruncated = byteCount > MAX_ENTRYPOINT_BYTES;

  if (!wasLineTruncated && !wasByteTruncated) {
    return { content: trimmed, wasTruncated: false };
  }

  let truncated = wasLineTruncated
    ? contentLines.slice(0, MAX_ENTRYPOINT_LINES).join("\n")
    : trimmed;

  if (truncated.length > MAX_ENTRYPOINT_BYTES) {
    const cutAt = truncated.lastIndexOf("\n", MAX_ENTRYPOINT_BYTES);
    truncated = truncated.slice(0, cutAt > 0 ? cutAt : MAX_ENTRYPOINT_BYTES);
  }

  const reason =
    wasByteTruncated && !wasLineTruncated
      ? `${formatFileSize(byteCount)} (limit: ${formatFileSize(MAX_ENTRYPOINT_BYTES)}) — index entries are too long`
      : wasLineTruncated && !wasByteTruncated
        ? `${lineCount} lines (limit: ${MAX_ENTRYPOINT_LINES})`
        : `${lineCount} lines and ${formatFileSize(byteCount)}`;

  return {
    content:
      truncated +
      `\n\n> WARNING: ${MEMORY_ENTRYPOINT_NAME} is ${reason}. Only part of it was loaded.` +
      ` Keep index entries to one line under ~200 chars; move detail into topic files.`,
    wasTruncated: true,
  };
}

/**
 * Read and return the content of MEMORY.md from the given workspaceDir.
 *
 * Synchronous: prompt building in openclaw happens synchronously inside the
 * MemoryPromptSectionBuilder callback. Mirrors the pattern from claude-code's
 * buildMemoryPrompt() which also uses readFileSync.
 */
export function readMemoryEntrypoint(workspaceDir: string): EntrypointReadResult {
  const entrypointPath = path.join(workspaceDir, MEMORY_ENTRYPOINT_NAME);
  let raw = "";
  try {
    // eslint-disable-next-line custom-rules/no-sync-fs
    raw = fs.readFileSync(entrypointPath, { encoding: "utf-8" });
  } catch {
    // No MEMORY.md yet — normal for new agents.
  }

  if (!raw.trim()) {
    return { content: "", isEmpty: true, wasTruncated: false };
  }

  const { content, wasTruncated } = truncateEntrypointContent(raw);
  return { content, isEmpty: false, wasTruncated };
}
