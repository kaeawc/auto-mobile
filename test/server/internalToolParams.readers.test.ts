import { describe, expect, test } from "bun:test";
import {
  adoptRestartResumeTargets,
  internalExecutionId,
  internalExecutionStartTime,
  internalMcpSessionId,
  internalOneShotCli,
  internalRestartResumeSessionUuid,
  internalRestartResumeTargets,
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

describe("start-device handoff readers", () => {
  test("one-shot CLI is only an exact true", () => {
    expect(internalOneShotCli({ __oneShotCli: true })).toBe(true);
    expect(internalOneShotCli({ __oneShotCli: "true" })).toBe(false);
    expect(internalOneShotCli({})).toBe(false);
  });

  test("restart-resume fields read through with their declared types", () => {
    const targets = [{ sessionId: "s1" }] as const;
    const args = { __restartResumeTargets: targets, __restartResumeSessionUuid: "s1" };
    expect(internalRestartResumeTargets(args)).toBe(targets);
    expect(internalRestartResumeSessionUuid(args)).toBe("s1");
    expect(internalRestartResumeTargets({})).toBeUndefined();
    expect(internalRestartResumeSessionUuid({})).toBeUndefined();
  });

  test("adopting restart-resume targets never replaces ones the start already carries", () => {
    const carried: { __restartResumeTargets?: string[] } = { __restartResumeTargets: ["mine"] };
    adoptRestartResumeTargets(carried, ["other"]);
    expect(carried.__restartResumeTargets).toEqual(["mine"]);
    const empty: { __restartResumeTargets?: string[] } = {};
    adoptRestartResumeTargets(empty, ["other"]);
    expect(empty.__restartResumeTargets).toEqual(["other"]);
  });
});
