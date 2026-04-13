import type {
  MemorySystemMessage,
  MemorySystemContentBlock,
} from "./memory-system-types.js";

export interface CompactionPreprocessConfig {
  imageReplacementText?: string;
  documentReplacementText?: string;
  duplicateFileReadKeepLast?: number;
  truncateToolOutputLines?: number;
  stripAttachmentTypes?: string[];
}

export interface PreprocessStats {
  imagesStripped: number;
  documentsStripped: number;
  duplicateFileReadsRemoved: number;
  toolOutputsTruncated: number;
  attachmentsStripped: number;
  estimatedTokensSaved: number;
}

const DEFAULT_CONFIG: Required<CompactionPreprocessConfig> = {
  imageReplacementText: '[image]',
  documentReplacementText: '[document]',
  duplicateFileReadKeepLast: 1,
  truncateToolOutputLines: 100,
  stripAttachmentTypes: [],
};

export function preprocessMessagesForCompaction(
  messages: MemorySystemMessage[],
  config?: Partial<CompactionPreprocessConfig>,
): {messages: MemorySystemMessage[]; stats: PreprocessStats} {
  const cfg = {...DEFAULT_CONFIG, ...config};
  const stats: PreprocessStats = {
    imagesStripped: 0,
    documentsStripped: 0,
    duplicateFileReadsRemoved: 0,
    toolOutputsTruncated: 0,
    attachmentsStripped: 0,
    estimatedTokensSaved: 0,
  };

  const processedMessages: (MemorySystemMessage | null)[] = [];

  for (const message of messages) {
    let processed: MemorySystemMessage | null = message;

    processed = stripImagesFromMessage(processed, cfg.imageReplacementText, stats);
    processed = stripDocumentsFromMessage(processed, cfg.documentReplacementText, stats);
    processed = stripReinjectedAttachments(processed, cfg.stripAttachmentTypes, stats);

    if (processed) {
      processedMessages.push(processed);
    }
  }

  const deduped = deduplicateFileReadResults(processedMessages, cfg.duplicateFileReadKeepLast, stats);
  const truncated = truncateLongToolOutputs(deduped, cfg.truncateToolOutputLines, stats);

  return {
    messages: truncated,
    stats,
  };
}

function stripImagesFromMessage(
  message: MemorySystemMessage,
  replacementText: string,
  stats: PreprocessStats,
): MemorySystemMessage | null {
  if (message.type !== 'user' || !message.message) {
    return message;
  }

  const content = message.message.content;
  if (!Array.isArray(content)) {
    return message;
  }

  let hasMediaBlock = false;
  const newContent = content.flatMap((block): MemorySystemContentBlock[] => {
    if (block.type === 'image') {
      hasMediaBlock = true;
      return [{type: 'text', text: replacementText}];
    }

    if (block.type === 'tool_result' && Array.isArray(block.content)) {
      let toolHasMedia = false;
      const newToolContent = block.content.map((item): Record<string, unknown> => {
        if (item && typeof item === 'object' && item.type === 'image') {
          toolHasMedia = true;
          return {type: 'text', text: replacementText};
        }
        if (item && typeof item === 'object' && item.type === 'document') {
          toolHasMedia = true;
          return {type: 'text', text: replacementText};
        }
        return item;
      });

      if (toolHasMedia) {
        hasMediaBlock = true;
        return [{...block, content: newToolContent}];
      }
    }

    return [block];
  });

  if (!hasMediaBlock) {
    return message;
  }

  stats.imagesStripped += 1;
  stats.estimatedTokensSaved += 500;

  return {
    ...message,
    message: {
      ...message.message,
      content: newContent,
    },
  };
}

function stripDocumentsFromMessage(
  message: MemorySystemMessage,
  replacementText: string,
  stats: PreprocessStats,
): MemorySystemMessage | null {
  if (message.type !== 'user' || !message.message) {
    return message;
  }

  const content = message.message.content;
  if (!Array.isArray(content)) {
    return message;
  }

  let hasDocumentBlock = false;
  const newContent = content.flatMap((block): MemorySystemContentBlock[] => {
    if (block.type === 'document') {
      hasDocumentBlock = true;
      return [{type: 'text', text: replacementText}];
    }

    if (block.type === 'tool_result' && Array.isArray(block.content)) {
      let hasDoc = false;
      const newToolContent = block.content.map((item): Record<string, unknown> => {
          hasDoc = true;
          return {type: 'text', text: replacementText};
        }
        return item;
      });

      if (hasDoc) {
        hasDocumentBlock = true;
        return [{...block, content: newToolContent}];
      }
    }

    return [block];
  });

  if (!hasDocumentBlock) {
    return message;
  }

  stats.documentsStripped += 1;
  stats.estimatedTokensSaved += 1000;

  return {
    ...message,
    message: {
      ...message.message,
      content: newContent,
    },
  };
}

