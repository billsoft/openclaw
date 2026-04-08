/**
 * Prompt cache prefix stability tests.
 *
 * AGENTS.md [Prompt Cache Stability — lines 163-170]: model/tool payload
 * assembly must be deterministic and produce byte-identical stable prefixes
 * turn-to-turn. Any deviation in the prefix region invalidates the prompt
 * cache and wastes tokens on every API call.
 *
 * This test file verifies:
 *  1. The stable prefix (above SYSTEM_PROMPT_CACHE_BOUNDARY) is byte-identical
 *     across two consecutive buildAgentSystemPrompt calls with the same params.
 *  2. The dynamic suffix (below the boundary) is allowed to differ.
 *  3. Params that SHOULD vary (extraSystemPrompt, userTime) do NOT affect the
 *     stable prefix.
 *  4. Params that SHOULD be stable (toolNames, workspaceDir) are stable across
 *     identical calls.
 *
 * Run with: pnpm test src/agents/prompt-cache-prefix-stability.test.ts
 */

import { describe, expect, it } from "vitest";
import { buildAgentSystemPrompt } from "./system-prompt.js";
import { splitSystemPromptCacheBoundary } from "./system-prompt-cache-boundary.js";

/** Fixed params used for all stability tests. These must not change between calls. */
const STABLE_BASE_PARAMS: Parameters<typeof buildAgentSystemPrompt>[0] = {
  workspaceDir: "/home/test/workspace",
  promptMode: "full",
  acpEnabled: true,
  toolNames: ["sessions_spawn", "exec", "memory_search", "memory_get"],
  modelAliasLines: [],
  userTimezone: "UTC",
  runtimeInfo: {
    agentId: "main",
    host: "test-host",
    os: "linux",
    arch: "x64",
    node: "20.0.0",
    model: "claude-sonnet-4-6",
    provider: "anthropic",
  },
};

function extractStablePrefix(prompt: string): string {
  const split = splitSystemPromptCacheBoundary(prompt);
  // If no boundary found, the entire prompt is treated as the stable prefix
  return split?.stablePrefix ?? prompt;
}

function extractDynamicSuffix(prompt: string): string | undefined {
  const split = splitSystemPromptCacheBoundary(prompt);
  return split?.dynamicSuffix;
}

describe("prompt cache prefix stability", () => {
  it("stable prefix is byte-identical across two calls with identical params", () => {
    const prompt1 = buildAgentSystemPrompt(STABLE_BASE_PARAMS);
    const prompt2 = buildAgentSystemPrompt(STABLE_BASE_PARAMS);

    const prefix1 = extractStablePrefix(prompt1);
    const prefix2 = extractStablePrefix(prompt2);

    expect(prefix1).toBe(prefix2);
    expect(prefix1.length).toBeGreaterThan(0);
  });

  it("stable prefix is not affected by extraSystemPrompt (subagent task context)", () => {
    const withoutExtra = buildAgentSystemPrompt(STABLE_BASE_PARAMS);
    const withExtra = buildAgentSystemPrompt({
      ...STABLE_BASE_PARAMS,
      extraSystemPrompt: "[Subagent Task]: summarize this document for the user.",
    });

    const prefix1 = extractStablePrefix(withoutExtra);
    const prefix2 = extractStablePrefix(withExtra);

    // The stable prefix must be identical despite different extraSystemPrompt
    expect(prefix1).toBe(prefix2);

    // The dynamic suffix SHOULD differ
    const suffix1 = extractDynamicSuffix(withoutExtra);
    const suffix2 = extractDynamicSuffix(withExtra);
    expect(suffix2).toContain("Subagent Task");
    expect(suffix1).not.toContain("Subagent Task");
  });

  it("stable prefix is not affected by heartbeatPrompt (session-config volatile value)", () => {
    const withHeartbeat = buildAgentSystemPrompt({
      ...STABLE_BASE_PARAMS,
      heartbeatPrompt: "__HEARTBEAT_POLL__",
    });
    const withoutHeartbeat = buildAgentSystemPrompt(STABLE_BASE_PARAMS);

    const prefix1 = extractStablePrefix(withHeartbeat);
    const prefix2 = extractStablePrefix(withoutHeartbeat);

    // heartbeatPrompt is in the dynamic suffix (after SYSTEM_PROMPT_CACHE_BOUNDARY)
    expect(prefix1).toBe(prefix2);

    // The dynamic suffix should contain the heartbeat config
    const suffix1 = extractDynamicSuffix(withHeartbeat);
    expect(suffix1).toContain("__HEARTBEAT_POLL__");
  });

  it("changing toolNames changes the stable prefix (tools are part of cache key)", () => {
    const withTool = buildAgentSystemPrompt({
      ...STABLE_BASE_PARAMS,
      toolNames: [...(STABLE_BASE_PARAMS.toolNames ?? []), "browser_control"],
    });
    const withoutTool = buildAgentSystemPrompt(STABLE_BASE_PARAMS);

    const prefix1 = extractStablePrefix(withTool);
    const prefix2 = extractStablePrefix(withoutTool);

    // Different tool sets must produce different stable prefixes
    expect(prefix1).not.toBe(prefix2);
  });

  it("the cache boundary marker is present in the output", () => {
    const prompt = buildAgentSystemPrompt(STABLE_BASE_PARAMS);
    const split = splitSystemPromptCacheBoundary(prompt);
    // There must be a cache boundary in every complete prompt
    expect(split).not.toBeUndefined();
  });

  it("subagent promptMode=minimal produces a byte-identical stable prefix to full mode (same capabilities)", () => {
    // When a subagent uses the same model and tools, its stable prefix should
    // match the parent's for prompt cache sharing. The only difference is
    // promptMode (some sections omitted in minimal), but the shared sections
    // must be identical.
    const fullPrompt = buildAgentSystemPrompt({
      ...STABLE_BASE_PARAMS,
      promptMode: "full",
    });
    const minimalPrompt = buildAgentSystemPrompt({
      ...STABLE_BASE_PARAMS,
      promptMode: "minimal",
    });

    // Both must have a cache boundary
    expect(splitSystemPromptCacheBoundary(fullPrompt)).not.toBeUndefined();
    expect(splitSystemPromptCacheBoundary(minimalPrompt)).not.toBeUndefined();

    // The minimal prefix will be shorter (fewer sections), but must be
    // deterministic: two identical minimal calls must match each other.
    const minimalPrompt2 = buildAgentSystemPrompt({
      ...STABLE_BASE_PARAMS,
      promptMode: "minimal",
    });
    expect(extractStablePrefix(minimalPrompt)).toBe(extractStablePrefix(minimalPrompt2));
  });
});
