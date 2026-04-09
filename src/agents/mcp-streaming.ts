import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type {
  McpProgressNotification,
  StreamableContentChunk,
  StreamingToolCallOptions,
  StreamingToolCallResult,
} from "./pi-bundle-mcp-types.js";

type SessionMcpRuntimeLike = {
  callTool: (serverName: string, toolName: string, input: unknown) => Promise<CallToolResult>;
};

const DEFAULT_STREAMING_TIMEOUT_MS = 120_000;

function applyTimeout<T>(promise: Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }

    const timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`Streaming tool call timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const controller = new AbortController();

    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };

    signal?.addEventListener("abort", onAbort, { once: true });

    promise.then(
      (value) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

export async function* callToolStreaming(
  runtime: SessionMcpRuntimeLike,
  options: StreamingToolCallOptions,
): AsyncGenerator<StreamableContentChunk, StreamingToolCallResult> {
  const startTime = Date.now();
  const progressHistory: McpProgressNotification[] = [];

  const emitProgress = (progress: McpProgressNotification) => {
    progressHistory.push(progress);
    options.onProgress?.(progress);
  };

  const emitChunk = (chunk: StreamableContentChunk) => {
    options.onContent?.(chunk);
  };

  emitProgress({ progress: 0, total: 100, message: "Starting tool call..." });

  let result: CallToolResult;
  try {
    result = await applyTimeout(
      runtime.callTool(options.serverName, options.toolName, options.input),
      options.timeoutMs ?? DEFAULT_STREAMING_TIMEOUT_MS,
      options.signal,
    );
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      emitProgress({ progress: -1, message: "Aborted" });
      const abortedResult: StreamingToolCallResult = {
        content: [{ type: "text", text: "Tool call was aborted" }],
        isError: true,
        progressHistory,
        durationMs: Date.now() - startTime,
      };
      yield { type: "text", text: "[ABORTED]" };
      return abortedResult;
    }

    emitProgress({ progress: -1, message: `Error: ${String(error)}` });
    const errorResult: StreamingToolCallResult = {
      content: [{ type: "text", text: `Error: ${String(error)}` }],
      isError: true,
      progressHistory,
      durationMs: Date.now() - startTime,
    };
    yield { type: "text", text: `[ERROR] ${String(error)}` };
    return errorResult;
  }

  emitProgress({ progress: 80, message: "Received response, processing chunks..." });

  const content = Array.isArray(result.content) ? result.content : [];

  for (const part of content) {
    if (typeof part === "string") {
      const chunk: StreamableContentChunk = { type: "text", text: part };
      emitChunk(chunk);
      yield chunk;
    } else if (typeof part === "object" && part !== null) {
      const p = part as Record<string, unknown>;

      if (p.type === "text" && typeof p.text === "string") {
        const chunk: StreamableContentChunk = { type: "text", text: p.text };
        emitChunk(chunk);
        yield chunk;
      } else if (p.type === "image") {
        const chunk: StreamableContentChunk = {
          type: "image",
          data: Buffer.from(p.data as string, "base64"),
          mimeType: p.mimeType as string | undefined,
        };
        emitChunk(chunk);
        yield chunk;
      } else if (p.type === "resource") {
        const chunk: StreamableContentChunk = {
          type: "resource",
          uri: p.uri as string,
          mimeType: p.mimeType as string | undefined,
        };
        emitChunk(chunk);
        yield chunk;
      } else {
        const fallbackText = typeof p.text === "string" ? p.text : JSON.stringify(p);
        const chunk: StreamableContentChunk = { type: "text", text: fallbackText };
        emitChunk(chunk);
        yield chunk;
      }
    }
  }

  emitProgress({ progress: 100, total: 100, message: "Complete" });

  const finalResult: StreamingToolCallResult = {
    content: content.map((c) =>
      typeof c === "string"
        ? { type: "text" as const, text: c }
        : (c as { type: string; text?: string; data?: string; mimeType?: string }),
    ),
    isError: result.isError === true,
    progressHistory,
    durationMs: Date.now() - startTime,
  };

  return finalResult;
}
