/**
 * SkillIndex — Manages the `_auto/_index.json` file that serves as a
 * lightweight skill catalog for the main session prompt and the matcher.
 *
 * The main session's system prompt only loads this index (name + description +
 * triggers); full skill steps are loaded on-demand via read_file when matched.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { SkillConfidenceLevel } from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SkillIndexEntry = {
  name: string;
  description: string;
  triggerPatterns: string[];
  negativePatterns: string[];
  confidence: SkillConfidenceLevel;
  location: string;
  useCount: number;
  successCount: number;
  dependsOn?: string[];
};

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const INDEX_FILE_NAME = "_index.json";

function resolveAutoDir(managedSkillsDir: string): string {
  return path.join(managedSkillsDir, "_auto");
}

function resolveIndexPath(managedSkillsDir: string): string {
  return path.join(resolveAutoDir(managedSkillsDir), INDEX_FILE_NAME);
}

// ---------------------------------------------------------------------------
// Read / Write
// ---------------------------------------------------------------------------

export async function readSkillIndex(
  managedSkillsDir: string,
): Promise<SkillIndexEntry[]> {
  const indexPath = resolveIndexPath(managedSkillsDir);
  let raw: string;
  try {
    raw = await fs.readFile(indexPath, "utf-8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      return [];
    }
    throw err;
  }
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(
    (entry): entry is SkillIndexEntry =>
      !!entry &&
      typeof entry === "object" &&
      typeof (entry as Record<string, unknown>).name === "string",
  );
}

export async function writeSkillIndex(
  managedSkillsDir: string,
  entries: SkillIndexEntry[],
): Promise<void> {
  const autoDir = resolveAutoDir(managedSkillsDir);
  await fs.mkdir(autoDir, { recursive: true });
  const indexPath = resolveIndexPath(managedSkillsDir);
  const sorted = entries.slice().sort((a, b) => a.name.localeCompare(b.name));
  await fs.writeFile(indexPath, JSON.stringify(sorted, null, 2), {
    encoding: "utf-8",
    mode: 0o600,
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export async function findSkillByName(
  managedSkillsDir: string,
  name: string,
): Promise<SkillIndexEntry | undefined> {
  const entries = await readSkillIndex(managedSkillsDir);
  return entries.find((e) => e.name === name);
}

export async function removeSkillFromIndex(
  managedSkillsDir: string,
  name: string,
): Promise<boolean> {
  const entries = await readSkillIndex(managedSkillsDir);
  const filtered = entries.filter((e) => e.name !== name);
  if (filtered.length === entries.length) return false;
  await writeSkillIndex(managedSkillsDir, filtered);
  return true;
}

export async function updateSkillInIndex(
  managedSkillsDir: string,
  name: string,
  updater: (entry: SkillIndexEntry) => SkillIndexEntry,
): Promise<boolean> {
  const entries = await readSkillIndex(managedSkillsDir);
  let found = false;
  const updated = entries.map((e) => {
    if (e.name === name) {
      found = true;
      return updater(e);
    }
    return e;
  });
  if (!found) return false;
  await writeSkillIndex(managedSkillsDir, updated);
  return true;
}

// ---------------------------------------------------------------------------
// Prompt builder — generates the compact index for the system prompt
// ---------------------------------------------------------------------------

export function formatSkillIndexForPrompt(entries: SkillIndexEntry[]): string {
  const active = entries.filter((e) => e.confidence !== "archived");
  if (active.length === 0) return "";

  const lines: string[] = [
    "\n\nThe following auto-learned skills are available. When a user request matches a skill's triggers, use the read tool to load its SKILL.md for detailed steps.",
    "",
    "<auto_evolved_skills>",
  ];

  for (const entry of active) {
    lines.push("  <skill>");
    lines.push(`    <name>${escapeXml(entry.name)}</name>`);
    lines.push(`    <description>${escapeXml(entry.description)}</description>`);
    lines.push(`    <triggers>${escapeXml(entry.triggerPatterns.join("; "))}</triggers>`);
    if (entry.negativePatterns.length > 0) {
      lines.push(`    <exclude>${escapeXml(entry.negativePatterns.join("; "))}</exclude>`);
    }
    lines.push(`    <confidence>${entry.confidence}</confidence>`);
    lines.push(`    <location>${escapeXml(entry.location)}</location>`);
    lines.push("  </skill>");
  }

  lines.push("</auto_evolved_skills>");
  return lines.join("\n");
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
