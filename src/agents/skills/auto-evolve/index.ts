/**
 * Auto-Evolving Skill System — Main integration entry point.
 *
 * Provides the public API consumed by the agent pipeline:
 *
 *  1. `onAgentReply()` — Post-processing hook after each agent reply.
 *     Strips task signals, detects completion, triggers extraction.
 *
 *  2. `onUserMessage()` — Pre-processing hook before each user message.
 *     Matches skills, loads steps into context.
 *
 *  3. `getSystemPromptAddendum()` — Returns prompt additions for inline
 *     signal injection + auto-evolved skill index.
 */

import { logDebug, logInfo, logWarn } from "../../../logger.js";
import type { AutoEvolveConfig, AutoEvolveSpawnFn, SkillMatchResult } from "./types.js";
import { resolveAutoEvolveConfig } from "./config.js";
import {
  detectTaskCompletion,
  detectUserDissatisfaction,
  stripTaskSignal,
  TASK_SIGNAL_SYSTEM_PROMPT_ADDENDUM,
  TASK_DISSATISFACTION_SIGNAL_ADDENDUM,
} from "./task-completion-detector.js";
import { extractSkillIfNeeded } from "./skill-extractor.js";
import { readSkillIndex, formatSkillIndexForPrompt } from "./skill-index.js";
import { matchSkills, loadSkillSteps } from "./skill-matcher.js";
import { recordSkillSuccess } from "./skill-evolution.js";
import { diagnoseAndRepair } from "./skill-diagnostics.js";
import { resolveOrchestrationPlan } from "./skill-orchestrator.js";

// ---------------------------------------------------------------------------
// State — tracks which skill was auto-loaded in the current session
// ---------------------------------------------------------------------------

type SessionAutoEvolveState = {
  loadedSkillName?: string;
  loadedSkillDir?: string;
  lastExtractionTurnIndex?: number;
};

const sessionStates = new Map<string, SessionAutoEvolveState>();

function getSessionState(sessionId: string): SessionAutoEvolveState {
  let state = sessionStates.get(sessionId);
  if (!state) {
    state = {};
    sessionStates.set(sessionId, state);
  }
  return state;
}

// ---------------------------------------------------------------------------
// System prompt addendum
// ---------------------------------------------------------------------------

export async function getSystemPromptAddendum(params: {
  managedSkillsDir: string;
  skillsConfig?: Record<string, unknown>;
}): Promise<string> {
  const config = resolveAutoEvolveConfig(params.skillsConfig);
  if (!config.enabled) return "";

  const parts: string[] = [];

  // 1. Inject task signal request
  if (config.detection.inlineSignal) {
    parts.push(TASK_SIGNAL_SYSTEM_PROMPT_ADDENDUM);
    parts.push(TASK_DISSATISFACTION_SIGNAL_ADDENDUM);
  }

  // 2. Inject auto-evolved skill index
  try {
    const entries = await readSkillIndex(params.managedSkillsDir);
    const indexPrompt = formatSkillIndexForPrompt(entries);
    if (indexPrompt) {
      parts.push(indexPrompt);
    }
  } catch {
    // No index yet — skip.
  }

  return parts.join("\n\n");
}

// ---------------------------------------------------------------------------
// Post-reply hook — called after each agent reply
// ---------------------------------------------------------------------------

export type OnAgentReplyResult = {
  strippedReply: string;
  taskCompleted: boolean;
  extractionTriggered: boolean;
  dissatisfactionDetected: boolean;
};

