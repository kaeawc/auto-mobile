import { describe, expect, test } from "bun:test";
import {
  internalLiveDeadlineKey,
  internalMcpRequestDeadlineMs,
  internalMcpSessionId,
  internalOneShotCli,
  internalOptionalOneShotCli,
  internalRequesterSessionUuid,
} from "../../../src/daemon/wire/internalToolParams";

describe("shared internal tool parameter readers", () => {
  test.each([
    ["__mcpSessionId", internalMcpSessionId],
    ["__mcpLiveDeadlineKey", internalLiveDeadlineKey],
    ["__requesterSessionUuid", internalRequesterSessionUuid],
  ] as const)("%s reads strings without normalizing them", (key, read) => {
    expect(read({ [key]: "identity" })).toBe("identity");
    expect(read({ [key]: "" })).toBe("");
    expect(read({})).toBeUndefined();
    for (const value of [undefined, null, true, 42, {}, []]) {
      expect(read({ [key]: value })).toBeUndefined();
    }
  });

  test("the request deadline reads numbers without imposing arithmetic policy", () => {
    for (const value of [42, 0, -1, Infinity, NaN]) {
      expect(internalMcpRequestDeadlineMs({ __mcpRequestDeadlineMs: value })).toBe(value);
    }
    expect(internalMcpRequestDeadlineMs({})).toBeUndefined();
    for (const value of [undefined, null, true, "42", {}, []]) {
      expect(internalMcpRequestDeadlineMs({ __mcpRequestDeadlineMs: value })).toBeUndefined();
    }
  });

  test("the optional one-shot marker preserves false and absence", () => {
    for (const value of [true, false]) {
      expect(internalOptionalOneShotCli({ __oneShotCli: value })).toBe(value);
    }
    expect(internalOptionalOneShotCli({})).toBeUndefined();
    for (const value of [undefined, null, "true", 1, {}, []]) {
      expect(internalOptionalOneShotCli({ __oneShotCli: value })).toBeUndefined();
    }
  });

  test("the existing one-shot predicate stays exact-true with an absent false default", () => {
    expect(internalOneShotCli({ __oneShotCli: true })).toBe(true);
    expect(internalOneShotCli({})).toBe(false);
    for (const value of [false, undefined, null, "true", 1, {}, []]) {
      expect(internalOneShotCli({ __oneShotCli: value })).toBe(false);
    }
  });
});