function stripReinjectedAttachments(
  message: MemorySystemMessage,
  _stripTypes: string[],
  stats: PreprocessStats,
): MemorySystemMessage | null {
  if (_stripTypes.length === 0 || message.type !== 'attachment') {
    return message;
  }

  if (message.attachment && _stripTypes.includes(message.attachment.type)) {
    stats.attachmentsStripped += 1;
    return null;
  }

  return message;
}

function deduplicateFileReadResults(
  messages: (MemorySystemMessage | null)[],
  keepLast: number,
  stats: PreprocessStats,
): MemorySystemMessage[] {
  if (keepLast <= 0) {
    return messages.filter((m): m is MemorySystemMessage => m !== null && m !== undefined);
  }

  const fileReadHistory = new Map<string, {count: number; indices: number[]}>();

  messages.forEach((msg, idx) => {
    if (!msg || !msg.message || !Array.isArray(msg.message.content)) {return;}

    for (const block of msg.message.content) {
      if (
        block.type === 'tool_result' &&
        typeof block === 'object' &&
        'name' in block &&
        (block.name === 'FileReadTool' || block.name === 'Read')
      ) {
        const filePath = ((block as Record<string, unknown>).input as Record<string, string>)?.file_path || ((block as Record<string, unknown>).input as Record<string, string>)?.path || 'unknown';
        const existing = fileReadHistory.get(filePath);
        if (existing) {
          existing.count++;
          existing.indices.push(idx);
        } else {
          fileReadHistory.set(filePath, {count: 1, indices: [idx]});
        }
      }
    }
  });

  const indicesToRemove = new Set<number>();

  for (const [, history] of fileReadHistory) {
    if (history.count > keepLast) {
      const removeCount = history.count - keepLast;
      const oldestIndices = history.indices.slice(0, removeCount);
      oldestIndices.forEach((idx) => indicesToRemove.add(idx));
      stats.duplicateFileReadsRemoved += removeCount;
      stats.estimatedTokensSaved += removeCount * 2000;
    }
  }

  return messages.filter((_, idx) => !indicesToRemove.has(idx)) as MemorySystemMessage[];
}

function truncateLongToolOutputs(
  messages: MemorySystemMessage[],
  maxLines: number,
  stats: PreprocessStats,
): MemorySystemMessage[] {
  return messages.map((message) => {
    if (!message.message || !Array.isArray(message.message.content)) {
      return message;
    }

    const newContent = message.message.content.map((block) => {
      if (block.type === 'tool_result' && typeof block === 'object') {
        const content = (block as Record<string, unknown>).content;
        if (typeof content === 'string') {
          const lines = content.split('\n');
          if (lines.length > maxLines) {
            stats.toolOutputsTruncated += 1;
            const removedLines = lines.length - maxLines;
            stats.estimatedTokensSaved += removedLines * 20;
            return {
              ...block,
              content:
                lines.slice(0, maxLines).join('\n') +
                `\n\n[... ${removedLines} more lines truncated for compaction ...]`,
            };
          }
        }
      }
      return block;
    });

    return {
      ...message,
      message: {
        ...message.message,
        content: newContent,
      },
    };
  });
}

export function getPreprocessSummary(stats: PreprocessStats): string {
  const parts: string[] = [];

  if (stats.imagesStripped > 0) {parts.push(`${stats.imagesStripped} images stripped`);}
  if (stats.documentsStripped > 0) {parts.push(`${stats.documentsStripped} documents stripped`);}
  if (stats.duplicateFileReadsRemoved > 0)
    {parts.push(`${stats.duplicateFileReadsRemoved} duplicate reads removed`);}
  if (stats.toolOutputsTruncated > 0) {parts.push(`${stats.toolOutputsTruncated} outputs truncated`);}
  if (stats.attachmentsStripped > 0) {parts.push(`${stats.attachmentsStripped} attachments stripped`);}

  if (parts.length === 0) {
    return 'No preprocessing applied';
  }

  return `Compaction preprocessing: ${parts.join(', ')}. Estimated savings: ~${stats.estimatedTokensSaved} tokens.`;
}
