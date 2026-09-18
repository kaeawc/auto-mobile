import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  describeDevice,
  projectBootedDevice,
  projectConfiguredImage,
  projectListDevicesEntry,
  projectProvisionedDevice,
  type DeviceDescription,
  type DeviceDescriptionInput,
} from "../../src/server/deviceDescription";

type Assert<T extends true> = T;
type ProjectionSubset<T> = Assert<
  Exclude<keyof T, keyof DeviceDescription> extends never ? true : false
>;

const projectionKeys = {
  listDevices: {
    identity: true,
    name: true,
    platform: true,
    isVirtual: true,
    source: false,
    runtime: true,
    display: true,
    lifecycle: true,
    readiness: false,
    session: true,
    provenance: false,
    capabilityInventory: false,
  },
  provisioned: {
    identity: true,
    name: true,
    platform: true,
    isVirtual: false,
    source: false,
    runtime: true,
    display: true,
    lifecycle: true,
    readiness: false,
    session: false,
    provenance: false,
    capabilityInventory: false,
  },
  configuredImage: {
    identity: true,
    name: true,
    platform: true,
    isVirtual: true,
    source: true,
    runtime: true,
    display: true,
    lifecycle: true,
    readiness: false,
    session: false,
    provenance: true,
    capabilityInventory: true,
  },
  booted: {
    identity: true,
    name: true,
    platform: true,
    isVirtual: true,
    source: true,
    runtime: true,
    display: true,
    lifecycle: true,
    readiness: true,
    session: true,
    provenance: true,
    capabilityInventory: true,
  },
} satisfies Record<string, Record<keyof DeviceDescription, boolean>>;

function pick<T extends object>(value: T, keys: Record<keyof T, boolean>): Partial<T> {
  return Object.fromEntries(
    Object.entries(keys)
      .filter(([, include]) => include)
      .map(([key]) => [key, value[key as keyof T]]),
  ) as Partial<T>;
}

const androidImage: DeviceDescriptionInput = {
  kind: "image",
  image: {
    stableId: "Pixel_9",
    name: "Pixel 9",
    platform: "android",
    isRunning: false,
    apiLevel: 36,
    osVersion: "16",
    runtime: "android-36",
    screenWidth: 1080,
    screenHeight: 2424,
    screenDensity: 420,
    formFactor: "phone",
    capabilityInventory: {
      schemaVersion: 1,
      capabilities: [{ id: "android.hardware.nfc", state: "available", source: "avd_config" }],
    },
  },
};

const iosImage: DeviceDescriptionInput = {
  kind: "image",
  image: {
    stableId: "IOS-UDID",
    name: "iPhone 17",
    platform: "ios",
    deviceId: "IOS-UDID",
    isRunning: false,
    state: "Shutdown",
    isAvailable: true,
    iosVersion: "26.5",
    runtime: "com.apple.CoreSimulator.SimRuntime.iOS-26-5",
    deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-17",
    formFactor: "phone",
  },
};

describe("device description projections", () => {
  test.each([androidImage, iosImage])("projects one canonical record for %s", (input) => {
    const canonical = describeDevice(input);
    expect(projectListDevicesEntry(canonical)).toEqual({
      ...pick(canonical, projectionKeys.listDevices),
      display: { formFactor: canonical.display.formFactor },
      session: { sessionUuid: canonical.session.sessionUuid },
    });
    expect(projectProvisionedDevice(canonical)).toEqual(
      pick(canonical, projectionKeys.provisioned),
    );
    expect(projectConfiguredImage(canonical)).toEqual(
      pick(canonical, projectionKeys.configuredImage),
    );
    expect(projectBootedDevice(canonical)).toEqual(pick(canonical, projectionKeys.booted));
  });

  test("keeps unknown values as explicit nulls", () => {
    const description = describeDevice({
      kind: "booted",
      device: { name: "Phone", platform: "ios", deviceId: "IOS-UDID" },
    });
    expect(description.runtime.runtimeId).toBeNull();
    expect(description.display.density).toBeNull();
    expect(description.session.sessionUuid).toBeNull();
    expect(Object.keys(description)).toEqual(Object.keys(projectionKeys.booted));
  });

  test("synthesizes static inventory only for iOS simulators", () => {
    const simulator = describeDevice({
      kind: "booted",
      device: {
        name: "iPhone 17 Simulator",
        platform: "ios",
        deviceId: "A1B2C3D4-E5F6-7890-ABCD-EF1234567890",
      },
    });
    const physicalWithoutInventory = describeDevice({
      kind: "booted",
      device: {
        name: "Jason's iPhone",
        platform: "ios",
        deviceId: "00008110-0012345678901234",
      },
    });
    const discoveredInventory = {
      schemaVersion: 1,
      capabilities: [{ id: "ios.real-device.camera", state: "available" as const }],
    };
    const physicalWithInventory = describeDevice({
      kind: "booted",
      device: {
        name: "Jason's iPhone",
        platform: "ios",
        deviceId: "00008110-0012345678901234",
        capabilityInventory: discoveredInventory,
      },
    });

    expect(simulator.capabilityInventory?.capabilities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "ios.simulator.doNotDisturb", state: "unsupported" }),
        expect.objectContaining({ id: "ios.simulator.networkCondition", state: "unsupported" }),
        expect.objectContaining({ id: "ios.simulator.connectivity", state: "unsupported" }),
      ]),
    );
    expect(physicalWithoutInventory.capabilityInventory).toBeNull();
    expect(physicalWithInventory.capabilityInventory).toEqual({
      schemaVersion: 1,
      capabilities: [
        {
          id: "ios.real-device.camera",
          state: "supported",
          reason: null,
          source: null,
        },
      ],
    });
  });

  test("keeps retired output literals out of every producer", () => {
    const producers = [
      "../../src/server/deviceTools.ts",
      "../../src/utils/configuredDeviceInventory.ts",
      "../../src/server/deviceImageResources.ts",
      "../../src/server/bootedDeviceResources.ts",
    ];
    for (const producer of producers) {
      const source = readFileSync(new URL(producer, import.meta.url), "utf8");
      expect(source).not.toMatch(/lifecycleState:\s*["']booted["']/);
      expect(source).not.toMatch(/\biosVersion\s*:/);
    }
  });

  test("projections are type-level subsets of the canonical record", () => {
    const subsets: [
      ProjectionSubset<ReturnType<typeof projectListDevicesEntry>>,
      ProjectionSubset<ReturnType<typeof projectProvisionedDevice>>,
      ProjectionSubset<ReturnType<typeof projectConfiguredImage>>,
      ProjectionSubset<ReturnType<typeof projectBootedDevice>>,
    ] = [true, true, true, true];
    expect(subsets).toEqual([true, true, true, true]);
  });
});
