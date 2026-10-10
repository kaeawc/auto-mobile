import { describe, expect, test } from "bun:test";
import { mcpRequestFailureDetails } from "../../../src/daemon/socketServer";
import { InputDeviceOwnedError } from "../../../src/daemon/inputDeviceOwnership";
import { DeviceOutsideBoundSessionError } from "../../../src/server/deviceOutsideBoundSessionRefusal";
import { DeviceOutsideManagedSlotsError } from "../../../src/daemon/managedSlots/managedSlotRefusal";
import { shapeToolCallError } from "../../../src/server/shapeToolCallError";

/** The typed fields the MCP result carries for the same refusal. */
function mcpFields(error: Error): Record<string, unknown> {
  const result = shapeToolCallError(error, { toolName: "tapOn", source: "MCP" });
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

describe("a socket failure frame keeps the typed fields the MCP result carries", () => {
  test("device_owned_by_other_session frame says it is not retryable", () => {
    const error = new InputDeviceOwnedError("input/tap", "emulator-5554", "session-b");
    // The MCP result says retryable false (refusal-wire fixture: device_owned_by_other_session).
    expect(mcpFields(error).retryable).toBe(false);
    // The input/* failure frame carries only the bare code: a retry loop reading `retryable`
    // finds nothing to branch on.
    expect(mcpRequestFailureDetails(error, undefined).retryable).toBe(false);
  });

  test("device_owned_by_other_session frame names the held device", () => {
    const error = new InputDeviceOwnedError("input/tap", "emulator-5554", "session-b");
    expect(mcpFields(error).deviceId).toBe("emulator-5554");
    expect(JSON.stringify(mcpRequestFailureDetails(error, undefined))).toContain("emulator-5554");
  });

  test("device_outside_bound_session frame names the bound session and device", () => {
    const error = new DeviceOutsideBoundSessionError(
      "session-a",
      { deviceId: "emulator-5554", platform: "android" },
      { deviceId: "emulator-5556" },
    );
    expect(mcpFields(error).boundSessionUuid).toBe("session-a");
    const frame = JSON.stringify(mcpRequestFailureDetails(error, undefined));
    expect(frame).toContain("session-a");
    expect(frame).toContain("emulator-5554");
  });

  test("device_outside_managed_slots frame names the refused target", () => {
    const error = new DeviceOutsideManagedSlotsError("tapOn", "device", "scope-1", {
      deviceId: "emulator-5556",
    });
    expect(mcpFields(error).deviceId).toBe("emulator-5556");
    expect(JSON.stringify(mcpRequestFailureDetails(error, undefined))).toContain("emulator-5556");
  });
});
