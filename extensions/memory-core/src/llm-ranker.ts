/**
 * LLM-based memory relevance ranker.
 *
 * Ported from claude-code/memdir/findRelevantMemories.ts +
 * claude-code/memdir/memoryScan.ts.
 *
 * After vector search returns candidates, this module makes a single
 * lightweight LLM call (via openclaw's simple-completion-runtime — the
 * equivalent of claude-code's sideQuery) to re-rank and filter results
 * by semantic relevance to the query. The LLM sees only filenames and
 * frontmatter descriptions (< 256 tokens), not file content, so the call
 * is fast and cheap.
 *
 * Key design decisions ported from claude-code:
 *  1. `alreadySurfaced` filtering: already done in tools.ts; ranker only
 *     sees fresh candidates.
 *  2. `recentTools` exclusion: memories that are pure API/usage docs for
 *     tools currently being used are excluded from the selection prompt.
 *     Active usage IS exactly when gotchas/warnings matter, so those are
 *     kept.
 *  3. Parse failure → return [] (graceful degradation, not crash).
 *  4. AbortSignal propagated: caller can cancel if session ends.
 *  5. At most MAX_RANKED_RESULTS paths returned (default 5, matching
 *     claude-code's budget).
 *
 * Integration: called from createMemorySearchTool after vector search
 * when the ranked-recall feature flag is enabled in config.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import {
  completeWithPreparedSimpleCompletionModel,
  extractAssistantText,
  prepareSimpleCompletionModelForAgent,
  resolveSidecarModelRef,
} from "openclaw/plugin-sdk/simple-completion-runtime";

/** Maximum memories the ranker will select per query. */
export const MAX_RANKED_RESULTS = 5;

/** Maximum memory files scanned for frontmatter (prevents O(N) on huge dirs). */
const MAX_SCAN_FILES = 200;

/** Lines read per file for frontmatter extraction. */
const FRONTMATTER_SCAN_LINES = 30;

/** Timeout for the ranker LLM call. Best-effort; failures return []. */
const RANKER_TIMEOUT_MS = 8_000;

export type RankedMemory = {
  /** Absolute path to the memory file. */
  path: string;
  /** File modification time in milliseconds. */
  mtimeMs: number;
  /** Frontmatter description, if any. */
  description: string | null;
};

/** Valid memory type labels from the 4-type taxonomy. */
type MemoryType = "user" | "feedback" | "project" | "reference";

function parseMemoryType(raw: string | undefined): MemoryType | undefined {
  if (raw === "user" || raw === "feedback" || raw === "project" || raw === "reference") {
    return raw;
  }
  return undefined;
}

type MemoryHeader = {
  filename: string; // relative path within memoryDir
  filePath: string; // absolute path
  mtimeMs: number;
  description: string | null;
  type: MemoryType | undefined;
};

// ── Frontmatter scanning ─────────────────────────────────────────────────────

