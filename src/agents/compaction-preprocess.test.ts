import { describe, it, expect } from 'vitest';
import {
  preprocessMessagesForCompaction,
  getPreprocessSummary,
  type CompactionPreprocessConfig,
  type PreprocessStats,
} from './compaction-preprocess.js';

describe('compaction-preprocess', () => {
  const defaultConfig: CompactionPreprocessConfig = {};

  describe('stripImagesFromMessage', () => {
    it('应从用户消息中剥离图片块', () => {
      const messages = [
        {
          type: 'user',
          message: {
            content: [
              {type: 'text', text: 'Look at this image:'},
              {type: 'image', source: {type: 'base64'}},
              {type: 'text', text: 'What do you think?'},
            ],
          },
        },
      ];

      const result = preprocessMessagesForCompaction(messages, defaultConfig);

      const userMsg = result.messages.find((m) => m.type === 'user');
      const content = userMsg!.message!.content as any[];

      expect(content[0].type).toBe('text');
      expect(content[1].type).toBe('text');
      expect(content[1].text).toBe('[image]');
      expect(result.stats.imagesStripped).toBe(1);
    });

    it('不应修改非用户消息', () => {
      const messages = [
        {
          type: 'assistant',
          message: {
            content: [
              {type: 'text', text: 'Here is an image:'},
              {type: 'image', source: {type: 'base64'}},
            ],
          },
        },
      ];

      const result = preprocessMessagesForCompaction(messages, defaultConfig);
      const content = result.messages[0].message!.content as any[];
      expect(content[1].type).toBe('image');
      expect(result.stats.imagesStripped).toBe(0);
    });

    it('应处理 tool_result 中嵌套的图片', () => {
      const messages = [
        {
          type: 'user',
          message: {
            content: [
              {type: 'tool_result', name: 'Read', content: [
                {type: 'text', text: 'File content'},
                {type: 'image', source: {type: 'base64'}},
              ]},
            ],
          },
        },
      ];

      const result = preprocessMessagesForCompaction(messages, defaultConfig);
      const toolResult = result.messages[0].message!.content as any[0];
      expect(toolResult.content[1].type).toBe('text');
      expect(toolResult.content[1].text).toBe('[image]');
    });

    it('对无图片的消息应不做修改', () => {
      const messages = [
        {
          type: 'user',
          message: {content: 'Plain text message'},
        },
      ];

      const result = preprocessMessagesForCompaction(messages, defaultConfig);
      expect(result.messages[0]).toEqual(messages[0]);
      expect(result.stats.imagesStripped).toBe(0);
    });
  });

  describe('stripDocumentsFromMessage', () => {
    it('应剥离文档块', () => {
      const messages = [
        {
          type: 'user',
          message: {
            content: [
              {type: 'text', text: 'See this PDF:'},
              {type: 'document', source: {type: 'base64', media_type: 'application/pdf'}},
            ],
          },
        },
      ];

      const result = preprocessMessagesForCompaction(messages, defaultConfig);
      const content = result.messages[0].message!.content as any[];
      expect(content[1].type).toBe('text');
      expect(content[1].text).toBe('[document]');
      expect(result.stats.documentsStripped).toBe(1);
    });
  });

  describe('deduplicateFileReadResults', () => {
    it('应移除较旧的重复文件读取结果', () => {
      const messages = [
        {
          type: 'assistant',
          message: {
            content: [
              {type: 'tool_result', name: 'FileReadTool', input: {file_path: '/test.ts'}, content: 'first read'},
            ],
          },
        },
        {
          type: 'user',
          message: {content: 'continue'},
        },
        {
          type: 'assistant',
          message: {
            content: [
              {type: 'tool_result', name: 'FileReadTool', input: {file_path: '/test.ts'}, content: 'second read'},
            ],
          },
        },
      ];

      const result = preprocessMessagesForCompaction(messages, {duplicateFileReadKeepLast: 1});
      expect(result.stats.duplicateFileReadsRemoved).toBe(1);
    });
  });

  describe('truncateLongToolOutputs', () => {
    it('应截断过长的工具输出', () => {
      const longOutput = 'line\n'.repeat(200);
      const messages = [
        {
          type: 'assistant',
          message: {
            content: [{type: 'tool_result', name: 'Bash', content: longOutput}],
          },
        },
      ];

      const result = preprocessMessagesForCompaction(messages, {truncateToolOutputLines: 50});
      const toolResult = result.messages[0].message!.content as any[0];
      expect(toolResult.content).toContain('truncated for compaction');
      expect(result.stats.toolOutputsTruncated).toBe(1);
    });
  });

  describe('getPreprocessSummary', () => {
    it('应为空统计生成摘要', () => {
      const stats: PreprocessStats = {
        imagesStripped: 0,
        documentsStripped: 0,
        duplicateFileReadsRemoved: 0,
        toolOutputsTruncated: 0,
        attachmentsStripped: 0,
        estimatedTokensSaved: 0,
      };
      expect(getPreprocessSummary(stats)).toContain('No preprocessing');
    });

    it('应列出所有应用的转换操作', () => {
      const stats: PreprocessStats = {
        imagesStripped: 2,
        documentsStripped: 1,
        duplicateFileReadsRemoved: 3,
        toolOutputsTruncated: 4,
        attachmentsStripped: 0,
        estimatedTokensSaved: 8500,
      };
      const summary = getPreprocessSummary(stats);
      expect(summary).toContain('2 images');
      expect(summary).toContain('1 documents');
      expect(summary).toContain('3 duplicate');
      expect(summary).toContain('4 outputs');
      expect(summary).toContain('~8500 tokens');
    });
  });

  describe('integration', () => {
    it('应一起应用所有预处理步骤', () => {
      const messages = [
        {
          type: 'user',
          message: {
            content: [
              {type: 'text', text: 'Check this:'},
              {type: 'image', source: {type: 'base64'}},
              {type: 'document', source: {type: 'base64', media_type: 'application/pdf'}},
            ],
          },
        },
        {
          type: 'assistant',
          message: {
            content: [{type: 'tool_result', name: 'Bash', content: 'line\n'.repeat(150)}],
          },
        },
      ];

      const result = preprocessMessagesForCompaction(messages, {
        truncateToolOutputLines: 50,
      });

      expect(result.stats.imagesStripped).toBeGreaterThanOrEqual(1);
      expect(result.stats.documentsStripped).toBeGreaterThanOrEqual(1);
      expect(result.stats.toolOutputsTruncated).toBeGreaterThanOrEqual(1);
      expect(result.stats.estimatedTokensSaved).toBeGreaterThan(0);
    });
  });
});
