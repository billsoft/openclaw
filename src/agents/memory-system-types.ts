export interface MemorySystemMessage {
  type: string;
  uuid?: string;
  message?: {
    role?: string;
    content: string | MemorySystemContentBlock[];
  };
  isMeta?: boolean;
  timestamp?: number;
  attachment?: {
    type: string;
  };
}

export interface MemorySystemContentBlock {
  type: string;
  text?: string;
  source?: {
    type: string;
    media_type?: string;
  };
  content?: MemorySystemContentBlock[] | Record<string, unknown>[];
  name?: string;
  input?: unknown;
  id?: string;
}

export function isContentBlockArray(content: unknown): content is MemorySystemContentBlock[] {
  return Array.isArray(content);
}
