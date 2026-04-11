/**
 * SkillExtractor — Background agent that distills a successful conversation
 * into a reusable SKILL.md file.
 *
 * Architecture: mirrors `extract-memories.ts` — fires asynchronously via
 * `spawnFn`, parses structured JSON output, writes files to managed skills dir.
 *
 * Key behaviors:
 *  1. Searches existing skill index to avoid duplicates (merge-update if found).
 *  2. Reads session notes (pre-denoised summary) when available.
 *  3. Queries user memory for preferences to bake into skill steps.
 *  4. Strips failed attempts — outputs only the shortest reproducible path.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { logInfo, logWarn, logDebug } from "../../../logger.js";
import { readSkillIndex, writeSkillIndex, type SkillIndexEntry } from "./skill-index.js";
import type {
  AutoEvolveConfig,
  AutoEvolveSpawnFn,
  SkillExtractionRequest,
  SkillExtractionResult,
  SkillDiagnosticsResult,
  AutoEvolveSkillFrontmatter,
} from "./types.js";
import { createEmptyStats } from "./types.js";

// ---------------------------------------------------------------------------
// Extraction state (throttle)
// ---------------------------------------------------------------------------

let extractionsToday = 0;
let lastResetDay = "";

function resetDailyCounterIfNeeded(): void {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== lastResetDay) {
    extractionsToday = 0;
    lastResetDay = today;
  }
}

export function getExtractionsToday(): number {
  resetDailyCounterIfNeeded();
  return extractionsToday;
}

// ---------------------------------------------------------------------------
// Extraction prompt
// ---------------------------------------------------------------------------

function buildExtractionPrompt(request: SkillExtractionRequest): string {
  const parts: string[] = [EXTRACTION_SYSTEM_PROMPT];

  if (request.existingSkillIndex) {
    parts.push(`\n## Existing skill index\n\n${request.existingSkillIndex}`);
  }

  if (request.sessionNotesContent) {
    parts.push(
      `\n## Session notes (pre-summarized)\n\nUse these as the primary source — they are already denoised.\n\n${request.sessionNotesContent}`,
    );
  }

  if (request.recentMessages && request.recentMessages.length > 0) {
    const transcript = request.recentMessages
      .map((m) => `[${m.role}]: ${m.content}`)
      .join("\n\n---\n\n");
    parts.push(`\n## Conversation transcript (last ${request.recentMessages.length} turns)\n\nUse this as the primary source to extract steps.\n\n${transcript}`);
  }

  if (request.mergeTargetSkillName) {
    parts.push(
      `\n## Merge target\n\nThis session successfully used skill "${request.mergeTargetSkillName}". Preferred action: **merge-update** that skill with any improved or refined steps from this session. Preserve the skill name. Only create a new skill if the task is clearly unrelated to "${request.mergeTargetSkillName}".`,
    );
  }

  if (request.diagnosticsContext) {
    const ctx = request.diagnosticsContext;
    parts.push(
      `\n## Diagnostics context\n\nThe system auto-loaded skill "${ctx.skillName}" (v${ctx.skillVersion}), but the user was ${ctx.reason === "user_unsatisfied" ? "unsatisfied" : "correcting steps"}. Analyze:\n1. Was the skill wrongly matched? (if yes, suggest negative-patterns)\n2. Are the skill steps outdated? (if yes, output updated SKILL.md)\n3. Does it need orchestration with other skills? (if yes, output depends-on)`,
    );
  }

  parts.push(
    `\n## Task info\n\n- Session: ${request.sessionId}\n- Agent: ${request.agentId}\n- Summary: ${request.taskSummary}\n- Turn range: ${request.turnRange[0]}–${request.turnRange[1]}`,
  );

  return parts.join("\n");
}

const EXTRACTION_SYSTEM_PROMPT = `# Skill Extraction

You are a skill distillation expert. You will receive context about a completed human-AI conversation and must extract the successful approach as a reusable skill.

## Your workflow

1. **Search existing skills**: Check the skill index below. If a similar skill exists, output an UPDATE rather than creating a new one.
2. **Identify the task**: What was accomplished?
3. **Denoise**: Remove ALL failed attempts, wrong directions, and debugging tangents.
4. **Extract shortest path**: Keep ONLY the minimal reproducible steps from zero to success.
5. **Package**: Output the result in the exact JSON format below.

## Output format

Respond with ONLY a JSON object — no markdown fences, no explanation:

{
  "action": "created" | "updated" | "merged" | "skipped",
  "reason": "short explanation",
  "skill": {
    "name": "kebab-case-name",
    "description": "One-line description under 120 chars",
    "triggerPatterns": ["pattern 1", "pattern 2"],
    "negativePatterns": [],
    "dependsOn": [],
    "steps": "# Steps\\n\\n1. First do X\\n2. Then do Y\\n..."
  },
  "diagnostics": null
}

If the task is too trivial (e.g., just answering a question) or already perfectly covered by an existing skill, use action "skipped".

If diagnosing a failed skill invocation, include a "diagnostics" object:
{
  "diagnosis": "wrong_match" | "outdated" | "needs_orchestration",
  "negativePatterns": ["pattern to exclude"],
  "updatedSkill": "full updated SKILL.md content if outdated",
  "suggestedOrchestration": { "skills": ["a", "b"], "order": [1, 2] }
}

## Rules

- Steps must be reproducible commands/operations. Never include "I tried X but it failed".
- Prefer merging into an existing skill over creating near-duplicates.
- trigger-patterns should be natural-language intent phrases the user might say.
- If updating, preserve existing trigger-patterns and stats; only modify steps/description.

## Decision: modify existing vs create helper skill

When a \`mergeTargetSkillName\` is provided (a skill was already used successfully):
- **Merge-update**: If the session refined, shortened, or improved the same steps → output action="updated", preserve the skill name.
- **Create helper skill**: If the session revealed a reusable NEW subtask (e.g. "setup env vars" is needed before every deploy) → create a new skill for that subtask AND add it to the existing skill's \`dependsOn\`. Output the helper skill; mention the dependency in the steps.
- **No change**: If the loaded skill's steps were followed exactly with no improvements → output action="skipped".

When NO \`mergeTargetSkillName\` is provided:
- Check the existing index. If >70% trigger-pattern overlap with existing skill → merge-update.
- If the task spans multiple distinct reusable phases → consider creating 2-3 smaller skills each with a clear trigger, rather than one monolithic skill.
- If the task is too simple (< 3 steps, no reusable pattern) → action="skipped".`;

// ---------------------------------------------------------------------------
// Result parser
// ---------------------------------------------------------------------------

type RawExtractionOutput = {
  action: string;
  reason?: string;
  skill?: {
    name?: string;
    description?: string;
    triggerPatterns?: string[];
    negativePatterns?: string[];
    dependsOn?: Array<{ name: string; order: number; parallelWith?: string }>;
    steps?: string;
  };
  diagnostics?: {
    diagnosis?: string;
    negativePatterns?: string[];
    updatedSkill?: string;
    suggestedOrchestration?: { skills: string[]; order: number[] };
  } | null;
};

function parseExtractionOutput(text: string): RawExtractionOutput | null {
  const jsonMatch = /\{[\s\S]*\}/.exec(text);
  if (!jsonMatch) return null;
  try {
    const parsed = JSON.parse(jsonMatch[0]) as unknown;
    if (parsed && typeof parsed === "object" && "action" in parsed) {
      return parsed as RawExtractionOutput;
    }
  } catch {
    // Malformed JSON — skip.
  }
  return null;
}

// ---------------------------------------------------------------------------
// File writer
// ---------------------------------------------------------------------------

function buildSkillMdContent(frontmatter: AutoEvolveSkillFrontmatter, steps: string): string {
  const lines: string[] = ["---"];
  lines.push(`name: ${frontmatter.name}`);
  lines.push(`description: ${frontmatter.description}`);
  if (frontmatter.triggerPatterns.length > 0) {
    lines.push("trigger-patterns:");
    for (const p of frontmatter.triggerPatterns) {
      lines.push(`  - "${p}"`);
    }
  }
  if (frontmatter.negativePatterns.length > 0) {
    lines.push("negative-patterns:");
    for (const p of frontmatter.negativePatterns) {
      lines.push(`  - "${p}"`);
    }
  }
  lines.push(`confidence: ${frontmatter.confidence}`);
  lines.push(`version: ${frontmatter.version}`);
  if (frontmatter.createdFromSession) {
    lines.push(`created-from-session: ${frontmatter.createdFromSession}`);
  }
  if (frontmatter.dependsOn.length > 0) {
    lines.push("depends-on:");
    for (const dep of frontmatter.dependsOn) {
      lines.push(`  - name: ${dep.name}`);
      lines.push(`    order: ${dep.order}`);
      if (dep.parallelWith) {
        lines.push(`    parallel-with: ${dep.parallelWith}`);
      }
    }
  }
  // Stats
  const s = frontmatter.stats;
  lines.push("stats:");
  lines.push(`  use-count: ${s.useCount}`);
  lines.push(`  success-count: ${s.successCount}`);
  lines.push(`  fail-count: ${s.failCount}`);
  lines.push(`  wrong-match-count: ${s.wrongMatchCount}`);
  if (s.lastUsedAt) lines.push(`  last-used: ${s.lastUsedAt}`);
  if (s.lastEvolvedAt) lines.push(`  last-evolved: ${s.lastEvolvedAt}`);
  if (s.evolvedFromSessions.length > 0) {
    lines.push("  evolved-from-sessions:");
    for (const sid of s.evolvedFromSessions) {
      lines.push(`    - ${sid}`);
    }
  }
  lines.push("---");
  lines.push("");
  lines.push(steps);
  return lines.join("\n");
}

async function writeSkillFiles(
  managedSkillsDir: string,
  name: string,
  frontmatter: AutoEvolveSkillFrontmatter,
  steps: string,
): Promise<string> {
  const autoDir = path.join(managedSkillsDir, "_auto");
  const skillDir = path.join(autoDir, name);
  await fs.mkdir(skillDir, { recursive: true });

  const skillMdContent = buildSkillMdContent(frontmatter, steps);
  await fs.writeFile(path.join(skillDir, "SKILL.md"), skillMdContent, {
    encoding: "utf-8",
    mode: 0o600,
  });

  return skillDir;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function extractSkillIfNeeded(params: {
  request: SkillExtractionRequest;
  config: AutoEvolveConfig;
  managedSkillsDir: string;
  spawnFn: AutoEvolveSpawnFn;
}): Promise<SkillExtractionResult> {
  const { request, config, managedSkillsDir, spawnFn } = params;

  const skipResult: SkillExtractionResult = { action: "skipped" };

  if (!config.enabled) return skipResult;

  // Daily throttle
  resetDailyCounterIfNeeded();
  if (extractionsToday >= config.extraction.maxExtractionsPerDay) {
    logDebug(
      `[auto-evolve] daily extraction limit reached (${extractionsToday}/${config.extraction.maxExtractionsPerDay})`,
    );
    return skipResult;
  }

  // Min turns gate
  const turnCount = request.turnRange[1] - request.turnRange[0];
  if (!request.diagnosticsContext && turnCount < config.extraction.minTaskTurns) {
    logDebug(
      `[auto-evolve] task too short (${turnCount} turns < ${config.extraction.minTaskTurns})`,
    );
    return skipResult;
  }

  // Read existing index for dedup context
  let existingIndex = "";
  try {
    const indexEntries = await readSkillIndex(managedSkillsDir);
    existingIndex = indexEntries
      .map((e) => `- ${e.name}: ${e.description} [triggers: ${e.triggerPatterns.join(", ")}]`)
      .join("\n");
    request.existingSkillIndex = existingIndex;
  } catch {
    // No index yet — fine.
  }

  const prompt = buildExtractionPrompt(request);

  try {
    logInfo(`[auto-evolve] extracting skill from session=${request.sessionId}`);
    const result = await spawnFn({ task: prompt, label: "auto_evolve_extract" });

    extractionsToday++;

    const lastMsg = result.messages[result.messages.length - 1];
    const text = typeof lastMsg?.content === "string" ? lastMsg.content : "";
    const parsed = parseExtractionOutput(text);

    if (!parsed || parsed.action === "skipped" || !parsed.skill?.name) {
      logDebug(`[auto-evolve] extraction skipped: ${parsed?.reason ?? "no output"}`);
      return skipResult;
    }

    const skillName = parsed.skill.name.replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-");
    const frontmatter: AutoEvolveSkillFrontmatter = {
      name: skillName,
      description: parsed.skill.description || skillName,
      triggerPatterns: parsed.skill.triggerPatterns ?? [],
      negativePatterns: parsed.skill.negativePatterns ?? [],
      confidence: "draft",
      version: 1,
      createdFromSession: request.sessionId,
      dependsOn: (parsed.skill.dependsOn ?? []).map((d) => ({
        name: d.name,
        order: d.order,
        parallelWith: d.parallelWith,
      })),
      stats: {
        ...createEmptyStats(),
        lastEvolvedAt: new Date().toISOString(),
        evolvedFromSessions: [request.sessionId],
      },
    };

    const steps = parsed.skill.steps || `# ${skillName}\n\nNo steps extracted.`;
    const action =
      parsed.action === "updated" || parsed.action === "merged"
        ? (parsed.action as "updated" | "merged")
        : "created";

    const skillDir = await writeSkillFiles(managedSkillsDir, skillName, frontmatter, steps);

    // Update index
    const newEntry: SkillIndexEntry = {
      name: skillName,
      description: frontmatter.description,
      triggerPatterns: frontmatter.triggerPatterns,
      negativePatterns: frontmatter.negativePatterns,
      confidence: frontmatter.confidence,
      location: path.relative(managedSkillsDir, path.join(skillDir, "SKILL.md")),
      successCount: 0,
      useCount: 0,
    };

    try {
      const currentIndex = await readSkillIndex(managedSkillsDir).catch(() => []);
      const updatedIndex = currentIndex.filter((e) => e.name !== skillName);
      updatedIndex.push(newEntry);
      await writeSkillIndex(managedSkillsDir, updatedIndex);
    } catch (indexErr) {
      logWarn(`[auto-evolve] failed to update skill index: ${String(indexErr)}`);
    }

    logInfo(
      `[auto-evolve] ${action} skill "${skillName}" at ${skillDir} ` +
        `(input=${result.totalUsage.input_tokens} output=${result.totalUsage.output_tokens})`,
    );

    return {
      action,
      skillName,
      skillDir,
      diagnostics: parsed.diagnostics
        ? {
            diagnosis: (parsed.diagnostics.diagnosis ??
              "unknown") as SkillDiagnosticsResult["diagnosis"],
            negativePatterns: parsed.diagnostics.negativePatterns,
            updatedSkill: parsed.diagnostics.updatedSkill,
            suggestedOrchestration: parsed.diagnostics.suggestedOrchestration,
          }
        : undefined,
    };
  } catch (error) {
    logWarn(`[auto-evolve] extraction failed for session=${request.sessionId}: ${String(error)}`);
    return skipResult;
  }
}

export function resetExtractionState(): void {
  extractionsToday = 0;
  lastResetDay = "";
}
