import { describe, expect, test } from "bun:test";
import { classifyToolResult } from "../../src/utils/toolEnvelopePayload";
import { FakeLogger } from "../fakes/FakeLogger";

describe("tool result classification", () => {
  for (const text of ["not json", '{"success":tr', "null", "true"]) {
    test(`rejects uninterpretable text ${text} without logging its body`, () => {
      const logger = new FakeLogger();
      const result = classifyToolResult(
        { content: [{ type: "text", text }] },
        "syntheticTool",
        logger,
      );
      expect(result).toEqual({
        kind: "uninterpretable",
        failure: { success: false, error: 'Tool "syntheticTool" result could not be interpreted' },
      });
      expect(logger.at("warn")).toHaveLength(1);
      const warning = logger.at("warn")[0];
      expect(warning.message).toBe('Tool "syntheticTool" result could not be interpreted');
      expect(warning.args).toEqual(
        text === "null" || text === "true" ? [{}] : [{ parseError: "SyntaxError" }],
      );
    });
  }

  test("uses structured payload before malformed text without warning", () => {
    const logger = new FakeLogger();
    const payload = { updatedAt: 0 };
    const result = classifyToolResult(
      { structuredContent: payload, content: [{ type: "text", text: "not json" }] },
      "observe",
      logger,
    );
    expect(result).toEqual({ kind: "payload", payload });
    expect(logger.messages).toEqual([]);
  });

  test("preserves direct failures and structured errors by identity", () => {
    const payload = { success: false, error: { code: "failed", message: "original failure" } };
    expect(classifyToolResult(payload, "syntheticTool", new FakeLogger())).toEqual({
      kind: "payload",
      payload,
    });
    const result = classifyToolResult(
      { isError: true, structuredContent: payload },
      "syntheticTool",
      new FakeLogger(),
    );
    expect(result.kind === "payload" && result.payload).toBe(payload);
  });

  test("isError overrides a success flag and retains the original message", () => {
    expect(
      classifyToolResult(
        { isError: true, structuredContent: { success: true, error: "original failure" } },
        "syntheticTool",
        new FakeLogger(),
      ),
    ).toEqual({
      kind: "payload",
      payload: { success: true, error: "original failure" },
      failure: { success: false, error: "original failure" },
    });
  });

  for (const response of [
    undefined,
    null,
    { content: [] },
    { content: [{ type: "text" }] },
    { content: [{ type: "unknown" }] },
    { structuredContent: "invalid" },
  ]) {
    test(`rejects unrecognised shape ${JSON.stringify(response)}`, () => {
      const logger = new FakeLogger();
      expect(classifyToolResult(response, "syntheticTool", logger).kind).toBe("uninterpretable");
      expect(logger.at("warn")).toHaveLength(1);
    });
  }

  for (const response of [
    { content: [{ type: "image", data: "synthetic", mimeType: "image/png" }] },
    { message: "direct legacy result" },
  ]) {
    test(`recognises unstructured shape ${JSON.stringify(response)}`, () => {
      const logger = new FakeLogger();
      expect(classifyToolResult(response, "syntheticTool", logger).kind).toBe("no-payload");
      expect(logger.messages).toEqual([]);
    });
  }
});
