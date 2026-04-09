import fs from "node:fs/promises";
import path from "node:path";
import { logInfo, logWarn, logDebug } from "../logger.js";
import {
  buildSessionMemoryUpdatePrompt,
  isSessionMemoryEmpty,
  loadSessionMemoryTemplate,
  truncateSessionMemoryForCompact,
} from "./session-memory-prompts.js";

export type SessionMemoryConfig = {
  minimumMessageTokensToInit: number;
  minimumTokensBetweenUpdate: number;
  toolCallsBetweenUpdates: number;
};

export const DEFAULT_SESSION_MEMORY_CONFIG: SessionMemoryConfig = {
  minimumMessageTokensToInit: 10_000,
  minimumTokensBetweenUpdate: 5_000,
  toolCallsBetweenUpdates: 3,
};

const EXTRACTION_WAIT_TIMEOUT_MS = 15_000;
const EXTRACTION_STALE_THRESHOLD_MS = 60_000;

type PerSessionState = {
  initialized: boolean;
  lastSummarizedMessageId: string | undefined;
  tokensAtLastExtraction: number;
  extractionStartedAt: number | undefined;
  config: SessionMemoryConfig;
};

const sessionStates = new Map<string, PerSessionState>();

function getOrCreateSessionState(sessionId: string): PerSessionState {
  let state = sessionStates.get(sessionId);
  if (!state) {
    state = {
      initialized: false,
      lastSummarizedMessageId: undefined,
      tokensAtLastExtraction: 0,
      extractionStartedAt: undefined,
      config: { ...DEFAULT_SESSION_MEMORY_CONFIG },
    };
    sessionStates.set(sessionId, state);
  }
  return state;
}

export function resolveSessionMemoryDir(baseDir: string, sessionId: string): string {
  // Each session gets its own notes directory so compaction summaries don't
  // bleed across unrelated conversations. This matches claude-code's per-session
  // isolation model where session memory is intra-session rolling context.
  return path.join(baseDir, "session-memory", sessionId);
}

export function resolveSessionMemoryPath(baseDir: string, sessionId: string): string {
  return path.join(resolveSessionMemoryDir(baseDir, sessionId), "notes.md");
}

export async function ensureSessionMemoryFile(
  baseDir: string,
  sessionId: string,
): Promise<{ memoryPath: string; currentMemory: string }> {
  const memoryDir = resolveSessionMemoryDir(baseDir, sessionId);
  const memoryPath = resolveSessionMemoryPath(baseDir, sessionId);

  await fs.mkdir(memoryDir, { mode: 0o700, recursive: true });

  try {
    await fs.writeFile(memoryPath, "", {
      encoding: "utf-8",
      mode: 0o600,
      flag: "wx",
    });
    const template = await loadSessionMemoryTemplate();
    await fs.writeFile(memoryPath, template, {
      encoding: "utf-8",
      mode: 0o600,
    });
  } catch (e: unknown) {
    const code = (e as NodeJS.ErrnoException)?.code;
    if (code !== "EEXIST") {
      throw e;
    }
  }

  const currentMemory = await fs.readFile(memoryPath, {
    encoding: "utf-8",
  });

  return { memoryPath, currentMemory };
}

export async function getSessionMemoryContent(
  baseDir: string,
  sessionId: string,
): Promise<string | null> {
  const memoryPath = resolveSessionMemoryPath(baseDir, sessionId);
  try {
    return await fs.readFile(memoryPath, { encoding: "utf-8" });
  } catch {
    return null;
  }
}

export function setSessionMemoryConfig(
  sessionId: string,
  config: Partial<SessionMemoryConfig>,
): void {
  const state = getOrCreateSessionState(sessionId);
  state.config = { ...state.config, ...config };
}

export function getSessionMemoryConfig(sessionId: string): SessionMemoryConfig {
  return { ...getOrCreateSessionState(sessionId).config };
}

export function getLastSummarizedMessageId(sessionId: string): string | undefined {
  return getOrCreateSessionState(sessionId).lastSummarizedMessageId;
}

export function setLastSummarizedMessageId(sessionId: string, messageId: string | undefined): void {
  getOrCreateSessionState(sessionId).lastSummarizedMessageId = messageId;
}

function markExtractionStarted(sessionId: string): void {
  getOrCreateSessionState(sessionId).extractionStartedAt = Date.now();
}

