import { describe, expect, test } from "bun:test";
import type { DeviceReadiness } from "../../src/daemon/readiness/DeviceReadiness";
import type { BootedDevice } from "../../src/models";
import { ActionableError } from "../../src/models/ActionableError";

/** The readiness surface the contract exercises. */
export type ReadinessSurface = Pick<
  DeviceReadiness,
  | "getExplicitDevicePin"
  | "setExplicitDevicePin"
  | "clearExplicitDevicePin"
  | "clearConnectionDevicePin"
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
 * Shared behavioural contract for DeviceReadiness's selection surface (#11868): the real
 * DeviceReadiness (adb/simctl/CtrlProxy seams faked) and FakeDeviceReadiness agree on which
 * device a call resolves, that readiness never pins, how connection pins rank against
 * explicit targets, and what an unknown target does.
 */
export function runDeviceReadinessContract(name: string, make: () => ScriptedReadiness): void {
  const ready = { readiness: "booted" as const, skipCtrlProxyDownload: true };

  describe(`DeviceReadiness contract: ${name}`, () => {
    test("a platform call resolves the only device without pinning it", async () => {
      const { readiness, connect } = make();
      connect([android("emulator-5554")]);
      const device = await readiness.ensureDeviceReady("android", undefined, ready);
      expect(device.deviceId).toBe("emulator-5554");
      expect(readiness.getExplicitDevicePin()).toBeUndefined();
    });

    test("a read call resolves the device without remembering it", async () => {
      const { readiness, connect } = make();
      connect([android("emulator-5554")]);
      const device = await readiness.ensureDeviceReady("android", undefined, {
        ...ready,
        intent: "read",
      });
      expect(device.deviceId).toBe("emulator-5554");
      expect(readiness.getExplicitDevicePin()).toBeUndefined();
    });

    test("a provided deviceId selects that device among several", async () => {
      const { readiness, connect } = make();
      connect([android("emulator-5554"), android("emulator-5556")]);
      const device = await readiness.ensureDeviceReady("android", "emulator-5556", ready);
      expect(device.deviceId).toBe("emulator-5556");
      expect(readiness.getExplicitDevicePin()).toBeUndefined();
    });

    test("an unknown deviceId is an ActionableError and remembers nothing", async () => {
      const { readiness, connect } = make();
      connect([android("emulator-5554")]);
      await expect(
        readiness.ensureDeviceReady("android", "emulator-9999", ready),
      ).rejects.toBeInstanceOf(ActionableError);
      expect(readiness.getExplicitDevicePin()).toBeUndefined();
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

    test("an explicit pin outranks a previously readied device on the same platform", async () => {
      const { readiness, connect } = make();
      const first = android("emulator-5554");
      const pinned = android("emulator-5556");
      connect([first, pinned]);
      await readiness.ensureDeviceReady("android", first.deviceId, ready);
      readiness.setExplicitDevicePin(pinned);
      const device = await readiness.ensureDeviceReady("android", undefined, ready);
      expect(device.deviceId).toBe("emulator-5556");
    });

    test("a previously readied device does not resolve same-platform ambiguity", async () => {
      const { readiness, connect } = make();
      const first = android("emulator-5554");
      connect([android("emulator-5556"), first]);
      await readiness.ensureDeviceReady("android", first.deviceId, ready);
      await expect(readiness.ensureDeviceReady("android", undefined, ready)).rejects.toBeInstanceOf(
        ActionableError,
      );
      expect(readiness.getExplicitDevicePin()).toBeUndefined();
    });

    test("explicit selection is scoped to the calling connection", async () => {
      const { readiness, connect } = make();
      const simulator = ios("SIM-1");
      connect([android("emulator-5554"), simulator]);
      readiness.setExplicitDevicePin(simulator, "conn-a");
      await expect(
        readiness.ensureDeviceReady("either", undefined, { ...ready, connectionId: "conn-b" }),
      ).rejects.toBeInstanceOf(ActionableError);
      const device = await readiness.ensureDeviceReady("either", undefined, {
        ...ready,
        connectionId: "conn-a",
      });
      expect(device.deviceId).toBe(simulator.deviceId);
      readiness.setExplicitDevicePin(simulator, "conn-b");
      readiness.clearConnectionDevicePin("conn-b");
      expect(readiness.getExplicitDevicePin("conn-a")).toEqual(simulator);
      readiness.clearConnectionDevicePin("conn-a");
      expect(readiness.getExplicitDevicePin("conn-a")).toBeUndefined();
    });

    test("device-wide clearing drops every matching connection pin", () => {
      const { readiness } = make();
      const pinned = android("emulator-5554");
      const other = ios("SIM-1");
      readiness.setExplicitDevicePin(pinned, "conn-a");
      readiness.setExplicitDevicePin(pinned, "conn-b");
      readiness.setExplicitDevicePin(other, "conn-c");
      readiness.clearExplicitDevicePin(pinned.deviceId);
      expect(readiness.getExplicitDevicePin("conn-a")).toBeUndefined();
      expect(readiness.getExplicitDevicePin("conn-b")).toBeUndefined();
      expect(readiness.getExplicitDevicePin("conn-c")).toEqual(other);
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
      readiness.setExplicitDevicePin(android("emulator-5554"));
      const device = await readiness.ensureDeviceReady("android", undefined, ready);
      expect(device.deviceId).toBe("emulator-5556");
      expect(readiness.getExplicitDevicePin()).toBeUndefined();
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
      readiness.setExplicitDevicePin(simulator);
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

    test("an explicit pin records the device and its platform", () => {
      const { readiness } = make();
      readiness.setExplicitDevicePin(ios("SIM-1"));
      expect(readiness.getExplicitDevicePin()?.deviceId).toBe("SIM-1");
      expect(readiness.getExplicitDevicePin()?.platform).toBe("ios");
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
