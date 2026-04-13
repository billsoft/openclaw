import { createSubsystemLogger } from "../infra/logger.js";
import type { MemorySearchResult } from "../memory-host-sdk/host/types.js";
import type { MemorySystemMessage } from "./memory-system-types.js";

const log = createSubsystemLogger("session-memory");

export interface SessionMemoryExtractorConfig {
  initializationThreshold?: number;
  updateThreshold?: number;
  toolCallThreshold?: number;
  extractIntervalMs?: number;
  maxExtractRetries?: number;
}

export interface ExtractionMetrics {
  totalExtractions: number;
  successfulExtractions: number;
  failedExtractions: number;
  totalMemoriesExtracted: number;
  averageExtractionTimeMs: number;
  lastExtractionAt: number | null;
}

const DEFAULT_CONFIG = {
  initializationThreshold: 10000,
  updateThreshold: 5000,
  toolCallThreshold: 10,
  extractIntervalMs: 30000,
  maxExtractRetries: 3,
};

export class SessionMemoryExtractor {
  private config: Required<SessionMemoryExtractorConfig>;
  private metrics: ExtractionMetrics;
  private lastExtractedMessageUuid: string | undefined;
  private isExtracting: boolean = false;
  private extractionQueue: Array<{sessionId: string; messages: MemorySystemMessage[]}> = [];

  constructor(config?: SessionMemoryExtractorConfig) {
    this.config = {...DEFAULT_CONFIG, ...config};
    this.metrics = this.createEmptyMetrics();
  }

  public shouldExtractMemory(messages: MemorySystemMessage[]): boolean {
    const currentTokenCount = this.estimateTokenCount(messages);

    if (!this.lastExtractedMessageUuid) {
      if (currentTokenCount < this.config.initializationThreshold) {
        return false;
      }
      const lastMessage = messages[messages.length - 1];
      if (lastMessage?.uuid) {
        this.lastExtractedMessageUuid = lastMessage.uuid;
      }
      return true;
    }

    const tokenGrowth = currentTokenCount - this.getLastExtractionBaseTokens();
    const hasMetTokenThreshold = tokenGrowth >= this.config.updateThreshold;

    const toolCallsSinceLastUpdate = this.countToolCallsSince(messages, this.lastExtractedMessageUuid);
    const hasMetToolCallThreshold = toolCallsSinceLastUpdate >= this.config.toolCallThreshold;

    if (this.isExtracting) {
      return false;
    }

    if (hasMetTokenThreshold || hasMetToolCallThreshold) {
      const lastMessage = messages[messages.length - 1];
      if (lastMessage?.uuid) {
        this.lastExtractedMessageUuid = lastMessage.uuid;
      }
      log.debug(
        `memory extraction triggered: tokenGrowth=${tokenGrowth}, ` +
        `toolCalls=${toolCallsSinceLastUpdate}, ` +
        `reason=${hasMetTokenThreshold ? 'token' : 'toolCall'}`,
      );
      return true;
    }

    return false;
  }

  public async extractInBackground(sessionId: string, messages: MemorySystemMessage[]): Promise<void> {
    if (this.isExtracting) {
      log.debug("extraction already in progress, queuing request");
      this.extractionQueue.push({sessionId, messages});
      return;
    }

    this.isExtracting = true;
    const startTime = Date.now();

    try {
      const extractedMemories = await this.performExtraction(sessionId, messages);

      if (extractedMemories.length > 0) {
        await this.writeToMemorySystem(extractedMemories);
        this.metrics.totalMemoriesExtracted += extractedMemories.length;
        this.metrics.successfulExtractions += 1;
        log.info(`extracted ${extractedMemories.length} memories from session ${sessionId}`);
      } else {
        this.metrics.successfulExtractions += 1;
      }

      this.metrics.lastExtractionAt = Date.now();
      const elapsedMs = Date.now() - startTime;
      this.metrics.averageExtractionTimeMs =
        this.metrics.totalExtractions === 1
          ? elapsedMs
          : (this.metrics.averageExtractionTimeMs * (this.metrics.totalExtractions - 1) + elapsedMs) /
            this.metrics.totalExtractions;
    } catch (error) {
      this.metrics.failedExtractions += 1;
      log.error(`session memory extraction failed: ${String(error)}`);
    } finally {
      this.isExtracting = false;
      this.metrics.totalExtractions += 1;

      if (this.extractionQueue.length > 0) {
        const next = this.extractionQueue.shift()!;
        setTimeout(() => this.extractInBackground(next.sessionId, next.messages), 100);
      }
    }
  }

  private async performExtraction(_sessionId: string, _messages: MemorySystemMessage[]): Promise<MemorySearchResult[]> {
    return [];
  }

  private async writeToMemorySystem(_memories: MemorySearchResult[]): Promise<void> {
    log.debug(`would write ${_memories.length} memories to system`);
  }

  public getMetrics(): Readonly<ExtractionMetrics> {
    return {...this.metrics};
  }

  public reset(): void {
    this.metrics = this.createEmptyMetrics();
    this.lastExtractedMessageUuid = undefined;
    this.isExtracting = false;
    this.extractionQueue = [];
  }

  private createEmptyMetrics(): ExtractionMetrics {
    return {
      totalExtractions: 0,
      successfulExtractions: 0,
      failedExtractions: 0,
      totalMemoriesExtracted: 0,
      averageExtractionTimeMs: 0,
      lastExtractionAt: null,
    };
  }

  private estimateTokenCount(messages: MemorySystemMessage[]): number {
    let count = 0;
    for (const msg of messages) {
      if (typeof msg.message?.content === "string") {
        count += Math.ceil(msg.message.content.length / 4);
      } else if (Array.isArray(msg.message?.content)) {
        for (const block of msg.message.content) {
          if (block.type === "text" && typeof block.text === "string") {
            count += Math.ceil(block.text.length / 4);
          }
        }
      }
    }
    return count;
  }

  private countToolCallsSince(messages: MemorySystemMessage[], sinceUuid?: string): number {
    let count = 0;
    let foundStart = sinceUuid === null || sinceUuid === undefined;

    for (const msg of messages) {
      if (!foundStart) {
        if (msg.uuid === sinceUuid) {
          foundStart = true;
        }
        continue;
      }

      if (msg.type === "assistant" && Array.isArray(msg.message?.content)) {
        for (const block of msg.message.content) {
          if (block.type === "tool_use") {
            count++;
          }
        }
      }
    }

    return count;
  }

  private getLastExtractionBaseTokens(): number {
    return this.config.initializationThreshold;
  }
}

let extractorInstance: SessionMemoryExtractor | null = null;

export function getSessionMemoryExtractor(config?: SessionMemoryExtractorConfig): SessionMemoryExtractor {
  if (!extractorInstance) {
    extractorInstance = new SessionMemoryExtractor(config);
  }
  return extractorInstance;
}

export function resetSessionMemoryExtractorForTest(): void {
  if (extractorInstance) {
    extractorInstance.reset();
  }
  extractorInstance = null;
}
