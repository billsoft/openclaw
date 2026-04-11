import { describe, expect, it } from "vitest";
import {
  parseTaskSignal,
  stripTaskSignal,
  detectTaskCompletion,
  detectUserDissatisfaction,
} from "./task-completion-detector.js";
import { DEFAULT_AUTO_EVOLVE_CONFIG, type AutoEvolveConfig } from "./types.js";

function makeConfig(overrides?: Partial<AutoEvolveConfig>): AutoEvolveConfig {
  return { ...DEFAULT_AUTO_EVOLVE_CONFIG, enabled: true, ...overrides };
}

describe("parseTaskSignal", () => {
  it("parses a valid completed signal", () => {
    const text = 'Done! <task_signal status="completed" confidence="high" summary="Deployed Next.js app to Vercel"/>';
    const result = parseTaskSignal(text);
    expect(result).toEqual({
      status: "completed",
      confidence: "high",
      summary: "Deployed Next.js app to Vercel",
    });
  });

  it("parses an unsatisfied signal", () => {
    const text = '<task_signal status="unsatisfied" confidence="medium" summary="Wrong approach used"/>';
    const result = parseTaskSignal(text);
    expect(result).toEqual({
      status: "unsatisfied",
      confidence: "medium",
      summary: "Wrong approach used",
    });
  });

  it("returns null for text without a signal", () => {
    expect(parseTaskSignal("Just a normal reply.")).toBeNull();
  });

  it("returns null for malformed confidence", () => {
    const text = '<task_signal status="completed" confidence="super_high" summary="test"/>';
    expect(parseTaskSignal(text)).toBeNull();
  });

  it("handles empty summary", () => {
    const text = '<task_signal status="completed" confidence="high" summary=""/>';
    const result = parseTaskSignal(text);
    expect(result?.summary).toBe("");
  });
});

describe("stripTaskSignal", () => {
  it("removes the signal tag from text", () => {
    const text = 'Done! <task_signal status="completed" confidence="high" summary="test"/>';
    expect(stripTaskSignal(text)).toBe("Done!");
  });

  it("returns original text if no signal", () => {
    const text = "No signal here.";
    expect(stripTaskSignal(text)).toBe("No signal here.");
  });
});

describe("detectTaskCompletion", () => {
  it("detects a high-confidence completion", () => {
    const config = makeConfig({ detection: { inlineSignal: true, minConfidence: "medium" } });
    const text = 'All done! <task_signal status="completed" confidence="high" summary="Fixed ESLint config"/>';
    const result = detectTaskCompletion(text, 10, config);
    expect(result.detected).toBe(true);
    expect(result.confidence).toBe("high");
    expect(result.taskSummary).toBe("Fixed ESLint config");
    expect(result.turnRange).toEqual([0, 10]);
  });

  it("rejects medium confidence when minConfidence is high", () => {
    const config = makeConfig({ detection: { inlineSignal: true, minConfidence: "high" } });
    const text = '<task_signal status="completed" confidence="medium" summary="test"/>';
    const result = detectTaskCompletion(text, 5, config);
    expect(result.detected).toBe(false);
  });

  it("returns no signal when disabled", () => {
    const config = makeConfig({ enabled: false });
    const text = '<task_signal status="completed" confidence="high" summary="test"/>';
    const result = detectTaskCompletion(text, 5, config);
    expect(result.detected).toBe(false);
  });

  it("returns no signal when inlineSignal is off", () => {
    const config = makeConfig({ detection: { inlineSignal: false, minConfidence: "medium" } });
    const text = '<task_signal status="completed" confidence="high" summary="test"/>';
    const result = detectTaskCompletion(text, 5, config);
    expect(result.detected).toBe(false);
  });
});

describe("detectUserDissatisfaction", () => {
  it("detects dissatisfaction signal", () => {
    const text = '<task_signal status="unsatisfied" confidence="high" summary="Wrong skill applied"/>';
    const result = detectUserDissatisfaction(text);
    expect(result).not.toBeNull();
    expect(result?.status).toBe("unsatisfied");
    expect(result?.summary).toBe("Wrong skill applied");
  });

  it("returns null for completed signal", () => {
    const text = '<task_signal status="completed" confidence="high" summary="test"/>';
    expect(detectUserDissatisfaction(text)).toBeNull();
  });
});
