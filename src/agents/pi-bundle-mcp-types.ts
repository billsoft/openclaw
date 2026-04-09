import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { OpenClawConfig } from "../config/config.js";
import type { AnyAgentTool } from "./tools/common.js";

export type BundleMcpToolRuntime = {
  tools: AnyAgentTool[];
  dispose: () => Promise<void>;
};

export type McpServerCatalog = {
  serverName: string;
  launchSummary: string;
  toolCount: number;
};

export type McpCatalogTool = {
  serverName: string;
  safeServerName: string;
  toolName: string;
  title?: string;
  description?: string;
  inputSchema: unknown;
  fallbackDescription: string;
};

export type McpToolCatalog = {
  version: number;
  generatedAt: number;
  servers: Record<string, McpServerCatalog>;
  tools: McpCatalogTool[];
};

// --- Sampling types (MCP spec extension) ---

export type SamplingContentPart =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export type SamplingCreateMessageParams = {
  messages: Array<{ role: string; content: string | SamplingContentPart[] }>;
  maxTokens?: number;
  modelPreferences?: { hints?: string[] };
  temperature?: number;
  stopSequences?: string[];
  systemPrompt?: string;
};

export type SamplingMessage = {
  role: "assistant";
  content: SamplingContentPart[];
  model?: string;
  stopReason?: string | null;
};

export type McpSamplingCapability = {
  supported: boolean;
  serverNames: string[];
};

// --- Resources types (MCP spec extension) ---

export type McpResource = {
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
};

export type McpResourceContent = {
  uri: string;
  mimeType?: string;
  blob?: string;
  text?: string;
};

export type McpResourceTemplate = {
  uriTemplate: string;
  name?: string;
  description?: string;
  mimeType?: string;
};

export type McpResourceCatalog = {
  version: number;
  generatedAt: number;
  resources: McpResource[];
  templates: McpResourceTemplate[];
};

// --- Streaming types (MCP spec extension) ---

export type McpProgressNotification = {
  progress: number;
  total?: number;
  message?: string;
};

export type StreamableContentChunk =
  | { type: "text"; text: string }
  | { type: "image"; data: Buffer; mimeType?: string }
  | { type: "resource"; uri: string; mimeType?: string };

export type StreamingToolCallOptions = {
  serverName: string;
  toolName: string;
  input: unknown;
  onProgress?: (progress: McpProgressNotification) => void;
  onContent?: (chunk: StreamableContentChunk) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
};

export type StreamingToolCallResult = {
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  isError: boolean;
  progressHistory: McpProgressNotification[];
  durationMs: number;
};

// --- Extended SessionMcpRuntime ---

export type SessionMcpRuntime = {
  sessionId: string;
  sessionKey?: string;
  workspaceDir: string;
  configFingerprint: string;
  createdAt: number;
  lastUsedAt: number;
  getCatalog: () => Promise<McpToolCatalog>;
  markUsed: () => void;

  // Core tools
  callTool: (serverName: string, toolName: string, input: unknown) => Promise<CallToolResult>;

  // Sampling (P0)
  createMessage: (
    serverName: string,
    params: SamplingCreateMessageParams,
  ) => Promise<SamplingMessage>;

  // Resources (P1)
  listResources: (serverName?: string) => Promise<McpResource[]>;
  readResource: (uri: string) => Promise<McpResourceContent[]>;
  listResourceTemplates: () => Promise<McpResourceTemplate[]>;
  subscribeToResource: (uri: string) => Promise<void>;
  unsubscribeFromResource: (uri: string) => Promise<void>;
  getResourceCatalog: () => Promise<McpResourceCatalog>;

  // Cleanup
  dispose: () => Promise<void>;
};

export type SessionMcpRuntimeManager = {
  getOrCreate: (params: {
    sessionId: string;
    sessionKey?: string;
    workspaceDir: string;
    cfg?: OpenClawConfig;
  }) => Promise<SessionMcpRuntime>;
  bindSessionKey: (sessionKey: string, sessionId: string) => void;
  resolveSessionId: (sessionKey: string) => string | undefined;
  disposeSession: (sessionId: string) => Promise<void>;
  disposeAll: () => Promise<void>;
  listSessionIds: () => string[];
};
