import { describe, expect, test } from "bun:test";
import {
  confidence,
  decisionsRequest,
  distillState,
  ranked,
  suggestionBlock,
} from "../plugins/jev-router/jev";

describe("ranked", () => {
  test("sorts best first", () => {
    const r = ranked({ probabilities: { a: 0.2, b: 0.7, c: 0.1 } });
    expect(r[0]).toEqual(["b", 0.7]);
    expect(r).toHaveLength(3);
  });
});

describe("confidence", () => {
  test("top minus mean of rest", () => {
    expect(confidence({ a: 0.7, b: 0.2, c: 0.1 })).toBeCloseTo(0.55);
  });
  test("single option", () => {
    expect(confidence({ a: 0.9 })).toBeCloseTo(0.9);
  });
});

describe("distillState", () => {
  test("extracts last user request and tails context", () => {
    const s = distillState(
      [
        { role: "user", text: "fix the login bug" },
        { role: "assistant", text: "reading auth.ts" },
        { role: "user", text: "also check oauth" },
      ],
      4000,
    );
    expect(s.request).toBe("also check oauth");
    expect(s.recent_context).toContain("fix the login bug");
  });
  test("respects maxChars", () => {
    const s = distillState(
      [{ role: "assistant", text: "x".repeat(10000) }],
      100,
    );
    expect(s.recent_context.length).toBeLessThanOrEqual(100);
  });
});

describe("decisionsRequest", () => {
  test("typesafe default", () => {
    expect(decisionsRequest({ apiKey: "k" })).toEqual({
      url: "https://api.typesafe.ai/v1/systemone",
      model: "jev-latest",
    });
  });
  test("openrouter default pins jev-1.13", () => {
    expect(decisionsRequest({ apiKey: "k", provider: "openrouter" })).toEqual({
      url: "https://openrouter.ai/api/alpha/decisions",
      model: "typesafe/jev-1.13",
    });
  });
  test("openrouter alias model passes through", () => {
    const r = decisionsRequest({
      apiKey: "k",
      provider: "openrouter",
      model: "~typesafe/jev-latest",
    });
    expect(r.url).toBe("https://openrouter.ai/api/alpha/decisions");
    expect(r.model).toBe("~typesafe/jev-latest");
  });
});

describe("suggestionBlock", () => {
  test("names winner, keeps ignore-out", () => {
    const b = suggestionBlock(["pptx-author"]);
    expect(b).toContain("pptx-author");
    expect(b).toContain("Ignore this");
  });
  test("empty says nothing relevant", () => {
    expect(suggestionBlock([])).toContain("No skill");
  });
});
