import { describe, it, expect } from 'vitest';
import {
  parseMemoryType,
  isValidMemoryType,
  validateMemoryType,
  inferMemoryTypeFromContent,
  formatMemoryManifestWithType,
  getTypeStats,
  MEMORY_TYPES,
  MEMORY_TYPE_DESCRIPTIONS,
  type MemoryType,
  type TypedMemoryEntry,
} from './memory-types.js';

describe('memory-types', () => {
  describe('MEMORY_TYPES', () => {
    it('应包含恰好 4 种类型', () => {
      expect(MEMORY_TYPES).toHaveLength(4);
      expect(MEMORY_TYPES).toContain('user');
      expect(MEMORY_TYPES).toContain('feedback');
      expect(MEMORY_TYPES).toContain('project');
      expect(MEMORY_TYPES).toContain('reference');
    });
  });

  describe('parseMemoryType', () => {
    it('应解析有效类型', () => {
      expect(parseMemoryType('user')).toBe('user');
      expect(parseMemoryType('feedback')).toBe('feedback');
      expect(parseMemoryType('project')).toBe('project');
      expect(parseMemoryType('reference')).toBe('reference');
    });

    it('对无效类型应返回 undefined', () => {
      expect(parseMemoryType('invalid')).toBeUndefined();
      expect(parseMemoryType('')).toBeUndefined();
      expect(parseMemoryType(123)).toBeUndefined();
      expect(parseMemoryType(null)).toBeUndefined();
      expect(parseMemoryType(undefined)).toBeUndefined();
    });

    it('应区分大小写', () => {
      expect(parseMemoryType('User')).toBeUndefined();
      expect(parseMemoryType('USER')).toBeUndefined();
    });
  });

  describe('isValidMemoryType', () => {
    it('应作为类型守卫工作', () => {
      const value: string = 'user';
      if (isValidMemoryType(value)) {
        expect(value).toEqual<'user' | 'feedback' | 'project' | 'reference'>(value);
      }
    });
  });

  describe('validateMemoryType', () => {
    it('应验证正确类型', () => {
      expect(validateMemoryType('user').valid).toBe(true);
      expect(validateMemoryType('feedback').error).toBeUndefined();
    });

    it('应拒绝不正确类型', () => {
      const result = validateMemoryType('unknown' as MemoryType);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Invalid memory type');
    });
  });

  describe('inferMemoryTypeFromContent', () => {
    it('应从纠正上下文推断 feedback', () => {
      expect(inferMemoryTypeFromContent('stop doing that', {isCorrection: true})).toBe('feedback');
    });

    it('应从外部系统提及推断 reference', () => {
      expect(inferMemoryTypeFromContent('check Linear for bugs', {mentionsExternalSystem: true})).toBe(
        'reference',
      );
    });

    it('应从项目关键词推断 project', () => {
      expect(inferMemoryTypeFromContent('release next sprint')).toBe('project');
    });

    it('应从用户画像关键词推断 user', () => {
      expect(inferMemoryTypeFromContent("I'm a senior developer")).toBe('user');
    });

    it('无明确信号时应返回 undefined', () => {
      expect(inferMemoryTypeFromContent('some random text')).toBeUndefined();
    });
  });

  describe('formatMemoryManifestWithType', () => {
    it('空数组应格式化为空字符串', () => {
      expect(formatMemoryManifestWithType([])).toBe('');
    });

    it('应格式化带类型标签的记忆', () => {
      const memories: TypedMemoryEntry[] = [
        {
          path: '/test.md',
          startLine: 1,
          endLine: 5,
          score: 0.9,
          snippet: 'test snippet',
          source: 'memory',
          type: 'user',
          metadata: {extractedAt: Date.now()},
        },
      ];

      const result = formatMemoryManifestWithType(memories);
      expect(result).toContain('[user]');
      expect(result).toContain('/test.md');
      expect(result).toContain('test snippet');
      expect(result).toContain('## Relevant Memories');
    });

    it('应遵守 maxItems 限制', () => {
      const memories: TypedMemoryEntry[] = Array.from({length: 10}, (_, i) => ({
        path: `/file${i}.md`,
        startLine: 1,
        endLine: 5,
        score: 0.9 - i * 0.1,
        snippet: `snippet ${i}`,
        source: 'memory' as const,
        type: 'user' as MemoryType,
      }));

      const result = formatMemoryManifestWithType(memories, 3);
      expect(result.split('###').length - 1).toBe(3);
    });
  });

  describe('getTypeStats', () => {
    it('应按类型统计记忆数', () => {
      const memories: TypedMemoryEntry[] = [
        {path: '', startLine: 0, endLine: 0, score: 0, snippet: '', source: 'memory', type: 'user'},
        {path: '', startLine: 0, endLine: 0, score: 0, snippet: '', source: 'memory', type: 'user'},
        {path: '', startLine: 0, endLine: 0, score: 0, snippet: '', source: 'memory', type: 'feedback'},
        {path: '', startLine: 0, endLine: 0, score: 0, snippet: '', source: 'memory'},
      ];

      const stats = getTypeStats(memories);
      expect(stats.get('user')).toBe(2);
      expect(stats.get('feedback')).toBe(1);
      expect(stats.get('project')).toBe(0);
      expect(stats.get('reference')).toBe(0);
    });
  });

  describe('MEMORY_TYPE_DESCRIPTIONS', () => {
    it('应为所有类型提供描述', () => {
      for (const type of MEMORY_TYPES) {
        expect(MEMORY_TYPE_DESCRIPTIONS[type]).toBeDefined();
        expect(MEMORY_TYPE_DESCRIPTIONS[type].label).toBeTruthy();
        expect(MEMORY_TYPE_DESCRIPTIONS[type].description).toBeTruthy();
        expect(MEMORY_TYPE_DESCRIPTIONS[type].examples.length).toBeGreaterThan(0);
      }
    });
  });
});
