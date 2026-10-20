import { describe, expect, test } from "bun:test";
import { MCP_SESSION_KEY_HEADER, readMcpSessionKey } from "../../src/daemon/mcpSessionKey";

describe("readMcpSessionKey", () => {
  test("reads the header value", () => {
    expect(readMcpSessionKey({ [MCP_SESSION_KEY_HEADER]: "abc" })).toBe("abc");
  });
  test("takes the first value of a repeated header", () => {
    expect(readMcpSessionKey({ [MCP_SESSION_KEY_HEADER]: ["one", "two"] })).toBe("one");
  });
  test("treats a missing or empty header as absent", () => {
    expect(readMcpSessionKey({})).toBeUndefined();
    expect(readMcpSessionKey({ [MCP_SESSION_KEY_HEADER]: "" })).toBeUndefined();
  });
});
