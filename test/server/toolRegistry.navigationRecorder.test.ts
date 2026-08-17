import { describe, expect, test } from "bun:test";
import { stripNavigationInternalParams } from "../../src/server/toolRegistry";
import { INTERNAL_NO_DIFF_PARAM } from "../../src/server/internalToolCall";

describe("navigation tool call recording", () => {
  test("does not persist internal execution metadata in navigation arguments", () => {
    expect(stripNavigationInternalParams({
      text: "Continue",
      __mcpSessionId: "mcp-session",
      __executionId: "execution-1",
      __executionStartTime: 123,
      [INTERNAL_NO_DIFF_PARAM]: true,
    })).toEqual({ text: "Continue" });
  });
});
