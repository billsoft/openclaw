import fs from "node:fs/promises";
import path from "node:path";
import { logInfo, logWarn, logDebug } from "../logger.js";
import { resolveGlobalMemoryDir } from "../memory-host-sdk/global-memory.js";
import { resolveStateDir } from "../config/paths.js";

export type ExtractMemoriesConfig = {
  enabled: boolean;
  minTurnsBetweenExtractions: number;
  maxTurnsPerExtraction: number;
  memoryDir: string;
};

export const DEFAULT_EXTRACT_MEMORIES_CONFIG: ExtractMemoriesConfig = {
  enabled: true,
  minTurnsBetweenExtractions: 1,
  maxTurnsPerExtraction: 5,
  memoryDir: "",
};

/**
 * System prompt for the memory extraction LLM call.
 * The model receives recent messages and outputs JSON describing what to save.
 */
const EXTRACTION_SYSTEM_PROMPT = `You are a memory extraction assistant. Analyze the recent conversation and decide what facts are worth saving to persistent memory.

Respond ONLY with a JSON object in this exact format — no markdown fences, no extra text:
{"memories":[{"filename":"descriptive_name.md","tier":"global"|"per-agent","content":"---\\nname: ...\\ndescription: ...\\ntype: user|feedback|project|reference\\n---\\n\\nContent here."}]}

If nothing is worth saving, respond with: {"memories":[]}

## Memory tiers

- **"global"** — cross-agent user facts: personal identity, preferences that apply everywhere (e.g., "user prefers TypeScript", "user is vegetarian", "timezone UTC+8"). Written to the global memory directory, shared across ALL agents.
- **"per-agent"** — everything else: feedback, project decisions, references, or user facts specific to this agent/workspace.

## Memory type guide (use in frontmatter \`type:\` field)

- **user** — facts about the person (role, goals, expertise, cross-agent preferences) → prefer "global" tier
- **feedback** — guidance on approach, what to avoid/keep doing. Include **Why:** and **How to apply:** → per-agent
- **project** — ongoing work, decisions, bugs, deadlines. Include **Why:** and **How to apply:**; convert relative dates to absolute → per-agent
- **reference** — pointers to external resources (URLs, board names, dashboards) → per-agent

## Rules

- One file per distinct topic. Use snake_case filenames ending in .md.
- Do NOT save: code patterns, git history, debugging recipes, transient "currently working on X" state.
- Do NOT duplicate: if a memory updates an existing file, set the same filename so we can overwrite it.`;

function buildExtractionUserMessage(params: {
  memoryDir: string;
  globalMemoryDir: string;
  existingFilesManifest: string;
}): string {
  const { memoryDir, globalMemoryDir, existingFilesManifest } = params;
  const globalFilesDir = path.join(globalMemoryDir, "memory");
  let msg =
    `Per-agent memory directory: ${memoryDir}\n` +
    `Global memory directory: ${globalFilesDir}\n\n` +
    `Based on the conversation above, extract any facts worth saving.`;
  if (existingFilesManifest) {
    msg += `\n\n${existingFilesManifest}\n\nAvoid duplicates — prefer reusing the same filename to overwrite an existing file.`;
  }
  return msg;
}

type PerAgentExtractionState = {
  lastExtractionTurnIndex: number;
  extractionsCount: number;
};

const agentStates = new Map<string, PerAgentExtractionState>();

function getOrCreateAgentState(agentId: string): PerAgentExtractionState {
  let state = agentStates.get(agentId);
  if (!state) {
    state = {
      lastExtractionTurnIndex: -1,
      extractionsCount: 0,
    };
    agentStates.set(agentId, state);
  }
  return state;
}

export async function ensureMemoryDir(config: ExtractMemoriesConfig): Promise<void> {
  if (!config.memoryDir) {
    return;
  }
  await fs.mkdir(config.memoryDir, { mode: 0o700, recursive: true });
}

