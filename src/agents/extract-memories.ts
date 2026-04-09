import fs from "node:fs/promises";
import path from "node:path";
import { logInfo, logWarn, logDebug } from "../logger.js";

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

const EXTRACTION_PROMPT = `You are now acting as the memory extraction subagent. Analyze the most recent messages above and use them to update your persistent memory systems.

Available tools: Read, Grep, Glob, read-only Bash (ls/find/cat/stat/wc/head/tail and similar), and Edit/Write for paths inside the memory directory only. Bash rm is not permitted. All other tools will be denied.

You have a limited turn budget. Edit requires a prior Read of the same file, so the efficient strategy is: turn 1 — issue all Read calls in parallel for every file you might update; turn 2 — issue all Write/Edit calls in parallel.

You MUST only use content from the last messages to update your persistent memories. Do not waste any turns investigating or verifying that content further — no grepping source files, no reading code to confirm a pattern exists, no git commands.

If the user explicitly asks you to remember something, save it immediately as whichever type fits best. If they ask you to forget something, find and remove the relevant entry.

## How to save memories

Write each memory to its own file (e.g., \`user_role.md\`, \`feedback_testing.md\`) using this frontmatter format:

---
title: "Short Title"
tags: [user-preference, workflow, error-fix]
created: "auto"
---

- Organize memory semantically by topic, not chronologically
- Update or remove memories that turn out to be wrong or outdated
- Do not write duplicate memories. First check if there is an existing memory you can update before writing a new one.
- Keep each file under ~200 lines
- Focus on actionable facts: preferences, errors+fixes, patterns, decisions
- Do NOT store transient info like "currently working on X" — that belongs in session memory`;

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

  let manifest = "";
  if (config.memoryDir) {
    const existingFiles = await scanExistingMemoryFiles(config.memoryDir);
    manifest = formatMemoryManifest(existingFiles);
  }

  const userPrompt = EXTRACTION_PROMPT + (manifest ? `\n\n${manifest}` : "");

  try {
    const result = await spawnFn({
      task: userPrompt,
      label: "extract_memories",
    });

    state.lastExtractionTurnIndex = currentTurnIndex;
    state.extractionsCount++;

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
