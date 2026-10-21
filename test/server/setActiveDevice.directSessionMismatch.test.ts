import { afterEach, expect, test } from "bun:test";
import { DEVICE_OUTSIDE_BOUND_SESSION_CODE } from "../../src/daemon/DeviceOutsideBoundSessionError";
import { createSetActiveDeviceHandler } from "../../src/server/setActiveDevice";
import {
  clearDirectSessionDevices,
  registerDirectSessionDevice,
  resolveDirectSessionDevice,
} from "../../src/utils/directSessionDeviceRegistry";
import { FakeDeviceReadiness } from "../fakes/FakeDeviceReadiness";

afterEach(clearDirectSessionDevices);

test.each([false, true])(
  "registered direct session refuses another device before side effects (matching=%s)",
  async (matching) => {
    const deviceA = { name: "Pixel A", deviceId: "emulator-5554", platform: "android" } as const;
    const deviceB = { name: "Pixel B", deviceId: "emulator-5556", platform: "android" } as const;
    registerDirectSessionDevice("direct-session", deviceA);
    const original = resolveDirectSessionDevice("direct-session");
    const readiness = new FakeDeviceReadiness();
    readiness.setConnectedDevices([deviceA, deviceB]);
    const resumed: string[] = [];
    const select = createSetActiveDeviceHandler({
      legacyDeviceSelection: () => readiness,
      resumeCtrlProxy: async (id) => {
        resumed.push(id);
      },
    });
    const requested = matching ? deviceA : deviceB;
    const result = select({
      sessionUuid: "direct-session",
      deviceId: requested.deviceId,
      platform: requested.platform,
    });
    if (matching) {
      await result;
      expect(readiness.getEnsureDeviceReadyCallCount()).toBe(1);
      expect(resumed).toEqual([deviceA.deviceId]);
      expect(readiness.getExplicitDevicePin()).toEqual(deviceA);
      expect(resolveDirectSessionDevice("direct-session")?.device).toEqual(deviceA);
    } else {
      await expect(result).rejects.toMatchObject({
        code: DEVICE_OUTSIDE_BOUND_SESSION_CODE,
        boundSessionUuid: "direct-session",
        boundDevice: { deviceId: deviceA.deviceId, platform: deviceA.platform },
        requested: { deviceId: deviceB.deviceId, platform: deviceB.platform },
      });
      expect(readiness.getEnsureDeviceReadyCallCount()).toBe(0);
      expect(resumed).toEqual([]);
      expect(resolveDirectSessionDevice("direct-session")).toEqual(original);
      expect(readiness.getExplicitDevicePin()).toBeUndefined();
    }
  },
);
