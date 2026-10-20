import { describe, expect, test } from "bun:test";
import type { PlatformDeviceManager } from "../../src/devices/deviceUtils";
import type { BootedDevice, DeviceInfo, Platform } from "../../src/models";

/**
 * The scenario driver each implementation supplies. The real MultiPlatformDeviceManager is
 * driven through stubbed emulator/simctl seams; FakeDeviceUtils through its setters. Scenarios
 * only use this surface, so both run the same assertions.
 */
export interface ScriptedDeviceManager {
  manager: PlatformDeviceManager;
  /** The device images (AVDs / simulators) the host lists for a platform. */
  setImages(platform: Platform, images: DeviceInfo[]): void;
  /** The devices currently booted on a platform. */
  setBooted(platform: Platform, devices: BootedDevice[]): void;
  /** The platform's discovery tooling exists but fails when asked to list booted devices. */
  failBootedDiscovery(platform: Platform): void;
}

export const PIXEL_IMAGE: DeviceInfo = { name: "Pixel_9", platform: "android", isRunning: false };
export const SPARE_IMAGE: DeviceInfo = {
  name: "Pixel_Spare",
  platform: "android",
  isRunning: false,
};
export const PIXEL_BOOTED: BootedDevice = {
  name: "Pixel_9",
  platform: "android",
  deviceId: "emulator-5554",
};
export const IPHONE_BOOTED: BootedDevice = {
  name: "iPhone 16",
  platform: "ios",
  deviceId: "1B2C3D4E-5F60-4718-8293-A1B2C3D4E5F6",
};
const IPHONE_IMAGE: DeviceInfo = {
  name: "iPhone 16",
  platform: "ios",
  isRunning: false,
  deviceId: IPHONE_BOOTED.deviceId,
};

/**
 * Shared behavioural contract for {@link PlatformDeviceManager} (#11868): the scripted
 * FakeDeviceUtils and the real MultiPlatformDeviceManager over stubbed emulator and simctl seams
 * agree on booted-device listing, discovery success reporting, failure isolation, presentation
 * order and the running-state overlay on image listings.
 */
