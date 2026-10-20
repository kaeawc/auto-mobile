import { describe, expect, test } from "bun:test";
import { ProtocolError, SdkError, SdkErrorCode } from "@modelcontextprotocol/server";
import { ErrorCode, McpError, withV1ClientErrors } from "../../src/daemon/mcpError";

// Issue #4678: script clients (mcp-drive, manual-test proxy-session) report SDK v2 client
// failures in the v1 shape, so a timeout keeps its numeric code and prefixed message.

describe("withV1ClientErrors", () => {
  test("a v2 request timeout becomes the v1 -32001 McpError", async () => {
    const call = Promise.reject(
      new SdkError(SdkErrorCode.RequestTimeout, "Request timed out", { timeout: 10 }),
    );

    const error = await withV1ClientErrors(call).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(McpError);
    expect(error).toMatchObject({
      code: ErrorCode.RequestTimeout,
      message: "MCP error -32001: Request timed out",
      data: { timeout: 10 },
    });
  });

  test("a server protocol error regains the v1 client prefix", async () => {
    const error = await withV1ClientErrors(
      Promise.reject(new ProtocolError(-32603, "MCP error -32603: boom")),
    ).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: -32603,
      message: "MCP error -32603: MCP error -32603: boom",
    });
  });

  test("a successful call and an unrelated error pass through unchanged", async () => {
    const unrelated = new Error("spawn failed");

    expect(await withV1ClientErrors(Promise.resolve(42))).toBe(42);
    expect(await withV1ClientErrors(Promise.reject(unrelated)).catch((e: unknown) => e)).toBe(
      unrelated,
    );
  });
});
