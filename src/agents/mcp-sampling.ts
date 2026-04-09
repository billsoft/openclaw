import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { CreateMessageResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { logWarn } from "../logger.js";
import type {
  McpSamplingCapability,
  SamplingCreateMessageParams,
  SamplingMessage,
} from "./pi-bundle-mcp-types.js";

const SAMPLING_METHOD = "sampling/createMessage" as const;

export function hasSamplingCapability(client: Client): boolean {
  // Check server capabilities without making an API call.
  // The MCP SDK exposes getServerCapabilities() for this.
  try {
    const caps = client.getServerCapabilities?.();
    return caps?.sampling !== undefined;
  } catch {
    return false;
  }
}

export function detectSamplingCapabilities(
  sessions: Map<string, { client: Client; serverName: string }>,
): McpSamplingCapability {
  const serverNames: string[] = [];
  for (const [, session] of sessions) {
    try {
      if (hasSamplingCapability(session.client)) {
        serverNames.push(session.serverName);
      }
    } catch {
      continue;
    }
  }
  return {
    supported: serverNames.length > 0,
    serverNames,
  };
}

export async function createSamplingMessage(
  client: Client,
  serverName: string,
  params: SamplingCreateMessageParams,
): Promise<SamplingMessage> {
  try {
    const response = await client.request(
      {
        method: SAMPLING_METHOD,
        params: {
          messages: params.messages as Parameters<
            typeof CreateMessageResultSchema.parse
          >[0] extends { messages: infer M }
            ? M
            : never,
          maxTokens: params.maxTokens ?? 4096,
          modelPreferences: params.modelPreferences,
          temperature: params.temperature,
          stopSequences: params.stopSequences,
          systemPrompt: params.systemPrompt,
        },
      },
      CreateMessageResultSchema,
    );

    const raw = response as Record<string, unknown>;
    const content = normalizeContent(raw.content);
    return {
      role: (raw.role as "assistant") || "assistant",
      content,
      model: raw.model as string | undefined,
      stopReason: raw.stopReason as string | undefined | null,
    };
  } catch (error) {
    logWarn(`bundle-mcp sampling: createMessage failed on "${serverName}": ${String(error)}`);
    throw error;
  }
}

function normalizeContent(raw: unknown): SamplingMessage["content"] {
  if (!raw) {
    return [{ type: "text", text: "" }];
  }
  if (!Array.isArray(raw)) {
    return [{ type: "text", text: JSON.stringify(raw) }];
  }
  return raw.map((part) => {
    if (typeof part === "string") {
      return { type: "text" as const, text: part };
    }
    if (typeof part === "object" && part !== null) {
      const p = part as Record<string, unknown>;
      if (p.type === "image") {
        return {
          type: "image" as const,
          data: p.data as string,
          mimeType: (p.mimeType as string) || "image/png",
        };
      }
      return {
        type: "text" as const,
        text: (p.text as string) || JSON.stringify(p),
      };
    }
    return { type: "text" as const, text: String(part) };
  });
}
