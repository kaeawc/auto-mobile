import { describe, expect, test } from "bun:test";
import type { DeviceSessionManager } from "../../src/devices/DeviceSessionManager";
import type { BootedDevice } from "../../src/models";
import { ActionableError } from "../../src/models/ActionableError";

/** The readiness surface the contract exercises. */
export type ReadinessSurface = Pick<
  DeviceSessionManager,
  | "getCurrentDevice"
  | "getCurrentPlatform"
  | "setCurrentDevice"
  | "getExplicitDevicePin"
  | "setExplicitDevicePin"
  | "clearExplicitDevicePin"
  | "ensureDeviceReady"
  | "detectConnectedPlatformsWithStatus"
  | "verifyDevice"
>;

/** The scenario driver each implementation supplies. */
export interface ScriptedReadiness {
  readiness: ReadinessSurface;
  /** Exactly these devices are booted and reachable; Android through adb, iOS through simctl. */
  connect(devices: BootedDevice[]): void;
}

const android = (id: string): BootedDevice => ({ name: id, deviceId: id, platform: "android" });
const ios = (id: string): BootedDevice => ({ name: id, deviceId: id, platform: "ios" });

/**
 * Shared behavioural contract for DeviceSessionManager's selection surface (#11868): the real
 * DeviceReadiness (adb/simctl/CtrlProxy seams faked) and FakeDeviceSessionManager agree on which
 * device a call resolves, what a read vs a control call remembers, how the explicit pin ranks
 * against the current device, and what an unknown target does.
 */
