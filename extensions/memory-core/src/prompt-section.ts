import type { MemoryPromptSectionBuilder } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import { readMemoryEntrypoint, MEMORY_ENTRYPOINT_NAME } from "./memory-entrypoint.js";
import { buildTypedMemoryGuidanceLines } from "./prompt-sections-typed.js";

/**
 * Build the memory recall tool guidance lines (search/get instructions + citations).
 * This is the original section — kept intact so existing behaviour is unchanged
 * when no workspaceDir is available.
 */
function buildRecallGuidanceLines(
  availableTools: Set<string>,
  citationsMode: string | undefined,
): string[] {
  const hasMemorySearch = availableTools.has("memory_search");
  const hasMemoryGet = availableTools.has("memory_get");

  if (!hasMemorySearch && !hasMemoryGet) {
    return [];
  }

  let toolGuidance: string;
  if (hasMemorySearch && hasMemoryGet) {
    toolGuidance =
      "Before answering anything about prior work, decisions, dates, people, preferences, or todos: run memory_search on MEMORY.md + memory/*.md + indexed session transcripts; then use memory_get to pull only the needed lines. If low confidence after search, say you checked.";
  } else if (hasMemorySearch) {
    toolGuidance =
      "Before answering anything about prior work, decisions, dates, people, preferences, or todos: run memory_search on MEMORY.md + memory/*.md + indexed session transcripts and answer from the matching results. If low confidence after search, say you checked.";
  } else {
    toolGuidance =
      "Before answering anything about prior work, decisions, dates, people, preferences, or todos that already point to a specific memory file or note: run memory_get to pull only the needed lines. If low confidence after reading them, say you checked.";
  }

  const lines = ["## Memory Recall", toolGuidance];
  if (citationsMode === "off") {
    lines.push(
      "Citations are disabled: do not mention file paths or line numbers in replies unless the user explicitly asks.",
    );
  } else {
    lines.push(
      "Citations: include Source: <path#line> when it helps the user verify memory snippets.",
    );
  }
  lines.push("");
  return lines;
}

/**
 * Original export — preserved unchanged for backward compatibility.
 * Used when no workspaceDir is available (e.g. legacy path, tests).
 */
export const buildPromptSection: MemoryPromptSectionBuilder = ({
  availableTools,
  citationsMode,
}) => {
  return buildRecallGuidanceLines(availableTools, citationsMode);
};

/**
 * Enhanced prompt builder factory that includes:
 *   1. Typed memory guidance (4 types: user/feedback/project/reference)
 *   2. MEMORY.md index content (truncated to line + byte caps)
 *   3. Memory recall tool instructions
 *
 * Created via createTypedMemoryPromptBuilder(workspaceDir, memoryDir) in
 * index.ts and passed as the registerMemoryCapability promptBuilder when
 * both paths are known at plugin registration time.
 *
 * This is additive: if workspaceDir is not provided, falls back to the
 * original buildPromptSection behaviour (no typed guidance, no index).
 */
export function createTypedMemoryPromptBuilder(
  workspaceDir: string,
  memoryDir: string,
): MemoryPromptSectionBuilder {
  return ({ availableTools, citationsMode }) => {
    const lines: string[] = [];

    // Section 1: typed memory guidance (types, what not to save, how to save,
    // when to access, before recommending). These go BEFORE the tool guidance
    // so they are in the stable-prefix zone of the prompt cache.
    lines.push(...buildTypedMemoryGuidanceLines(memoryDir));
    lines.push("");

    // Section 2: MEMORY.md index content. Read synchronously (matches claude-code
    // pattern; prompt building is synchronous in openclaw too).
    const entrypoint = readMemoryEntrypoint(workspaceDir);
    lines.push(`## ${MEMORY_ENTRYPOINT_NAME}`);
    lines.push("");
    if (entrypoint.isEmpty) {
      lines.push(
        `Your ${MEMORY_ENTRYPOINT_NAME} is currently empty. When you save new memories, they will appear here.`,
      );
    } else {
      lines.push(entrypoint.content);
    }
    lines.push("");

    // Section 3: recall tool guidance (dynamic: depends on which tools are
    // available at runtime). Placed AFTER static content so tool-list changes
    // don't invalidate the stable cached prefix.
    lines.push(...buildRecallGuidanceLines(availableTools, citationsMode));

    return lines;
  };
}
