import { AdbDeviceTransportUnavailableError } from "../../src/utils/android-cmdline-tools/AdbDeviceTransportUnavailableError";
import { McpError } from "../../src/daemon/mcpError";
import { AndroidAvdIdentityUnresolvedError } from "../../src/devices/deviceBootService";
import { ActionableError } from "../../src/models/ActionableError";
import { SessionReleasedDuringCallError } from "../../src/daemon/sessionReleasedDuringCall";
import { mcpRequestFailureDetails } from "../../src/daemon/socketServer";
import { TextIndeterminateError } from "../../src/features/action/TextIndeterminateError";
import { SessionRecoveryAssignmentError } from "../../src/models/SessionRecoveryAssignmentError";
import { BootCapacityExhaustedError } from "../../src/models/BootCapacityExhaustedError";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { DaemonDisconnectError } from "../../src/daemon/DaemonDisconnectError";
import { McpTimeoutError } from "../../src/daemon/wire/McpTimeoutError";
import { SessionHeldByRecoveryError, SessionSuspectError } from "../../src/daemon/sessionManager";
import { isTypedToolRefusal, shapeToolCallError } from "../../src/daemon/shapeToolCallError";
import {
  DeviceAssignedToBindingError,
  BindingDiscoveryIncompleteError,
  BindingOwnershipUnconfirmedError,
  BindingOwnershipLostError,
} from "../../src/daemon/sessionBroker/provisioning/refusal";
import { errorMessage } from "../../src/utils/describeUnknownError";
import { logger } from "../../src/utils/logger";
import { RunnerReadinessError } from "../../src/ctrlProxy/RunnerReadinessService";
import { typedRefusalFields } from "../../src/models/typedRefusalFields";

import { DEFAULT_DEVICE_ACQUISITION_RETRY_AFTER_MS } from "../../src/models/deviceAcquisitionRefusals";

const context = { toolName: "observe", source: "MCP" } as const;

