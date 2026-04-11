import { describe, expect, it } from "vitest";
import { resolveAutoEvolveConfig } from "./config.js";
import { DEFAULT_AUTO_EVOLVE_CONFIG } from "./types.js";

describe("resolveAutoEvolveConfig", () => {
  it("returns defaults when no config", () => {
    const config = resolveAutoEvolveConfig(undefined);
    expect(config).toEqual(DEFAULT_AUTO_EVOLVE_CONFIG);
  });

  it("returns defaults when empty config", () => {
    const config = resolveAutoEvolveConfig({});
    expect(config).toEqual(DEFAULT_AUTO_EVOLVE_CONFIG);
  });

  it("enables with explicit enabled: true", () => {
    const config = resolveAutoEvolveConfig({ autoEvolve: { enabled: true } });
    expect(config.enabled).toBe(true);
  });

  it("overrides detection minConfidence", () => {
    const config = resolveAutoEvolveConfig({
      autoEvolve: {
        enabled: true,
        detection: { minConfidence: "high" },
      },
    });
    expect(config.detection.minConfidence).toBe("high");
    expect(config.detection.inlineSignal).toBe(true); // default preserved
  });

  it("overrides extraction model", () => {
    const config = resolveAutoEvolveConfig({
      autoEvolve: {
        extraction: { model: "gpt-4o-mini", minTaskTurns: 2 },
      },
    });
    expect(config.extraction.model).toBe("gpt-4o-mini");
    expect(config.extraction.minTaskTurns).toBe(2);
  });

  it("overrides matching strategy", () => {
    const config = resolveAutoEvolveConfig({
      autoEvolve: { matching: { strategy: "hybrid", minScore: 0.8 } },
    });
    expect(config.matching.strategy).toBe("hybrid");
    expect(config.matching.minScore).toBe(0.8);
  });

  it("overrides evolution thresholds", () => {
    const config = resolveAutoEvolveConfig({
      autoEvolve: { evolution: { provenThreshold: 10, archiveDays: 30 } },
    });
    expect(config.evolution.provenThreshold).toBe(10);
    expect(config.evolution.archiveDays).toBe(30);
  });

  it("ignores invalid minConfidence value", () => {
    const config = resolveAutoEvolveConfig({
      autoEvolve: { detection: { minConfidence: "invalid" } },
    });
    expect(config.detection.minConfidence).toBe("medium"); // default
  });

  it("ignores invalid strategy value", () => {
    const config = resolveAutoEvolveConfig({
      autoEvolve: { matching: { strategy: "magic" } },
    });
    expect(config.matching.strategy).toBe("keyword"); // default
  });

  it("clamps score between 0 and 1", () => {
    const config = resolveAutoEvolveConfig({
      autoEvolve: { matching: { minScore: 2.5 } },
    });
    expect(config.matching.minScore).toBe(0.6); // fallback, out of range
  });

  it("handles string booleans", () => {
    const config = resolveAutoEvolveConfig({
      autoEvolve: { enabled: "true" },
    });
    expect(config.enabled).toBe(true);
  });
});
