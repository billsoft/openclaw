/**
 * Global Memory Curation Phase
 *
 * Scans user-type memory files across ALL agent workspaces, identifies
 * cross-agent universal facts via LLM, and promotes them to the shared
 * global memory layer (~/.openclaw/global-memory/memory/).
 *
 * Conservative writing rules:
 *  - Only facts that appear in 2+ distinct agent workspaces are candidates
 *  - LLM is the final arbiter; it skips anything uncertain
 *  - Never deletes existing global memory files (only creates/updates)
 *  - Never touches soul.md, agents.md, tools.md, heartbeat.md
 *  - Runs at most once every 20 hours (prevents redundant daily triggers)
 *  - Logs every run to global-memory/.dreams/curation-log.md
 *  - Warns when global MEMORY.md index grows beyond 80 entries
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/memory-core";
import {
  resolveDefaultAgentId,
  resolveGlobalMemoryDir,
  resolveStateDir,
} from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { resolveMemoryDreamingWorkspaces } from "openclaw/plugin-sdk/memory-core-host-status";
import {
  completeWithPreparedSimpleCompletionModel,
  extractAssistantText,
  prepareSimpleCompletionModelForAgent,
  resolveSidecarModelRef,
} from "openclaw/plugin-sdk/simple-completion-runtime";

// ── Constants ─────────────────────────────────────────────────────────────────

const LOOKBACK_DAYS = 14;
const MIN_HOURS_BETWEEN_RUNS = 20;
const LLM_TIMEOUT_MS = 20_000;
const HEALTH_WARNING_THRESHOLD = 80;
const FRONTMATTER_SCAN_LINES = 25;
const MAX_CONTENT_CHARS = 600; // truncate long files before sending to LLM
const STATE_RELATIVE_PATH = path.join(".dreams", "curation-state.json");
const LOG_RELATIVE_PATH = path.join(".dreams", "curation-log.md");

// ── Types ─────────────────────────────────────────────────────────────────────

type Logger = { info(msg: string): void; warn(msg: string): void; error(msg: string): void };

type CurationState = {
  lastRunMs: number;
  totalPromoted: number;
};

type UserFactFile = {
  agentId: string;
  workspaceDir: string;
  filename: string;
  filePath: string;
  description: string | null;
  contentPreview: string;
};

type PromotionEntry = {
  filename: string;
  content: string;
};

// ── Frontmatter parsing ───────────────────────────────────────────────────────

function parseUserTypeFrontmatter(text: string): {
  description: string | null;
  isUserType: boolean;
} {
  if (!text.startsWith("---")) {
    return { description: null, isUserType: false };
  }
  const end = text.indexOf("\n---", 3);
  if (end === -1) {
    return { description: null, isUserType: false };
  }
  const block = text.slice(3, end);
  let description: string | null = null;
  let isUserType = false;
  for (const line of block.split("\n")) {
    const t = line.trim();
    const desc = /^description\s*:\s*(.+)$/.exec(t);
    if (desc) {
      description = desc[1].trim().replace(/^["']|["']$/g, "");
    }
    if (/^type\s*:\s*user\s*$/.test(t)) {
      isUserType = true;
    }
  }
  return { description, isUserType };
}

// ── Workspace scanning ────────────────────────────────────────────────────────

async function scanUserFactsAcrossAgents(
  cfg: OpenClawConfig,
  lookbackMs: number,
): Promise<UserFactFile[]> {
  const workspaces = resolveMemoryDreamingWorkspaces(cfg);
  const results: UserFactFile[] = [];

  for (const { workspaceDir, agentIds } of workspaces) {
    const memDir = path.join(workspaceDir, "memory");
    let entries: string[];
    try {
      entries = await fs.readdir(memDir);
    } catch {
      continue;
    }

    const mdFiles = entries.filter((f) => f.endsWith(".md") && f !== "MEMORY.md");

    for (const filename of mdFiles) {
      const filePath = path.join(memDir, filename);
      try {
        const stat = await fs.stat(filePath);
        if (stat.mtimeMs < lookbackMs) {
          continue;
        }

        const rawLines = await fs
          .readFile(filePath, "utf-8")
          .then((t) => t.split("\n").slice(0, FRONTMATTER_SCAN_LINES).join("\n"));
        const { description, isUserType } = parseUserTypeFrontmatter(rawLines);
        if (!isUserType) {
          continue;
        }

        // Read a truncated preview for the LLM
        const fullContent = await fs.readFile(filePath, "utf-8");
        const contentPreview = fullContent.slice(0, MAX_CONTENT_CHARS);

        // One entry per (agentId, file) — use first agentId for the workspace
        const agentId = agentIds[0] ?? "unknown";
        results.push({ agentId, workspaceDir, filename, filePath, description, contentPreview });
      } catch {
        // skip unreadable files
      }
    }
  }

  return results;
}

// ── LLM call ─────────────────────────────────────────────────────────────────

const CURATION_SYSTEM_PROMPT = `You are curating a global memory layer shared across all conversations and agents for one user.

You receive user-type memory facts collected from multiple agents/workspaces. Your job:
identify which facts are UNIVERSAL (clearly applicable in every interaction) and should
be promoted to the shared global memory.

Respond ONLY with a JSON object — no markdown fences, no other text:
{"promote":[{"filename":"snake_case_name.md","content":"---\\nname: ...\\ndescription: ...\\ntype: user\\n---\\n\\nContent here."}]}

If nothing qualifies, respond with: {"promote":[]}

Promotion criteria (ALL must be true):
1. The fact is about the user personally (identity, preferences, habits) — not about a project
2. The fact clearly generalises across all contexts (not workspace-specific)
3. The fact is stated explicitly, not inferred from a single data point
4. The fact is NOT already covered by an existing global memory file

Be very conservative — it's better to miss a fact than to write something incorrect.
One file per distinct topic. Use snake_case filenames ending in .md.`;

async function callCurationLLM(params: {
  facts: UserFactFile[];
  existingGlobalFiles: string[];
  cfg: OpenClawConfig;
  agentId: string;
}): Promise<PromotionEntry[]> {
  const { facts, existingGlobalFiles, cfg, agentId } = params;
  if (facts.length === 0) {
    return [];
  }

  // Group by filename to find cross-workspace candidates
  const byFilename = new Map<string, UserFactFile[]>();
  for (const f of facts) {
    const key = f.filename.toLowerCase();
    const group = byFilename.get(key) ?? [];
    group.push(f);
    byFilename.set(key, group);
  }

  // Build manifest: include facts from 2+ workspaces OR any agent if only 1 workspace exists
  const uniqueWorkspaces = new Set(facts.map((f) => f.workspaceDir)).size;
  const minWorkspaces = uniqueWorkspaces >= 2 ? 2 : 1;

  const candidates = [...byFilename.values()].filter(
    (group) => new Set(group.map((f) => f.workspaceDir)).size >= minWorkspaces,
  );

  if (candidates.length === 0) {
    return [];
  }

  const manifest = candidates
    .map((group) => {
      const sample = group[0];
      return `### [${group.map((f) => f.agentId).join(", ")}] ${sample.filename}\n${sample.contentPreview}`;
    })
    .join("\n\n---\n\n");

  const existingSection =
    existingGlobalFiles.length > 0
      ? `\n\nExisting global memory files (do not duplicate):\n${existingGlobalFiles.map((f) => `- ${f}`).join("\n")}`
      : "";

  const userContent = `User-type facts from multiple agents:\n\n${manifest}${existingSection}`;

  const prepared = await prepareSimpleCompletionModelForAgent({
    cfg,
    agentId,
    modelRef: resolveSidecarModelRef(cfg),
    allowMissingApiKeyModes: ["aws-sdk"],
  });
  if ("error" in prepared) {
    return [];
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);

  try {
    const response = await completeWithPreparedSimpleCompletionModel({
      model: prepared.model,
      auth: prepared.auth,
      context: {
        systemPrompt: CURATION_SYSTEM_PROMPT,
        messages: [{ role: "user", content: userContent, timestamp: Date.now() }],
      },
      options: { maxTokens: 1024, signal: controller.signal },
    });

    const text = extractAssistantText(response)?.trim() ?? "";
    const jsonMatch = /\{[\s\S]*\}/.exec(text);
    if (!jsonMatch) {
      return [];
    }

    const parsed: unknown = JSON.parse(jsonMatch[0]);
    if (!parsed || typeof parsed !== "object") {
      return [];
    }
    const promote = (parsed as { promote?: unknown[] }).promote;
    if (!Array.isArray(promote)) {
      return [];
    }

    return promote
      .filter(
        (e): e is PromotionEntry =>
          typeof e === "object" &&
          e !== null &&
          typeof (e as PromotionEntry).filename === "string" &&
          typeof (e as PromotionEntry).content === "string",
      )
      .slice(0, 10); // safety cap
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

// ── Apply promotions ──────────────────────────────────────────────────────────

async function applyPromotions(
  entries: PromotionEntry[],
  globalMemoryDir: string,
): Promise<number> {
  if (entries.length === 0) {
    return 0;
  }
  const memDir = path.join(globalMemoryDir, "memory");
  await fs.mkdir(memDir, { mode: 0o700, recursive: true });

  let written = 0;
  for (const entry of entries) {
    const safeName =
      path
        .basename(entry.filename)
        .replace(/[^a-zA-Z0-9_-]/g, "_")
        .replace(/\.md$/, "") + ".md";
    try {
      await fs.writeFile(path.join(memDir, safeName), entry.content, {
        encoding: "utf-8",
        mode: 0o600,
      });
      written++;
    } catch {
      // skip write failures
    }
  }
  return written;
}

// ── Curation log ──────────────────────────────────────────────────────────────

async function appendCurationLog(globalMemoryDir: string, summary: string): Promise<void> {
  const logDir = path.join(globalMemoryDir, ".dreams");
  await fs.mkdir(logDir, { mode: 0o700, recursive: true });
  const logPath = path.join(globalMemoryDir, LOG_RELATIVE_PATH);
  const timestamp = new Date().toISOString();
  const entry = `\n## ${timestamp}\n\n${summary}\n`;
  await fs.appendFile(logPath, entry, "utf-8");
}

// ── Health check ──────────────────────────────────────────────────────────────

async function checkGlobalMemoryHealth(globalMemoryDir: string, logger: Logger): Promise<void> {
  const memoryMdPath = path.join(globalMemoryDir, "MEMORY.md");
  try {
    const content = await fs.readFile(memoryMdPath, "utf-8");
    const entryCount = content
      .split("\n")
      .filter((l) => l.trim().startsWith("-") || /^\d+\./.test(l.trim())).length;
    if (entryCount > HEALTH_WARNING_THRESHOLD) {
      logger.warn(
        `memory-core: global MEMORY.md has ${entryCount} entries (threshold: ${HEALTH_WARNING_THRESHOLD}). ` +
          `Consider consolidating entries to keep prompt injection lean. ` +
          `Archive stale facts to global-memory/.archive/.`,
      );
    }
  } catch {
    // MEMORY.md doesn't exist yet — normal for new installations
  }
}

// ── State management ──────────────────────────────────────────────────────────

async function loadCurationState(globalMemoryDir: string): Promise<CurationState> {
  const statePath = path.join(globalMemoryDir, STATE_RELATIVE_PATH);
  try {
    const raw = await fs.readFile(statePath, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      const s = parsed as Partial<CurationState>;
      return {
        lastRunMs: typeof s.lastRunMs === "number" ? s.lastRunMs : 0,
        totalPromoted: typeof s.totalPromoted === "number" ? s.totalPromoted : 0,
      };
    }
  } catch {
    // no state yet
  }
  return { lastRunMs: 0, totalPromoted: 0 };
}

async function saveCurationState(globalMemoryDir: string, state: CurationState): Promise<void> {
  const stateDir = path.join(globalMemoryDir, ".dreams");
  await fs.mkdir(stateDir, { mode: 0o700, recursive: true });
  const statePath = path.join(globalMemoryDir, STATE_RELATIVE_PATH);
  await fs.writeFile(statePath, JSON.stringify(state, null, 2), {
    encoding: "utf-8",
    mode: 0o600,
  });
}

// ── Existing global files list ────────────────────────────────────────────────

async function listExistingGlobalFiles(globalMemoryDir: string): Promise<string[]> {
  const memDir = path.join(globalMemoryDir, "memory");
  try {
    const entries = await fs.readdir(memDir);
    return entries.filter((f) => f.endsWith(".md") && f !== "MEMORY.md");
  } catch {
    return [];
  }
}

// ── Main entry point ──────────────────────────────────────────────────────────

export type GlobalCurationResult = {
  skipped: boolean;
  skipReason?: string;
  promoted: number;
  candidates: number;
};

/**
 * Run the Global Memory Curation phase.
 *
 * Typically called at the end of runDreamingSweepPhases, after Light + REM
 * sleep have processed per-workspace memory. This phase operates on the
 * global layer only and is safe to call even if per-workspace phases failed.
 */
