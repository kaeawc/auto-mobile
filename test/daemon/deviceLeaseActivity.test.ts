import { describe, expect, test } from "bun:test";
import {
  isDeviceLeaseBusy,
  readDeviceLeaseActivity,
  type DeviceLeaseActivitySources,
} from "../../src/daemon/deviceLeaseActivity";

function sources(overrides: Partial<DeviceLeaseActivitySources> = {}): DeviceLeaseActivitySources {
  return {
    sessionForDevice: () => null,
    activeExecutionCount: () => 0,
    toolIdleForMs: () => null,
    hasStreamSubscriber: () => false,
    clientActivity: () => ({ inFlightRequests: 0, idleForMs: null }),
    ...overrides,
  };
}

describe("readDeviceLeaseActivity (#10497)", () => {
  test("takes the most recent of tool and CtrlProxy-client activity", () => {
    const activity = readDeviceLeaseActivity(
      sources({
        toolIdleForMs: () => 90_000,
        clientActivity: () => ({ inFlightRequests: 0, idleForMs: 4_000 }),
      }),
      "emulator-5600",
    );
    expect(activity.idleForMs).toBe(4_000);
    expect(isDeviceLeaseBusy(activity)).toBe(false);
    expect(readDeviceLeaseActivity(sources({ toolIdleForMs: () => 7 }), "d").idleForMs).toBe(7);
    expect(readDeviceLeaseActivity(sources(), "d").idleForMs).toBeNull();
  });

  test("a CtrlProxy request in flight makes the device busy without any tool call", () => {
    const activity = readDeviceLeaseActivity(
      sources({ clientActivity: () => ({ inFlightRequests: 1, idleForMs: 0 }) }),
      "emulator-5600",
    );
    expect(activity.inFlightRequests).toBe(1);
    expect(isDeviceLeaseBusy(activity)).toBe(true);
  });

  test("a session, tool call, or stream subscriber makes the device busy", () => {
    for (const override of [
      { sessionForDevice: () => "s-1" },
      { activeExecutionCount: () => 1 },
      { hasStreamSubscriber: () => true },
    ]) {
      expect(isDeviceLeaseBusy(readDeviceLeaseActivity(sources(override), "d"))).toBe(true);
    }
  });
});
