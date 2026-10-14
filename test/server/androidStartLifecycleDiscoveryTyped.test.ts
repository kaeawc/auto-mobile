import { describe, expect, test } from "bun:test";
import {
  knownProvisionDeviceError,
  resolveAndroidStartStableDeviceLifecycleTarget,
} from "../../src/server/deviceTools";
import type { PlatformDeviceManager } from "../../src/devices/deviceUtils";
import { ActionableError } from "../../src/models/ActionableError";
import { AndroidBootedDeviceDiscoveryIncompleteError } from "../../src/models/BootedDeviceDiscoveryIncompleteError";
import type { BootedDevice } from "../../src/models";
import { isTypedToolRefusal, shapeToolCallError } from "../../src/server/shapeToolCallError";
import { logger } from "../../src/utils/logger";
import { FakeTimer } from "../fakes/FakeTimer";

type BootedResult = Awaited<ReturnType<PlatformDeviceManager["getBootedDevicesDetailed"]>>;
type ImageResult = Awaited<ReturnType<PlatformDeviceManager["getDeviceImagesDetailed"]>>;

/** adb failed this sweep: no device list, Android not in succeededPlatforms. */
function adbDownDeviceManager(): PlatformDeviceManager {
  return managerWith(
    {
      succeededPlatforms: new Set(),
      discoveryErrors: {
        android: { code: "failed", message: "adb server crashed", retryable: true },
      },
    },
    { succeededPlatforms: new Set() },
  );
}

function managerWith(
  booted: Partial<BootedResult>,
  images: Partial<ImageResult>,
): PlatformDeviceManager {
  return {
    getBootedDevicesDetailed: async () => ({
      devices: [],
      succeededPlatforms: new Set(["android"]),
      ...booted,
    }),
    getDeviceImagesDetailed: async () => ({
      devices: [],
      succeededPlatforms: new Set(["android"]),
      ...images,
    }),
  } as unknown as PlatformDeviceManager;
}

async function resolveOutcome(
  manager: PlatformDeviceManager,
): Promise<{ error?: unknown; target?: unknown }> {
  return await resolveAndroidStartStableDeviceLifecycleTarget(
    "emulator-5554",
    Date.now() + 60_000,
    manager,
    new FakeTimer(),
    undefined,
  ).then(
    (target) => ({ target }),
    (error: unknown) => ({ error }),
  );
}

function emulator(name: string): BootedDevice {
  return { name, platform: "android", deviceId: "emulator-5554" } as BootedDevice;
}

function wire(error: unknown): { success: boolean; code?: string; retryable?: boolean } {
  const original = logger.error;
  logger.error = () => {};
  try {
    const shaped = shapeToolCallError(error, { toolName: "startDevice", source: "MCP" });
    return JSON.parse((shaped.content[0] as { text: string }).text);
  } finally {
    logger.error = original;
  }
}

describe("startDevice Android deviceId with incomplete discovery", () => {
  test("is a typed retryable discovery_incomplete, as provisionDevice reports it", async () => {
    const { error } = await resolveOutcome(adbDownDeviceManager());

    expect(error).toBeDefined();
    expect(knownProvisionDeviceError(error)?.code).toBe("discovery_incomplete");
    expect(error).toBeInstanceOf(AndroidBootedDeviceDiscoveryIncompleteError);
    expect((error as Error).message).toContain("Could not refresh device list");
    expect(wire(error)).toMatchObject({
      success: false,
      code: "discovery_incomplete",
      retryable: true,
    });
  });

  test("adb unavailable (no refresh failure) is incomplete, not a missing device", async () => {
    const { error } = await resolveOutcome(
      managerWith(
        {
          succeededPlatforms: new Set(),
          discoveryErrors: { android: { code: "unavailable", message: "adb not found" } },
        },
        { succeededPlatforms: new Set() },
      ),
    );

    expect(error).toBeInstanceOf(AndroidBootedDeviceDiscoveryIncompleteError);
    expect((error as Error).message).toContain("Cannot uniquely resolve Android device");
    expect(wire(error).retryable).toBe(true);
  });

  test("AVD image discovery failing under a virtual serial is typed discovery_incomplete", async () => {
    const { error } = await resolveOutcome(
      managerWith(
        { devices: [emulator("Pixel_8")] },
        {
          succeededPlatforms: new Set(),
          discoveryErrors: { android: { code: "failed", message: "avd list failed" } },
        },
      ),
    );

    expect(error).toBeInstanceOf(AndroidBootedDeviceDiscoveryIncompleteError);
    expect(knownProvisionDeviceError(error)?.retryable).toBe(true);
  });
});

describe("startDevice Android deviceId with complete discovery", () => {
  test("an unanswered emulator identity probe is a typed retryable refusal", async () => {
    const { error } = await resolveOutcome(
      managerWith({ devices: [emulator("Unknown (emulator-5554)")] }, {}),
    );

    expect(isTypedToolRefusal(error)).toBe(true);
    expect(wire(error)).toMatchObject({
      success: false,
      code: "target_identity_unresolved",
      retryable: true,
      retryAfterMs: 1000,
      deviceId: "emulator-5554",
      candidateSerials: ["emulator-5554"],
    });
    expect((error as Error).message).toContain("emulator-5554");
    expect((error as Error).message).toContain("killDevice");
    expect((error as Error).message).toContain("startDevice");
  });

  test("a duplicate serial stays a plain, non-retryable ambiguity", async () => {
    const { error } = await resolveOutcome(
      managerWith({ devices: [emulator("A"), emulator("B")] }, {}),
    );

    expect(error).toBeInstanceOf(ActionableError);
    expect(error).not.toBeInstanceOf(AndroidBootedDeviceDiscoveryIncompleteError);
    expect(isTypedToolRefusal(error)).toBe(false);
  });

  test("two matching AVD images stay a plain, non-retryable ambiguity", async () => {
    const image = (name: string) => ({ name, platform: "android", deviceId: "emulator-5554" });
    const { error } = await resolveOutcome(
      managerWith(
        { devices: [emulator("Pixel_8")] },
        { devices: [image("A"), image("B")] as never },
      ),
    );

    expect(error).toBeInstanceOf(ActionableError);
    expect(error).not.toBeInstanceOf(AndroidBootedDeviceDiscoveryIncompleteError);
  });

  test("a serial absent under complete discovery is not turned into a retryable answer", async () => {
    const outcome = await resolveOutcome(managerWith({}, {}));

    expect(outcome.error).toBeUndefined();
    expect(outcome.target).toBeUndefined();
  });
});
