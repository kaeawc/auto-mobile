import { describe, expect, test } from "bun:test";
import {
  calculateClaudeCost,
  parseClaudeResponse,
  toClaudeVisionFallbackResult,
} from "../../src/vision/ClaudeVisionClient";
import type { ClaudeVisionAnalysis } from "../../src/vision/VisionTypes";

const makeResponse = (text: string) => ({ content: [{ type: "text", text }] }) as any;

const analysis = (overrides: Partial<ClaudeVisionAnalysis> = {}): ClaudeVisionAnalysis => ({
  elementFound: true,
  navigationRequired: false,
  visualDescription: "Login screen",
  similarElements: [],
  confidence: 0.9,
  reasoning: "visible",
  ...overrides,
});

describe("parseClaudeResponse", () => {
  test.each([
    "{}",
    '{"elementFound":false,"confidence":0,"reasoning":"","steps":null,"similarElements":null}',
  ])("preserves falsey defaults from %s", (text) => {
    expect(parseClaudeResponse(makeResponse(text))).toEqual({
      elementFound: false,
      elementLocation: undefined,
      suggestedText: undefined,
      suggestedResourceId: undefined,
      navigationRequired: false,
      steps: undefined,
      visualDescription: "",
      similarElements: [],
      confidence: 0,
      reasoning: "",
    });
  });

  test("preserves all populated fields from an inline response", () => {
    const expected = {
      elementFound: true,
      elementLocation: { x: 1, y: 2 },
      suggestedText: "OK",
      suggestedResourceId: "id",
      navigationRequired: true,
      steps: [],
      visualDescription: "screen",
      similarElements: [],
      confidence: 0.8,
      reasoning: "visible",
    };
    expect(parseClaudeResponse(makeResponse(JSON.stringify(expected)))).toEqual(expected);
  });

  test.each([
    ["a malformed fenced JSON response", '```json\n{ "elementFound": tr,\n```'],
    ["a malformed inline JSON response", "here is a result: { not valid json at all }"],
    ["a prose-only response", "Claude returned only prose, no JSON here."],
  ])("throws a controlled error for %s", (_name, responseText) => {
    expect(() => parseClaudeResponse(makeResponse(responseText))).toThrow(
      /Failed to parse JSON from Claude response/,
    );
  });

  test("returns analysis fields from a well-formed fenced response", () => {
    const parsed = parseClaudeResponse(
      makeResponse('```json\n{"elementFound": true, "confidence": 0.95, "reasoning": "ok"}\n```'),
    );

    expect(parsed).toMatchObject({ elementFound: true, confidence: 0.95, reasoning: "ok" });
  });
});

describe("calculateClaudeCost", () => {
  test("prices input and output tokens at $3 and $15 per million", () => {
    expect(calculateClaudeCost(1_000_000, 1_000_000)).toBeCloseTo(18, 6);
    expect(calculateClaudeCost(500_000, 100_000)).toBeCloseTo(3, 6);
    expect(calculateClaudeCost(0, 0)).toBe(0);
  });
});

describe("toClaudeVisionFallbackResult", () => {
  test.each([
    [0.9, "high"],
    [0.7, "medium"],
    [0.699, "low"],
  ] as const)("uses %p as the %s confidence boundary", (confidence, expectedConfidence) => {
    const result = toClaudeVisionFallbackResult(analysis({ confidence }), 0.01, 12, "/screen.png");

    expect(result.confidence).toBe(expectedConfidence);
  });

  test("defaults an unknown navigation action to tap while preserving its target", () => {
    const result = toClaudeVisionFallbackResult(
      analysis({
        steps: [{ action: "open details", target: "Settings", reasoning: "next screen" }],
      }),
      0.01,
      12,
      "/screen.png",
    );

    expect(result.navigationSteps).toEqual([
      { action: "tap", target: "Settings", description: "next screen" },
    ]);
  });
});
