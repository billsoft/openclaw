export const POST_COMPACT_RESTORE_POLICY = {
  maxFilesToRestore: 5,
  postCompactTokenBudget: 50_000,
  maxTokensPerFile: 5_000,
  maxTokensPerSkill: 5_000,
  skillsTokenBudget: 25_000,
} as const;

export interface RestoreDecision {
  filePath: string;
  restoreType: 'recently-edited' | 'skill-instruction' | 'plan-context' | 'user-referenced';
  shouldRestore: boolean;
  priority: number;
  estimatedTokens: number;
  reason: string;
}

export interface PostRestoreResult {
  restoredFiles: number;
  totalRestoredTokens: number;
  skippedFiles: number;
  decisions: RestoreDecision[];
}

type ToolUse = {
  name: string;
  input?: unknown;
};

export function analyzePostCompactRestoreNeeds(
  recentToolUses: ToolUse[],
  activeSkills: string[],
  referencedFilePaths: string[],
): RestoreDecision[] {
  const decisions: RestoreDecision[] = [];
  let currentBudget = POST_COMPACT_RESTORE_POLICY.postCompactTokenBudget;

  const recentlyEditedFiles = identifyRecentlyEditedFiles(recentToolUses);
  for (const filePath of recentlyEditedFiles.slice(0, POST_COMPACT_RESTORE_POLICY.maxFilesToRestore)) {
    const estimatedTokens = Math.min(POST_COMPACT_RESTORE_POLICY.maxTokensPerFile, 3000);

    if (currentBudget >= estimatedTokens) {
      decisions.push({
        filePath,
        restoreType: 'recently-edited',
        shouldRestore: true,
        priority: 0,
        estimatedTokens,
        reason: `Recently edited via ${recentToolUses.find((t) => t.input?.file_path === filePath)?.name || 'unknown'} tool`,
      });
      currentBudget -= estimatedTokens;
    }
  }

  for (const skillName of activeSkills.slice(0, 3)) {
    const estimatedTokens = Math.min(POST_COMPACT_RESTORE_POLICY.maxTokensPerSkill, 2000);

    if (
      currentBudget >= estimatedTokens &&
      decisions.length < POST_COMPACT_RESTORE_POLICY.maxFilesToRestore
    ) {
      decisions.push({
        filePath: `[skill]${skillName}`,
        restoreType: 'skill-instruction',
        shouldRestore: true,
        priority: 1,
        estimatedTokens,
        reason: `Active skill instruction: ${skillName}`,
      });
      currentBudget -= estimatedTokens;
    }
  }

  for (const filePath of referencedFilePaths.slice(0, 2)) {
    const alreadyIncluded = decisions.some((d) => d.filePath === filePath);
    if (alreadyIncluded) {continue;}

    const estimatedTokens = Math.min(POST_COMPACT_RESTORE_POLICY.maxTokensPerFile, 2500);

    if (
      currentBudget >= estimatedTokens &&
      decisions.length < POST_COMPACT_RESTORE_POLICY.maxFilesToRestore
    ) {
      decisions.push({
        filePath,
        restoreType: 'user-referenced',
        shouldRestore: true,
        priority: 2,
        estimatedTokens,
        reason: 'Referenced in recent conversation',
      });
      currentBudget -= estimatedTokens;
    }
  }

  decisions.sort((a, b) => a.priority - b.priority);
  return decisions;
}

function identifyRecentlyEditedFiles(toolUses: ToolUse[]): string[] {
  const editTools = new Set(['FileEditTool', 'Write', 'Edit', 'write_file', 'edit_file']);
  const files = new Set<string>();

  for (const toolUse of toolUses) {
    if (editTools.has(toolUse.name) && toolUse.input?.file_path) {
      files.add(toolUse.input.file_path);
    }
    if (editTools.has(toolUse.name) && toolUse.input?.path) {
      files.add(toolUse.input.path);
    }
  }

  return Array.from(files).toReversed();
}

export function generateRestoreContext(decisions: RestoreDecision[]): string {
  if (decisions.length === 0) {
    return '';
  }

  const lines: string[] = [
    '',
    '---',
    '<compaction-restore>',
    'The following context was preserved after compaction:',
    '',
  ];

  for (const decision of decisions) {
    if (!decision.shouldRestore) {continue;}

    lines.push(`**${decision.restoreType.replace(/-/g, ' ').toUpperCase()}**: ${decision.filePath}`);
    lines.push(`- ${decision.reason}`);
    lines.push(`- Estimated size: ~${decision.estimatedTokens} tokens`);
    lines.push('');
  }

  lines.push('</compaction-restore>');
  lines.push('---');
  lines.push('');

  return lines.join('\n');
}

export function calculatePostCompactTokenBudget(
  preCompactTokens: number,
  postCompactTokens: number,
  targetUtilization: number = 0.6,
): number {
  const availableSpace = postCompactTokens * (1 - targetUtilization);
  return Math.min(availableSpace, POST_COMPACT_RESTORE_POLICY.postCompactTokenBudget);
}
