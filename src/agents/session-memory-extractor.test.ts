import { describe, it, expect, beforeEach } from 'vitest';
import {
  SessionMemoryExtractor,
  resetSessionMemoryExtractorForTest,
} from './session-memory-extractor.js';
import type { MemorySystemMessage } from './memory-system-types.js';

describe('SessionMemoryExtractor', () => {
  let extractor: SessionMemoryExtractor;

  beforeEach(() => {
    resetSessionMemoryExtractorForTest();
    extractor = new SessionMemoryExtractor({
      initializationThreshold: 5000,
      updateThreshold: 2000,
      toolCallThreshold: 5,
    });
  });

  describe('shouldExtractMemory', () => {
    it('当低于初始化阈值时应返回 false', () => {
      const messages = createMockMessages(100);
      expect(extractor.shouldExtractMemory(messages)).toBe(false);
    });

    it('当达到初始化阈值时应返回 true', () => {
      const messages = createMockMessages(1500);
      expect(extractor.shouldExtractMemory(messages)).toBe(true);
    });

    it('首次提取后，低于更新阈值应返回 false', () => {
      const messages1 = createMockMessages(1500);
      extractor.shouldExtractMemory(messages1);

      const messages2 = createMockMessages(1600);
      expect(extractor.shouldExtractMemory(messages2)).toBe(false);
    });

    it('应遵守工具调用阈值', () => {
      const messages = createMockMessagesWithToolCalls(1500, 3);
      expect(extractor.shouldExtractMemory(messages)).toBe(false);
    });
  });

  describe('getMetrics', () => {
    it('应返回初始零指标', () => {
      const metrics = extractor.getMetrics();
      expect(metrics.totalExtractions).toBe(0);
      expect(metrics.successfulExtractions).toBe(0);
    });
  });
});

function createMockMessages(tokenCount: number): MemorySystemMessage[] {
  return Array.from({length: 10}, (_, i) => ({
    type: i % 2 === 0 ? 'user' : 'assistant',
    uuid: `msg-${i}`,
    message: {
      content: 'x'.repeat(Math.floor(tokenCount / 10)),
    },
  }));
}

function createMockMessagesWithToolCalls(tokenCount: number, toolCallCount: number): Message[] {
  const baseMessages = createMockMessages(tokenCount);
  baseMessages.push({
    type: 'assistant',
    uuid: 'msg-tool',
    message: {
      content: Array.from({length: toolCallCount}, () => ({
        type: 'tool_use' as const,
        id: `toolu-${Math.random().toString(36).substring(2, 11)}`,
        name: 'Bash',
        input: {command: 'echo test'},
      })),
    },
  });
  return baseMessages;
}