export async function runGlobalCurationPhase(params: {
  cfg?: OpenClawConfig;
  logger: Logger;
  nowMs?: number;
}): Promise<GlobalCurationResult> {
  const { cfg, logger } = params;
  const nowMs = params.nowMs ?? Date.now();

  if (!cfg) {
    return { skipped: true, skipReason: "no config", promoted: 0, candidates: 0 };
  }

  const stateDir = resolveStateDir();
  const globalMemoryDir = resolveGlobalMemoryDir(stateDir);

  // Rate-limit: skip if run too recently
  const state = await loadCurationState(globalMemoryDir);
  const hoursSinceLastRun = (nowMs - state.lastRunMs) / (1000 * 60 * 60);
  if (hoursSinceLastRun < MIN_HOURS_BETWEEN_RUNS) {
    logger.info(
      `memory-core: global curation skipped (last run ${hoursSinceLastRun.toFixed(1)}h ago, minimum ${MIN_HOURS_BETWEEN_RUNS}h).`,
    );
    return {
      skipped: true,
      skipReason: `last run ${hoursSinceLastRun.toFixed(1)}h ago`,
      promoted: 0,
      candidates: 0,
    };
  }

  logger.info("memory-core: global curation phase starting.");

  // Scan user-type facts across all agent workspaces
  const lookbackMs = nowMs - LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
  const facts = await scanUserFactsAcrossAgents(cfg, lookbackMs);

  if (facts.length === 0) {
    logger.info("memory-core: global curation — no user-type facts found in the lookback window.");
    await saveCurationState(globalMemoryDir, { ...state, lastRunMs: nowMs });
    return { skipped: false, promoted: 0, candidates: 0 };
  }

  // Check for existing global files (to avoid duplication)
  const existingGlobal = await listExistingGlobalFiles(globalMemoryDir);

  // LLM: identify which facts should be promoted
  const agentId = resolveDefaultAgentId(cfg);
  const toPromote = await callCurationLLM({
    facts,
    existingGlobalFiles: existingGlobal,
    cfg,
    agentId,
  });

  // Write the promoted facts
  const promoted = await applyPromotions(toPromote, globalMemoryDir);

  // Log the run
  const logLines = [
    `Scanned ${facts.length} user-type fact(s) from ${new Set(facts.map((f) => f.workspaceDir)).size} workspace(s).`,
    `Candidates sent to LLM: ${facts.length}. Promoted: ${promoted}.`,
  ];
  if (toPromote.length > 0) {
    logLines.push(`Files written: ${toPromote.map((e) => e.filename).join(", ")}`);
  }
  await appendCurationLog(globalMemoryDir, logLines.join("\n"));

  // Health check
  await checkGlobalMemoryHealth(globalMemoryDir, logger);

  // Persist state
  await saveCurationState(globalMemoryDir, {
    lastRunMs: nowMs,
    totalPromoted: state.totalPromoted + promoted,
  });

  logger.info(
    `memory-core: global curation done — scanned ${facts.length} fact(s), promoted ${promoted}.`,
  );

  return { skipped: false, promoted, candidates: facts.length };
}
