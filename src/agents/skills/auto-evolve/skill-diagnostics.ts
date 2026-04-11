/**
 * SkillDiagnostics — Determines why a skill invocation failed and routes
 * to the appropriate fix path:
 *   A) Wrong match → add negative-patterns
 *   B) Outdated → trigger re-extraction
 *   C) Needs orchestration → generate composite skill
 *
 * This module does NOT make independent LLM calls. Instead, it prepares
 * diagnostics context that gets appended to the SkillExtractor's prompt,
 * reusing the same background agent call.
 */

import { logInfo } from "../../../logger.js";
import { updateSkillInIndex, readSkillIndex, type SkillIndexEntry } from "./skill-index.js";
import type {
  AutoEvolveConfig,
  AutoEvolveSpawnFn,
  SkillDiagnosticsResult,
  SkillExtractionRequest,
  SkillExtractionResult,
} from "./types.js";
import { extractSkillIfNeeded } from "./skill-extractor.js";
import { recordSkillFailure } from "./skill-evolution.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function diagnoseAndRepair(params: {
  skillName: string;
  sessionId: string;
  agentId: string;
  taskSummary: string;
  turnRange: [number, number];
  reason: "user_unsatisfied" | "user_corrected";
  managedSkillsDir: string;
  config: AutoEvolveConfig;
  spawnFn: AutoEvolveSpawnFn;
  sessionNotesContent?: string;
}): Promise<SkillExtractionResult> {
  const {
    skillName,
    sessionId,
    agentId,
    taskSummary,
    turnRange,
    reason,
    managedSkillsDir,
    config,
    spawnFn,
    sessionNotesContent,
  } = params;

  // Record the failure in evolution tracking
  const isWrongMatch = reason === "user_unsatisfied";
  await recordSkillFailure({
    skillName,
    managedSkillsDir,
    config,
    isWrongMatch,
  });

  // Look up current skill version
  let skillVersion = 1;
  try {
    const entries = await readSkillIndex(managedSkillsDir);
    const entry = entries.find((e) => e.name === skillName);
    if (entry) {
      // We don't have version in index directly, default to 1
      skillVersion = 1;
    }
  } catch {
    // Continue with default
  }

  // Build extraction request with diagnostics context
  const request: SkillExtractionRequest = {
    sessionId,
    agentId,
    taskSummary,
    turnRange,
    sessionNotesContent,
    diagnosticsContext: {
      skillName,
      skillVersion,
      reason,
    },
  };

  logInfo(
    `[auto-evolve] diagnosing skill "${skillName}" (reason: ${reason}) from session=${sessionId}`,
  );

  // Delegate to SkillExtractor — it handles the LLM call and file writes,
  // and will include the diagnostics context in its prompt.
  const result = await extractSkillIfNeeded({
    request,
    config,
    managedSkillsDir,
    spawnFn,
  });

  // Apply diagnostics-specific fixes
  if (result.diagnostics) {
    await applyDiagnosticsResult({
      skillName,
      managedSkillsDir,
      diagnostics: result.diagnostics,
    });
  }

  return result;
}

// ---------------------------------------------------------------------------
// Apply diagnostics result
// ---------------------------------------------------------------------------

async function applyDiagnosticsResult(params: {
  skillName: string;
  managedSkillsDir: string;
  diagnostics: SkillDiagnosticsResult;
}): Promise<void> {
  const { skillName, managedSkillsDir, diagnostics } = params;

  if (diagnostics.diagnosis === "wrong_match" && diagnostics.negativePatterns?.length) {
    // Add negative patterns to prevent future mismatches
    await updateSkillInIndex(managedSkillsDir, skillName, (entry) => ({
      ...entry,
      negativePatterns: [
        ...new Set([...entry.negativePatterns, ...(diagnostics.negativePatterns ?? [])]),
      ],
    }));
    logInfo(
      `[auto-evolve] added ${diagnostics.negativePatterns.length} negative patterns to "${skillName}"`,
    );
  }
}
