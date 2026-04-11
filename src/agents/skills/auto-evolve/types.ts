/**
 * Core types for the auto-evolving skill system.
 *
 * This module defines the shared type contracts used across all auto-evolve
 * submodules: detection, extraction, matching, orchestration, evolution, and
 * diagnostics.
 */

// ---------------------------------------------------------------------------
// Confidence lifecycle
// ---------------------------------------------------------------------------

export const SKILL_CONFIDENCE_LEVELS = ["draft", "validated", "proven", "archived"] as const;
export type SkillConfidenceLevel = (typeof SKILL_CONFIDENCE_LEVELS)[number];

// ---------------------------------------------------------------------------
// Task completion signal
// ---------------------------------------------------------------------------

export type TaskCompletionSignal = {
  detected: boolean;
  confidence: "high" | "medium" | "low";
  taskSummary: string;
  turnRange: [number, number];
};

// ---------------------------------------------------------------------------
// Auto-evolved skill stats (persisted in SKILL.md frontmatter)
// ---------------------------------------------------------------------------

export type AutoEvolveSkillStats = {
  useCount: number;
  successCount: number;
  failCount: number;
  wrongMatchCount: number;
  lastUsedAt?: string;
  lastEvolvedAt?: string;
  evolvedFromSessions: string[];
};

export function createEmptyStats(): AutoEvolveSkillStats {
  return {
    useCount: 0,
    successCount: 0,
    failCount: 0,
    wrongMatchCount: 0,
    evolvedFromSessions: [],
  };
}

// ---------------------------------------------------------------------------
// Auto-evolved skill frontmatter extension
// ---------------------------------------------------------------------------

export type AutoEvolveSkillFrontmatter = {
  name: string;
  description: string;
  triggerPatterns: string[];
  negativePatterns: string[];
  confidence: SkillConfidenceLevel;
  version: number;
  createdFromSession?: string;
  dependsOn: AutoEvolveDependency[];
  stats: AutoEvolveSkillStats;
};

export type AutoEvolveDependency = {
  name: string;
  order: number;
  parallelWith?: string;
};

// ---------------------------------------------------------------------------
// Diagnostics result
// ---------------------------------------------------------------------------

export type SkillDiagnosisType =
  | "wrong_match"
  | "outdated"
  | "needs_orchestration"
  | "unknown";

export type SkillDiagnosticsResult = {
  diagnosis: SkillDiagnosisType;
  negativePatterns?: string[];
  updatedSkill?: string;
  suggestedOrchestration?: { skills: string[]; order: number[] };
};

// ---------------------------------------------------------------------------
// Extraction request / result
// ---------------------------------------------------------------------------

export type SkillExtractionRequest = {
  sessionId: string;
  agentId: string;
  taskSummary: string;
  turnRange: [number, number];
  sessionNotesContent?: string;
  existingSkillIndex?: string;
  /**
   * When set, the extractor is explicitly instructed to merge-update this skill
   * (used when the session already used it successfully and may have refined the steps).
   */
  mergeTargetSkillName?: string;
  diagnosticsContext?: {
    skillName: string;
    skillVersion: number;
    reason: "user_unsatisfied" | "user_corrected";
  };
  /** Last N conversation messages (role + text) injected into the extraction prompt so the LLM can distill actual steps. */
  recentMessages?: Array<{ role: "user" | "assistant"; content: string }>;
};

export type SkillExtractionResult = {
  action: "created" | "updated" | "merged" | "skipped";
  skillName?: string;
  skillDir?: string;
  diagnostics?: SkillDiagnosticsResult;
};

// ---------------------------------------------------------------------------
// Matcher result
// ---------------------------------------------------------------------------

export type SkillMatchResult = {
  skillName: string;
  skillDir: string;
  score: number;
  matchType: "keyword" | "semantic" | "hybrid";
};

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export type AutoEvolveDetectionConfig = {
  inlineSignal: boolean;
  minConfidence: "high" | "medium" | "low";
};

export type AutoEvolveExtractionConfig = {
  model?: string;
  maxOutputTokens?: number;
  minTaskTurns: number;
  maxExtractionsPerDay: number;
};

export type AutoEvolveMatchingConfig = {
  enabled: boolean;
  strategy: "keyword" | "semantic" | "hybrid";
  minScore: number;
};

export type AutoEvolveEvolutionConfig = {
  provenThreshold: number;
  archiveDays: number;
  degradeFailRate: number;
};

export type AutoEvolveConfig = {
  enabled: boolean;
  detection: AutoEvolveDetectionConfig;
  extraction: AutoEvolveExtractionConfig;
  matching: AutoEvolveMatchingConfig;
  evolution: AutoEvolveEvolutionConfig;
};

export const DEFAULT_AUTO_EVOLVE_CONFIG: AutoEvolveConfig = {
  enabled: true,
  detection: {
    inlineSignal: true,
    minConfidence: "medium",
  },
  extraction: {
    minTaskTurns: 4,
    maxExtractionsPerDay: 10,
  },
  matching: {
    enabled: true,
    strategy: "keyword",
    minScore: 0.6,
  },
  evolution: {
    provenThreshold: 5,
    archiveDays: 90,
    degradeFailRate: 0.5,
  },
};

// ---------------------------------------------------------------------------
// SpawnFn (shared with extract-memories)
// ---------------------------------------------------------------------------

export type AutoEvolveSpawnFnResult = {
  messages: Array<Record<string, unknown>>;
  totalUsage: { input_tokens: number; output_tokens: number };
};

export type AutoEvolveSpawnFn = (params: {
  task: string;
  label: string;
}) => Promise<AutoEvolveSpawnFnResult>;