export function markExtractionCompleted(sessionId: string): void {
  getOrCreateSessionState(sessionId).extractionStartedAt = undefined;
}

function recordExtractionTokenCount(sessionId: string, tokenCount: number): void {
  getOrCreateSessionState(sessionId).tokensAtLastExtraction = tokenCount;
}

function hasMetInitializationThreshold(sessionId: string, currentTokenCount: number): boolean {
  const state = getOrCreateSessionState(sessionId);
  if (!state.initialized) {
    if (currentTokenCount >= state.config.minimumMessageTokensToInit) {
      state.initialized = true;
    }
    return state.initialized;
  }
  return true;
}

function hasMetUpdateThreshold(sessionId: string, currentTokenCount: number): boolean {
  const state = getOrCreateSessionState(sessionId);
  const tokensSinceLast = currentTokenCount - state.tokensAtLastExtraction;
  return tokensSinceLast >= state.config.minimumTokensBetweenUpdate;
}

export function countToolCallsSinceLastUpdate(
  messages: Array<{ role?: string; type?: string; content?: unknown }>,
  sessionId: string,
): number {
  const state = getOrCreateSessionState(sessionId);
  const sinceUuid = state.lastSummarizedMessageId;
  let foundStart = sinceUuid === null || sinceUuid === undefined;
  let toolCallCount = 0;

  for (const msg of messages) {
    if (!foundStart) {
      if (
        typeof msg === "object" &&
        msg !== null &&
        "uuid" in msg &&
        (msg as Record<string, unknown>).uuid === sinceUuid
      ) {
        foundStart = true;
      }
      continue;
    }
    const role = (msg as Record<string, unknown>).role ?? (msg as Record<string, unknown>).type;
    if (role === "assistant") {
      const content = (msg as Record<string, unknown>).content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (
            typeof block === "object" &&
            block !== null &&
            "type" in block &&
            (block as Record<string, unknown>).type === "tool_use"
          ) {
            toolCallCount++;
          }
        }
      }
    }
  }

  return toolCallCount;
}

export function shouldExtractSessionMemory(
  sessionId: string,
  messages: Array<{ role?: string; type?: string; content?: unknown; uuid?: string }>,
  currentTokenCount: number,
  hasToolCallsInLastTurn: boolean,
): boolean {
  if (!hasMetInitializationThreshold(sessionId, currentTokenCount)) {
    return false;
  }

  const hasMetToken = hasMetUpdateThreshold(sessionId, currentTokenCount);
  const toolCallsSince = countToolCallsSinceLastUpdate(messages, sessionId);
  const hasMetTools =
    toolCallsSince >= getOrCreateSessionState(sessionId).config.toolCallsBetweenUpdates;

  if ((hasMetToken && hasMetTools) || (hasMetToken && !hasToolCallsInLastTurn)) {
    const lastMsg = messages[messages.length - 1];
    if (lastMsg && "uuid" in lastMsg && (lastMsg as Record<string, unknown>).uuid) {
      setLastSummarizedMessageId(sessionId, (lastMsg as Record<string, unknown>).uuid as string);
    }
    return true;
  }

  return false;
}

