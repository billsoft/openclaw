/**
 * Fork Worktree Manager
 *
 * Creates Git worktrees for fork subagent isolation.
 * This allows parallel agents to work on the same repository without
 * file system conflicts.
 *
 * Uses `git worktree` CLI commands for proper worktree management.
 */

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { getForkIsolationMode } from "./fork-subagent-core.js";

const execFileAsync = promisify(execFile);

export type WorktreeInfo = {
  path: string;
  name: string;
  branch: string;
  isNew: boolean;
  commit?: string;
};

/**
 * Validates a worktree name to prevent path traversal attacks.
 */
function isValidWorktreeName(name: string): boolean {
  // Must be alphanumeric with dashes/underscores, max 64 chars
  return /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(name);
}

/**
 * Sanitizes a slug for use as worktree name.
 */
function sanitizeSlug(slug: string): string {
  return slug
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

/**
 * Runs a git command in the repository.
 */
async function gitWorktree(
  repoPath: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, {
      cwd: repoPath,
      timeout: 30000,
    });
    return { stdout, stderr };
  } catch (err) {
    const error = err as { stdout?: string; stderr?: string; message?: string };
    throw new Error(
      `git worktree failed: ${error.message ?? "Unknown error"}\nstderr: ${error.stderr ?? ""}`,
      { cause: err },
    );
  }
}

/**
 * Checks if a git repository has no commits (empty/unborn HEAD).
 * Returns true if HEAD cannot be resolved (no commits yet).
 */
async function isEmptyGitRepo(repoPath: string): Promise<boolean> {
  try {
    const { stdout } = await gitWorktree(repoPath, ["rev-parse", "--verify", "HEAD"]);
    return !stdout.trim();
  } catch {
    return true;
  }
}

/**
 * Checks if a path is a valid git worktree by checking git worktree list.
 */