function parseFrontmatter(content: string): {
  description: string | null;
  type: MemoryType | undefined;
} {
  if (!content.startsWith("---")) {
    return { description: null, type: undefined };
  }
  const end = content.indexOf("\n---", 3);
  if (end === -1) {
    return { description: null, type: undefined };
  }
  const block = content.slice(3, end);
  let description: string | null = null;
  let type: MemoryType | undefined;
  for (const line of block.split("\n")) {
    const trimmed = line.trim();
    const descMatch = /^description\s*:\s*(.+)$/.exec(trimmed);
    if (descMatch) {
      description = descMatch[1].trim().replace(/^["']|["']$/g, "");
    }
    const typeMatch = /^type\s*:\s*(.+)$/.exec(trimmed);
    if (typeMatch) {
      type = parseMemoryType(typeMatch[1].trim().replace(/^["']|["']$/g, ""));
    }
  }
  return { description, type };
}

async function readFrontmatterHeader(
  filePath: string,
  signal: AbortSignal,
): Promise<Pick<MemoryHeader, "mtimeMs" | "description" | "type"> | null> {
  try {
    const [stat, content] = await Promise.all([
      fs.stat(filePath),
      fs
        .readFile(filePath, { encoding: "utf8", signal })
        .then((text) => text.split("\n").slice(0, FRONTMATTER_SCAN_LINES).join("\n")),
    ]);
    const { description, type } = parseFrontmatter(content);
    return { mtimeMs: stat.mtimeMs, description, type };
  } catch {
    return null;
  }
}

/**
 * Scan memory directory for .md files (excluding MEMORY.md), read their
 * frontmatter descriptions, sort by recency, cap at MAX_SCAN_FILES.
 */
async function scanMemoryHeaders(memoryDir: string, signal: AbortSignal): Promise<MemoryHeader[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(memoryDir, { recursive: true, encoding: "utf8" });
  } catch {
    return [];
  }

  const mdFiles = entries
    .filter((f) => f.endsWith(".md") && path.basename(f) !== "MEMORY.md")
    .slice(0, MAX_SCAN_FILES * 2); // over-fetch, trim after sort

  const results = await Promise.allSettled(
    mdFiles.map(async (relPath): Promise<MemoryHeader> => {
      const filePath = path.join(memoryDir, relPath);
      const header = await readFrontmatterHeader(filePath, signal);
      return {
        filename: relPath,
        filePath,
        mtimeMs: header?.mtimeMs ?? 0,
        description: header?.description ?? null,
        type: header?.type,
      };
    }),
  );

  return results
    .filter((r): r is PromiseFulfilledResult<MemoryHeader> => r.status === "fulfilled")
    .map((r) => r.value)
    .toSorted((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, MAX_SCAN_FILES);
}

// ── Manifest formatting ───────────────────────────────────────────────────────

function formatManifest(memories: MemoryHeader[]): string {
  return memories
    .map((m) => {
      const tag = m.type ? `[${m.type}] ` : "";
      const ts = new Date(m.mtimeMs).toISOString();
      return m.description
        ? `- ${tag}${m.filename} (${ts}): ${m.description}`
        : `- ${tag}${m.filename} (${ts})`;
    })
    .join("\n");
}

// ── System prompt (ported from claude-code SELECT_MEMORIES_SYSTEM_PROMPT) ────

const SELECT_MEMORIES_SYSTEM_PROMPT = `You are selecting memories that will be useful to OpenClaw as it processes a user's query. You will be given the user's query and a list of available memory files with their filenames and descriptions.

Return a list of filenames for the memories that will clearly be useful to OpenClaw as it processes the user's query (up to ${MAX_RANKED_RESULTS}). Only include memories that you are certain will be helpful based on their name and description.
- If you are unsure if a memory will be useful in processing the user's query, then do not include it in your list. Be selective and discerning.
- If there are no memories in the list that would clearly be useful, feel free to return an empty list.
- If a list of recently-used tools is provided, do not select memories that are usage reference or API documentation for those tools (OpenClaw is already exercising them). DO still select memories containing warnings, gotchas, or known issues about those tools — active use is exactly when those matter.

Respond ONLY with a JSON object: {"selected_memories": ["filename1", "filename2", ...]}`;

// ── LLM selection call ────────────────────────────────────────────────────────

async function selectRelevantMemoriesViaLLM(params: {
  query: string;
  memories: MemoryHeader[];
  recentTools: readonly string[];
  cfg: OpenClawConfig;
  agentId: string;
  signal: AbortSignal;
}): Promise<string[]> {
  const { query, memories, recentTools, cfg, agentId, signal } = params;
  const validFilenames = new Set(memories.map((m) => m.filename));

  const manifest = formatManifest(memories);
  const toolsSection =
    recentTools.length > 0 ? `\n\nRecently used tools: ${recentTools.join(", ")}` : "";

  const userContent = `Query: ${query}\n\nAvailable memories:\n${manifest}${toolsSection}`;

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
  const timer = setTimeout(() => controller.abort(), RANKER_TIMEOUT_MS);
  // Merge with caller's signal
  if (signal.aborted) {
    controller.abort();
  }
  const abortListener = () => controller.abort();
  signal.addEventListener("abort", abortListener, { once: true });

  try {
    const response = await completeWithPreparedSimpleCompletionModel({
      model: prepared.model,
      auth: prepared.auth,
      context: {
        systemPrompt: SELECT_MEMORIES_SYSTEM_PROMPT,
        messages: [{ role: "user", content: userContent, timestamp: Date.now() }],
      },
      options: {
        maxTokens: 256,
        signal: controller.signal,
      },
    });

    const text = extractAssistantText(response)?.trim() ?? "";
    // Extract JSON: find first { ... } block
    const jsonMatch = /\{[\s\S]*\}/.exec(text);
    if (!jsonMatch) {
      return [];
    }
    const parsed: unknown = JSON.parse(jsonMatch[0]);
    if (
      !parsed ||
      typeof parsed !== "object" ||
      !Array.isArray((parsed as Record<string, unknown>)["selected_memories"])
    ) {
      return [];
    }
    return (parsed as { selected_memories: unknown[] })["selected_memories"].filter(
      (f): f is string => typeof f === "string" && validFilenames.has(f),
    );
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abortListener);
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Given a list of candidate memory search result paths (from vector search),
 * use a lightweight LLM call to re-rank and filter them by relevance to the
 * user's query.
 *
 * Returns the filtered/ranked subset as absolute paths (ordered by LLM
 * preference). Falls back to empty array on any failure — callers must treat
 * this as optional enrichment, not a hard dependency.
 *
 * @param query          - The user's search query.
 * @param candidatePaths - Absolute file paths from vector search to re-rank.
 * @param memoryDir      - Root of the memory directory (for frontmatter scan).
 * @param cfg            - OpenClaw config (for model resolution).
 * @param agentId        - Agent identifier (for model/auth resolution).
 * @param signal         - AbortSignal for cancellation.
 * @param recentTools      - Tools recently used in this session (for exclusion).
 * @param alreadySurfaced  - Paths already shown in prior searches this session.
 *                           Pre-filtered before the LLM call so the 5-slot budget
 *                           is spent on fresh candidates only.
 *                           Ported from claude-code findRelevantMemories alreadySurfaced filter.
 */
export async function rankMemoriesByRelevance(params: {
  query: string;
  candidatePaths: ReadonlyArray<string>;
  memoryDir: string;
  cfg: OpenClawConfig;
  agentId: string;
  signal: AbortSignal;
  recentTools?: readonly string[];
  alreadySurfaced?: ReadonlySet<string>;
}): Promise<RankedMemory[]> {
  if (params.candidatePaths.length === 0) {
    return [];
  }

  // Only scan the subset that are candidates (no need to scan all files).
  // Pre-filter alreadySurfaced before the LLM call so the selector's 5-slot
  // budget is spent on fresh candidates only (ported from claude-code findRelevantMemories).
  const alreadySurfaced = params.alreadySurfaced ?? new Set<string>();
  const candidateSet = new Set(params.candidatePaths.filter((p) => !alreadySurfaced.has(p)));
  const headers = await scanMemoryHeaders(params.memoryDir, params.signal);
  const candidateHeaders = headers.filter((h) => candidateSet.has(h.filePath));

  if (candidateHeaders.length === 0) {
    return [];
  }

  const selectedFilenames = await selectRelevantMemoriesViaLLM({
    query: params.query,
    memories: candidateHeaders,
    recentTools: params.recentTools ?? [],
    cfg: params.cfg,
    agentId: params.agentId,
    signal: params.signal,
  });

  if (selectedFilenames.length === 0) {
    return [];
  }

  const byFilename = new Map(candidateHeaders.map((h) => [h.filename, h]));
  return selectedFilenames
    .map((filename) => byFilename.get(filename))
    .filter((h): h is MemoryHeader => h !== undefined)
    .map((h) => ({ path: h.filePath, mtimeMs: h.mtimeMs, description: h.description }));
}