export async function onAgentReply(params: {
  agentReplyText: string;
  sessionId: string;
  agentId: string;
  currentTurnIndex: number;
  managedSkillsDir: string;
  skillsConfig?: Record<string, unknown>;
  spawnFn?: AutoEvolveSpawnFn;
  sessionNotesContent?: string;
  recentMessages?: Array<{ role: "user" | "assistant"; content: string }>;
}): Promise<OnAgentReplyResult> {
  const config = resolveAutoEvolveConfig(params.skillsConfig);
  const stripped = stripTaskSignal(params.agentReplyText);

  const result: OnAgentReplyResult = {
    strippedReply: stripped,
    taskCompleted: false,
    extractionTriggered: false,
    dissatisfactionDetected: false,
  };

  if (!config.enabled) return result;

  const state = getSessionState(params.sessionId);

  // Check for dissatisfaction (if a skill was auto-loaded)
  const dissatisfaction = detectUserDissatisfaction(params.agentReplyText);
  if (dissatisfaction && state.loadedSkillName && params.spawnFn) {
    result.dissatisfactionDetected = true;
    logInfo(
      `[auto-evolve] dissatisfaction detected for skill "${state.loadedSkillName}" in session=${params.sessionId}`,
    );

    // Fire diagnostics asynchronously — don't block the main reply
    diagnoseAndRepair({
      skillName: state.loadedSkillName,
      sessionId: params.sessionId,
      agentId: params.agentId,
      taskSummary: dissatisfaction.summary,
      turnRange: [0, params.currentTurnIndex],
      reason: "user_unsatisfied",
      managedSkillsDir: params.managedSkillsDir,
      config,
      spawnFn: params.spawnFn,
      sessionNotesContent: params.sessionNotesContent,
    }).catch((err) => {
      logWarn(`[auto-evolve] diagnostics failed: ${String(err)}`);
    });

    return result;
  }

  // Check for task completion
  const signal = detectTaskCompletion(
    params.agentReplyText,
    params.currentTurnIndex,
    config,
  );

  if (!signal.detected) return result;

  result.taskCompleted = true;

  // If a skill was used and task succeeded, record success
  if (state.loadedSkillName) {
    await recordSkillSuccess({
      skillName: state.loadedSkillName,
      managedSkillsDir: params.managedSkillsDir,
      config,
    }).catch((err) => {
      logWarn(`[auto-evolve] recordSkillSuccess failed: ${String(err)}`);
    });
  }

  // Session-level extraction dedup: don't extract if we already extracted within the last 5 turns.
  const turnsSinceLastExtraction =
    state.lastExtractionTurnIndex !== undefined
      ? params.currentTurnIndex - state.lastExtractionTurnIndex
      : Infinity;
  if (turnsSinceLastExtraction < 5) {
    result.extractionTriggered = false;
    return result;
  }
  state.lastExtractionTurnIndex = params.currentTurnIndex;

  // Fire skill extraction asynchronously.
  // If a skill was loaded this turn, pass it as mergeTargetSkillName so the
  // extractor knows to merge-update it with any improved steps from this session.
  if (params.spawnFn) {
    result.extractionTriggered = true;
    extractSkillIfNeeded({
      request: {
        sessionId: params.sessionId,
        agentId: params.agentId,
        taskSummary: signal.taskSummary,
        turnRange: signal.turnRange,
        sessionNotesContent: params.sessionNotesContent,
        recentMessages: params.recentMessages,
        ...(state.loadedSkillName ? { mergeTargetSkillName: state.loadedSkillName } : {}),
      },
      config,
      managedSkillsDir: params.managedSkillsDir,
      spawnFn: params.spawnFn,
    }).catch((err) => {
      logWarn(`[auto-evolve] extraction failed: ${String(err)}`);
    });
  }

  return result;
}

// ---------------------------------------------------------------------------
// Pre-message hook — called before processing user message
// ---------------------------------------------------------------------------

export type OnUserMessageResult = {
  matchedSkills: SkillMatchResult[];
  contextAddendum: string;
};

export async function onUserMessage(params: {
  userMessage: string;
  sessionId: string;
  managedSkillsDir: string;
  skillsConfig?: Record<string, unknown>;
}): Promise<OnUserMessageResult> {
  const config = resolveAutoEvolveConfig(params.skillsConfig);
  const noMatch: OnUserMessageResult = { matchedSkills: [], contextAddendum: "" };

  if (!config.enabled || !config.matching.enabled) return noMatch;

  const matches = await matchSkills({
    userMessage: params.userMessage,
    managedSkillsDir: params.managedSkillsDir,
    config,
    maxResults: 1,
  });

  if (matches.length === 0) return noMatch;

  const topMatch = matches[0];
  const steps = await loadSkillSteps(params.managedSkillsDir, topMatch.skillDir);
  if (!steps) return noMatch;

  // Track which skill was loaded for this session
  const state = getSessionState(params.sessionId);
  state.loadedSkillName = topMatch.skillName;
  state.loadedSkillDir = topMatch.skillDir;

  // Check if orchestration is needed
  const plan = await resolveOrchestrationPlan({
    skillName: topMatch.skillName,
    managedSkillsDir: params.managedSkillsDir,
  });

  let contextAddendum: string;
  if (plan.valid && plan.steps.length > 1) {
    // Multi-skill orchestration
    const stepDescriptions = plan.steps
      .map((s) => `  Step ${s.order}: ${s.skills.join(" + ")}`)
      .join("\n");
    contextAddendum = `[Auto-loaded skill: "${topMatch.skillName}" (orchestrated)]
This task requires multiple skills in sequence:
${stepDescriptions}

Follow these steps as a guide, starting with the loaded skill:

${steps}`;
  } else {
    contextAddendum = `[Auto-loaded skill: "${topMatch.skillName}" (score: ${topMatch.score.toFixed(2)})]
The following skill steps are relevant to the user's request.
Follow them as a guide, adapting as needed.

${steps}`;
  }

  logInfo(
    `[auto-evolve] matched skill "${topMatch.skillName}" (score=${topMatch.score.toFixed(2)}) for session=${params.sessionId}`,
  );

  return {
    matchedSkills: matches,
    contextAddendum,
  };
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

export function resetSessionAutoEvolveState(sessionId: string): void {
  sessionStates.delete(sessionId);
}

export function resetAllAutoEvolveState(): void {
  sessionStates.clear();
}

// ---------------------------------------------------------------------------
// Re-exports
// ---------------------------------------------------------------------------

export { resolveAutoEvolveConfig } from "./config.js";
export type { AutoEvolveConfig } from "./types.js";
export { readSkillIndex, writeSkillIndex, formatSkillIndexForPrompt } from "./skill-index.js";
export { matchSkills } from "./skill-matcher.js";
export { buildExecutionPlan, resolveOrchestrationPlan } from "./skill-orchestrator.js";
export { recordSkillSuccess, recordSkillFailure } from "./skill-evolution.js";
export { diagnoseAndRepair } from "./skill-diagnostics.js";
export {
  parseTaskSignal,
  stripTaskSignal,
  detectTaskCompletion,
} from "./task-completion-detector.js";
