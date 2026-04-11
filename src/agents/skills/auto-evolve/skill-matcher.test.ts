import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { matchSkills } from "./skill-matcher.js";
import { writeSkillIndex, type SkillIndexEntry } from "./skill-index.js";
import { DEFAULT_AUTO_EVOLVE_CONFIG, type AutoEvolveConfig } from "./types.js";

let tmpDir: string;

function makeConfig(overrides?: Partial<AutoEvolveConfig>): AutoEvolveConfig {
  return {
    ...DEFAULT_AUTO_EVOLVE_CONFIG,
    enabled: true,
    matching: { ...DEFAULT_AUTO_EVOLVE_CONFIG.matching, enabled: true, minScore: 0.5 },
    ...overrides,
  };
}

function makeEntry(name: string, triggers: string[], negatives: string[] = []): SkillIndexEntry {
  return {
    name,
    description: `Skill ${name}`,
    triggerPatterns: triggers,
    negativePatterns: negatives,
    confidence: "proven",
    location: `_auto/${name}/SKILL.md`,
    useCount: 5,
    successCount: 5,
  };
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "auto-evolve-matcher-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("matchSkills", () => {
  it("matches by exact substring in trigger patterns", async () => {
    await writeSkillIndex(tmpDir, [
      makeEntry("deploy-nextjs", ["deploy to vercel", "部署 Next.js"]),
    ]);

    const results = await matchSkills({
      userMessage: "帮我 deploy to vercel",
      managedSkillsDir: tmpDir,
      config: makeConfig(),
    });

    expect(results).toHaveLength(1);
    expect(results[0].skillName).toBe("deploy-nextjs");
    expect(results[0].score).toBeGreaterThan(0.5);
  });

  it("excludes skills matching negative patterns", async () => {
    await writeSkillIndex(tmpDir, [
      makeEntry("deploy-nextjs", ["deploy", "部署"], ["删除数据库"]),
    ]);

    const results = await matchSkills({
      userMessage: "删除数据库然后deploy",
      managedSkillsDir: tmpDir,
      config: makeConfig(),
    });

    expect(results).toHaveLength(0);
  });

  it("returns empty when matching is disabled", async () => {
    await writeSkillIndex(tmpDir, [makeEntry("deploy", ["deploy"])]);

    const results = await matchSkills({
      userMessage: "deploy",
      managedSkillsDir: tmpDir,
      config: makeConfig({ matching: { ...DEFAULT_AUTO_EVOLVE_CONFIG.matching, enabled: false } }),
    });

    expect(results).toHaveLength(0);
  });

  it("skips archived skills", async () => {
    await writeSkillIndex(tmpDir, [
      {
        ...makeEntry("old-skill", ["deploy"]),
        confidence: "archived",
      },
    ]);

    const results = await matchSkills({
      userMessage: "deploy",
      managedSkillsDir: tmpDir,
      config: makeConfig(),
    });

    expect(results).toHaveLength(0);
  });

  it("returns top N results sorted by score", async () => {
    await writeSkillIndex(tmpDir, [
      makeEntry("generic", ["build"]),
      makeEntry("specific", ["build and deploy nextjs app"]),
    ]);

    const results = await matchSkills({
      userMessage: "build and deploy nextjs app",
      managedSkillsDir: tmpDir,
      config: makeConfig(),
      maxResults: 2,
    });

    expect(results.length).toBeGreaterThanOrEqual(1);
    // The more specific match should score higher
    if (results.length >= 2) {
      expect(results[0].score).toBeGreaterThanOrEqual(results[1].score);
    }
  });

  it("matches Chinese trigger patterns", async () => {
    await writeSkillIndex(tmpDir, [
      makeEntry("fix-eslint", ["修复 eslint 配置", "eslint 报错"]),
    ]);

    const results = await matchSkills({
      userMessage: "我的 eslint 报错了帮我修一下",
      managedSkillsDir: tmpDir,
      config: makeConfig(),
    });

    expect(results).toHaveLength(1);
    expect(results[0].skillName).toBe("fix-eslint");
  });
});
