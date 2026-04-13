export type MemoryType = 'user' | 'feedback' | 'project' | 'reference';
export type MemoryScope = 'private' | 'team';

export const MEMORY_TYPES: readonly MemoryType[] = [
  'user',
  'feedback',
  'project',
  'reference',
] as const;

export const MEMORY_TYPE_DESCRIPTIONS: Record<
  MemoryType,
  {
    label: string;
    description: string;
    whenToSave: string;
    howToUse: string;
    examples: string[];
  }
> = {
  user: {
    label: 'User Profile',
    description: '用户角色、目标、职责和知识背景信息',
    whenToSave: '当了解到用户的角色、偏好、职责或知识时',
    howToUse: '当工作需要根据用户画像或视角进行调整时',
    examples: [
      'user is a data scientist focusing on observability/logging',
      'deep Go expertise (10 years), new to React and this frontend',
    ],
  },
  feedback: {
    label: 'Feedback & Guidance',
    description: '用户给出的工作方式指导（避免什么、保持什么）',
    whenToSave: '当用户纠正你的方法 或 确认某个非显而易见的方法有效时',
    howToUse: '让这些记忆指导你的行为，避免用户重复给出相同指导',
    examples: [
      'integration tests must hit real database, not mocks',
      'user prefers terse responses without trailing summaries',
    ],
  },
  project: {
    label: 'Project Context',
    description: '项目中的工作进行情况、目标、bug 或事件（无法从代码/git推导的信息）',
    whenToSave: '当了解到谁在做什么、为什么做、何时完成时',
    howToUse: '更全面地理解用户请求的细节和背景，做出更好的建议',
    examples: [
      'merge freeze begins 2026-03-05 for mobile release cut',
      'auth middleware rewrite driven by legal/compliance requirements',
    ],
  },
  reference: {
    label: 'External References',
    description: '外部系统中可找到信息的指针',
    whenToSave: '当了解到外部系统的资源及其用途时',
    howToUse: '当用户引用外部系统或可能在外部系统中的信息时',
    examples: [
      'pipeline bugs tracked in Linear project "INGEST"',
      'grafana.internal/d/api-latency is the oncall latency dashboard',
    ],
  },
};

export interface TypedMemoryEntry {
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  snippet: string;
  source: 'memory' | 'sessions';
  citation?: string;
  type?: MemoryType;
  scope?: MemoryScope;
  bodyStructure?: {
    rule: string;
    reason?: string;
    application?: string;
  };
  metadata?: {
    extractedAt: number;
    sourceSession?: string;
    confidence?: number;
    lastVerifiedAt?: number;
    verificationStatus?: 'valid' | 'stale' | 'expired';
  };
}

export function parseMemoryType(raw: unknown): MemoryType | undefined {
  if (typeof raw !== 'string') {return undefined;}
  return MEMORY_TYPES.find((t) => t === raw);
}

export function isValidMemoryType(value: string): value is MemoryType {
  return MEMORY_TYPES.includes(value as MemoryType);
}

export function validateMemoryType(type: MemoryType): {valid: boolean; error?: string} {
  if (!MEMORY_TYPES.includes(type)) {
    return {
      valid: false,
      error: `Invalid memory type: ${type}. Must be one of: ${MEMORY_TYPES.join(', ')}`,
    };
  }
  return {valid: true};
}

export function inferMemoryTypeFromContent(
  content: string,
  context?: {
    isCorrection?: boolean;
    isConfirmation?: boolean;
    mentionsUser?: boolean;
    mentionsProject?: boolean;
    mentionsExternalSystem?: boolean;
  },
): MemoryType | undefined {
  const lowerContent = content.toLowerCase();

  if (context?.isCorrection || context?.isConfirmation) {
    return 'feedback';
  }

  if (
    context?.mentionsExternalSystem ||
    /(linear|jira|confluence|grafana|slack|notion|docs?\.)\test/i.test(lowerContent)
  ) {
    return 'reference';
  }

  if (
    context?.mentionsProject ||
    /(release|sprint|deadline|merge|freeze|milestone)\test/i.test(lowerContent)
  ) {
    return 'project';
  }

  if (
    context?.mentionsUser ||
    /(user is|i'm a|my role|experience with|years of)\test/i.test(lowerContent)
  ) {
    return 'user';
  }

  return undefined;
}

export function formatMemoryManifestWithType(memories: TypedMemoryEntry[], maxItems?: number): string {
  const limited = maxItems ? memories.slice(0, maxItems) : memories;

  if (limited.length === 0) {
    return '';
  }

  const lines: string[] = ['## Relevant Memories', ''];

  for (const mem of limited) {
    const typeTag = mem.type ? `[${mem.type}] ` : '';
    const timestamp = mem.metadata?.extractedAt
      ? new Date(mem.metadata.extractedAt).toISOString().split('T')[0]
      : '';

    lines.push(`### ${typeTag}${mem.path} (${timestamp})`);
    lines.push(`- ${mem.snippet}`);

    if (mem.bodyStructure?.reason) {
      lines.push(`  **Why:** ${mem.bodyStructure.reason}`);
    }
    if (mem.bodyStructure?.application) {
      lines.push(`  **How to apply:** ${mem.bodyStructure.application}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

export function getTypeStats(memories: TypedMemoryEntry[]): Map<MemoryType, number> {
  const stats = new Map<MemoryType, number>();

  for (const type of MEMORY_TYPES) {
    stats.set(type, 0);
  }

  for (const mem of memories) {
    if (mem.type && stats.has(mem.type)) {
      stats.set(mem.type, stats.get(mem.type)! + 1);
    }
  }

  return stats;
}
