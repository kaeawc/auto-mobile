import { z } from "zod/v4";
import { describe, expect, test } from "bun:test";
import {
  DEVICE_CONTROL_TRANSPORT_FAILURE_CODE,
  isReplaySafeToolName,
  sanitizeDeviceControlTransportFailure,
} from "../../src/daemon/deviceControlTransportFailure";
import { ToolRegistry, ToolRegistryClass } from "../../src/server/toolRegistry";

/**
 * The daemon stopped producing `device_control_transport_failure` when forwards moved in process
 * (#11820). What stays is what the proxy and the daemon client still read from an older daemon:
 * the replay-safe tool set and the wire sanitizer.
 */
describe("device-control transport failure wire type", () => {
  test("replay safety comes from the registered recovery capability and clears with the registry", () => {
    const handler = async () => ({ content: [] });
    ToolRegistry.register("safeProbe", "read-only probe", z.object({}), {
      handler,
      transportRecovery: "replay",
    });
    ToolRegistry.register("unsafeProbe", "changes state", z.object({}), handler);
    try {
      expect(isReplaySafeToolName("safeProbe")).toBe(true);
      expect(isReplaySafeToolName("unsafeProbe")).toBe(false);
      expect(isReplaySafeToolName(undefined)).toBe(false);
    } finally {
      ToolRegistry.clearTools();
    }
    expect(isReplaySafeToolName("safeProbe")).toBe(false);
  });

  test("clearing another registry preserves the singleton's observe replay permission", () => {
    const handler = async () => ({ content: [] });
    const otherRegistry = new ToolRegistryClass();
    ToolRegistry.registerDeviceAware("observe", "Read device state", z.object({}), {
      handler,
      transportRecovery: "replay",
    });
    try {
      otherRegistry.registerDeviceAware("observe", "Other device state", z.object({}), handler);
      otherRegistry.clearTools();
      expect(isReplaySafeToolName("observe")).toBe(true);
    } finally {
      ToolRegistry.clearTools();
    }
  });

  test("an older daemon's failure frame still sanitizes to the typed wire shape", () => {
    const failure = {
      code: DEVICE_CONTROL_TRANSPORT_FAILURE_CODE,
      transport: "daemon_loopback_http",
      toolName: "observe",
      deviceId: "emulator-5554",
      sessionValid: true,
      deviceSessionValid: true,
      phase: "response",
      retryable: true,
      reconnectAttempted: true,
      replayAttempted: false,
      extra: "dropped",
    };

    expect(sanitizeDeviceControlTransportFailure(failure)).toEqual({
      code: DEVICE_CONTROL_TRANSPORT_FAILURE_CODE,
      transport: "daemon_loopback_http",
      toolName: "observe",
      deviceId: "emulator-5554",
      sessionValid: true,
      deviceSessionValid: true,
      phase: "response",
      retryable: true,
      reconnectAttempted: true,
      replayAttempted: false,
    });
    expect(sanitizeDeviceControlTransportFailure({ ...failure, phase: "other" })).toBeUndefined();
    expect(sanitizeDeviceControlTransportFailure("not a failure")).toBeUndefined();
  });
});