export async function waitForSessionMemoryExtraction(sessionId: string): Promise<void> {
  const startTime = Date.now();
  const state = getOrCreateSessionState(sessionId);

  while (state.extractionStartedAt) {
    const extractionAge = Date.now() - state.extractionStartedAt;
    if (extractionAge > EXTRACTION_STALE_THRESHOLD_MS) {
      return;
    }
    if (Date.now() - startTime > EXTRACTION_WAIT_TIMEOUT_MS) {
      return;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

export function resetSessionMemoryState(sessionId: string): void {
  sessionStates.delete(sessionId);
}

export async function trySessionMemoryCompaction(
  baseDir: string,
  sessionId: string,
  messages: Array<{ uuid?: string }>,
): Promise<{
  boundaryMarker: unknown;
  summaryMessages: Array<unknown>;
  messagesToKeep: Array<unknown>;
  attachments: Array<never>;
  hookResults: Array<never>;
  preCompactTokenCount?: number;
  postCompactTokenCount?: number;
  truePostCompactTokenCount?: number;
  wasSmCompact: true;
} | null> {
  const sessionMemory = await getSessionMemoryContent(baseDir, sessionId);
  if (!sessionMemory) {
    return null;
  }

  if (await isSessionMemoryEmpty(sessionMemory)) {
    return null;
  }

  const lastSummaryId = getLastSummarizedMessageId(sessionId);
  let lastSummaryIndex: number;

  if (lastSummaryId) {
    lastSummaryIndex = messages.findIndex((m) => m.uuid === lastSummaryId);
    if (lastSummaryIndex === -1) {
      return null;
    }
  } else {
    lastSummaryIndex = messages.length - 1;
  }

  const startIndex = Math.max(0, lastSummaryIndex + 1);
  const messagesToKeep = messages.slice(startIndex);

  const { truncatedContent, wasTruncated } = truncateSessionMemoryForCompact(sessionMemory);

  let summaryContent = `This session is being continued from a previous conversation that ran out of context. The session memory below covers the earlier portion of the conversation.\n\n${truncatedContent}`;

  if (wasTruncated) {
    const memoryPath = resolveSessionMemoryPath(baseDir, sessionId);
    summaryContent += `\n\nSome session memory sections were truncated for length. The full session memory can be viewed at: ${memoryPath}`;
  }

  summaryContent +=
    "\n\nRecent messages are preserved verbatim. Continue the conversation from where it left off without asking the user any further questions. Resume directly — do not acknowledge the summary, do not recap what was happening.";

  const boundaryMarker = {
    type: "system" as const,
    role: "system" as const,
    content: `[session-memory-compact at ${new Date().toISOString()}]`,
    compactMetadata: {
      trigger: "auto" as const,
      preCompactTokenCount: messages.length,
    },
  };

  const summaryMessages = [
    {
      role: "user" as const,
      content: summaryContent,
      isCompactSummary: true,
      isVisibleInTranscriptOnly: true,
    },
  ];

  const postCompactTokenCount = summaryContent.length / 4 + messagesToKeep.length * 50;

  return {
    boundaryMarker,
    summaryMessages,
    messagesToKeep,
    attachments: [],
    hookResults: [],
    wasSmCompact: true,
    postCompactTokenCount,
    truePostCompactTokenCount: postCompactTokenCount,
  };
}

export type SessionMemorySpawnFnResult = {
  messages: Array<Record<string, unknown>>;
  totalUsage: { input_tokens: number; output_tokens: number };
};

export type SessionMemorySpawnFn = (params: {
  task: string;
  label: string;
}) => Promise<SessionMemorySpawnFnResult>;

export type SessionMemoryExtractParams = {
  baseDir: string;
  sessionId: string;
  messages: Array<Record<string, unknown>>;
  currentTokenCount: number;
  hasToolCallsInLastTurn: boolean;
  spawnFn?: SessionMemorySpawnFn;
};

export async function extractSessionMemoryIfNeeded(
  params: SessionMemoryExtractParams,
): Promise<boolean> {
  const { baseDir, sessionId, messages, currentTokenCount, hasToolCallsInLastTurn, spawnFn } =
    params;

  if (!shouldExtractSessionMemory(sessionId, messages, currentTokenCount, hasToolCallsInLastTurn)) {
    return false;
  }

  if (!spawnFn) {
    logDebug(`session-memory: spawnFn not provided for ${sessionId}, skipping extraction`);
    return false;
  }

  markExtractionStarted(sessionId);

  try {
    const { memoryPath, currentMemory } = await ensureSessionMemoryFile(baseDir, sessionId);

    const userPrompt = await buildSessionMemoryUpdatePrompt(currentMemory, memoryPath);

    const result = await spawnFn({
      task: userPrompt,
      label: "session_memory",
    });

    recordExtractionTokenCount(sessionId, currentTokenCount);

    logInfo(
      `session-memory: extracted for session=${sessionId} ` +
        `input=${result.totalUsage.input_tokens} output=${result.totalUsage.output_tokens}`,
    );

    setLastSummarizedMessageId(
      sessionId,
      (messages[messages.length - 1]?.uuid as string) ?? undefined,
    );

    return true;
  } catch (error) {
    logWarn(`session-memory: extraction failed for ${sessionId}: ${String(error)}`);
    return false;
  } finally {
    markExtractionCompleted(sessionId);
  }
}
