/**
 * SkillEvolution — Tracks skill usage and manages the confidence lifecycle:
 *   draft → validated → proven → archived
 *
 * Golden rule: if a skill is used successfully and the user is satisfied,
 * only increment counters. NEVER modify skill content on success.
 * Content changes only happen through SkillExtractor on negative signals.
 */

import { logDebug, logInfo } from "../../../logger.js";
import {
  readSkillIndex,
  updateSkillInIndex,
  type SkillIndexEntry,
} from "./skill-index.js";
import type { AutoEvolveConfig, SkillConfidenceLevel } from "./types.js";

// ---------------------------------------------------------------------------
// Confidence thresholds
// ---------------------------------------------------------------------------

function resolveNextConfidence(
  current: SkillConfidenceLevel,
  successCount: number,
  config: AutoEvolveConfig,
): SkillConfidenceLevel {
  if (current === "archived") return "archived";

  if (current === "draft" && successCount >= 2) return "validated";
  if (current === "validated" && successCount >= config.evolution.provenThreshold) return "proven";
  return current;
}

function shouldDegrade(
  entry: SkillIndexEntry,
  config: AutoEvolveConfig,
): boolean {
  const total = entry.useCount;
  if (total < 3) return false;

  const failCount = total - entry.successCount;
  const failRate = failCount / total;
  return failRate > config.evolution.degradeFailRate;
}

function degradeConfidence(current: SkillConfidenceLevel): SkillConfidenceLevel {
  if (current === "proven") return "validated";
  if (current === "validated") return "draft";
  return current;
}

// ---------------------------------------------------------------------------
// Public API — called after each skill invocation
// ---------------------------------------------------------------------------

export async function recordSkillSuccess(params: {
  skillName: string;
  managedSkillsDir: string;
  config: AutoEvolveConfig;
}): Promise<void> {
  const { skillName, managedSkillsDir, config } = params;

  const updated = await updateSkillInIndex(managedSkillsDir, skillName, (entry) => {
    const newUseCount = entry.useCount + 1;
    const newSuccessCount = entry.successCount + 1;
    const newConfidence = resolveNextConfidence(entry.confidence, newSuccessCount, config);

    if (newConfidence !== entry.confidence) {
      logInfo(`[auto-evolve] skill "${skillName}" upgraded: ${entry.confidence} → ${newConfidence}`);
    }

    return {
      ...entry,
      useCount: newUseCount,
      successCount: newSuccessCount,
      confidence: newConfidence,
    };
  });

  if (!updated) {
    logDebug(`[auto-evolve] recordSkillSuccess: skill "${skillName}" not found in index`);
  }
}

export async function recordSkillFailure(params: {
  skillName: string;
  managedSkillsDir: string;
  config: AutoEvolveConfig;
  isWrongMatch?: boolean;
}): Promise<void> {
  const { skillName, managedSkillsDir, config, isWrongMatch } = params;

  const updated = await updateSkillInIndex(managedSkillsDir, skillName, (entry) => {
    const newEntry = {
      ...entry,
      useCount: entry.useCount + 1,
    };

    if (shouldDegrade(newEntry, config)) {
      const degraded = degradeConfidence(newEntry.confidence);
      if (degraded !== newEntry.confidence) {
        logInfo(
          `[auto-evolve] skill "${skillName}" degraded: ${newEntry.confidence} → ${degraded} (fail rate too high)`,
        );
        newEntry.confidence = degraded;
      }
    }

    return newEntry;
  });

  if (!updated) {
    logDebug(`[auto-evolve] recordSkillFailure: skill "${skillName}" not found in index`);
  }
}

// ---------------------------------------------------------------------------
// Dreaming integration — called during Deep/REM sleep phases
// ---------------------------------------------------------------------------

export async function archiveStaleSkills(params: {
  managedSkillsDir: string;
  config: AutoEvolveConfig;
  nowMs?: number;
}): Promise<string[]> {
  const { managedSkillsDir, config } = params;
  const nowMs = params.nowMs ?? Date.now();
  const archiveThresholdMs = config.evolution.archiveDays * 24 * 60 * 60 * 1000;

  let entries: SkillIndexEntry[];
  try {
    entries = await readSkillIndex(managedSkillsDir);
  } catch {
    return [];
  }

  const archived: string[] = [];
  // Note: we don't have lastUsedAt in the index entries directly.
  // For now, archive skills with 0 uses that are older than archiveDays.
  // In a full implementation, lastUsedAt would be tracked in the index.
  // This is a placeholder that archives never-used draft skills.
  for (const entry of entries) {
    if (entry.confidence === "archived") continue;
    if (entry.confidence === "draft" && entry.useCount === 0) {
      // Mark for archival — in a real implementation we'd check creation date
      // For now, skip actual date check since we don't persist creation timestamps
      // in the index. This will be improved when the full SKILL.md parser is wired.
    }
  }

  return archived;
}

export async function findMergeableSkills(params: {
  managedSkillsDir: string;
}): Promise<Array<[string, string]>> {
  const { managedSkillsDir } = params;

  let entries: SkillIndexEntry[];
  try {
    entries = await readSkillIndex(managedSkillsDir);
  } catch {
    return [];
  }

  const active = entries.filter((e) => e.confidence !== "archived");
  const pairs: Array<[string, string]> = [];

  // Simple heuristic: check if two skills have >50% trigger pattern overlap.
  for (let i = 0; i < active.length; i++) {
    for (let j = i + 1; j < active.length; j++) {
      const a = active[i];
      const b = active[j];
      const aPatterns = new Set(a.triggerPatterns.map((p) => p.toLowerCase()));
      const bPatterns = new Set(b.triggerPatterns.map((p) => p.toLowerCase()));

      let overlap = 0;
      for (const p of aPatterns) {
        if (bPatterns.has(p)) overlap++;
      }
      const maxSize = Math.max(aPatterns.size, bPatterns.size);
      if (maxSize > 0 && overlap / maxSize > 0.5) {
        pairs.push([a.name, b.name]);
      }
    }
  }

  return pairs;
}
