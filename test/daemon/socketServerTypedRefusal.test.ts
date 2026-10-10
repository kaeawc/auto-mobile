import { expect, test } from "bun:test";
import { daemonResponseError } from "../../src/daemon/client";
import { mcpRequestFailureDetails } from "../../src/daemon/socketServer";
import type { DaemonResponse } from "../../src/daemon/types";
import { InputDeviceOwnedError } from "../../src/daemon/inputDeviceOwnership";
import { DeviceOutsideManagedSlotsError } from "../../src/daemon/managedSlots/managedSlotRefusal";
import {
  SessionRecoveryIdentityLossError,
  SessionSuspectError,
  TerminalSessionError,
} from "../../src/daemon/sessionManager";
import { DeviceOutsideBoundSessionError } from "../../src/server/deviceOutsideBoundSessionRefusal";
import { sessionOwnershipLostPayload } from "../../src/server/deviceSessionResult";
import { shapeToolCallError } from "../../src/server/shapeToolCallError";
import { BootCapacityExhaustedError } from "../../src/models/BootCapacityExhaustedError";
import { BootedDeviceDiscoveryIncompleteError } from "../../src/models/BootedDeviceDiscoveryIncompleteError";

// #11244: an ide/* device lookup throws the retryable discovery_incomplete refusal, but the
// socket serializer kept codes only for a few known classes, so desktop clients got a bare string.

test("a discovery_incomplete refusal keeps its code and retry intent on the socket wire", () => {
  const error = new BootedDeviceDiscoveryIncompleteError("ios", {
    code: "failed",
    message: "simctl list timed out",
    retryable: true,
  });

  expect(mcpRequestFailureDetails(error, undefined)).toEqual({
    code: "discovery_incomplete",
    retryable: true,
  });
});

test("a capacity refusal carries its wait hint and details", () => {
  const error = new BootCapacityExhaustedError(
    { platform: "ios", limit: 2, booted: 2, retryAfterMs: 5_000 },
    "Refused to boot",
  );

  expect(mcpRequestFailureDetails(error, undefined)).toMatchObject({
    code: "capacity_exhausted",
    retryable: true,
    retryAfterMs: 5_000,
    details: { limit: 2, booted: 2, platform: "ios" },
  });
});

test("an untyped error with only a system code stays untyped", () => {
  const error = Object.assign(new Error("no such file"), { code: "ENOENT" });
  expect(mcpRequestFailureDetails(error, undefined)).toEqual({});
});

test("the daemon client keeps the refusal's retry intent on the error it throws", () => {
  const response: DaemonResponse = {
    id: "1",
    type: "mcp_response",
    success: false,
    error: "Refused to boot",
    code: "capacity_exhausted",
    retryable: true,
    retryAfterMs: 5_000,
    details: { limit: 2 },
  };

  expect(daemonResponseError(response)).toMatchObject({
    code: "capacity_exhausted",
    retryable: true,
    retryAfterMs: 5_000,
    details: { limit: 2 },
  });
});

// #11391: a refusal keeps the code, retry intent and evidence of its MCP result on a socket
// failure frame; the frame carried only the bare code for the self-describing refusals.

/** The typed fields the MCP result carries for the same refusal. */
function mcpFields(error: Error): Record<string, unknown> {
  const result = shapeToolCallError(error, { toolName: "tapOn", source: "MCP" });
  const payload: Record<string, unknown> = JSON.parse(result.content[0].text);
  // Everything after `success` and the message.
  return Object.fromEntries(
    Object.entries(payload).filter(([key]) => key !== "success" && key !== "error"),
  );
}

/** A failure frame's typed fields flattened back to the MCP result's layout. */
function frameFields(error: Error): Record<string, unknown> {
  const { details, ...typed } = mcpRequestFailureDetails(error, undefined);
  return { ...typed, ...details };
}

test("device_owned_by_other_session keeps retryable false and the held device on the frame", () => {
  const error = new InputDeviceOwnedError("input/tap", "emulator-5554", "session-b");

  expect(mcpRequestFailureDetails(error, undefined)).toEqual({
    code: "device_owned_by_other_session",
    retryable: false,
    details: { deviceId: "emulator-5554" },
  });
  expect(frameFields(error)).toEqual(mcpFields(error));
});

