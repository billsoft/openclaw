/**
 * Resolve the auto-evolve configuration from the OpenClaw config tree.
 *
 * Config path: `skills.autoEvolve.*`
 *
 * All fields are optional and fall back to DEFAULT_AUTO_EVOLVE_CONFIG.
 */

import {
  DEFAULT_AUTO_EVOLVE_CONFIG,
  type AutoEvolveConfig,
  type AutoEvolveDetectionConfig,
  type AutoEvolveEvolutionConfig,
  type AutoEvolveExtractionConfig,
  type AutoEvolveMatchingConfig,
} from "./types.js";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const lower = value.trim().toLowerCase();
    if (lower === "true") return true;
    if (lower === "false") return false;
  }
  return fallback;
}

function normalizePositiveInt(value: unknown, fallback: number): number {
  const num = typeof value === "string" ? Number(value) : Number(value);
  if (Number.isFinite(num) && num > 0) return Math.floor(num);
  return fallback;
}

function normalizeScore(value: unknown, fallback: number): number {
  const num = typeof value === "string" ? Number(value) : Number(value);
  if (Number.isFinite(num) && num >= 0 && num <= 1) return num;
  return fallback;
}

function normalizeConfidenceLevel(
  value: unknown,
  fallback: "high" | "medium" | "low",
): "high" | "medium" | "low" {
  if (typeof value === "string") {
    const lower = value.trim().toLowerCase();
    if (lower === "high" || lower === "medium" || lower === "low") return lower;
  }
  return fallback;
}

function normalizeStrategy(
  value: unknown,
  fallback: "keyword" | "semantic" | "hybrid",
): "keyword" | "semantic" | "hybrid" {
  if (typeof value === "string") {
    const lower = value.trim().toLowerCase();
    if (lower === "keyword" || lower === "semantic" || lower === "hybrid") return lower;
  }
  return fallback;
}

function resolveDetection(raw: unknown): AutoEvolveDetectionConfig {
  const record = asRecord(raw);
  const defaults = DEFAULT_AUTO_EVOLVE_CONFIG.detection;
  return {
    inlineSignal: normalizeBoolean(record?.inlineSignal, defaults.inlineSignal),
    minConfidence: normalizeConfidenceLevel(record?.minConfidence, defaults.minConfidence),
  };
}

function resolveExtraction(raw: unknown): AutoEvolveExtractionConfig {
  const record = asRecord(raw);
  const defaults = DEFAULT_AUTO_EVOLVE_CONFIG.extraction;
  const model = typeof record?.model === "string" ? record.model.trim() || undefined : undefined;
  const maxOutputTokens =
    record?.maxOutputTokens !== undefined
      ? normalizePositiveInt(record.maxOutputTokens, 0) || undefined
      : undefined;
  return {
    ...(model ? { model } : {}),
    ...(maxOutputTokens ? { maxOutputTokens } : {}),
    minTaskTurns: normalizePositiveInt(record?.minTaskTurns, defaults.minTaskTurns),
    maxExtractionsPerDay: normalizePositiveInt(
      record?.maxExtractionsPerDay,
      defaults.maxExtractionsPerDay,
    ),
  };
}

function resolveMatching(raw: unknown): AutoEvolveMatchingConfig {
  const record = asRecord(raw);
  const defaults = DEFAULT_AUTO_EVOLVE_CONFIG.matching;
  return {
    enabled: normalizeBoolean(record?.enabled, defaults.enabled),
    strategy: normalizeStrategy(record?.strategy, defaults.strategy),
    minScore: normalizeScore(record?.minScore, defaults.minScore),
  };
}

function resolveEvolution(raw: unknown): AutoEvolveEvolutionConfig {
  const record = asRecord(raw);
  const defaults = DEFAULT_AUTO_EVOLVE_CONFIG.evolution;
  return {
    provenThreshold: normalizePositiveInt(record?.provenThreshold, defaults.provenThreshold),
    archiveDays: normalizePositiveInt(record?.archiveDays, defaults.archiveDays),
    degradeFailRate: normalizeScore(record?.degradeFailRate, defaults.degradeFailRate),
  };
}

export function resolveAutoEvolveConfig(
  skillsConfig?: Record<string, unknown>,
): AutoEvolveConfig {
  const raw = asRecord(skillsConfig?.autoEvolve);
  return {
    enabled: normalizeBoolean(raw?.enabled, DEFAULT_AUTO_EVOLVE_CONFIG.enabled),
    detection: resolveDetection(raw?.detection),
    extraction: resolveExtraction(raw?.extraction),
    matching: resolveMatching(raw?.matching),
    evolution: resolveEvolution(raw?.evolution),
  };
}
