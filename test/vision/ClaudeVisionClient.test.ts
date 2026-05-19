import { describe, expect, test } from "bun:test";
import { ClaudeVisionClient } from "../../src/vision/ClaudeVisionClient";

const makeClient = () => new ClaudeVisionClient("test-key-not-used");

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
