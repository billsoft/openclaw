import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recordSkillSuccess, recordSkillFailure, findMergeableSkills } from "./skill-evolution.js";
import { writeSkillIndex, readSkillIndex, type SkillIndexEntry } from "./skill-index.js";
import { DEFAULT_AUTO_EVOLVE_CONFIG, type AutoEvolveConfig } from "./types.js";

let tmpDir: string;

function makeConfig(overrides?: Partial<AutoEvolveConfig>): AutoEvolveConfig {
  return {
    ...DEFAULT_AUTO_EVOLVE_CONFIG,
    enabled: true,
    evolution: { ...DEFAULT_AUTO_EVOLVE_CONFIG.evolution, provenThreshold: 5 },
    ...overrides,
  };
}

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
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "auto-evolve-evolution-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("recordSkillSuccess", () => {
  it("increments useCount and successCount", async () => {
    await writeSkillIndex(tmpDir, [makeEntry("deploy", { useCount: 1, successCount: 1 })]);
    await recordSkillSuccess({ skillName: "deploy", managedSkillsDir: tmpDir, config: makeConfig() });
    const entries = await readSkillIndex(tmpDir);
    expect(entries[0].useCount).toBe(2);
    expect(entries[0].successCount).toBe(2);
  });

  it("upgrades draft → validated at 2 successes", async () => {
    await writeSkillIndex(tmpDir, [
      makeEntry("deploy", { confidence: "draft", useCount: 1, successCount: 1 }),
    ]);
    await recordSkillSuccess({ skillName: "deploy", managedSkillsDir: tmpDir, config: makeConfig() });
    const entries = await readSkillIndex(tmpDir);
    expect(entries[0].confidence).toBe("validated");
  });

  it("upgrades validated → proven at threshold", async () => {
    await writeSkillIndex(tmpDir, [
      makeEntry("deploy", { confidence: "validated", useCount: 4, successCount: 4 }),
    ]);
    await recordSkillSuccess({ skillName: "deploy", managedSkillsDir: tmpDir, config: makeConfig() });
    const entries = await readSkillIndex(tmpDir);
    expect(entries[0].confidence).toBe("proven");
  });

  it("does not downgrade on success", async () => {
    await writeSkillIndex(tmpDir, [
      makeEntry("deploy", { confidence: "proven", useCount: 10, successCount: 10 }),
    ]);
    await recordSkillSuccess({ skillName: "deploy", managedSkillsDir: tmpDir, config: makeConfig() });
    const entries = await readSkillIndex(tmpDir);
    expect(entries[0].confidence).toBe("proven");
  });
});

describe("recordSkillFailure", () => {
  it("increments useCount without incrementing successCount", async () => {
    await writeSkillIndex(tmpDir, [makeEntry("deploy", { useCount: 5, successCount: 3 })]);
    await recordSkillFailure({ skillName: "deploy", managedSkillsDir: tmpDir, config: makeConfig() });
    const entries = await readSkillIndex(tmpDir);
    expect(entries[0].useCount).toBe(6);
    expect(entries[0].successCount).toBe(3);
  });

  it("degrades when fail rate exceeds threshold", async () => {
    // 2 successes out of 5 uses = 60% fail rate (> default 50%)
    await writeSkillIndex(tmpDir, [
      makeEntry("deploy", { confidence: "proven", useCount: 4, successCount: 2 }),
    ]);
    await recordSkillFailure({
      skillName: "deploy",
      managedSkillsDir: tmpDir,
      config: makeConfig({ evolution: { ...DEFAULT_AUTO_EVOLVE_CONFIG.evolution, degradeFailRate: 0.5 } }),
    });
    const entries = await readSkillIndex(tmpDir);
    expect(entries[0].confidence).toBe("validated");
  });
});

describe("findMergeableSkills", () => {
  it("finds skills with overlapping trigger patterns", async () => {
    await writeSkillIndex(tmpDir, [
      makeEntry("deploy-a", { triggerPatterns: ["deploy to vercel", "deploy frontend"] }),
      makeEntry("deploy-b", { triggerPatterns: ["deploy to vercel", "deploy backend"] }),
    ]);
    const pairs = await findMergeableSkills({ managedSkillsDir: tmpDir });
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toEqual(["deploy-a", "deploy-b"]);
  });

  it("returns empty for non-overlapping skills", async () => {
    await writeSkillIndex(tmpDir, [
      makeEntry("deploy", { triggerPatterns: ["deploy"] }),
      makeEntry("lint", { triggerPatterns: ["fix lint"] }),
    ]);
    const pairs = await findMergeableSkills({ managedSkillsDir: tmpDir });
    expect(pairs).toHaveLength(0);
  });
});
