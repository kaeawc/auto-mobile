import { expect, spyOn, test } from "bun:test";
import { mcpRequestFailureDetails } from "../../src/daemon/socketServer";
import {
  MCP_QUEUE_TIMEOUT_ERROR_CODE,
  McpTimeoutError,
} from "../../src/daemon/wire/McpTimeoutError";
import { shapeToolCallError } from "../../src/daemon/shapeToolCallError";
import { logger } from "../../src/utils/logger";

/**
 * The queue-deadline refusal is `retryable: true` in the MCP tool result (nothing was
 * dispatched, so a retry is safe). The same error on the control socket's failure frame carries
 * the code but no `retryable`, so a client that reads the frame cannot tell it from a terminal
 * timeout. The JUnit and XCTest runners talk to the daemon socket directly: Kotlin
 * parseDaemonToolResult (line ~898) turns any `success: false` frame into a non-retryable
 * failure with no code.
 */
test("a queue-deadline failure frame says retryable like its MCP result does", () => {
  const error = new McpTimeoutError({
    toolName: "executePlan",
    timeoutMs: 5000,
    origin: "test",
    code: MCP_QUEUE_TIMEOUT_ERROR_CODE,
  });
  const logged = spyOn(logger, "error").mockImplementation(() => {});
  try {
    const result = JSON.parse(
      shapeToolCallError(error, { toolName: "executePlan", source: "MCP" }).content[0].text,
    );
    expect(result).toMatchObject({ code: "daemon_queue_timeout", retryable: true });
    const frame = mcpRequestFailureDetails(error, undefined);
    expect(frame).toMatchObject({ code: "daemon_queue_timeout", retryable: true });
  } finally {
    logged.mockRestore();
  }
});
