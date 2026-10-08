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

test("an invalid-params McpError (malformed resource URI) keeps -32602 as the response code", () => {
  const error = new McpError(
    -32602,
    "Malformed resource URI: a path segment is not valid percent-encoding.",
  );
  expect(mcpRequestFailureDetails(error, undefined)).toEqual({ code: -32602 });
  expect(mcpRequestFailureDetails(new McpError(-32603, "boom"), undefined)).toEqual({});
});

test("the same prose without the marker gets no code (older server, or an unregistered name)", () => {
  expect(mcpRequestFailureDetails(new McpError(-32603, GATE_TEXT), undefined)).toEqual({});
  expect(mcpRequestFailureDetails(new Error(GATE_TEXT), undefined)).toEqual({});
});
