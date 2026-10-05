import { describe, expect, test } from "bun:test";
import {
  applyThresholds,
  hash01,
  loadTasks,
  simulateClarify,
  simulateFailures,
  simulatePermissions,
  simulateReviews,
  simulateSkill,
  simulateStop,
  simulateTools,
  scoreTool,
  sweep,
} from "./eval-harness";
import {
  applyToolThresholds,
  choiceMargin,
  failureSignature,
  passesConfidence,
  resolveReviewType,
} from "../plugins/jev-router/jev";

describe("eval harness", () => {
  test("loads 16 skill + 6 permission + 4 stop tasks", () => {
    const t = loadTasks();
    expect(t.skillTasks).toHaveLength(16);
    expect(t.permissionTasks).toHaveLength(6);
    expect(t.stopTasks).toHaveLength(4);
  });

  test("mock is deterministic", () => {
    const t = loadTasks();
    const a = t.skillTasks.map(simulateSkill);
    const b = t.skillTasks.map(simulateSkill);
    expect(a).toEqual(b);
    expect(hash01("S01")).toBeGreaterThanOrEqual(0);
    expect(hash01("S01")).toBeLessThan(1);
  });

  test("gate blocks, fits blocks, suggest flows", () => {
    const sim = {
      id: "X", expected: "pdf-fill", gateMean: 0.7, fitsMax: 0.8,
      winnerIfSuggested: "pdf-fill", winnerCorrectIfSuggested: true,
      wideTokens: 1200, narrowTokens: 1800,
    };
    expect(applyThresholds(sim, 0.8, 0.3).outcome).toBe("miss"); // gate blocks
    expect(applyThresholds(sim, 0.3, 0.9).outcome).toBe("miss"); // fits blocks
    expect(applyThresholds(sim, 0.3, 0.3).outcome).toBe("correct");
    expect(applyThresholds(sim, 0.8, 0.3).jevCalls).toBe(1); // wide only when gated
    expect(applyThresholds(sim, 0.3, 0.3).jevCalls).toBe(2);
  });

  test("uncovered + low gate threshold => needless load", () => {
    const sim = {
      id: "U", expected: null, gateMean: 0.18, fitsMax: 0.22,
      winnerIfSuggested: "doc-search", winnerCorrectIfSuggested: false,
      wideTokens: 1200, narrowTokens: 1800,
    };
    expect(applyThresholds(sim, 0.1, 0.1).outcome).toBe("needless");
    expect(applyThresholds(sim, 0.3, 0.3).outcome).toBe("ok-quiet");
  });

  test("sweep grid is 25 cells and default cell is sane", () => {
    const t = loadTasks();
    const sims = t.skillTasks.map(simulateSkill);
    const cells = sweep(sims, [0.1, 0.2, 0.3, 0.4, 0.5], [0.1, 0.2, 0.3, 0.4, 0.5]);
    expect(cells).toHaveLength(25);
    const def = cells.find((c) => c.gateT === 0.3 && c.fitsT === 0.3)!;
    // 5 covered correct (S05 baked wrong) + 2 lookalike correct = 7
    expect(def.correct).toBe(7);
    expect(def.needless).toBe(0); // gate 0.3 blocks all uncovered mocks
    expect(def.net).toBeGreaterThan(def.jevCost * 10); // savings dominate
  });

  test("permission mock has one false-allow (P04)", () => {
    const t = loadTasks();
    const perms = simulatePermissions(t.permissionTasks);
    expect(perms.filter((p) => p.correct)).toHaveLength(5);
    expect(perms.find((p) => p.id === "P04")?.correct).toBe(false);
  });

  test("stop mock catches both incomplete cases", () => {
    const t = loadTasks();
    const stops = simulateStop(t.stopTasks);
    expect(stops.filter((s) => s.correct)).toHaveLength(4);
    expect(stops.filter((s) => s.kind === "true-catch")).toHaveLength(2);
  });

  test("guardrail: margin and confidence", () => {
    expect(choiceMargin({ probabilities: { a: 0.8, b: 0.15, c: 0.05 } })).toBeCloseTo(0.65);
    expect(choiceMargin({})).toBe(0);
    expect(passesConfidence({ choice: "x", probabilities: { x: 0.9, y: 0.1 }, confidence: 0.9 }, 0.7)).toBe(true);
    expect(passesConfidence({ choice: "x", probabilities: { x: 0.45, y: 0.4 }, confidence: 0.45 }, 0.7)).toBe(false);
    expect(passesConfidence(null, 0.7)).toBe(false);
    expect(passesConfidence({ probabilities: { x: 0.9 } }, 0.7)).toBe(false); // no choice
  });

  test("failureSignature is stable under key order", () => {
    expect(failureSignature("shell", { b: 1, a: 2 })).toBe(failureSignature("shell", { a: 2, b: 1 }));
    expect(failureSignature("shell", { a: 1 })).not.toBe(failureSignature("read", { a: 1 }));
  });

  test("applyToolThresholds: gate, redundancy, fits", () => {
    expect(applyToolThresholds(0.1, 0, 0.9, "read", 0.3, 0.3).action).toBe("nothing");
    expect(applyToolThresholds(0.8, 0.9, 0.9, "read", 0.3, 0.3).action).toBe("suppress-redundant");
    expect(applyToolThresholds(0.8, 0.1, 0.2, "read", 0.3, 0.3).action).toBe("nothing");
    expect(applyToolThresholds(0.8, 0.1, 0.9, "read", 0.3, 0.3)).toEqual({ action: "suggest", winner: "read" });
  });

  test("resolveReviewType downgrades fresh on single-model roster", () => {
    expect(resolveReviewType("fresh", 1)).toBe("adversarial");
    expect(resolveReviewType("fresh", 2)).toBe("fresh");
    expect(resolveReviewType("routine", 1)).toBe("routine");
    expect(resolveReviewType("bogus", 5)).toBe("nothing");
    expect(resolveReviewType(null, 5)).toBe("nothing");
  });

  test("new buckets load and mock-score", () => {
    const t = loadTasks() as any;
    expect(t.toolTasks).toHaveLength(6);
    expect(t.clarifyTasks).toHaveLength(4);
    expect(t.failureTasks).toHaveLength(4);
    expect(t.reviewTasks).toHaveLength(6);
    const tools = simulateTools(t.toolTasks);
    const outcomes = tools.map((s) => scoreTool(s, 0.3, 0.3));
    expect(outcomes.filter((o) => o === "correct")).toHaveLength(3); // C02, C03, C04 redirects
    expect(outcomes).toContain("redundant-caught"); // C05
    expect(simulateClarify(t.clarifyTasks).every((c) => c.correct)).toBe(true);
    expect(simulateFailures(t.failureTasks).every((f) => f.correct)).toBe(true);
    expect(simulateReviews(t.reviewTasks).every((r) => r.correct)).toBe(true);
  });
});
