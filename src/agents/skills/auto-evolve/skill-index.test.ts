import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  readSkillIndex,
  writeSkillIndex,
  findSkillByName,
  removeSkillFromIndex,
  updateSkillInIndex,
  formatSkillIndexForPrompt,
  type SkillIndexEntry,
} from "./skill-index.js";

let tmpDir: string;

function makeEntry(name: string, overrides?: Partial<SkillIndexEntry>): SkillIndexEntry {
  return {
    name,
    description: `Skill ${name}`,
    triggerPatterns: [`do ${name}`],
    negativePatterns: [],
    confidence: "draft",
    location: `_auto/${name}/SKILL.md`,
    useCount: 0,
    successCount: 0,
    ...overrides,
  };
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "auto-evolve-index-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("readSkillIndex / writeSkillIndex", () => {
  it("returns empty array when no index exists", async () => {
    const entries = await readSkillIndex(tmpDir);
    expect(entries).toEqual([]);
  });

  it("round-trips entries", async () => {
    const entries = [makeEntry("deploy"), makeEntry("lint-fix")];
    await writeSkillIndex(tmpDir, entries);
    const read = await readSkillIndex(tmpDir);
    expect(read).toHaveLength(2);
    expect(read[0].name).toBe("deploy");
    expect(read[1].name).toBe("lint-fix");
  });

  it("sorts entries by name", async () => {
    const entries = [makeEntry("zebra"), makeEntry("alpha")];
    await writeSkillIndex(tmpDir, entries);
    const read = await readSkillIndex(tmpDir);
    expect(read[0].name).toBe("alpha");
    expect(read[1].name).toBe("zebra");
  });
});

describe("findSkillByName", () => {
  it("finds an existing skill", async () => {
    await writeSkillIndex(tmpDir, [makeEntry("deploy")]);
    const found = await findSkillByName(tmpDir, "deploy");
    expect(found?.name).toBe("deploy");
  });

  it("returns undefined for missing skill", async () => {
    await writeSkillIndex(tmpDir, [makeEntry("deploy")]);
    const found = await findSkillByName(tmpDir, "nonexistent");
    expect(found).toBeUndefined();
  });
});

describe("removeSkillFromIndex", () => {
  it("removes an existing skill", async () => {
    await writeSkillIndex(tmpDir, [makeEntry("deploy"), makeEntry("lint")]);
    const removed = await removeSkillFromIndex(tmpDir, "deploy");
    expect(removed).toBe(true);
    const remaining = await readSkillIndex(tmpDir);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].name).toBe("lint");
  });

  it("returns false when skill not found", async () => {
    await writeSkillIndex(tmpDir, [makeEntry("deploy")]);
    const removed = await removeSkillFromIndex(tmpDir, "nonexistent");
    expect(removed).toBe(false);
  });
});

describe("updateSkillInIndex", () => {
  it("updates an existing skill", async () => {
    await writeSkillIndex(tmpDir, [makeEntry("deploy", { useCount: 3 })]);
    const updated = await updateSkillInIndex(tmpDir, "deploy", (e) => ({
      ...e,
      useCount: e.useCount + 1,
    }));
    expect(updated).toBe(true);
    const read = await readSkillIndex(tmpDir);
    expect(read[0].useCount).toBe(4);
  });

  it("returns false when skill not found", async () => {
    await writeSkillIndex(tmpDir, [makeEntry("deploy")]);
    const updated = await updateSkillInIndex(tmpDir, "missing", (e) => e);
    expect(updated).toBe(false);
  });
});

describe("formatSkillIndexForPrompt", () => {
  it("returns empty string for empty entries", () => {
    expect(formatSkillIndexForPrompt([])).toBe("");
  });

  it("excludes archived skills", () => {
    const entries = [
      makeEntry("active", { confidence: "proven" }),
      makeEntry("old", { confidence: "archived" }),
    ];
    const prompt = formatSkillIndexForPrompt(entries);
    expect(prompt).toContain("active");
    expect(prompt).not.toContain("old");
  });

  it("includes trigger patterns and XML structure", () => {
    const entries = [makeEntry("deploy", { triggerPatterns: ["部署", "deploy to vercel"] })];
    const prompt = formatSkillIndexForPrompt(entries);
    expect(prompt).toContain("<auto_evolved_skills>");
    expect(prompt).toContain("部署; deploy to vercel");
    expect(prompt).toContain("</auto_evolved_skills>");
  });
});
