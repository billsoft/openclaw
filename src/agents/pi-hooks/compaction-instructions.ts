/**
 * Compaction instruction utilities.
 *
 * Provides default language-preservation instructions and a precedence-based
 * resolver for customInstructions used during context compaction summaries.
 */

/**
 * Default instructions injected into every safeguard-mode compaction summary.
 * Preserves conversation language and persona while keeping the SDK's required
 * summary structure intact.
 */
export const DEFAULT_COMPACTION_INSTRUCTIONS =
  "Write the summary body in the primary language used in the conversation.\n" +
  "CRITICAL: Respond with TEXT ONLY. Do NOT call any tools (Read, Bash, etc.). Tool calls will be REJECTED and waste the turn.\n" +
  "Before providing the final summary, wrap your analysis in <analysis> tags to organize your thoughts and chronologically analyze the events, decisions, errors, and fixes.\n" +
  "Focus on factual content: what was discussed, decisions made, and current state.\n" +
  "Keep the required summary structure and section headers unchanged. Do not translate or alter code, file paths, identifiers, or error messages.\n" +
  "Optional Next Step: Include direct quotes from the most recent conversation showing EXACTLY what task you were working on. This MUST be verbatim to ensure no drift in task interpretation.";

/**
 * Upper bound on custom instruction length to prevent prompt bloat.
 * Increased to ~2500 chars to accommodate strict extraction guidelines.
 */
const MAX_INSTRUCTION_LENGTH = 2500;

function truncateUnicodeSafe(s: string, maxCodePoints: number): string {
  const chars = Array.from(s);
  if (chars.length <= maxCodePoints) {
    return s;
  }
  return chars.slice(0, maxCodePoints).join("");
}

function normalize(s: string | undefined): string | undefined {
  if (s == null) {
    return undefined;
  }
  const trimmed = s.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Resolve compaction instructions with precedence:
 *   event (SDK) → runtime (config) → DEFAULT constant.
 *
 * Each input is normalized first (trim + empty→undefined) so that blank
 * strings don't short-circuit the fallback chain.
 */
export function resolveCompactionInstructions(
  eventInstructions: string | undefined,
  runtimeInstructions: string | undefined,
): string {
  const resolved =
    normalize(eventInstructions) ??
    normalize(runtimeInstructions) ??
    DEFAULT_COMPACTION_INSTRUCTIONS;
  return truncateUnicodeSafe(resolved, MAX_INSTRUCTION_LENGTH);
}

/**
 * Compose split-turn instructions by combining the SDK's turn-prefix
 * instructions with the resolved compaction instructions.
 */
export function composeSplitTurnInstructions(
  turnPrefixInstructions: string,
  resolvedInstructions: string,
): string {
  return [turnPrefixInstructions, "Additional requirements:", resolvedInstructions].join("\n\n");
}
