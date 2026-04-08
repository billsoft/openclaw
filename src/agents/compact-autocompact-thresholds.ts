/**
 * Auto-compact threshold calibration for openclaw.
 *
 * Ported from claude-code/services/compact/autoCompact.ts.
 * Production-tested values from claude-code:
 *   AUTOCOMPACT_BUFFER_TOKENS = 13_000 (p99 of prompt overhead that arrives
 *     between a proactive check and the actual API call)
 *   COMPACTION_WARNING_BUFFER_TOKENS = 20_000
 *   COMPACTION_SUMMARY_OUTPUT_RESERVE = 20_000 (p99.99 of compact summary
 *     output is 17,387 tokens — round up to 20 k)
 *
 * DO NOT change these constants without re-running compaction evals. They were
 * tuned against production traffic; arbitrary adjustments will either fire too
 * early (wasting compaction budget) or too late (missing the overflow window).
 */

/**
 * Reserve this many tokens for the compaction summary output.
 * Subtracting this from the context window gives the "usable" window for
 * conversation content. Based on p99.99 of compact summary output (17,387 t).
 */
export const COMPACTION_SUMMARY_OUTPUT_RESERVE = 20_000;

/**
 * Reserve this many tokens as a buffer between the proactive compaction
 * threshold and the effective context window. Accounts for prompt overhead
 * that arrives between a token-count check and the actual API call.
 * Based on production data from claude-code.
 */
export const AUTOCOMPACT_BUFFER_TOKENS = 13_000;

/**
 * Tokens below which the UI should show a context-fill warning to the user.
 * Matches claude-code's WARNING_THRESHOLD_BUFFER_TOKENS.
 */
export const COMPACTION_WARNING_BUFFER_TOKENS = 20_000;

/**
 * Reserve this many tokens above the auto-compact threshold to ensure
 * manual /compact still has room when autocompact has not fired.
 */
export const MANUAL_COMPACT_RESERVE_TOKENS = 3_000;

/**
 * Returns the effective context window for conversation content:
 *   contextWindow − COMPACTION_SUMMARY_OUTPUT_RESERVE
 *
 * The output reserve accounts for the tokens the compaction summary itself
 * will consume in the post-compact context. Without this, compact can fire
 * "too close" to the limit and the summary itself causes an overflow.
 *
 * @param contextWindow - The model's raw context window size in tokens.
 */
export function getEffectiveContextWindow(contextWindow: number): number {
  return Math.max(0, contextWindow - COMPACTION_SUMMARY_OUTPUT_RESERVE);
}

/**
 * Returns the token count at which proactive auto-compaction should trigger.
 *   effectiveContextWindow − AUTOCOMPACT_BUFFER_TOKENS
 *
 * This threshold is intentionally conservative: compaction must complete and
 * the post-compact context must fit within the actual window, so we need
 * headroom for the LLM output and any new user messages that arrive while
 * compaction is running.
 *
 * @param contextWindow - The model's raw context window size in tokens.
 */
export function getAutoCompactThreshold(contextWindow: number): number {
  return Math.max(0, getEffectiveContextWindow(contextWindow) - AUTOCOMPACT_BUFFER_TOKENS);
}

/**
 * Returns the token count at which a warning should be surfaced to the user.
 *
 * @param contextWindow - The model's raw context window size in tokens.
 */
export function getCompactionWarningThreshold(contextWindow: number): number {
  return Math.max(0, getEffectiveContextWindow(contextWindow) - COMPACTION_WARNING_BUFFER_TOKENS);
}

export type TokenWarningState = {
  /** Tokens used for conversation content (observed or estimated). */
  tokensUsed: number;
  /** Effective context window (raw window minus output reserve). */
  effectiveContextWindow: number;
  /** Percentage of the effective window still available (0–100). */
  percentRemaining: number;
  /** True when approaching the warning threshold — show a caution indicator. */
  isNearingLimit: boolean;
  /** True when at or beyond the auto-compact threshold. */
  shouldAutoCompact: boolean;
  /** True when manual compaction is still possible but context is very tight. */
  isAtManualCompactReserve: boolean;
};

/**
 * Calculate context-fill warning state from a current token count.
 *
 * Ported from claude-code's calculateTokenWarningState() with names adjusted
 * for openclaw conventions. Uses the same threshold constants so behaviour is
 * consistent regardless of provider.
 *
 * @param tokensUsed  - Current estimated prompt token count.
 * @param contextWindow - The model's raw context window size.
 */
export function calculateTokenWarningState(
  tokensUsed: number,
  contextWindow: number,
): TokenWarningState {
  const effectiveContextWindow = getEffectiveContextWindow(contextWindow);
  const autoCompactAt = getAutoCompactThreshold(contextWindow);
  const warningAt = getCompactionWarningThreshold(contextWindow);
  const manualCompactAt = Math.max(0, effectiveContextWindow - MANUAL_COMPACT_RESERVE_TOKENS);

  const percentRemaining =
    effectiveContextWindow > 0
      ? Math.max(0, Math.round(((effectiveContextWindow - tokensUsed) / effectiveContextWindow) * 100))
      : 0;

  return {
    tokensUsed,
    effectiveContextWindow,
    percentRemaining,
    isNearingLimit: tokensUsed >= warningAt,
    shouldAutoCompact: tokensUsed >= autoCompactAt,
    isAtManualCompactReserve: tokensUsed >= manualCompactAt,
  };
}
