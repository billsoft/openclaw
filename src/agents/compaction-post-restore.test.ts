import { describe, it, expect } from 'vitest';
import {
  analyzePostCompactRestoreNeeds,
  generateRestoreContext,
  calculatePostCompactTokenBudget,
  POST_COMPACT_RESTORE_POLICY,
  type RestoreDecision,
} from './compaction-post-restore.js';

describe('compaction-post-restore', () => {
  describe('POST_COMPACT_RESTORE_POLICY', () => {
    it('应有合理的默认值', () => {
      expect(POST_COMPACT_RESTORE_POLICY.maxFilesToRestore).toBe(5);
      expect(POST_COMPACT_RESTORE_POLICY.postCompactTokenBudget).toBe(50_000);
      expect(POST_COMPACT_RESTORE_POLICY.maxTokensPerFile).toBe(5_000);
    });
  });

  describe('analyzePostCompactRestoreNeeds', () => {
    it('应优先考虑最近编辑的文件', () => {
      const toolUses = [
        {name: 'FileEditTool', input: {file_path: '/src/main.ts'}},
        {name: 'FileEditTool', input: {file_path: '/src/utils.ts'}},
        {name: 'Bash', input: {command: 'echo test'}},
      ];

      const decisions = analyzePostCompactRestoreNeeds(toolUses, [], []);

      const editedDecisions = decisions.filter((d) => d.restoreType === 'recently-edited');
      expect(editedDecisions.length).toBe(2);
      expect(editedDecisions[0].priority).toBe(0);
    });

    it('应包含技能说明', () => {
      const decisions = analyzePostCompactRestoreNeeds([], ['skill-a', 'skill-b'], []);

      const skillDecisions = decisions.filter((d) => d.restoreType === 'skill-instruction');
      expect(skillDecisions.length).toBe(2);
      expect(skillDecisions[0].priority).toBe(1);
    });

    it('应包含用户引用的文件', () => {
      const decisions = analyzePostCompactRestoreNeeds([], [], ['/docs/api.md']);

      const refDecisions = decisions.filter((d) => d.restoreType === 'user-referenced');
      expect(refDecisions.length).toBe(1);
      expect(refDecisions[0].priority).toBe(2);
    });

    it('应遵守 maxFilesToRestore 限制', () => {
      const toolUses = Array.from({length: 10}, (_, i) => ({
        name: 'FileEditTool',
        input: {file_path: `/src/file${i}.ts`},
      }));

      const decisions = analyzePostCompactRestoreNeeds(toolUses, [], []);
      expect(decisions.length).toBeLessThanOrEqual(POST_COMPACT_RESTORE_POLICY.maxFilesToRestore);
    });

    it('无相关上下文时应返回空数组', () => {
      const decisions = analyzePostCompactRestoreNeeds([], [], []);
      expect(decisions).toHaveLength(0);
    });

    it('应按优先级排序', () => {
      const decisions = analyzePostCompactRestoreNeeds(
        [{name: 'FileEditTool', input: {file_path: '/a.ts'}}],
        ['skill-x'],
        ['/ref.md'],
      );

      for (let i = 1; i < decisions.length; i++) {
        expect(decisions[i - 1].priority).toBeLessThanOrEqual(decisions[i].priority);
      }
    });
  });

  describe('generateRestoreContext', () => {
    it('无决策时应返回空字符串', () => {
      expect(generateRestoreContext([])).toBe('');
    });

    it('应将决策格式化为类 XML 结构', () => {
      const decisions: RestoreDecision[] = [
        {
          filePath: '/main.ts',
          restoreType: 'recently-edited',
          shouldRestore: true,
          priority: 0,
          estimatedTokens: 3000,
          reason: 'Recently edited',
        },
      ];

      const context = generateRestoreContext(decisions);
      expect(context).toContain('<compaction-restore>');
      expect(context).toContain('</compaction-restore>');
      expect(context).toContain('/main.ts');
      expect(context).toContain('RECENTLY EDITED');
    });

    it('应跳过 shouldRestore 为 false 的决策', () => {
      const decisions: RestoreDecision[] = [
        {
          filePath: '/skip.ts',
          restoreType: 'plan-context',
          shouldRestore: false,
          priority: 3,
          estimatedTokens: 1000,
          reason: 'Should skip',
        },
      ];

      const context = generateRestoreContext(decisions);
      expect(context).not.toContain('/skip.ts');
    });
  });

  describe('calculatePostCompactTokenBudget', () => {
    it('应根据可用空间计算预算', () => {
      const budget = calculatePostCompactTokenBudget(100_000, 80_000);
      expect(budget).toBeGreaterThan(0);
      expect(budget).toBeLessThanOrEqual(POST_COMPACT_RESTORE_POLICY.postCompactTokenBudget);
    });

    it('应以策略最大值为上限', () => {
      const budget = calculatePostCompactTokenBudget(1_000_000, 800_000);
      expect(budget).toBe(POST_COMPACT_RESTORE_POLICY.postCompactTokenBudget);
    });

    it('无可用空间时应返回 0', () => {
      const budget = calculatePostCompactTokenBudget(1000, 999, 0.99);
      expect(budget).toBe(0);
    });
  });
});