export function runDeviceManagerContract(
  name: string,
  make: () => Promise<ScriptedDeviceManager> | ScriptedDeviceManager,
): void {
  describe(`PlatformDeviceManager contract: ${name}`, () => {
    test("getBootedDevices lists a platform's devices and 'either' puts Android first", async () => {
      const scripted = await make();
      scripted.setBooted("android", [PIXEL_BOOTED]);
      scripted.setBooted("ios", [IPHONE_BOOTED]);
      expect(await scripted.manager.getBootedDevices("android")).toEqual([PIXEL_BOOTED]);
      expect(await scripted.manager.getBootedDevices("ios")).toEqual([IPHONE_BOOTED]);
      expect(await scripted.manager.getBootedDevices("either")).toEqual([
        PIXEL_BOOTED,
        IPHONE_BOOTED,
      ]);
    });

    test("getBootedDevicesDetailed reports every requested platform as succeeded", async () => {
      const scripted = await make();
      scripted.setBooted("android", [PIXEL_BOOTED]);
      scripted.setBooted("ios", [IPHONE_BOOTED]);
      const result = await scripted.manager.getBootedDevicesDetailed("either");
      expect(result.devices).toEqual([PIXEL_BOOTED, IPHONE_BOOTED]);
      expect([...result.succeededPlatforms].sort()).toEqual(["android", "ios"]);
      expect(result.succeededSources?.has("android")).toBe(true);
      expect(result.succeededSources?.has("ios-simulator")).toBe(true);
      expect(result.discoveryErrors).toEqual({});
    });

    test("getBootedDevicesDetailed only covers the requested platform", async () => {
      const scripted = await make();
      scripted.setBooted("android", [PIXEL_BOOTED]);
      scripted.setBooted("ios", [IPHONE_BOOTED]);
      const result = await scripted.manager.getBootedDevicesDetailed("android");
      expect(result.devices).toEqual([PIXEL_BOOTED]);
      expect([...result.succeededPlatforms]).toEqual(["android"]);
    });

    test("presentationOrder 'reverse' reverses the devices only", async () => {
      const scripted = await make();
      scripted.setBooted("android", [PIXEL_BOOTED]);
      scripted.setBooted("ios", [IPHONE_BOOTED]);
      const result = await scripted.manager.getBootedDevicesDetailed("either", {
        presentationOrder: "reverse",
      });
      expect(result.devices).toEqual([IPHONE_BOOTED, PIXEL_BOOTED]);
      expect([...result.succeededPlatforms].sort()).toEqual(["android", "ios"]);
    });

    test("a failed Android discovery is not authoritative and does not hide iOS", async () => {
      const scripted = await make();
      scripted.setBooted("android", [PIXEL_BOOTED]);
      scripted.setBooted("ios", [IPHONE_BOOTED]);
      scripted.failBootedDiscovery("android");
      const result = await scripted.manager.getBootedDevicesDetailed("either");
      expect(result.devices).toEqual([IPHONE_BOOTED]);
      expect(result.succeededPlatforms.has("android")).toBe(false);
      expect(result.succeededPlatforms.has("ios")).toBe(true);
      expect(result.discoveryErrors?.android?.code).toBe("failed");
      expect(result.discoveryErrors?.ios).toBeUndefined();
    });

    test("isDeviceImageRunning is true only for an image that is booted", async () => {
      const scripted = await make();
      scripted.setBooted("android", [PIXEL_BOOTED]);
      expect(await scripted.manager.isDeviceImageRunning(PIXEL_IMAGE)).toBe(true);
      expect(await scripted.manager.isDeviceImageRunning(SPARE_IMAGE)).toBe(false);
    });

    test("isDeviceImageRunning for iOS matches the simulator by device id", async () => {
      const scripted = await make();
      scripted.setBooted("ios", [IPHONE_BOOTED]);
      expect(await scripted.manager.isDeviceImageRunning(IPHONE_IMAGE)).toBe(true);
      expect(
        await scripted.manager.isDeviceImageRunning({ ...IPHONE_IMAGE, deviceId: "OTHER" }),
      ).toBe(false);
    });

    test("listDeviceImages marks an Android image running exactly when it is booted", async () => {
      const scripted = await make();
      scripted.setImages("android", [PIXEL_IMAGE, SPARE_IMAGE]);
      scripted.setBooted("android", [PIXEL_BOOTED]);
      const images = await scripted.manager.listDeviceImages("android");
      expect(images.map((image) => [image.name, image.isRunning])).toEqual([
        ["Pixel_9", true],
        ["Pixel_Spare", false],
      ]);
    });

    test("listDeviceImages 'either' concatenates Android then iOS images", async () => {
      const scripted = await make();
      scripted.setImages("android", [PIXEL_IMAGE]);
      scripted.setImages("ios", [IPHONE_IMAGE]);
      const images = await scripted.manager.listDeviceImages("either");
      expect(images.map((image) => image.name)).toEqual(["Pixel_9", "iPhone 16"]);
    });

    test("getDeviceImagesDetailed reports the inventories that completed", async () => {
      const scripted = await make();
      scripted.setImages("android", [PIXEL_IMAGE]);
      scripted.setImages("ios", [IPHONE_IMAGE]);
      const result = await scripted.manager.getDeviceImagesDetailed("either");
      expect(result.devices.map((image) => image.name)).toEqual(["Pixel_9", "iPhone 16"]);
      expect([...result.succeededPlatforms].sort()).toEqual(["android", "ios"]);
      expect(result.discoveryErrors).toEqual({});
    });
  });
}

/** The slice of {@link ScriptedDeviceManager} the image-identity contract needs. */
export type ImageIdentityDriver = Pick<
  ScriptedDeviceManager,
  "manager" | "setImages" | "setBooted"
>;

