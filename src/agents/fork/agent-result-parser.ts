/**
 * Agent 结果解析器 - 结构化输出解析
 *
 * 复制自 Claude Code 的 forkedAgent.ts 概念
 * 通过系统提示词约束 Agent 输出格式，然后解析
 */

export interface ParsedAgentResult {
  scope: string; // 任务范围确认
  result: string; // 执行结果
  keyFiles: string[]; // 关键文件
  filesChanged: string[]; // 变更的文件（带 commit hash）
  issues: string[]; // 遇到的问题
  commitHash?: string; // 如果有提交
}

/**
 * 解析 Agent 结构化输出
 * 期望格式：
 *   Scope: <描述>
 *   Result: <结果>
 *   Key files: <文件列表>
 *   Files changed: <文件+commit>
 *   Issues: <问题或 "none">
 */
export function parseAgentResult(output: string): ParsedAgentResult {
  const result: ParsedAgentResult = {
    scope: "",
    result: "",
    keyFiles: [],
    filesChanged: [],
    issues: [],
  };

  // 解析 Scope
  const scopeMatch = output.match(/Scope:\s*(.+)/i);
  if (scopeMatch) {
    result.scope = scopeMatch[1].trim();
  }

  // 解析 Result
  const resultMatch = output.match(/Result:\s*([\s\S]+?)(?=Key files:|Files changed:|Issues:|$)/i);
  if (resultMatch) {
    result.result = resultMatch[1].trim();
  }

  // 解析 Key files
  const keyFilesMatch = output.match(/Key files:\s*(.+)/i);
  if (keyFilesMatch) {
    result.keyFiles = keyFilesMatch[1]
      .split(/[,;]/)
      .map((f) => f.trim())
      .filter((f) => f.length > 0);
  }

  // 解析 Files changed
  const filesChangedMatch = output.match(/Files changed:\s*(.+)/i);
  if (filesChangedMatch) {
    const changedText = filesChangedMatch[1].trim();
    if (changedText !== "none") {
      result.filesChanged = changedText
        .split(/[,;]/)
        .map((f) => f.trim())
        .filter((f) => f.length > 0);

      // 提取 commit hash
      const commitMatch = changedText.match(/\(([a-f0-9]+)\)/);
      if (commitMatch) {
        result.commitHash = commitMatch[1];
      }
    }
  }

  // 解析 Issues
  const issuesMatch = output.match(/Issues:\s*(.+)/i);
  if (issuesMatch) {
    const issuesText = issuesMatch[1].trim();
    if (issuesText !== "none") {
      result.issues = issuesText
        .split(/[,;]/)
        .map((i) => i.trim())
        .filter((i) => i.length > 0);
    }
  }

  return result;
}

/**
 * 验证 Agent 输出是否符合预期格式
 */
export function validateAgentResult(output: string): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  if (!output.includes("Scope:")) {
    errors.push("Missing 'Scope:' section");
  }
  if (!output.includes("Result:")) {
    errors.push("Missing 'Result:' section");
  }
  if (!output.includes("Key files:")) {
    errors.push("Missing 'Key files:' section");
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * 合成多个 Agent 结果为一个总结报告
 * 用于 Coordinator 汇总并行任务结果
 */
export function synthesizeAgentResults(
  results: Array<{ taskId: string; result: ParsedAgentResult; status: string }>,
): string {
  const parts: string[] = [];
  parts.push("## Task Execution Summary");
  parts.push("");

  const completed = results.filter((r) => r.status === "completed");
  const failed = results.filter((r) => r.status === "failed" || r.status === "cancelled");

  parts.push(`Total: ${results.length}`);
  parts.push(`Completed: ${completed.length}`);
  parts.push(`Failed: ${failed.length}`);
  parts.push("");

  for (const { taskId, result } of completed) {
    parts.push(`### ${taskId}`);
    parts.push(`**Scope**: ${result.scope || "N/A"}`);
    parts.push(`**Result**: ${result.result || "N/A"}`);

    if (result.keyFiles.length) {
      parts.push(`**Key Files**: ${result.keyFiles.join(", ")}`);
    }

    if (result.filesChanged.length) {
      parts.push(`**Files Changed**: ${result.filesChanged.join(", ")}`);
    }

    if (result.issues.length && result.issues[0] !== "none") {
      parts.push(`**Issues**: ${result.issues.join(", ")}`);
    }

    parts.push("");
  }

  if (failed.length > 0) {
    parts.push("### Failed Tasks");
    for (const { taskId } of failed) {
      parts.push(`- ${taskId}`);
    }
  }

  return parts.join("\n");
}
