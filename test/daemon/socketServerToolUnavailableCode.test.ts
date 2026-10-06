import { expect, test } from "bun:test";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { mcpRequestFailureDetails } from "../../src/daemon/socketServer";
import { DAEMON_TOOL_UNAVAILABLE_CODE } from "../../src/daemon/types";

// Issue #10177: the loopback transport hands the daemon an McpError whose `data`
// came from the server's ToolUnavailableError; the daemon turns it into the
// top-level response `code` that DaemonClient keeps on the thrown error.
const GATE_TEXT = "Unknown tool: setUIState. --debug is disabled; start the daemon with --debug";

test("a gated-tool McpError becomes the structured response code", () => {
  const error = new McpError(-32603, GATE_TEXT, {
    code: DAEMON_TOOL_UNAVAILABLE_CODE,
    toolName: "setUIState",
  });
  expect(mcpRequestFailureDetails(error, undefined)).toEqual({
    code: DAEMON_TOOL_UNAVAILABLE_CODE,
  });
});

test("the same prose without the marker gets no code (older server, or an unregistered name)", () => {
  expect(mcpRequestFailureDetails(new McpError(-32603, GATE_TEXT), undefined)).toEqual({});
  expect(mcpRequestFailureDetails(new Error(GATE_TEXT), undefined)).toEqual({});
});