describe("shapeToolCallError", () => {
  let errorSpy: ReturnType<typeof spyOn<typeof logger, "error">>;

  beforeEach(() => {
    errorSpy = spyOn(logger, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  test("transport refusal exposes retry and dispatch fields on both boundaries", () => {
    const error = new AdbDeviceTransportUnavailableError(
      "emulator-5554",
      new Error("adb: device 'emulator-5554' not found"),
    );
    for (const source of ["MCP", "ProxyServer"] as const) {
      expect(isTypedToolRefusal(error)).toBe(true);
      expect(JSON.parse(shapeToolCallError(error, { ...context, source }).content[0].text)).toEqual(
        { success: false, error: error.message, ...error.toPayload() },
      );
    }
  });

  test('post-dispatch transport loss exposes dispatched: "unknown" on both boundaries', () => {
    const error = new AdbDeviceTransportUnavailableError(
      "emulator-5554",
      new Error("connection terminated: read failed"),
      1000,
      "unknown",
    );
    for (const source of ["MCP", "ProxyServer"] as const) {
      const result = shapeToolCallError(error, { toolName: "openLink", source });
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0].text)).toEqual({
        success: false,
        error: error.message,
        code: "device_transport_unavailable",
        retryable: true,
        retryAfterMs: 1000,
        deviceId: "emulator-5554",
        dispatched: "unknown",
      });
    }
  });

  test("an unrelated structurally coded actionable error stays plain text", () => {
    const error = Object.assign(new ActionableError("x"), { code: "some_code", retryable: true });
    expect(shapeToolCallError(error, context).content[0].text).toBe("Error: x");
    expect(isTypedToolRefusal(error)).toBe(false);
  });

  test("an actionable timeout exposes only its code and retryable fields", () => {
    const error = Object.assign(new ActionableError("x"), {
      code: "timeout",
      retryable: true,
      nextAction: "retry",
      details: { extra: true },
    });
    expect(isTypedToolRefusal(error)).toBe(true);
    expect(JSON.parse(shapeToolCallError(error, context).content[0].text)).toEqual({
      success: false,
      error: "x",
      code: "timeout",
      retryable: true,
    });
  });

  test("a recovery-held session is a typed retryable refusal on every tool boundary", () => {
    const error = new SessionHeldByRecoveryError("session", "device");
    expect(isTypedToolRefusal(error)).toBe(true);
    for (const source of ["MCP", "ProxyServer"] as const) {
      const result = shapeToolCallError(error, { ...context, source });
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0].text)).toEqual({
        success: false,
        error: error.message,
        code: "session_held_by_recovery",
        sessionUuid: "session",
        deviceId: "device",
        retryable: true,
        retryAfterMs: DEFAULT_DEVICE_ACQUISITION_RETRY_AFTER_MS,
      });
    }
  });

  test("the binding payload allowlist preserves each refusal on both tool boundaries", () => {
    const refusals = [
      new DeviceAssignedToBindingError("tapOn", "device", {
        platform: "android",
        stableDeviceId: "device",
        holder: "session_broker",
        scopeKey: "scope",
        bindingIndex: 0,
      }),
      new BindingDiscoveryIncompleteError("registry busy"),
      new BindingOwnershipUnconfirmedError("session"),
    ];
    for (const error of refusals) {
      expect(isTypedToolRefusal(error)).toBe(true);
      for (const source of ["MCP", "ProxyServer"] as const) {
        expect(
          JSON.parse(shapeToolCallError(error, { ...context, source }).content[0].text),
        ).toEqual({
          success: false,
          error: error.message,
          ...error.toPayload(),
        });
      }
    }
  });

  test("known ownership loss at the gate equals the terminal release on every wire", () => {
    const gate = new BindingOwnershipLostError("session");
    const released = new SessionReleasedDuringCallError("session", "binding-ownership-lost");
    for (const source of ["MCP", "ProxyServer"] as const) {
      const payload = (error: Error) => {
        const { message, ...fields } = JSON.parse(
          shapeToolCallError(error, { ...context, source }).content[0].text,
        ).error;
        expect(message).toBe(error.message);
        return fields;
      };
      expect(payload(gate)).toEqual(payload(released));
      expect(payload(gate)).toMatchObject({
        code: "session_ownership_lost",
        retryable: false,
        nextAction: "acquire_new_session",
        sessionUuid: "session",
        reason: "binding-ownership-lost",
      });
      expect(payload(gate)).not.toHaveProperty("idle");
    }
    expect(mcpRequestFailureDetails(gate, undefined)).toEqual(
      mcpRequestFailureDetails(released, undefined),
    );
    expect(gate.message).toBe(
      "Session session is terminal after binding-ownership-lost and cannot be reused. Acquire a new device with getAndroid or getApple.",
    );
    expect(gate.name).toBe("BindingOwnershipLostError");
  });

  test("runner-connect deadline is a typed retryable timeout on every tool boundary", () => {
    const error = new RunnerReadinessError(
      "runner connect timed out",
      false,
      true,
      "runner-connect",
    );
    expect(typedRefusalFields(error)).toEqual({ code: "timeout", retryable: true });
    for (const source of ["MCP", "ProxyServer"] as const) {
      expect(JSON.parse(shapeToolCallError(error, { ...context, source }).content[0].text)).toEqual(
        {
          success: false,
          error: error.message,
          code: "timeout",
          retryable: true,
        },
      );
    }
  });

  test("terminal runner readiness stays an untyped error", () => {
    const error = new RunnerReadinessError("platform fault", false, false, "runner-setup");
    expect(typedRefusalFields(error)).toBeUndefined();
    expect(shapeToolCallError(error, context).content[0].text).toBe("Error: platform fault");
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

  // #11181: a boot that waited out its budget for capacity is typed and retryable.
  test("serializes boot capacity exhaustion as a typed retryable failure", () => {
    const error = new BootCapacityExhaustedError(
      { platform: "android", limit: 2, booted: 2, retryAfterMs: 5_000 },
      "Timed out waiting for emulator capacity",
    );
    const result = shapeToolCallError(error, context);
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text)).toEqual({
      success: false,
      error: "Timed out waiting for emulator capacity",
      code: "capacity_exhausted",
      retryable: true,
      retryAfterMs: 5_000,
      limit: 2,
      booted: 2,
      platform: "android",
    });
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

  test("shapes an unresolved AVD identity with one candidate", () => {
    const error = new AndroidAvdIdentityUnresolvedError("Pixel_8_API_35", ["emulator-5556"]);
    expect(error.message).toBe(
      "target_identity_unresolved: Cannot prove whether Android AVD 'Pixel_8_API_35' is already running; AVD name is unavailable for emulator-5556. Retry after identity discovery recovers.",
    );
    expect(isTypedToolRefusal(error)).toBe(true);
    expect(JSON.parse(shapeToolCallError(error, context).content[0].text)).toEqual({
      success: false,
      error: error.message,
      code: "target_identity_unresolved",
      retryable: true,
      retryAfterMs: 1000,
      deviceId: "emulator-5556",
      avdName: "Pixel_8_API_35",
      candidateSerials: ["emulator-5556"],
    });
  });

  test("shapes an unresolved AVD identity without selecting multiple candidates", () => {
    const error = new AndroidAvdIdentityUnresolvedError("Pixel_8_API_35", [
      "emulator-5554",
      "emulator-5556",
    ]);
    expect(isTypedToolRefusal(error)).toBe(true);
    const payload = JSON.parse(shapeToolCallError(error, context).content[0].text);
    expect(payload).toEqual({
      success: false,
      error: error.message,
      code: "target_identity_unresolved",
      retryable: true,
      retryAfterMs: 1000,
      avdName: "Pixel_8_API_35",
      candidateSerials: ["emulator-5554", "emulator-5556"],
    });
    expect(payload).not.toHaveProperty("deviceId");
  });

  test("keeps a plain ActionableError untyped", () => {
    const error = new ActionableError("x");
    expect(isTypedToolRefusal(error)).toBe(false);
    expect(shapeToolCallError(error, context).content[0].text).toBe("Error: x");
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

test("a suspect-session refusal keeps its wire code so a proxy can tell it is restorable (#10053)", () => {
  const error = new SessionSuspectError("session-a", 8_000);
  const shaped = shapeToolCallError(error, context);
  expect(JSON.parse(shaped.content[0].text)).toEqual({
    error: {
      code: "daemon_session_suspect",
      message: error.message,
      sessionUuid: "session-a",
      remainingMs: 8_000,
      retryable: true,
    },
  });
  expect(shaped.isError).toBe(true);
  // An unrelated error that merely carries a code stays prose.
  const other = Object.assign(new Error("boom"), { code: "something_else" });
  expect(shapeToolCallError(other, context).content[0].text).toBe("Error: boom");
});

test("a suspect-session refusal tells an agent to retry now, not to heartbeat or wait it out", () => {
  const { message } = new SessionSuspectError("session-a", 8_000);
  expect(message).toBe(
    "Session session-a missed a liveness heartbeat and is being restored; its device stays " +
      "reserved for 8s. Retry this call now, without waiting. If the retry says the session was " +
      "released, acquire a device again with getAndroid or getApple.",
  );
  expect(message).not.toMatch(/heartbeats from the owner|after the window/i);
});
