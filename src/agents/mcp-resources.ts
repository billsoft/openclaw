import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { logDebug, logWarn } from "../logger.js";
import type {
  McpResource,
  McpResourceCatalog,
  McpResourceContent,
  McpResourceTemplate,
} from "./pi-bundle-mcp-types.js";

const RESOURCE_CACHE_TTL_MS = 60_000; // 1 minute cache

type CacheEntry<T> = {
  value: T;
  expiresAt: number;
};

const resourceCache = new Map<string, CacheEntry<unknown>>();

function getCached<T>(key: string): T | undefined {
  const entry = resourceCache.get(key);
  if (!entry) {
    return undefined;
  }
  if (Date.now() > entry.expiresAt) {
    resourceCache.delete(key);
    return undefined;
  }
  return entry.value as T;
}

function setCache<T>(key: string, value: T, ttlMs: number = RESOURCE_CACHE_TTL_MS): void {
  resourceCache.set(key, {
    value,
    expiresAt: Date.now() + ttlMs,
  });
}

export function invalidateResourceCache(serverName?: string): void {
  if (serverName) {
    resourceCache.delete(`resources:${serverName}`);
    resourceCache.delete(`templates:${serverName}`);
  } else {
    resourceCache.clear();
  }
}

export function validateResourceUri(uri: string): boolean {
  if (!uri || typeof uri !== "string") {
    return false;
  }
  try {
    const parsed = new URL(uri);
    return ["file:", "http:", "https:", "data:"].includes(parsed.protocol);
  } catch {
    return false;
  }
}

async function listAllResourcesWithCursor(client: Client): Promise<McpResource[]> {
  const resources: McpResource[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listResources(cursor ? { cursor } : undefined);
    resources.push(...page.resources);
    cursor = page.nextCursor;
  } while (cursor);
  return resources;
}

export async function listAllResources(
  sessions: Map<string, { client: Client; serverName: string }>,
  targetServerName?: string,
): Promise<McpResource[]> {
  // Try cache first
  const cacheKey = targetServerName ?? "__all__";
  const cached = getCached<McpResource[]>(`resources:${cacheKey}`);
  if (cached !== undefined) {
    return cached;
  }

  if (targetServerName) {
    const session = sessions.get(targetServerName);
    if (!session) {
      throw new Error(`bundle-mcp: server "${targetServerName}" is not connected`);
    }
    const resources = await listAllResourcesWithCursor(session.client);
    setCache(`resources:${cacheKey}`, resources);
    return resources;
  }

  const allResources: McpResource[] = [];
  for (const [, session] of sessions) {
    try {
      const resources = await listAllResourcesWithCursor(session.client);
      for (const r of resources) {
        allResources.push(r);
      }
    } catch (error) {
      logWarn(
        `bundle-mcp resources: failed to list from "${session.serverName}": ${String(error)}`,
      );
    }
  }
  setCache(`resources:${cacheKey}`, allResources);
  return allResources;
}

export async function readResourceFromSessions(
  sessions: Map<string, { client: Client; serverName: string }>,
  uri: string,
): Promise<McpResourceContent[]> {
  if (!validateResourceUri(uri)) {
    throw new Error(`bundle-mcp resources: invalid URI: ${uri}`);
  }

  for (const [, session] of sessions) {
    try {
      const result = await session.client.readResource({ uri });
      if (result.contents && result.contents.length > 0) {
        return result.contents as McpResourceContent[];
      }
    } catch {
      continue;
    }
  }

  throw new Error(`bundle-mcp resources: no server could read resource: ${uri}`);
}

export async function listAllResourceTemplates(
  sessions: Map<string, { client: Client; serverName: string }>,
): Promise<McpResourceTemplate[]> {
  // Try cache first
  const cached = getCached<McpResourceTemplate[]>(`templates:__all__`);
  if (cached !== undefined) {
    return cached;
  }

  const templates: McpResourceTemplate[] = [];
  for (const [, session] of sessions) {
    try {
      const result = await session.client.listResourceTemplates();
      if (result.resourceTemplates) {
        for (const t of result.resourceTemplates) {
          templates.push(t as unknown as McpResourceTemplate);
        }
      }
    } catch (error) {
      logWarn(
        `bundle-mcp resources: failed to list templates from "${session.serverName}": ${String(error)}`,
      );
    }
  }
  setCache(`templates:__all__`, templates);
  return templates;
}

export async function subscribeToResourceOnSessions(
  sessions: Map<string, { client: Client; serverName: string }>,
  uri: string,
): Promise<void> {
  if (!validateResourceUri(uri)) {
    throw new Error(`bundle-mcp resources: invalid URI: ${uri}`);
  }

  const promises = Array.from(sessions.values()).map(async (session) => {
    try {
      await session.client.subscribeResource({ uri });
      logDebug(`bundle-mcp resources: subscribed to ${uri} on ${session.serverName}`);
    } catch (error) {
      logWarn(
        `bundle-mcp resources: subscribe failed on "${session.serverName}" for ${uri}: ${String(error)}`,
      );
    }
  });
  await Promise.allSettled(promises);
}

export async function unsubscribeFromResourceOnSessions(
  sessions: Map<string, { client: Client; serverName: string }>,
  uri: string,
): Promise<void> {
  if (!validateResourceUri(uri)) {
    throw new Error(`bundle-mcp resources: invalid URI: ${uri}`);
  }

  const promises = Array.from(sessions.values()).map(async (session) => {
    try {
      await session.client.unsubscribeResource({ uri });
    } catch (error) {
      logWarn(
        `bundle-mcp resources: unsubscribe failed on "${session.serverName}" for ${uri}: ${String(error)}`,
      );
    }
  });
  await Promise.allSettled(promises);
}

export async function buildResourceCatalog(
  sessions: Map<string, { client: Client; serverName: string }>,
): Promise<McpResourceCatalog> {
  const resources = await listAllResources(sessions);
  const templates = await listAllResourceTemplates(sessions);

  return {
    version: 1,
    generatedAt: Date.now(),
    resources,
    templates,
  };
}