async function isGitWorktree(repoPath: string, worktreePath: string): Promise<boolean> {
  try {
    const { stdout } = await gitWorktree(repoPath, ["worktree", "list", "--porcelain"]);
    // Each worktree entry starts with "worktree "
    const lines = stdout.split("\n");
    for (const line of lines) {
      if (line.startsWith("worktree ")) {
        const wtPath = line.slice("worktree ".length).replace(/^\//, "").trim();
        const fullWtPath = path.resolve(repoPath, wtPath);
        if (fullWtPath === path.resolve(worktreePath)) {
          return true;
        }
      }
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Extracts branch name from git worktree list output for a given path.
 */
async function getWorktreeBranch(
  repoPath: string,
  worktreePath: string,
): Promise<string | undefined> {
  try {
    const { stdout } = await gitWorktree(repoPath, ["worktree", "list", "--porcelain"]);
    const lines = stdout.split("\n");
    let currentWorktree: string | null = null;

    for (const line of lines) {
      if (line.startsWith("worktree ")) {
        currentWorktree = line.slice("worktree ".length).replace(/^\//, "").trim();
      } else if (line.startsWith("branch ") && currentWorktree) {
        const fullWtPath = path.resolve(repoPath, currentWorktree);
        if (fullWtPath === path.resolve(worktreePath)) {
          return line.slice("branch ".length).trim();
        }
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Creates a Git worktree for fork subagent isolation.
 *
 * Uses `git worktree add` to create a proper git worktree.
 * When isolation mode is "none", falls back to regular directory.
 *
 * @param params.repoPath - Path to the Git repository
 * @param params.worktreeName - Unique name for this worktree
 * @param params.baseBranch - Branch to create worktree from (defaults to HEAD)
 * @param params.parentDir - Parent directory for worktree (defaults to .git/worktrees/)
 * @returns WorktreeInfo with path and details
 */
export async function createAgentWorktree(params: {
  repoPath: string;
  worktreeName: string;
  baseBranch?: string;
  parentDir?: string;
}): Promise<WorktreeInfo> {
  const { repoPath, worktreeName, baseBranch = "HEAD", parentDir } = params;

  if (!isValidWorktreeName(worktreeName)) {
    throw new Error(`Invalid worktree name: ${worktreeName}`);
  }

  const isolationMode = getForkIsolationMode();

  // If isolation mode is "none", just create a regular directory
  if (isolationMode === "none") {
    return createRegularDirectory(repoPath, worktreeName, parentDir);
  }

  // Pre-flight: skip git worktree for empty repos (no commits → HEAD invalid)
  if (await isEmptyGitRepo(repoPath)) {
    console.warn(
      `[fork-worktree] Empty git repository detected at ${repoPath}, skipping worktree isolation (use regular directory)`,
    );
    return createRegularDirectory(repoPath, worktreeName, parentDir);
  }

  const sanitizedName = sanitizeSlug(worktreeName);

  // Use parentDir if provided, otherwise use .git/worktrees/
  let worktreeParent: string;
  if (parentDir) {
    worktreeParent = path.resolve(parentDir);
  } else {
    // Create in .git/worktrees/ by default
    worktreeParent = path.join(repoPath, ".git", "worktrees", sanitizedName);
  }

  const worktreePath = worktreeParent;

  // Check if worktree already exists (git worktree list)
  const existingWorktree = await isGitWorktree(repoPath, worktreePath);
  if (existingWorktree) {
    const branch = await getWorktreeBranch(repoPath, worktreePath);
    return {
      path: worktreePath,
      name: sanitizedName,
      branch: branch ?? `worktree/${sanitizedName}`,
      isNew: false,
    };
  }

  // Ensure parent directory exists
  await fs.mkdir(path.dirname(worktreePath), { recursive: true });

  try {
    // Create git worktree using: git worktree add <path> <branch>
    await gitWorktree(repoPath, [
      "worktree",
      "add",
      worktreePath,
      baseBranch,
      "--no-checkout", // Don't checkout files, we'll populate them as needed
    ]);

    return {
      path: worktreePath,
      name: sanitizedName,
      branch: `worktree/${sanitizedName}`,
      isNew: true,
    };
  } catch (err) {
    // If git worktree add fails for any reason (empty repo, invalid HEAD, permission, etc.),
    // fall back to creating a regular directory rather than failing the entire task.
    console.warn(
      `[fork-worktree] git worktree add failed, falling back to regular directory: ${err instanceof Error ? err.message : String(err)}`,
    );
    return createRegularDirectory(repoPath, worktreeName, parentDir);
  }
}

/**
 * Fallback to create a regular directory when git worktree is not available.
 */
async function createRegularDirectory(
  repoPath: string,
  worktreeName: string,
  parentDir?: string,
): Promise<WorktreeInfo> {
  const sanitizedName = sanitizeSlug(worktreeName);
  const worktreeParent = parentDir
    ? path.resolve(parentDir)
    : path.join(repoPath, ".git", "worktrees");

  const worktreePath = path.join(worktreeParent, sanitizedName);

  // Check if already exists
  try {
    await fs.access(worktreePath);
    return {
      path: worktreePath,
      name: sanitizedName,
      branch: `worktree/${sanitizedName}`,
      isNew: false,
    };
  } catch {
    // Doesn't exist
  }

  await fs.mkdir(worktreePath, { recursive: true });

  return {
    path: worktreePath,
    name: sanitizedName,
    branch: `worktree/${sanitizedName}`,
    isNew: true,
  };
}

/**
 * Removes a Git worktree.
 *
 * Uses `git worktree remove <path>` for proper cleanup.
 * If force is true, uses `git worktree remove --force <path>`.
 */
export async function removeAgentWorktree(params: {
  repoPath: string;
  worktreeName: string;
  parentDir?: string;
  force?: boolean;
}): Promise<void> {
  const { repoPath, worktreeName, parentDir, force = false } = params;

  if (!isValidWorktreeName(worktreeName)) {
    throw new Error(`Invalid worktree name: ${worktreeName}`);
  }

  const isolationMode = getForkIsolationMode();

  // If isolation mode is "none", just remove the directory
  if (isolationMode === "none") {
    const sanitizedName = sanitizeSlug(worktreeName);
    const worktreeParent = parentDir
      ? path.resolve(parentDir)
      : path.join(repoPath, ".git", "worktrees");
    const worktreePath = path.join(worktreeParent, sanitizedName);
    await fs.rm(worktreePath, { recursive: true, force: true });
    return;
  }

  const sanitizedName = sanitizeSlug(worktreeName);
  const worktreeParent = parentDir
    ? path.resolve(parentDir)
    : path.join(repoPath, ".git", "worktrees", sanitizedName);

  const worktreePath = worktreeParent;

  // Check if it's a git worktree
  const isWorktree = await isGitWorktree(repoPath, worktreePath);

  if (isWorktree) {
    try {
      // Use git worktree remove
      const args = ["worktree", "remove", worktreePath];
      if (force) {
        args.push("--force");
      }
      await gitWorktree(repoPath, args);
      // eslint-disable-next-line no-unused-vars
    } catch (_) {
      // If removal fails, fall back to directory removal
      await fs.rm(worktreePath, { recursive: true, force: true });
    }
  } else {
    // Not a git worktree, just remove directory
    await fs.rm(worktreePath, { recursive: true, force: true });
  }
}

/**
 * Lists all agent worktrees.
 *
 * Uses `git worktree list --porcelain` for accurate listing.
 */
export async function listAgentWorktrees(params: {
  repoPath: string;
  parentDir?: string;
}): Promise<WorktreeInfo[]> {
  const { repoPath, parentDir } = params;

  const isolationMode = getForkIsolationMode();

  // If isolation mode is "none", just list directories
  if (isolationMode === "none") {
    return listRegularDirectories(repoPath, parentDir);
  }

  try {
    const { stdout } = await gitWorktree(repoPath, ["worktree", "list", "--porcelain"]);
    const lines = stdout.split("\n");
    const worktrees: WorktreeInfo[] = [];
    let currentWorktree: { path: string; branch?: string } | null = null;

    for (const line of lines) {
      if (line.startsWith("worktree ")) {
        if (currentWorktree) {
          // Previous entry complete, add it
          const name = path.basename(currentWorktree.path);
          worktrees.push({
            path: currentWorktree.path,
            name,
            branch: currentWorktree.branch ?? `worktree/${name}`,
            isNew: false,
          });
        }
        const wtPath = line.slice("worktree ".length).replace(/^\//, "").trim();
        currentWorktree = { path: path.resolve(repoPath, wtPath) };
      } else if (line.startsWith("branch ") && currentWorktree) {
        currentWorktree.branch = line.slice("branch ".length).trim();
      }
    }

    // Don't forget the last entry
    if (currentWorktree) {
      const name = path.basename(currentWorktree.path);
      worktrees.push({
        path: currentWorktree.path,
        name,
        branch: currentWorktree.branch ?? `worktree/${name}`,
        isNew: false,
      });
    }

    return worktrees;
  } catch {
    // Fall back to directory listing
    return listRegularDirectories(repoPath, parentDir);
  }
}

/**
 * Lists regular directories when git worktree list fails.
 */
async function listRegularDirectories(
  repoPath: string,
  parentDir?: string,
): Promise<WorktreeInfo[]> {
  const worktreeParent = parentDir
    ? path.resolve(parentDir)
    : path.join(repoPath, ".git", "worktrees");

  let entries: string[];
  try {
    entries = await fs.readdir(worktreeParent);
  } catch {
    return [];
  }

  const worktrees: WorktreeInfo[] = [];
  for (const entry of entries) {
    const entryPath = path.join(worktreeParent, entry);
    try {
      const stat = await fs.stat(entryPath);
      if (stat.isDirectory()) {
        worktrees.push({
          path: entryPath,
          name: entry,
          branch: `worktree/${entry}`,
          isNew: false,
        });
      }
    } catch {
      // Skip inaccessible entries
    }
  }

  return worktrees;
}

/**
 * Cleans up stale worktrees (not modified in maxAgeMs).
 *
 * Uses `git worktree prune` for proper stale worktree cleanup.
 */
export async function cleanupStaleWorktrees(params: {
  repoPath: string;
  maxAgeMs?: number;
  parentDir?: string;
}): Promise<string[]> {
  const { repoPath, parentDir } = params;

  const isolationMode = getForkIsolationMode();

  // If isolation mode is "none", use directory-based cleanup
  if (isolationMode === "none") {
    return cleanupStaleDirectories(repoPath, params.maxAgeMs, parentDir);
  }

  // First, run git worktree prune to clean up stale worktrees
  try {
    await gitWorktree(repoPath, ["worktree", "prune"]);
  } catch {
    // Best effort - continue with manual cleanup
  }

  // Then clean up based on modification time
  return cleanupStaleDirectories(repoPath, params.maxAgeMs, parentDir);
}

/**
 * Cleans up stale directories based on modification time.
 */
async function cleanupStaleDirectories(
  repoPath: string,
  maxAgeMs?: number,
  parentDir?: string,
): Promise<string[]> {
  const maxAge = maxAgeMs ?? 3600000; // Default 1 hour
  const cutoff = Date.now() - maxAge;

  const worktrees = await listAgentWorktrees({ repoPath, parentDir });
  const cleaned: string[] = [];

  for (const wt of worktrees) {
    try {
      const stat = await fs.stat(wt.path);
      // Use mtime or ctime, whichever is older
      const lastModified = Math.min(stat.mtimeMs, stat.ctimeMs);
      if (lastModified < cutoff) {
        await removeAgentWorktree({ repoPath, worktreeName: wt.name, parentDir, force: true });
        cleaned.push(wt.path);
      }
    } catch {
      // Skip worktrees that can't be checked
    }
  }

  return cleaned;
}
