import { TextIndeterminateError } from "../../src/features/action/textTransportTimeout";
import { SessionRecoveryAssignmentError } from "../../src/models/SessionRecoveryAssignmentError";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { DaemonDisconnectError } from "../../src/daemon/DaemonDisconnectError";
import { McpTimeoutError } from "../../src/daemon/McpTimeoutError";
import { shapeToolCallError } from "../../src/server/shapeToolCallError";
import { errorMessage } from "../../src/utils/describeUnknownError";
import { logger } from "../../src/utils/logger";

const context = { toolName: "observe", source: "MCP" } as const;

describe("shapeToolCallError", () => {
  let errorSpy: ReturnType<typeof spyOn<typeof logger, "error">>;

  beforeEach(() => {
    errorSpy = spyOn(logger, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  test("serializes indeterminate text as a structured non-retryable failure", () => {
    const error = new TextIndeterminateError("request expired");
    const result = shapeToolCallError(error, { toolName: "sendKeys", source: "MCP" });
    expect(JSON.parse(result.content[0].text)).toEqual({
      success: false,
      error: error.message,
      retryable: false,
    });
    expect(result.isError).toBe(true);
  });

  test("serializes pending recovery with the established error vocabulary", () => {
    const error = new SessionRecoveryAssignmentError({
      sessionUuid: "session-a",
      platform: "android",
      deviceId: "emulator-5554",
      stableDeviceId: "Pixel_8_API_35",
      recoveryWindowRemainingMs: 120_000,
    });
    const result = shapeToolCallError(error, context);
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text)).toEqual({
      error: { message: error.message, ...error.details },
    });
    expect(error.details).toMatchObject({
      code: "session_recovery_pending",
      retryable: true,
      recovery: { action: "acquire_replacement_session", tools: ["getAndroid", "getApple"] },
    });
    expect(error.details).not.toHaveProperty("retry");
    expect(error.details).not.toHaveProperty("fallback");
    expect(error.message).toBe(
      "Cannot safely recover session session-a: android device 'Pixel_8_API_35' is unavailable or already in use. The session can still resume if the device returns before the recovery window ends (120 seconds remaining); otherwise acquire a new device with getAndroid or getApple.",
    );
  });

  test("shapes a plain Error", () => {
    expect(shapeToolCallError(new Error("failed"), context)).toEqual({
      content: [{ type: "text", text: "Error: failed" }],
      isError: true,
    });
  });

  for (const value of ["failed", undefined, { detail: "failed" }]) {
    test(`uses errorMessage for ${String(value)}`, () => {
      expect(shapeToolCallError(value, context)).toEqual({
        content: [{ type: "text", text: `Error: ${errorMessage(value)}` }],
        isError: true,
      });
    });
  }

  for (const code of [-32602, 32602]) {
    test(`strips the leading MCP prefix for code ${code}`, () => {
      const error = new McpError(code, "msg MCP error -32602: nested");
      expect(shapeToolCallError(error, context).content[0].text).toBe(
        "Error: msg MCP error -32602: nested",
      );
    });
  }

  test("preserves an MCP message without a matching leading prefix", () => {
    const error = new McpError(-32602, "msg");
    error.message = "before MCP error -32602: msg";
    expect(shapeToolCallError(error, context).content[0].text).toBe(
      "Error: before MCP error -32602: msg",
    );
  });

  const abort = new Error("cancelled");
  abort.name = "AbortError";
  const timeout = new Error("late");
  timeout.name = "TimeoutError";
  const causes: [string, unknown, string][] = [
    [
      "disconnect",
      new DaemonDisconnectError({ toolName: "tapOn", origin: "test" }),
      " (daemon connection closed before the response arrived while handling tapOn)",
    ],
    [
      "MCP timeout",
      new McpTimeoutError({ toolName: "swipeOn", timeoutMs: 1234, origin: "test" }),
      " (request timed out after 1234ms while handling swipeOn)",
    ],
    ["abort", abort, " (request was aborted)"],
    ["timeout", timeout, " (request timed out)"],
    ["ordinary Error", new Error("other"), ""],
    ["non-Error", { name: "AbortError" }, ""],
  ];
  for (const [label, cause, suffix] of causes) {
    test(`handles ${label} cause`, () => {
      expect(shapeToolCallError(new Error("failed", { cause }), context).content[0].text).toBe(
        `Error: failed${suffix}`,
      );
    });
    test(`strips MCP prefix before handling ${label} cause`, () => {
      const error = new McpError(-32602, "failed");
      error.cause = cause;
      expect(shapeToolCallError(error, context).content[0].text).toBe(`Error: failed${suffix}`);
    });
  }

  for (const source of ["MCP", "ProxyServer"] as const) {
    test(`logs once with ${source}, tool and shaped message`, () => {
      const cause = new Error("cancelled");
      cause.name = "AbortError";
      const error = new McpError(-32602, "failed");
      error.cause = cause;
      shapeToolCallError(error, { toolName: "tapOn", source });
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy).toHaveBeenCalledWith(
        `[${source}] Tool call failed: tapOn - failed (request was aborted)`,
      );
    });
  }
});

test("queue deadline marker survives tool error shaping; plain timeouts remain unmarked", () => {
  const error = Object.assign(new Error("timed out in queue before admission"), {
    code: "daemon_queue_timeout",
  });
  expect(JSON.parse(shapeToolCallError(error, context).content[0].text)).toEqual({
    success: false,
    error: error.message,
    code: "daemon_queue_timeout",
    retryable: true,
  });
  const started = new McpTimeoutError({ toolName: "tapOn", timeoutMs: 1000, origin: "device" });
  expect(shapeToolCallError(started, context)).toEqual({
    content: [{ type: "text", text: `Error: ${started.message}` }],
    isError: true,
  });
});
