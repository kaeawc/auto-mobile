import { describe, expect, test } from "bun:test";
import {
  internalExecutionId,
  internalExecutionStartTime,
  internalMcpSessionId,
} from "../../src/server/internalToolParams";

describe("internal call identity readers", () => {
  const args = { __executionId: "exec-1", __executionStartTime: 42, __mcpSessionId: "mcp-1" };

  test("read the in-band keys a handler's args carry", () => {
    expect(internalExecutionId(args)).toBe("exec-1");
    expect(internalExecutionStartTime(args)).toBe(42);
    expect(internalMcpSessionId(args)).toBe("mcp-1");
  });

  test("an absent key reads as absent", () => {
    expect(internalExecutionId({})).toBeUndefined();
    expect(internalExecutionStartTime({})).toBeUndefined();
    expect(internalMcpSessionId({})).toBeUndefined();
  });

  test("a value of the wrong type reads as absent", () => {
    const wrong = { __executionId: 7, __executionStartTime: "42", __mcpSessionId: null };
    expect(internalExecutionId(wrong)).toBeUndefined();
    expect(internalExecutionStartTime(wrong)).toBeUndefined();
    expect(internalMcpSessionId(wrong)).toBeUndefined();
  });

  test("a blank connection identity is still a string, as the stages read it today", () => {
    expect(internalMcpSessionId({ __mcpSessionId: "" })).toBe("");
  });
});
