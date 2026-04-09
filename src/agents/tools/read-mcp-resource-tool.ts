import { Type } from "@sinclair/typebox";
import type { McpResourceContent } from "../pi-bundle-mcp-types.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult } from "./common.js";

const READ_MCP_RESOURCE_TOOL_NAME = "readMcpResource";

const ReadMcpResourceToolSchema = Type.Object({
  server: Type.String({ description: "The MCP server name" }),
  uri: Type.String({ description: "The resource URI to read" }),
});

type ReadMcpResourceInput = {
  server: string;
  uri: string;
};

function buildToolDescription(): string {
  return [
    "Read a specific resource from a configured MCP server.",
    "",
    "Parameters:",
    "- server: The name of the MCP server that has the resource",
    "- uri: The URI of the resource to read",
    "",
    "Usage example:",
    "- readMcpResource({ server: 'myserver', uri: 'file:///path/to/resource' })",
  ].join("\n");
}

export function createReadMcpResourceTool(
  getRuntime: () => Promise<{
    readResource: (uri: string) => Promise<McpResourceContent[]>;
  }>,
): AnyAgentTool {
  return {
    label: "Read MCP Resource",
    name: READ_MCP_RESOURCE_TOOL_NAME,
    displaySummary: "Read MCP server resource",
    description: buildToolDescription(),
    parameters: ReadMcpResourceToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as ReadMcpResourceInput;

      if (!params.server) {
        return jsonResult({ error: "server parameter is required" });
      }

      if (!params.uri) {
        return jsonResult({ error: "uri parameter is required" });
      }

      try {
        const runtime = await getRuntime();
        const contents = await runtime.readResource(params.uri);

        if (!contents || contents.length === 0) {
          return jsonResult({
            error: `No content returned for resource: ${params.uri}`,
          });
        }

        return jsonResult({
          contents: contents.map((c) => ({
            uri: c.uri,
            mimeType: c.mimeType,
            text: c.text,
            blob: c.blob,
          })),
          count: contents.length,
        });
      } catch (error) {
        return jsonResult({
          error: `Failed to read MCP resource: ${String(error)}`,
        });
      }
    },
  };
}
