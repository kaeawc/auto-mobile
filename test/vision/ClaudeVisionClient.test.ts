import { describe, expect, test } from "bun:test";
import { ClaudeVisionClient } from "../../src/vision/ClaudeVisionClient";

const makeClient = () => new ClaudeVisionClient("test-key-not-used");

const callCalculateCost = (
  client: ClaudeVisionClient,
  inputTokens: number,
  outputTokens: number
): number => (client as any).calculateCost(inputTokens, outputTokens);

const makeResponse = (text: string) =>
  ({ content: [{ type: "text", text }] } as any);

const callParse = (client: ClaudeVisionClient, response: unknown) =>
  (client as any).parseClaudeResponse(response);

describe("ClaudeVisionClient.parseClaudeResponse", () => {
  test("throws a controlled error when JSON inside a code block is malformed", () => {
    const client = makeClient();
    const response = makeResponse("```json\n{ \"elementFound\": tr,\n```");

    expect(() => callParse(client, response)).toThrow(
      /Failed to parse JSON from Claude response/
    );
  });

  test("throws a controlled error when JSON outside a code block is malformed", () => {
    const client = makeClient();
    const response = makeResponse("here is a result: { not valid json at all }");

    expect(() => callParse(client, response)).toThrow(
      /Failed to parse JSON from Claude response/
    );
  });

  test("throws when no JSON match is present in the response", () => {
    const client = makeClient();
    const response = makeResponse("Claude returned only prose, no JSON here.");

    expect(() => callParse(client, response)).toThrow(
      /Failed to parse JSON from Claude response/
    );
  });

  test("parses well-formed JSON inside a fenced code block", () => {
    const client = makeClient();
    const response = makeResponse(
      "```json\n{\"elementFound\": true, \"confidence\": 0.95, \"reasoning\": \"ok\"}\n```"
    );

    const parsed = callParse(client, response);

    expect(parsed.elementFound).toBe(true);
    expect(parsed.confidence).toBe(0.95);
    expect(parsed.reasoning).toBe("ok");
  });
});

describe("ClaudeVisionClient.calculateCost", () => {
  // Sonnet pricing: $3 / Mtok input, $15 / Mtok output.
  test("prices input and output tokens at $3 and $15 per million", () => {
    const client = makeClient();
    // 1M input = $3, 1M output = $15 → $18 total.
    expect(callCalculateCost(client, 1_000_000, 1_000_000)).toBeCloseTo(18.0, 6);
  });

  test("is zero for zero tokens and scales linearly", () => {
    const client = makeClient();
    expect(callCalculateCost(client, 0, 0)).toBe(0);
    // 500k input ($1.50) + 100k output ($1.50) = $3.00.
    expect(callCalculateCost(client, 500_000, 100_000)).toBeCloseTo(3.0, 6);
  });
});
