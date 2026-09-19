import { describe, expect, test } from "bun:test";
import {
  describeDevice,
  projectBootedDevice,
  projectConfiguredImage,
  projectListDevicesEntry,
  projectProvisionedDevice,
  listDevicesEntrySchema,
  type DeviceDescription,
  type DeviceDescriptionInput,
} from "../../src/server/deviceDescription";
import type { DeviceInfo } from "../../src/models";

type Assert<T extends true> = T;
type ProjectionCanonicalExact<T> = Assert<
  keyof T extends keyof DeviceDescription
    ? keyof DeviceDescription extends keyof T
      ? true
      : false
    : false
>;

const projectionKeys = {
  name: true,
  platform: true,
  isVirtual: true,
  source: true,
  identity: true,
  formFactor: true,
  deviceType: true,
  model: true,
  architecture: true,
  osVersion: true,
  apiLevel: true,
  runtimeId: true,
  display: true,
  capabilityInventory: true,
  image: true,
  availabilityError: true,
  runtime: true,
} satisfies Record<keyof DeviceDescription, boolean>;

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

function keyShape(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }
  return Object.fromEntries(
    Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => [key, keyShape((value as Record<string, unknown>)[key])]),
  );
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
    for (const projection of [
      projectListDevicesEntry(canonical),
      projectProvisionedDevice(canonical),
      projectConfiguredImage(canonical),
      projectBootedDevice(canonical),
    ]) {
      expect(projection).toBe(canonical);
    }
  });

  test("keeps unknown values as explicit nulls", () => {
    const description = describeDevice({
      kind: "booted",
      device: { name: "Phone", platform: "ios", deviceId: "IOS-UDID" },
    });
    expect(description.runtimeId).toBeNull();
    expect(description.display.density).toBeNull();
    expect(description.runtime.session).toBeNull();
    expect(description.runtime.locked).toBeNull();
    expect(Object.keys(description).sort()).toEqual(Object.keys(projectionKeys).sort());
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
      runtimeId: "system-images;android-36;google_apis;arm64-v8a",
      deviceType: "pixel_9",
      image: {
        path: "/tmp/Pixel_9_API_36.avd",
        target: "Google APIs",
        basedOn: "Android 16 google_apis/arm64-v8a",
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
    expect(bootedDescription.image).toEqual(configured.image);
    expect(bootedDescription.runtimeId).toBe(configured.runtimeId);
    expect(bootedDescription.deviceType).toBe(configured.deviceType);
  });

  test("uses configured AVD provenance beneath pooled image facts, per field", () => {
    const configured = {
      stableId: "Pixel_9_API_36",
      name: "Pixel_9_API_36",
      platform: "android" as const,
      isRunning: true,
      image: {
        path: "/configured/Pixel_9_API_36.avd",
        target: "Configured target",
        basedOn: "Configured base",
      },
    };
    const device = {
      name: configured.name,
      platform: "android" as const,
      deviceId: "emulator-5554",
    };
    const pooled = {
      id: device.deviceId,
      name: device.name,
      platform: "android" as const,
      status: "idle" as const,
      lastUsedAt: 0,
      assignmentCount: 0,
      incarnation: 1,
      androidImage: { name: device.name, platform: "android" as const, isRunning: true },
    };

    expect(describeDevice({ kind: "booted", device, pooled, configured }).image).toEqual(
      configured.image,
    );
    expect(
      describeDevice({
        kind: "booted",
        device,
        configured,
        pooled: {
          ...pooled,
          androidImage: {
            ...configured,
            image: { path: "/pooled.avd", target: undefined, basedOn: "Pooled base" },
          },
        },
      }).image,
    ).toEqual({
      path: "/pooled.avd",
      target: "Configured target",
      basedOn: "Pooled base",
    });
  });

  test("compares nested device-description shape", () => {
    expect(keyShape({ runtime: { orientation: null } })).not.toEqual(keyShape({ runtime: {} }));
  });

  test("keeps one canonical key set across lifecycle and ownership states", () => {
    const configured = {
      stableId: "Pixel_9_API_36",
      name: "Pixel_9_API_36",
      platform: "android" as const,
      isRunning: false,
      runtimeId: "system-images;android-36;google_apis;arm64-v8a",
      deviceType: "pixel_9",
      screenWidth: 1080,
      screenHeight: 2400,
      screenDensity: 420,
      formFactor: "phone" as const,
    };
    const booted = {
      name: configured.name,
      platform: "android" as const,
      deviceId: "emulator-5554",
    };
    const descriptions = [
      describeDevice({ kind: "image", image: configured }),
      describeDevice({ kind: "image", image: { ...configured, state: "Booting" } }),
      describeDevice({ kind: "booted", device: booted, configured }),
      describeDevice({ kind: "booted", device: booted, configured, serviceStatus: undefined }),
      describeDevice({
        kind: "booted",
        device: booted,
        configured,
        pooled: {
          id: booted.deviceId,
          name: booted.name,
          platform: "android",
          status: "idle",
          lastUsedAt: 0,
          assignmentCount: 0,
          incarnation: 1,
        },
      }),
      describeDevice({
        kind: "booted",
        device: booted,
        configured,
        session: { sessionId: "session-1", ownership: "awaiting-owner" },
      }),
    ];

    for (const description of descriptions.slice(1)) {
      expect(Object.keys(description).sort()).toEqual(Object.keys(descriptions[0]).sort());
      expect(Object.keys(description.runtime).sort()).toEqual(
        Object.keys(descriptions[0].runtime).sort(),
      );
      expect({ ...description, runtime: undefined }).toEqual({
        ...descriptions[0],
        runtime: undefined,
      });
    }
  });

  test("keeps Android and iOS virtual-device key sets and static enrichment in parity", () => {
    const capabilityInventory = {
      schemaVersion: 1,
      capabilities: [{ id: "camera", state: "available" as const }],
    };
    const android = describeDevice({
      kind: "image",
      image: {
        stableId: "Pixel_9",
        name: "Pixel_9",
        platform: "android",
        isRunning: false,
        runtimeId: "system-images;android-36;google_apis;arm64-v8a",
        deviceType: "pixel_9",
        screenWidth: 1080,
        screenHeight: 2400,
        screenDensity: 420,
        capabilityInventory,
      },
    });
    const ios = describeDevice({
      kind: "image",
      image: {
        stableId: "IOS-UDID",
        name: "iPhone 17",
        platform: "ios",
        deviceId: "IOS-UDID",
        isRunning: false,
        runtimeId: "com.apple.CoreSimulator.SimRuntime.iOS-26-5",
        deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-17",
        screenWidth: 1206,
        screenHeight: 2622,
        screenDensity: 460,
        capabilityInventory,
      },
    });

    expect(keyShape(android)).toEqual(keyShape(ios));
    for (const description of [android, ios]) {
      expect(description.runtimeId).not.toBeNull();
      expect(description.deviceType).not.toBeNull();
      expect(description.display.width).not.toBeNull();
      expect(description.capabilityInventory).not.toBeNull();
    }
  });

  test("keeps physical-device shape while leaving image-only facts null", () => {
    const physical = describeDevice({
      kind: "booted",
      device: {
        name: "Jason's Pixel",
        platform: "android",
        deviceId: "R58M1234ABC",
        model: "Pixel 9 Pro",
      },
    });
    const virtual = describeDevice({
      kind: "booted",
      device: { name: "Pixel_9", platform: "android", deviceId: "emulator-5554" },
    });

    expect(keyShape(physical)).toEqual(keyShape(virtual));
    expect(physical).toMatchObject({
      isVirtual: false,
      deviceType: null,
      model: "Pixel 9 Pro",
      image: { path: null, target: null, basedOn: null },
    });
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

    expect(description).toMatchObject({ apiLevel: 35, osVersion: "15" });
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

    expect(description).toMatchObject({ apiLevel: 36, osVersion: "16" });
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

    expect(description).toMatchObject({
      runtimeId: "com.apple.CoreSimulator.SimRuntime.iOS-26-5",
      deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-17",
      model: "iPhone 17",
      architecture: "arm64",
    });
    expect(description.display).toEqual({
      width: 1206,
      height: 2622,
      density: 460,
    });
    expect(description.formFactor).toBe("phone");
    expect(description.capabilityInventory?.capabilities).toEqual([
      {
        id: "ios.simulator.camera",
        state: "supported",
        reason: null,
        source: null,
      },
    ]);
  });

  test("projects booted Android state in the canonical shape", () => {
    const description = describeDevice({
      kind: "booted",
      device: {
        name: "Pixel_9",
        platform: "android",
        deviceId: "emulator-5554",
        apiLevel: 36,
        osVersion: "16",
        formFactor: "phone",
      },
      pooled: {
        id: "emulator-5554",
        name: "Pixel_9",
        platform: "android",
        status: "busy",
        sessionId: "session-1",
        lastUsedAt: 0,
        assignmentCount: 1,
        incarnation: 4,
      },
      session: { sessionId: "session-1", ownership: "owned" },
      deviceSessionUuid: "connection-session-1",
      serviceStatus: { installed: true, enabled: true, running: true, isCompatible: true },
      locked: true,
      orientation: "landscape",
    });
    const projected = projectBootedDevice(description);

    expect(projected).toMatchObject({
      identity: { stableId: "Pixel_9" },
      osVersion: "16",
      apiLevel: 36,
      runtimeId: null,
      deviceType: null,
      architecture: null,
      model: null,
      formFactor: "phone",
      runtime: {
        deviceId: "emulator-5554",
        connectionId: "emulator-5554#4",
        deviceSessionUuid: "connection-session-1",
        lifecycle: { state: "booted", known: true },
        readiness: { state: "ready" },
        poolStatus: "assigned",
        session: { sessionUuid: "session-1", ownership: "owned" },
      },
    });
  });

  test("projects configured iOS values in the canonical shape", () => {
    const description = describeDevice(iosImage);
    const projected = projectConfiguredImage(description);

    expect(projected).toMatchObject({
      identity: { stableId: "IOS-UDID" },
      osVersion: "26.5",
      apiLevel: null,
      runtimeId: "com.apple.CoreSimulator.SimRuntime.iOS-26-5",
      deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-17",
      architecture: null,
      model: null,
      formFactor: "phone",
      runtime: {
        deviceId: null,
        connectionId: null,
        deviceSessionUuid: null,
        lifecycle: { state: "configured", known: true },
      },
    });
  });

  test("projects provisioned-device values in the canonical shape", () => {
    const description = describeDevice({
      kind: "provisioned",
      provisioned: {
        created: true,
        resolvedSpec: { runtime: "android-36", deviceType: "pixel_9" },
        device: {
          name: "Pixel_9_API_36",
          platform: "android",
          deviceId: "Pixel_9_API_36",
          isRunning: false,
          apiLevel: 36,
          osVersion: "16",
          runtime: "android-36",
          deviceType: "pixel_9",
          formFactor: "phone",
        },
      },
    });
    const projected = projectProvisionedDevice(description);

    expect(projected).toMatchObject({
      identity: { stableId: "Pixel_9_API_36" },
      osVersion: "16",
      apiLevel: 36,
      runtimeId: "android-36",
      deviceType: "pixel_9",
      architecture: null,
      model: null,
      formFactor: "phone",
      runtime: {
        lifecycle: { state: "configured", known: true },
      },
    });
  });

  test("uses exact unbooted runtime defaults for configured images", () => {
    const description = describeDevice(androidImage);

    expect(description.runtime).toEqual({
      deviceId: null,
      connectionId: null,
      deviceSessionUuid: null,
      lifecycle: { state: "configured", known: true },
      readiness: { state: "unknown" },
      poolStatus: null,
      session: null,
      serviceStatus: null,
      locked: null,
      orientation: null,
    });
  });

  test.each([
    ["phone", "phone"],
    ["tablet", "tablet"],
    ["foldable", "foldable"],
    [undefined, "unknown"],
    [null, "unknown"],
    ["watch", "unknown"],
  ])("maps form factor %p to %s", (value, expected) => {
    const image = {
      name: "Form factor fixture",
      platform: "android",
      isRunning: false,
      formFactor: value,
    } as unknown as DeviceInfo;
    expect(describeDevice({ kind: "image", image }).formFactor).toBe(expected);
  });

  test("normalizes missing form factors without adding a display alias", () => {
    const description = describeDevice({
      kind: "image",
      image: { name: "Unknown form factor", platform: "android", isRunning: false },
    });

    expect(description.formFactor).toBe("unknown");
    expect(projectConfiguredImage(description).display).toEqual({
      width: null,
      height: null,
      density: null,
    });
  });

  test("rejects removed listDevices aliases", () => {
    const projected = projectListDevicesEntry(
      describeDevice({
        kind: "booted",
        device: { name: "Unknown AVD", platform: "android", deviceId: "emulator-5554" },
      }),
    );
    expect(listDevicesEntrySchema.safeParse(projected).success).toBe(true);
    expect(() =>
      listDevicesEntrySchema.parse({ ...projected, deviceId: "emulator-5554" }),
    ).toThrow();
  });

  test("keeps service-status version metadata in canonical runtime state", () => {
    const projected = projectListDevicesEntry(
      describeDevice({
        kind: "booted",
        device: { name: "Pixel", platform: "android", deviceId: "emulator-5554" },
        serviceStatus: {
          installed: true,
          enabled: true,
          running: true,
          isCompatible: true,
          version: "1.2.3",
          versionInfo: {
            versionName: "1.2.3",
            versionCode: "45",
            source: "android-package",
          },
        },
      }),
    );

    const parsed = listDevicesEntrySchema.parse(projected);
    expect(parsed.runtime.serviceStatus).toMatchObject({
      version: "1.2.3",
      versionInfo: { versionName: "1.2.3", versionCode: "45", source: "android-package" },
    });
  });

  test("preserves explicitly observed lock state", () => {
    for (const locked of [true, false]) {
      const description = describeDevice({
        kind: "booted",
        device: { name: "Pixel", platform: "android", deviceId: "emulator-5554" },
        locked,
      });
      expect(description.runtime.locked).toBe(locked);
    }
  });

  test.each([
    ["image", androidImage],
    [
      "booted",
      { kind: "booted", device: { name: "Pixel", platform: "android", deviceId: "emulator-5554" } },
    ],
    [
      "provisioned",
      {
        kind: "provisioned",
        provisioned: {
          created: true,
          resolvedSpec: { runtime: "android-36", deviceType: "pixel_9" },
          device: { name: "Pixel", platform: "android", deviceId: "Pixel", isRunning: false },
        },
      },
    ],
  ] as const)(
    "emits only canonical keys for the %s producer and every projection",
    (_name, input) => {
      const description = describeDevice(input as DeviceDescriptionInput);
      const expectedShape = keyShape(description);
      for (const projection of [
        description,
        projectListDevicesEntry(description),
        projectProvisionedDevice(description),
        projectConfiguredImage(description),
        projectBootedDevice(description),
      ]) {
        expect(keyShape(projection)).toEqual(expectedShape);
        expect(Object.keys(projection.identity)).toEqual(["stableId"]);
        expect(Object.keys(projection.display).sort()).toEqual(["density", "height", "width"]);
        for (const removed of [
          "lifecycle",
          "readiness",
          "session",
          "provenance",
          "stableId",
          "deviceId",
          "path",
          "target",
          "basedOn",
          "error",
          "state",
          "isAvailable",
          "iosVersion",
          "legacyRuntimeId",
          "legacyRuntimeVersion",
          "status",
          "lifecycleState",
          "poolStatus",
          "assignedSession",
          "screenSize",
          "sessionUuid",
        ]) {
          expect(projection).not.toHaveProperty(removed);
        }
      }
    },
  );

  test("projections are type-level exact matches for the canonical record", () => {
    const subsets: [
      ProjectionCanonicalExact<ReturnType<typeof projectListDevicesEntry>>,
      ProjectionCanonicalExact<ReturnType<typeof projectProvisionedDevice>>,
      ProjectionCanonicalExact<ReturnType<typeof projectConfiguredImage>>,
      ProjectionCanonicalExact<ReturnType<typeof projectBootedDevice>>,
    ] = [true, true, true, true];
    expect(subsets).toEqual([true, true, true, true]);
  });
});