export async function scanExistingMemoryFiles(
  memoryDir: string,
): Promise<Array<{ name: string; path: string; title?: string }>> {
  try {
    const entries = await fs.readdir(memoryDir, { withFileTypes: true });
    const files: Array<{ name: string; path: string; title?: string }> = [];

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".md") || entry.name === "MEMORY.md") {
        continue;
      }
      const filePath = path.join(memoryDir, entry.name);
      files.push({ name: entry.name, path: filePath });
    }

    return files.toSorted((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

export function formatMemoryManifest(
  files: Array<{ name: string; path: string; title?: string }>,
): string {
  if (files.length === 0) {
    return "";
  }

  const lines = files.map((f) => `- **${f.name}**${f.title ? ` — ${f.title}` : ""}`);
  return `## Existing memory files\n\n${lines.join("\n")}\n\nCheck this list before writing — update an existing file rather than creating a duplicate.`;
}

type ExtractionMemoryEntry = {
  filename: string;
  tier: string;
  content: string;
};

/**
 * Parse the LLM's JSON output and write memory files to disk.
 * Silently skips malformed entries or write failures.
 */
async function applyExtractionResult(
  text: string,
  memoryDir: string,
  globalMemoryDir: string,
): Promise<void> {
  const jsonMatch = /\{[\s\S]*\}/.exec(text);
  if (!jsonMatch) {
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch {
    return;
  }
  if (!parsed || typeof parsed !== "object") {
    return;
  }
  const memories = (parsed as { memories?: unknown[] }).memories;
  if (!Array.isArray(memories) || memories.length === 0) {
    return;
  }
  for (const entry of memories) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const m = entry as Partial<ExtractionMemoryEntry>;
    if (
      typeof m.filename !== "string" ||
      !m.filename ||
      typeof m.content !== "string" ||
      !m.content
    ) {
      continue;
    }
    // Sanitize: allow only safe filenames, always end in .md
    const safeName =
      path
        .basename(m.filename)
        .replace(/[^a-zA-Z0-9_\-]/g, "_")
        .replace(/\.md$/, "") + ".md";
    const targetDir =
      m.tier === "global" ? path.join(globalMemoryDir, "memory") : memoryDir;
    const filePath = path.join(targetDir, safeName);
    try {
      await fs.writeFile(filePath, m.content, { encoding: "utf-8", mode: 0o600 });
    } catch {
      // Skip individual failures silently; don't abort the loop.
    }
  }
}

export function shouldExtractMemories(
  agentId: string,
  currentTurnIndex: number,
  config: ExtractMemoriesConfig,
): boolean {
  if (!config.enabled) {
    return false;
  }

  const state = getOrCreateAgentState(agentId);
  const turnsSinceLast = currentTurnIndex - state.lastExtractionTurnIndex;

  return turnsSinceLast >= config.minTurnsBetweenExtractions;
}

export type SpawnFnResult = {
  messages: Array<Record<string, unknown>>;
  totalUsage: { input_tokens: number; output_tokens: number };
};

export type SpawnFn = (params: { task: string; label: string }) => Promise<SpawnFnResult>;

export type ExtractMemoriesParams = {
  agentId: string;
  currentTurnIndex: number;
  config: ExtractMemoriesConfig;
  recentMessages: Array<Record<string, unknown>>;
  spawnFn?: SpawnFn;
};

export async function extractMemoriesIfNeeded(params: ExtractMemoriesParams): Promise<boolean> {
  const { agentId, currentTurnIndex, config, spawnFn } = params;

  if (!shouldExtractMemories(agentId, currentTurnIndex, config)) {
    return false;
  }

  if (!spawnFn) {
    logDebug(`extract-memories: spawnFn not provided for ${agentId}`);
    return false;
  }

  const state = getOrCreateAgentState(agentId);

  await ensureMemoryDir(config);

  // Resolve and ensure global memory directories exist.
  const globalMemoryDir = resolveGlobalMemoryDir(resolveStateDir());
  await fs.mkdir(path.join(globalMemoryDir, "memory"), { mode: 0o700, recursive: true });

  let manifest = "";
  if (config.memoryDir) {
    const [agentFiles, globalFiles] = await Promise.all([
      scanExistingMemoryFiles(config.memoryDir),
      scanExistingMemoryFiles(path.join(globalMemoryDir, "memory")),
    ]);
    const allFiles = [
      ...agentFiles.map((f) => ({ ...f, name: `[per-agent] ${f.name}` })),
      ...globalFiles.map((f) => ({ ...f, name: `[global] ${f.name}` })),
    ];
    manifest = formatMemoryManifest(allFiles);
  }

  const userMessage = buildExtractionUserMessage({
    memoryDir: config.memoryDir,
    globalMemoryDir,
    existingFilesManifest: manifest,
  });

  // The spawnFn is a simple-completion call. We pass EXTRACTION_SYSTEM_PROMPT
  // as system and userMessage as user content; the model outputs JSON.
  // We then parse that JSON and write files ourselves (applyExtractionResult).
  try {
    const result = await spawnFn({
      task: `${EXTRACTION_SYSTEM_PROMPT}\n\n---\n\n${userMessage}`,
      label: "extract_memories",
    });

    state.lastExtractionTurnIndex = currentTurnIndex;
    state.extractionsCount++;

    // Parse the LLM's JSON output and write memory files to disk.
    const lastMsg = result.messages[result.messages.length - 1];
    const text =
      typeof lastMsg?.content === "string"
        ? lastMsg.content
        : "";
    await applyExtractionResult(text, config.memoryDir, globalMemoryDir);

    logInfo(
      `extract-memories: completed for agent=${agentId} turn=${currentTurnIndex} ` +
        `#extractions=${state.extractionsCount} ` +
        `input=${result.totalUsage.input_tokens} output=${result.totalUsage.output_tokens}`,
    );

    return true;
  } catch (error) {
    logWarn(`extract-memories: failed for agent=${agentId}: ${String(error)}`);
    return false;
  }
}

export function resetExtractMemoriesState(agentId: string): void {
  agentStates.delete(agentId);
}
