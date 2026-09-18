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

function assertSharedKnownValuesAgree(...descriptions: DeviceDescription[]): void {
  const assertValuesAgree = (left: unknown, right: unknown, path: string): void => {
    if (left === null || right === null || left === undefined || right === undefined) {
      return;
    }
    if (typeof left !== "object" || typeof right !== "object") {
      expect(left, path).toEqual(right);
      return;
    }
    if (Array.isArray(left) || Array.isArray(right)) {
      expect(left, path).toEqual(right);
      return;
    }

    const leftRecord = left as Record<string, unknown>;
    const rightRecord = right as Record<string, unknown>;
    for (const key of Object.keys(leftRecord)) {
      if (key in rightRecord) {
        assertValuesAgree(leftRecord[key], rightRecord[key], `${path}.${key}`);
      }
    }
  };

  for (let i = 0; i < descriptions.length; i++) {
    for (let j = i + 1; j < descriptions.length; j++) {
      assertValuesAgree(descriptions[i], descriptions[j], "device");
    }
  }
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

  test("uses configured Android facts when no image was admitted to the booted device", () => {
    const configured = {
      stableId: "Pixel_9_API_36",
      name: "Pixel_9_API_36",
      platform: "android" as const,
      isRunning: true,
      apiLevel: 36,
      osVersion: "16",
      screenWidth: 1080,
      screenHeight: 2400,
      screenDensity: 420,
      formFactor: "phone" as const,
      capabilityInventory: {
        schemaVersion: 1,
        capabilities: [{ id: "android.hardware.nfc", state: "available" as const }],
      },
    };
    const configuredDescription = describeDevice({ kind: "image", image: configured });
    const bootedDescription = describeDevice({
      kind: "booted",
      device: {
        name: "Pixel_9_API_36",
        platform: "android",
        deviceId: "emulator-5554",
      },
      configured,
    });

    assertSharedKnownValuesAgree(configuredDescription, bootedDescription);
  });

  test("uses configured Android facts only to fill missing live runtime values", () => {
    const configured = {
      stableId: "Pixel_9_API_36",
      name: "Pixel_9_API_36",
      platform: "android" as const,
      isRunning: true,
      apiLevel: 36,
      osVersion: "16",
      screenDensity: 420,
    };
    const description = describeDevice({
      kind: "booted",
      device: {
        name: configured.name,
        platform: "android",
        deviceId: "emulator-5554",
        apiLevel: 35,
        osVersion: "15",
      },
      configured,
    });

    expect(description.runtime).toMatchObject({ apiLevel: 35, osVersion: "15" });
    expect(description.display.density).toBe(420);
  });

  test("keeps pooled Android image facts authoritative over live runtime values", () => {
    const description = describeDevice({
      kind: "booted",
      device: {
        name: "Pixel_9_API_36",
        platform: "android",
        deviceId: "emulator-5554",
        apiLevel: 35,
        osVersion: "15",
      },
      pooled: {
        id: "emulator-5554",
        name: "Pixel_9_API_36",
        platform: "android",
        status: "idle",
        lastUsedAt: 0,
        assignmentCount: 0,
        incarnation: 1,
        androidImage: {
          name: "Pixel_9_API_36",
          platform: "android",
          isRunning: true,
          apiLevel: 36,
          osVersion: "16",
        },
      },
    });

    expect(description.runtime).toMatchObject({ apiLevel: 36, osVersion: "16" });
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

  test("uses a booted provisioned image when pool and discovery have no match", () => {
    const description = describeDevice({
      kind: "provisioned",
      provisioned: {
        created: false,
        resolvedSpec: {
          runtime: "com.apple.CoreSimulator.SimRuntime.iOS-26-5",
          deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-17",
          displayCutout: "dynamic_island",
        },
        device: {
          name: "iPhone 17",
          platform: "ios",
          deviceId: "IOS-UDID",
          isRunning: false,
          iosVersion: "26.5",
          runtime: "com.apple.CoreSimulator.SimRuntime.iOS-26-5",
          deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-17",
          model: "iPhone 17",
          architecture: "arm64",
          screenWidth: 1206,
          screenHeight: 2622,
          screenDensity: 460,
          formFactor: "phone",
          capabilityInventory: {
            schemaVersion: 1,
            capabilities: [{ id: "ios.simulator.camera", state: "available" }],
          },
        },
      },
      booted: { name: "iPhone 17", platform: "ios", deviceId: "IOS-UDID" },
    });

    expect(description.runtime).toMatchObject({
      runtimeId: "com.apple.CoreSimulator.SimRuntime.iOS-26-5",
      deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-17",
      model: "iPhone 17",
      architecture: "arm64",
    });
    expect(description.display).toEqual({
      width: 1206,
      height: 2622,
      density: 460,
      formFactor: "phone",
    });
    expect(description.capabilityInventory?.capabilities).toEqual([
      {
        id: "ios.simulator.camera",
        state: "supported",
        reason: null,
        source: null,
      },
    ]);
  });

  test("keeps legacy keys present at every device-description producer", () => {
    const surfaces = [
      {
        surface: "listDeviceImages",
        producer: "../../src/server/deviceTools.ts",
        aliases: [
          "legacyListDeviceImageAliases",
          "stableId:",
          "deviceId:",
          "path:",
          "target:",
          "basedOn:",
          "error:",
          "state:",
          "isAvailable:",
          "availabilityError:",
          "iosVersion:",
          "deviceType:",
          "legacyRuntimeId:",
          "model:",
          "architecture:",
        ],
      },
      {
        surface: "automobile:devices/images",
        producer: "../../src/server/deviceImageResources.ts",
        aliases: [
          "function legacyAliases",
          "stableId:",
          "deviceId:",
          "path:",
          "target:",
          "basedOn:",
          "error:",
          "state:",
          "isAvailable:",
          "availabilityError:",
          "iosVersion:",
          "deviceType:",
          "legacyRuntimeId:",
          "model:",
          "architecture:",
        ],
      },
      {
        surface: "listDevices",
        producer: "../../src/server/deviceTools.ts",
        aliases: [
          "legacyListDevicesAliases",
          "deviceId:",
          "apiLevel:",
          "osVersion:",
          "formFactor:",
        ],
      },
      {
        surface: "provisionDevice.device",
        producer: "../../src/server/deviceTools.ts",
        aliases: ["legacyProvisionDeviceAliases", "...rawDevice", "legacyRuntimeId:"],
      },
      {
        surface: "startDevice/getAndroid/getApple",
        producer: "../../src/server/deviceTools.ts",
        aliases: [
          "legacyBootedResponseAliases",
          "deviceId:",
          "apiLevel:",
          "osVersion:",
          "formFactor:",
          "screenSize:",
          "sessionUuid:",
          "deviceIdentity:",
        ],
      },
      {
        surface: "automobile:devices/booted",
        producer: "../../src/server/bootedDeviceResources.ts",
        aliases: [
          "function legacyAliases",
          "deviceId:",
          "deviceSessionUuid:",
          "status:",
          "lifecycleState:",
          "legacyRuntimeVersion:",
          "formFactor:",
          "poolStatus:",
          "assignedSession:",
        ],
      },
    ];

    for (const { surface, producer, aliases } of surfaces) {
      const source = readFileSync(new URL(producer, import.meta.url), "utf8");
      const [helper, ...fields] = aliases;
      const helperOffset = source.indexOf(helper);
      expect(helperOffset, `${surface} must retain ${helper}`).toBeGreaterThanOrEqual(0);
      const helperSource = source.slice(helperOffset, helperOffset + 2_500);
      for (const field of fields) {
        expect(helperSource, `${surface} must retain ${field}`).toContain(field);
      }
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
