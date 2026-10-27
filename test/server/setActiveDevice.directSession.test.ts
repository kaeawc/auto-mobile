import { afterEach, expect, test } from "bun:test";
import { DaemonState } from "../../src/daemon/daemonState";
import { createSetActiveDeviceHandler } from "../../src/server/setActiveDevice";
import {
  clearDirectSessionDevices,
  registerDirectSessionDevice,
} from "../../src/utils/directSessionDeviceRegistry";
import { FakeDeviceReadiness } from "../fakes/FakeDeviceReadiness";

afterEach(clearDirectSessionDevices);

test.each([false, true])(
  "direct setActiveDevice validates its session before readiness (registered=%s)",
  async (registered) => {
    expect(DaemonState.getInstance().isInitialized()).toBe(false);
    const device = { name: "Pixel", deviceId: "emulator-5554", platform: "android" } as const;
    const readiness = new FakeDeviceReadiness();
    readiness.setConnectedDevices([device]);
    if (registered) {
      registerDirectSessionDevice("session", device);
    }
    const resumed: string[] = [];
    const select = createSetActiveDeviceHandler({
      legacyDeviceSelection: () => readiness,
      resumeCtrlProxy: async (id) => {
        resumed.push(id);
      },
    });
    const result = select({ deviceId: device.deviceId, sessionUuid: "session" });
    if (registered) {
      await result;
      expect(readiness.getEnsureDeviceReadyCallCount()).toBe(1);
      expect(resumed).toEqual([device.deviceId]);
    } else {
      await expect(result).rejects.toMatchObject({
        code: "direct_session_not_active",
        retryable: false,
      });
      expect(readiness.getEnsureDeviceReadyCallCount()).toBe(0);
      expect(resumed).toEqual([]);
      expect(readiness.getExplicitDevicePin()).toBeUndefined();
    }
  },
);
