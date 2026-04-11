/**
 * SkillOrchestrator — Resolves multi-skill execution plans from depends-on
 * declarations in skill frontmatter.
 *
 * Supports:
 *  - Sequential ordering via `order` field
 *  - Parallel grouping via `parallel-with` field
 *  - Cycle detection (DAG validation)
 */

import type { AutoEvolveDependency } from "./types.js";
import { readSkillIndex, type SkillIndexEntry } from "./skill-index.js";

// ---------------------------------------------------------------------------
// Execution plan types
// ---------------------------------------------------------------------------

export type ExecutionStep = {
  order: number;
  skills: string[];
};

export type ExecutionPlan = {
  steps: ExecutionStep[];
  valid: boolean;
  error?: string;
};

// ---------------------------------------------------------------------------
// DAG builder
// ---------------------------------------------------------------------------

function detectCycles(
  dependencies: AutoEvolveDependency[],
  allSkillNames: Set<string>,
): string | null {
  const graph = new Map<string, Set<string>>();
  for (const dep of dependencies) {
    if (!graph.has(dep.name)) graph.set(dep.name, new Set());
  }

  // Build adjacency: higher order depends on lower order
  const byOrder = new Map<number, string[]>();
  for (const dep of dependencies) {
    const group = byOrder.get(dep.order) ?? [];
    group.push(dep.name);
    byOrder.set(dep.order, group);
  }

  const sortedOrders = [...byOrder.keys()].sort((a, b) => a - b);
  for (let i = 1; i < sortedOrders.length; i++) {
    const prevSkills = byOrder.get(sortedOrders[i - 1]) ?? [];
    const currSkills = byOrder.get(sortedOrders[i]) ?? [];
    for (const curr of currSkills) {
      for (const prev of prevSkills) {
        if (!graph.has(curr)) graph.set(curr, new Set());
        graph.get(curr)!.add(prev);
      }
    }
  }

  // DFS cycle detection
  const visited = new Set<string>();
  const inStack = new Set<string>();

  function dfs(node: string): boolean {
    if (inStack.has(node)) return true;
    if (visited.has(node)) return false;
    visited.add(node);
    inStack.add(node);
    for (const neighbor of graph.get(node) ?? []) {
      if (dfs(neighbor)) return true;
    }
    inStack.delete(node);
    return false;
  }

  for (const node of graph.keys()) {
    if (dfs(node)) {
      return `Cycle detected involving skill "${node}"`;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Plan builder
// ---------------------------------------------------------------------------

export function buildExecutionPlan(
  dependencies: AutoEvolveDependency[],
): ExecutionPlan {
  if (dependencies.length === 0) {
    return { steps: [], valid: true };
  }

  const allNames = new Set(dependencies.map((d) => d.name));
  const cycleError = detectCycles(dependencies, allNames);
  if (cycleError) {
    return { steps: [], valid: false, error: cycleError };
  }

  // Group by order
  const byOrder = new Map<number, string[]>();
  for (const dep of dependencies) {
    const group = byOrder.get(dep.order) ?? [];
    group.push(dep.name);
    byOrder.set(dep.order, group);
  }

  const steps: ExecutionStep[] = [...byOrder.entries()]
    .sort(([a], [b]) => a - b)
    .map(([order, skills]) => ({
      order,
      skills: skills.sort(),
    }));

  return { steps, valid: true };
}

// ---------------------------------------------------------------------------
// Full plan resolver (reads index for dependencies)
// ---------------------------------------------------------------------------

export async function resolveOrchestrationPlan(params: {
  skillName: string;
  managedSkillsDir: string;
}): Promise<ExecutionPlan> {
  const { skillName, managedSkillsDir } = params;

  let entries: SkillIndexEntry[];
  try {
    entries = await readSkillIndex(managedSkillsDir);
  } catch {
    return { steps: [{ order: 1, skills: [skillName] }], valid: true };
  }

  const entry = entries.find((e) => e.name === skillName);
  if (!entry || !entry.dependsOn || entry.dependsOn.length === 0) {
    return { steps: [{ order: 1, skills: [skillName] }], valid: true };
  }

  // Parse dependsOn from index (stored as string[] of skill names)
  // For full depends-on with order, we need to read the SKILL.md frontmatter.
  // For now, treat all dependencies as order=1 (parallel) and the main skill as order=2.
  const deps: AutoEvolveDependency[] = entry.dependsOn.map((name, i) => ({
    name,
    order: 1,
  }));
  deps.push({ name: skillName, order: 2 });

  return buildExecutionPlan(deps);
}
