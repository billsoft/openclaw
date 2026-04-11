/**
 * SkillMatcher — Matches incoming user messages against auto-evolved skills
 * using a multi-level funnel: keyword → semantic (future) → LLM confirm (future).
 *
 * Current implementation: keyword matching against trigger-patterns with
 * negative-patterns exclusion. Returns scored matches above minScore.
 */

import type { AutoEvolveConfig, SkillMatchResult } from "./types.js";
import { readSkillIndex, type SkillIndexEntry } from "./skill-index.js";

// ---------------------------------------------------------------------------
// Keyword scoring
// ---------------------------------------------------------------------------

function normalizeForMatching(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af\s]/g, " ").trim();
}

function computeKeywordScore(userMessage: string, entry: SkillIndexEntry): number {
  const normalizedMsg = normalizeForMatching(userMessage);

  // Check negative patterns first — any match means score 0.
  for (const neg of entry.negativePatterns) {
    const normalizedNeg = normalizeForMatching(neg);
    if (normalizedNeg && normalizedMsg.includes(normalizedNeg)) {
      return 0;
    }
  }

  if (entry.triggerPatterns.length === 0) return 0;

  let maxScore = 0;
  for (const trigger of entry.triggerPatterns) {
    const normalizedTrigger = normalizeForMatching(trigger);
    if (!normalizedTrigger) continue;

    // Exact substring match → high score
    if (normalizedMsg.includes(normalizedTrigger)) {
      const lengthRatio = normalizedTrigger.length / Math.max(normalizedMsg.length, 1);
      const score = 0.6 + 0.4 * Math.min(lengthRatio * 3, 1);
      maxScore = Math.max(maxScore, score);
      continue;
    }

    // Token overlap scoring
    const triggerTokens = normalizedTrigger.split(/\s+/).filter(Boolean);
    const msgTokens = new Set(normalizedMsg.split(/\s+/).filter(Boolean));
    const matchCount = triggerTokens.filter((t) => msgTokens.has(t)).length;
    const overlapScore = matchCount / Math.max(triggerTokens.length, 1);
    maxScore = Math.max(maxScore, overlapScore * 0.8);
  }

  return maxScore;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function matchSkills(params: {
  userMessage: string;
  managedSkillsDir: string;
  config: AutoEvolveConfig;
  maxResults?: number;
}): Promise<SkillMatchResult[]> {
  const { userMessage, managedSkillsDir, config } = params;
  const maxResults = params.maxResults ?? 3;

  if (!config.enabled || !config.matching.enabled) return [];
  if (!userMessage.trim()) return [];

  let entries: SkillIndexEntry[];
  try {
    entries = await readSkillIndex(managedSkillsDir);
  } catch {
    return [];
  }

  // Filter out archived skills
  const active = entries.filter((e) => e.confidence !== "archived");
  if (active.length === 0) return [];

  const scored: Array<{ entry: SkillIndexEntry; score: number }> = [];

  for (const entry of active) {
    let score: number;

    switch (config.matching.strategy) {
      case "keyword":
        score = computeKeywordScore(userMessage, entry);
        break;
      case "semantic":
        // Semantic matching would use embedding vectors.
        // For now, fall back to keyword matching.
        score = computeKeywordScore(userMessage, entry);
        break;
      case "hybrid":
        // Hybrid would combine keyword + semantic.
        // For now, fall back to keyword matching.
        score = computeKeywordScore(userMessage, entry);
        break;
      default:
        score = computeKeywordScore(userMessage, entry);
    }

    if (score >= config.matching.minScore) {
      scored.push({ entry, score });
    }
  }

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults)
    .map(({ entry, score }) => ({
      skillName: entry.name,
      skillDir: entry.location,
      score,
      matchType: config.matching.strategy,
    }));
}

export async function loadSkillSteps(
  managedSkillsDir: string,
  skillLocation: string,
): Promise<string | null> {
  const { readFile } = await import("node:fs/promises");
  const { join, dirname } = await import("node:path");

  // skillLocation is relative to managedSkillsDir
  const skillMdPath = join(managedSkillsDir, skillLocation);
  try {
    const content = await readFile(skillMdPath, "utf-8");
    // Strip frontmatter, return only the body (steps)
    const fmEnd = content.indexOf("---", content.indexOf("---") + 3);
    if (fmEnd !== -1) {
      return content.slice(fmEnd + 3).trim();
    }
    return content;
  } catch {
    return null;
  }
}
