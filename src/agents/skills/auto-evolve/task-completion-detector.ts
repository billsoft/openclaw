/**
 * TaskCompletionDetector
 *
 * Detects whether the current conversation turn represents a successfully
 * completed task where the user is satisfied.
 *
 * Detection is done by parsing a structured `<task_signal>` tag that the
 * main agent appends to its reply (injected via system prompt addendum).
 * This avoids an extra LLM call — the main model judges completion inline.
 *
 * Integration point: called as a post-processing step after each agent reply.
 */

import type { TaskCompletionSignal, AutoEvolveConfig } from "./types.js";

// ---------------------------------------------------------------------------
// System prompt addendum — injected at the end of the agent's system prompt
// when auto-evolve is enabled.
// ---------------------------------------------------------------------------

export const TASK_SIGNAL_SYSTEM_PROMPT_ADDENDUM = `
## Task completion signal (invisible to user)

When you believe the user's current task is **fully and successfully complete** and they are satisfied:
- Append this tag at the very end of your reply (invisible to user, stripped before display):
  <task_signal status="completed" confidence="high|medium" summary="verb + object in ≤12 words"/>
- Use confidence="high" only when: user explicitly confirmed ("完成了"/"done"/"谢谢"/"looks good"), or you verified the result works.
- Use confidence="medium" when: task appears done but no explicit confirmation.
- Do NOT emit when: task is only partially done, user is still iterating, or you're mid-multi-step work.
- The summary must describe what was accomplished, e.g. "deployed Next.js app to Vercel" or "fixed ESLint prettier conflict".

When the user is clearly dissatisfied with the approach taken (correcting steps, expressing frustration, asking for a different method):
  <task_signal status="unsatisfied" confidence="high" summary="what went wrong in ≤12 words"/>

Only ONE signal per reply. Never emit both.
`.trim();

// ---------------------------------------------------------------------------
// Negative signal addendum — covered by the unified addendum above.
// ---------------------------------------------------------------------------

export const TASK_DISSATISFACTION_SIGNAL_ADDENDUM = "";

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

const TASK_SIGNAL_REGEX =
  /<task_signal\b[^>]*\bstatus="(?<status>[^"]+)"[^>]*\bconfidence="(?<confidence>[^"]+)"[^>]*\bsummary="(?<summary>[^"]*)"[^/]*\/?>/;

export type ParsedTaskSignal = {
  status: "completed" | "unsatisfied" | string;
  confidence: "high" | "medium" | "low";
  summary: string;
};

export function parseTaskSignal(text: string): ParsedTaskSignal | null {
  const match = TASK_SIGNAL_REGEX.exec(text);
  if (!match?.groups) return null;

  const confidence = match.groups.confidence as "high" | "medium" | "low";
  if (confidence !== "high" && confidence !== "medium" && confidence !== "low") {
    return null;
  }

  return {
    status: match.groups.status,
    confidence,
    summary: match.groups.summary || "",
  };
}

export function stripTaskSignal(text: string): string {
  return text.replace(/<task_signal\b[^>]*\/?>(\s*<\/task_signal>)?/g, "").trimEnd();
}

// ---------------------------------------------------------------------------
// Confidence gate
// ---------------------------------------------------------------------------

const CONFIDENCE_ORDER: Record<string, number> = { low: 0, medium: 1, high: 2 };

function meetsConfidenceThreshold(
  actual: "high" | "medium" | "low",
  minimum: "high" | "medium" | "low",
): boolean {
  return (CONFIDENCE_ORDER[actual] ?? 0) >= (CONFIDENCE_ORDER[minimum] ?? 0);
}

// ---------------------------------------------------------------------------
// Detector
// ---------------------------------------------------------------------------

export function detectTaskCompletion(
  agentReplyText: string,
  currentTurnIndex: number,
  config: AutoEvolveConfig,
): TaskCompletionSignal {
  const noSignal: TaskCompletionSignal = {
    detected: false,
    confidence: "low",
    taskSummary: "",
    turnRange: [0, currentTurnIndex],
  };

  if (!config.enabled || !config.detection.inlineSignal) {
    return noSignal;
  }

  const parsed = parseTaskSignal(agentReplyText);
  if (!parsed) return noSignal;

  if (parsed.status !== "completed") return noSignal;

  if (!meetsConfidenceThreshold(parsed.confidence, config.detection.minConfidence)) {
    return noSignal;
  }

  return {
    detected: true,
    confidence: parsed.confidence,
    taskSummary: parsed.summary,
    turnRange: [0, currentTurnIndex],
  };
}

export function detectUserDissatisfaction(
  agentReplyText: string,
): ParsedTaskSignal | null {
  const parsed = parseTaskSignal(agentReplyText);
  if (!parsed || parsed.status !== "unsatisfied") return null;
  return parsed;
}
