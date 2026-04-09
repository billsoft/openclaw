import { Type } from "@sinclair/typebox";
import type { McpResource } from "../pi-bundle-mcp-types.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult } from "./common.js";

const LIST_MCP_RESOURCES_TOOL_NAME = "listMcpResources";

const ListMcpResourcesToolSchema = Type.Object({
  server: Type.Optional(Type.String()),
});

type ListMcpResourcesInput = {
  server?: string;
};

function buildToolDescription(): string {
  return [
    "List available resources from configured MCP servers.",
    "",
    "Each resource object includes a 'server' field indicating which server it's from.",
    "",
    "Usage examples:",
    "- List all resources from all servers: listMcpResources({})",
    "- List resources from a specific server: listMcpResources({ server: 'myserver' })",
  ].join("\n");
}

export function createListMcpResourcesTool(
  getRuntime: () => Promise<{
    listResources: (serverName?: string) => Promise<McpResource[]>;
  }>,
): AnyAgentTool {
  return {
    label: "List MCP Resources",
    name: LIST_MCP_RESOURCES_TOOL_NAME,
    displaySummary: "List MCP server resources",
    description: buildToolDescription(),
    parameters: ListMcpResourcesToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as ListMcpResourcesInput;

      try {
        const runtime = await getRuntime();
        const resources = await runtime.listResources(params.server);

        if (resources.length === 0) {
          return jsonResult({
            resources: [],
            message:
              "No resources found. MCP servers may still provide tools even if they have no resources.",
          });
        }

        return jsonResult({
          resources: resources.map((r) => ({
            uri: r.uri,
            name: r.name ?? "",
            description: r.description ?? "",
            mimeType: r.mimeType,
            server: r.uri.split("://")[0] ?? "unknown",
          })),
          count: resources.length,
        });
      } catch (error) {
        return jsonResult({
          error: `Failed to list MCP resources: ${String(error)}`,
        });
      }
    },
  };
}
