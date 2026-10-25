import { describe, expect, test } from "bun:test";
import { mcpRequestFailureDetails as reExported } from "../../src/daemon/socketServer";
import {
  isSessionRefusal,
  mcpRequestFailureDetails,
  requestFailureCause,
} from "../../src/daemon/socketServer/errorFrames";
import {
  McpTimeoutError,
  MCP_QUEUE_TIMEOUT_ERROR_CODE,
} from "../../src/daemon/wire/McpTimeoutError";

/** #11815 slice 1: the failure-frame functions live in their own module, free of server state. */
describe("socket server error frames", () => {
  test("the server still re-exports the frame builder for its existing importers", () => {
    expect(reExported).toBe(mcpRequestFailureDetails);
  });

  test("a queue timeout is a retryable frame with its code", () => {
    const error = new McpTimeoutError({
      toolName: "input/tap",
      timeoutMs: 10,
      origin: "test",
      code: MCP_QUEUE_TIMEOUT_ERROR_CODE,
    });
    const frame = mcpRequestFailureDetails(error, requestFailureCause(error));
    expect(frame.code).toBe(MCP_QUEUE_TIMEOUT_ERROR_CODE);
    expect(frame.retryable).toBe(true);
    expect(frame.requestFailureCause?.name).toBe("McpTimeoutError");
  });

  test("an ordinary error carries no refusal fields and is not a session refusal", () => {
    const error = new Error("boom");
    expect(mcpRequestFailureDetails(error, undefined)).toEqual({});
    expect(isSessionRefusal(error)).toBe(false);
  });
});