test("device_outside_bound_session names the bound session and device on the frame", () => {
  const error = new DeviceOutsideBoundSessionError(
    "session-a",
    { deviceId: "emulator-5554", platform: "android" },
    { deviceId: "emulator-5556" },
  );

  expect(mcpRequestFailureDetails(error, undefined)).toEqual({
    code: "device_outside_bound_session",
    retryable: false,
    details: {
      boundSessionUuid: "session-a",
      boundDeviceId: "emulator-5554",
      deviceId: "emulator-5556",
    },
  });
  expect(frameFields(error)).toEqual(mcpFields(error));
});

test("device_outside_managed_slots names the refused target on the frame", () => {
  const error = new DeviceOutsideManagedSlotsError("tapOn", "device", "scope-1", {
    deviceId: "emulator-5556",
  });

  expect(mcpRequestFailureDetails(error, undefined)).toEqual({
    code: "device_outside_managed_slots",
    retryable: false,
    details: { action: "tapOn", reason: "device", scopeKey: "scope-1", deviceId: "emulator-5556" },
  });
  expect(frameFields(error)).toEqual(mcpFields(error));
});

test("a session lost to recovery identity loss is the terminal refusal on the frame", () => {
  const error = new SessionRecoveryIdentityLossError(
    "dead-session",
    { platform: "android", stableDeviceId: "stable-1", deviceId: "emulator-5554" },
    "owned-by-other-daemon",
    { deviceId: "emulator-5554", ownerPid: 4242 },
  );

  expect(mcpRequestFailureDetails(error, undefined)).toEqual({
    code: "session_ownership_lost",
    retryable: false,
    nextAction: "acquire_new_session",
    details: {
      sessionUuid: "dead-session",
      reason: "identity-recovery-owned-by-other-daemon",
      recoveryReason: "owned-by-other-daemon",
      deviceId: "emulator-5554",
      ownerPid: 4242,
    },
  });
});

// #11417: a control call refused at session admission on the socket (direct `input/*`) answers the
// refusal the MCP result carries for the same error.

test("a suspect-session refusal is the retryable suspect refusal on the frame", () => {
  const error = new SessionSuspectError("quiet-session", 2_500);
  const result = shapeToolCallError(error, { toolName: "tapOn", source: "MCP" });
  const mcp: { error: Record<string, unknown> } = JSON.parse(result.content[0].text);

  expect(mcpRequestFailureDetails(error, undefined)).toEqual({
    code: "daemon_session_suspect",
    retryable: true,
    details: { sessionUuid: "quiet-session", remainingMs: 2_500 },
  });
  // The MCP error is the same fields plus the message, which the frame carries as `error`.
  expect({ ...frameFields(error), message: error.message }).toEqual(mcp.error);
});

test("a terminal-session refusal is session_ownership_lost on the frame", () => {
  const error = new TerminalSessionError("gone-session", {
    sessionId: "gone-session",
    deviceId: "emulator-5554",
    releaseReason: "heartbeat-timeout",
    releasedAtMs: 8_001,
    terminal: true,
    heartbeat: { lastHeartbeatMs: 0, hasReceivedHeartbeat: true, timeoutMs: 4_000, ageMs: 8_001 },
  });
  // The envelope the MCP server answers a TerminalSessionError with.
  const mcp = sessionOwnershipLostPayload({
    message: error.message,
    sessionUuid: error.sessionUuid,
    reason: error.release.releaseReason,
    release: error.release,
  }).error;

  expect(mcpRequestFailureDetails(error, undefined)).toEqual({
    code: "session_ownership_lost",
    retryable: false,
    nextAction: "acquire_new_session",
    details: { sessionUuid: "gone-session", reason: "heartbeat-timeout" },
  });
  expect(frameFields(error)).toMatchObject({
    code: mcp.code,
    retryable: mcp.retryable,
    nextAction: mcp.nextAction,
    sessionUuid: mcp.sessionUuid,
    reason: mcp.reason,
  });
});