export function runDeviceSessionManagerContract(name: string, make: () => ScriptedReadiness): void {
  const ready = { readiness: "booted" as const, skipCtrlProxyDownload: true };

  describe(`DeviceSessionManager contract: ${name}`, () => {
    test("a platform call resolves the only device of that platform and remembers it", async () => {
      const { readiness, connect } = make();
      connect([android("emulator-5554")]);
      const device = await readiness.ensureDeviceReady("android", undefined, ready);
      expect(device.deviceId).toBe("emulator-5554");
      expect(readiness.getCurrentDevice()?.deviceId).toBe("emulator-5554");
      expect(readiness.getCurrentPlatform()).toBe("android");
    });

    test("a read call resolves the device without remembering it", async () => {
      const { readiness, connect } = make();
      connect([android("emulator-5554")]);
      const device = await readiness.ensureDeviceReady("android", undefined, {
        ...ready,
        intent: "read",
      });
      expect(device.deviceId).toBe("emulator-5554");
      expect(readiness.getCurrentDevice()).toBeUndefined();
    });

    test("a provided deviceId selects that device among several", async () => {
      const { readiness, connect } = make();
      connect([android("emulator-5554"), android("emulator-5556")]);
      const device = await readiness.ensureDeviceReady("android", "emulator-5556", ready);
      expect(device.deviceId).toBe("emulator-5556");
      expect(readiness.getCurrentDevice()?.deviceId).toBe("emulator-5556");
    });

    test("an unknown deviceId is an ActionableError and remembers nothing", async () => {
      const { readiness, connect } = make();
      connect([android("emulator-5554")]);
      await expect(
        readiness.ensureDeviceReady("android", "emulator-9999", ready),
      ).rejects.toBeInstanceOf(ActionableError);
      expect(readiness.getCurrentDevice()).toBeUndefined();
    });

    test("an either call with both platforms connected and nothing selected asks for a target", async () => {
      const { readiness, connect } = make();
      connect([android("emulator-5554"), ios("SIM-1")]);
      await expect(readiness.ensureDeviceReady("either", undefined, ready)).rejects.toBeInstanceOf(
        ActionableError,
      );
    });

    test("an either call resolves the single connected platform", async () => {
      const { readiness, connect } = make();
      connect([ios("SIM-1")]);
      const device = await readiness.ensureDeviceReady("either", undefined, ready);
      expect(device.platform).toBe("ios");
    });

    test("the explicit pin outranks the current device on the same platform", async () => {
      const { readiness, connect } = make();
      const first = android("emulator-5554");
      const pinned = android("emulator-5556");
      connect([first, pinned]);
      readiness.setCurrentDevice(first, "android");
      readiness.setExplicitDevicePin(pinned);
      const device = await readiness.ensureDeviceReady("android", undefined, ready);
      expect(device.deviceId).toBe("emulator-5556");
    });

    test("the current device is reused when it is still connected", async () => {
      const { readiness, connect } = make();
      const first = android("emulator-5554");
      connect([android("emulator-5556"), first]);
      readiness.setCurrentDevice(first, "android");
      const device = await readiness.ensureDeviceReady("android", undefined, ready);
      expect(device.deviceId).toBe("emulator-5554");
    });

    test("clearing a pin for another device leaves the pin; clearing its own drops it", () => {
      const { readiness } = make();
      const pinned = android("emulator-5554");
      readiness.setExplicitDevicePin(pinned);
      readiness.clearExplicitDevicePin("emulator-5556");
      expect(readiness.getExplicitDevicePin()?.deviceId).toBe("emulator-5554");
      readiness.clearExplicitDevicePin("emulator-5554");
      expect(readiness.getExplicitDevicePin()).toBeUndefined();
    });

    test("a pinned device that is no longer connected is not returned", async () => {
      const { readiness, connect } = make();
      connect([android("emulator-5556")]);
      readiness.setExplicitDevicePin(android("emulator-5554"));
      const device = await readiness.ensureDeviceReady("android", undefined, ready);
      expect(device.deviceId).toBe("emulator-5556");
    });

    test("a current device that is no longer connected is replaced by a connected one", async () => {
      const { readiness, connect } = make();
      connect([android("emulator-5556")]);
      readiness.setCurrentDevice(android("emulator-5554"), "android");
      const device = await readiness.ensureDeviceReady("android", undefined, ready);
      expect(device.deviceId).toBe("emulator-5556");
      expect(readiness.getCurrentDevice()?.deviceId).toBe("emulator-5556");
    });

    test("a deviceId from the other platform is not found", async () => {
      const { readiness, connect } = make();
      connect([android("emulator-5554"), ios("SIM-1")]);
      await expect(readiness.ensureDeviceReady("android", "SIM-1", ready)).rejects.toBeInstanceOf(
        ActionableError,
      );
    });

    test("a platform with no connected device is an ActionableError", async () => {
      const { readiness, connect } = make();
      connect([android("emulator-5554")]);
      await expect(readiness.ensureDeviceReady("ios", undefined, ready)).rejects.toBeInstanceOf(
        ActionableError,
      );
    });

    test("an either call follows the current device's platform when both are connected", async () => {
      const { readiness, connect } = make();
      const simulator = ios("SIM-1");
      connect([android("emulator-5554"), simulator]);
      readiness.setCurrentDevice(simulator, "ios");
      const device = await readiness.ensureDeviceReady("either", undefined, ready);
      expect(device.deviceId).toBe("SIM-1");
    });

    test("a read call with nothing running is an ActionableError", async () => {
      const { readiness, connect } = make();
      connect([]);
      await expect(
        readiness.ensureDeviceReady("android", undefined, { ...ready, intent: "read" }),
      ).rejects.toBeInstanceOf(ActionableError);
    });

    test("setCurrentDevice records the device and its platform", () => {
      const { readiness } = make();
      readiness.setCurrentDevice(ios("SIM-1"), "ios");
      expect(readiness.getCurrentDevice()?.deviceId).toBe("SIM-1");
      expect(readiness.getCurrentPlatform()).toBe("ios");
    });

    test("a scan lists every connected device and marks both platforms scanned", async () => {
      const { readiness, connect } = make();
      connect([android("emulator-5554"), ios("SIM-1")]);
      const scan = await readiness.detectConnectedPlatformsWithStatus();
      expect(scan.devices.map((device) => device.deviceId).sort()).toEqual([
        "SIM-1",
        "emulator-5554",
      ]);
      expect(scan.scanned).toEqual({ android: true, ios: true });
    });

    test("verifying a device that is not connected rejects", async () => {
      const { readiness, connect } = make();
      connect([android("emulator-5554")]);
      await expect(readiness.verifyDevice("emulator-9999", "android", ready)).rejects.toThrow();
    });
  });
}