const SIM_ID_A = "AAAAAAAA-0000-4000-8000-000000000001";
const SIM_ID_B = "BBBBBBBB-0000-4000-8000-000000000002";
const withoutUdid = (image: DeviceInfo): DeviceInfo => ({ ...image, deviceId: undefined });
const twinSimulator = (deviceId: string): DeviceInfo => ({
  name: "iPhone 16",
  platform: "ios",
  isRunning: false,
  deviceId,
});

/**
 * Image identity (#11868): an Android image is its AVD name (the `emulator-<port>` serial changes
 * per boot and only emulator serials count as booted AVDs), an iOS simulator is its UDID (two may
 * share a name, and deleting one by name alone is refused). Driven against the real
 * MultiPlatformDeviceManager (src/devices/deviceUtils.ts isDeviceImageRunning, the Android
 * running-state overlay and destroyDeviceRepresentation) and the fakes that stand in for it.
 */
export function runImageIdentityContract(
  name: string,
  make: () => Promise<ImageIdentityDriver> | ImageIdentityDriver,
): void {
  describe(`PlatformDeviceManager image identity contract: ${name}`, () => {
    test("an Android image is running by AVD name, whatever serial its row carries", async () => {
      const scripted = await make();
      scripted.setBooted("android", [PIXEL_BOOTED]);
      expect(
        await scripted.manager.isDeviceImageRunning({ ...PIXEL_IMAGE, deviceId: "emulator-5556" }),
      ).toBe(true);
      expect(
        await scripted.manager.isDeviceImageRunning({
          ...SPARE_IMAGE,
          deviceId: PIXEL_BOOTED.deviceId,
        }),
      ).toBe(false);
    });

    test("a physical handset modelled like an AVD does not mark that AVD running in listings", async () => {
      const scripted = await make();
      scripted.setImages("android", [PIXEL_IMAGE]);
      scripted.setBooted("android", [{ ...PIXEL_BOOTED, deviceId: "R58M1234567" }]);
      const images = await scripted.manager.listDeviceImages("android");
      expect(images.map((image) => [image.name, image.isRunning])).toEqual([["Pixel_9", false]]);
    });

    test("an iOS image without a UDID is running by simulator name", async () => {
      const scripted = await make();
      scripted.setBooted("ios", [IPHONE_BOOTED]);
      const nameOnly = withoutUdid(twinSimulator(SIM_ID_A));
      expect(await scripted.manager.isDeviceImageRunning(nameOnly)).toBe(true);
    });

    test("an iOS twin with the booted simulator's name is not running unless its UDID is", async () => {
      const scripted = await make();
      scripted.setBooted("ios", [{ ...IPHONE_BOOTED, deviceId: SIM_ID_A }]);
      expect(await scripted.manager.isDeviceImageRunning(twinSimulator(SIM_ID_A))).toBe(true);
      expect(await scripted.manager.isDeviceImageRunning(twinSimulator(SIM_ID_B))).toBe(false);
    });

    test("destroyDevice deletes only the iOS simulator with that UDID", async () => {
      const scripted = await make();
      scripted.setImages("ios", [twinSimulator(SIM_ID_A), twinSimulator(SIM_ID_B)]);
      await scripted.manager.destroyDevice(twinSimulator(SIM_ID_A));
      const remaining = await scripted.manager.listDeviceImages("ios");
      expect(remaining.map((image) => image.deviceId)).toEqual([SIM_ID_B]);
    });

    test("destroyDevice refuses an iOS simulator without a UDID and deletes nothing", async () => {
      const scripted = await make();
      scripted.setImages("ios", [twinSimulator(SIM_ID_A)]);
      const nameOnly = withoutUdid(twinSimulator(SIM_ID_A));
      await expect(scripted.manager.destroyDevice(nameOnly)).rejects.toThrow(
        /without a simulator UDID/,
      );
      expect(await scripted.manager.listDeviceImages("ios")).toHaveLength(1);
    });
  });
}
