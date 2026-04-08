/**
 * Tests for auto-compact threshold calibration.
 *
 * These constants come from claude-code/services/compact/autoCompact.ts and
 * are production-validated. The tests verify the math and guard against
 * accidental drift — DO NOT change the expected values without re-running
 * compaction evals first.
 */

import { describe, expect, it } from "vitest";
import {
  AUTOCOMPACT_BUFFER_TOKENS,
  calculateTokenWarningState,
  COMPACTION_SUMMARY_OUTPUT_RESERVE,
  COMPACTION_WARNING_BUFFER_TOKENS,
  getAutoCompactThreshold,
  getCompactionWarningThreshold,
  getEffectiveContextWindow,
  MANUAL_COMPACT_RESERVE_TOKENS,
} from "./compact-autocompact-thresholds.js";

describe("compact-autocompact-thresholds", () => {
  describe("constants sanity checks", () => {
    it("output reserve is 20k (p99.99 of compact summary output)", () => {
      expect(COMPACTION_SUMMARY_OUTPUT_RESERVE).toBe(20_000);
    });

    it("auto-compact buffer is 13k", () => {
      expect(AUTOCOMPACT_BUFFER_TOKENS).toBe(13_000);
    });

    it("warning buffer is 20k", () => {
      expect(COMPACTION_WARNING_BUFFER_TOKENS).toBe(20_000);
    });

    it("manual compact reserve is 3k", () => {
      expect(MANUAL_COMPACT_RESERVE_TOKENS).toBe(3_000);
    });
  });

  describe("getEffectiveContextWindow", () => {
    it("subtracts output reserve from context window", () => {
      expect(getEffectiveContextWindow(200_000)).toBe(180_000);
    });

    it("clamps to 0 when context window is too small", () => {
      expect(getEffectiveContextWindow(10_000)).toBe(0);
    });

    it("handles large context windows correctly", () => {
      expect(getEffectiveContextWindow(1_000_000)).toBe(980_000);
    });
  });

  describe("getAutoCompactThreshold", () => {
    it("is effectiveWindow minus buffer (200k model)", () => {
      // 200k - 20k reserve - 13k buffer = 167k
      expect(getAutoCompactThreshold(200_000)).toBe(167_000);
    });

    it("is effectiveWindow minus buffer (128k model)", () => {
      // 128k - 20k reserve - 13k buffer = 95k
      expect(getAutoCompactThreshold(128_000)).toBe(95_000);
    });

    it("clamps to 0 when context window is smaller than both reserves", () => {
      expect(getAutoCompactThreshold(5_000)).toBe(0);
    });
  });

  describe("getCompactionWarningThreshold", () => {
    it("is effectiveWindow minus warning buffer (200k model)", () => {
      // 200k - 20k reserve - 20k warning = 160k
      expect(getCompactionWarningThreshold(200_000)).toBe(160_000);
    });
  });

  describe("calculateTokenWarningState", () => {
    const contextWindow = 200_000;

    it("no warnings when well below threshold", () => {
      const state = calculateTokenWarningState(50_000, contextWindow);
      expect(state.isNearingLimit).toBe(false);
      expect(state.shouldAutoCompact).toBe(false);
      expect(state.isAtManualCompactReserve).toBe(false);
      expect(state.percentRemaining).toBeGreaterThan(50);
    });

    it("warns when above warning threshold", () => {
      // Warning at 160k (effectiveWindow - 20k warning buffer)
      const state = calculateTokenWarningState(165_000, contextWindow);
      expect(state.isNearingLimit).toBe(true);
      expect(state.shouldAutoCompact).toBe(false);
    });

    it("triggers autocompact when above auto-compact threshold", () => {
      // AutoCompact at 167k (effectiveWindow - 13k buffer)
      const state = calculateTokenWarningState(170_000, contextWindow);
      expect(state.shouldAutoCompact).toBe(true);
    });

    it("percentRemaining is 0 when fully saturated", () => {
      const state = calculateTokenWarningState(200_000, contextWindow);
      expect(state.percentRemaining).toBe(0);
    });

    it("percentRemaining is 100 when empty", () => {
      const state = calculateTokenWarningState(0, contextWindow);
      // effectiveWindow = 180k, used = 0, so 100% remaining
      expect(state.percentRemaining).toBe(100);
    });

    it("reports correct effectiveContextWindow", () => {
      const state = calculateTokenWarningState(50_000, contextWindow);
      expect(state.effectiveContextWindow).toBe(180_000);
    });
  });
});
