import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { FakeDeviceUtils } from "../../fakes/FakeDeviceUtils";
import { FakeAvdManager } from "../../fakes/FakeAvdManager";
import { FakeSimctl } from "../../fakes/FakeSimctl";
import {
  FakeWatchSimctl,
  WATCH_DEVICE_TYPE,
  WATCH_RUNTIME,
  WATCH_RUNTIME_ID,
  watchDevice,
} from "../../fakes/FakeWatchSimctl";
import {
  createDeviceImageResourcesHandler,
  resetAndroidDeviceImageResourceCache,
} from "../../../src/server/deviceImageResources";
import { WatchSimulatorInventory } from "../../../src/utils/ios-cmdline-tools/WatchSimulatorInventory";
import type {
  AppleDeviceRuntime,
  AppleDeviceType,
} from "../../../src/utils/ios-cmdline-tools/SimCtlSupport";
import { AndroidAvdProvenanceCache } from "../../../src/utils/AndroidAvdProvenanceCache";
import { snapshotPlatformDeviceManagerFactory } from "../../helpers/platformDeviceManagerSnapshot";

// Watch simulators are listed only under automobile:devices/images/watchos as platform "watchos",
// and their runtimes and models leave the iOS catalog (#14901, docs/decisions/watchos-platform.md).

const fixtures = join(import.meta.dir, "../../fixtures/ios-simctl");
const capturedRuntimes = (
  JSON.parse(readFileSync(join(fixtures, "list-runtimes.json"), "utf8")) as {
    runtimes: AppleDeviceRuntime[];
  }
).runtimes;
const capturedDeviceTypes = (
  JSON.parse(readFileSync(join(fixtures, "list-devicetypes.json"), "utf8")) as {
    devicetypes: AppleDeviceType[];
  }
).devicetypes;

describe("watchOS device images", () => {
  let restoreFactory: (() => void) | undefined;
  let deviceUtils: FakeDeviceUtils;
  let simctl: FakeSimctl;
  let watchSimctl: FakeWatchSimctl;

  beforeEach(() => {
    restoreFactory = snapshotPlatformDeviceManagerFactory();
    AndroidAvdProvenanceCache.resetForTests();
    resetAndroidDeviceImageResourceCache();
    deviceUtils = new FakeDeviceUtils();
    deviceUtils.setDeviceImages("ios", []);
    simctl = new FakeSimctl();
    watchSimctl = new FakeWatchSimctl();
  });

  afterEach(() => {
    restoreFactory?.();
    resetAndroidDeviceImageResourceCache();
    AndroidAvdProvenanceCache.resetForTests();
  });

  function handler(watchInventory = new WatchSimulatorInventory(watchSimctl, "arm64")) {
    return createDeviceImageResourcesHandler({
      deviceManager: deviceUtils,
      avdManager: new FakeAvdManager(),
      simctl,
      watchInventory,
    });
  }

  function hostWithWatchCatalog(): void {
    simctl.setRuntimes([...capturedRuntimes, WATCH_RUNTIME]);
    simctl.setDeviceTypes([...capturedDeviceTypes, WATCH_DEVICE_TYPE]);
    watchSimctl.runtimes = [...capturedRuntimes, WATCH_RUNTIME];
    watchSimctl.deviceTypes = [...capturedDeviceTypes, WATCH_DEVICE_TYPE];
  }

  test("lists a watch simulator as a watchos image", async () => {
    watchSimctl.listing = { devices: { [WATCH_RUNTIME_ID]: [watchDevice({ state: "Booted" })] } };

    const result = await handler().getDeviceImagesForPlatforms(["watchos"]);

    expect(result).toMatchObject({
      totalCount: 1,
      androidCount: 0,
      iosCount: 0,
      watchosCount: 1,
      catalogComplete: true,
      configuredInventory: { complete: true, observations: { watchos: { complete: true } } },
    });
    expect(result.images).toHaveLength(1);
    expect(result.images[0]).toMatchObject({
      platform: "watchos",
      identity: { stableId: watchDevice().udid },
      formFactor: "watch",
      osVersion: "11.0",
      runtimeId: WATCH_RUNTIME_ID,
      capabilityInventory: null,
      runtime: { lifecycle: { state: "booted", known: true } },
    });
  });

  test("moves watch runtimes and models from the iOS catalog to the watchOS catalog", async () => {
    hostWithWatchCatalog();

    const ios = await handler().getDeviceImagesForPlatforms(["ios"]);
    const watch = await handler().getDeviceImagesForPlatforms(["watchos"]);

    expect(ios.provisioningCatalog.runtimes.map((runtime) => runtime.id)).not.toContain(
      WATCH_RUNTIME_ID,
    );
    expect(ios.provisioningCatalog.deviceTypes.map((type) => type.id)).not.toContain(
      WATCH_DEVICE_TYPE.identifier,
    );
    expect(watch.provisioningCatalog.runtimes).toEqual([
      {
        platform: "watchos",
        id: WATCH_RUNTIME_ID,
        name: "watchOS 11.0",
        version: "11.0",
        availability: { available: true },
      },
    ]);
    expect(watch.provisioningCatalog.deviceTypes).toEqual([
      expect.objectContaining({
        platform: "watchos",
        id: WATCH_DEVICE_TYPE.identifier,
        family: "Apple Watch",
        availability: { available: true },
        runtimeCompatibility: {
          knowledge: "known",
          minRuntimeVersion: "11.0.0",
          maxRuntimeVersion: null,
          compatibleRuntimeIds: [WATCH_RUNTIME_ID],
        },
      }),
    ]);
  });

  test("an iOS read is unchanged by watch runtimes and models on the host", async () => {
    simctl.setRuntimes(capturedRuntimes);
    simctl.setDeviceTypes(capturedDeviceTypes);
    const withoutWatch = await handler().getDeviceImagesForPlatforms(["ios"]);
    hostWithWatchCatalog();
    const withWatch = await handler().getDeviceImagesForPlatforms(["ios"]);

    expect({ ...withWatch, lastUpdated: "" }).toEqual({ ...withoutWatch, lastUpdated: "" });
    expect(withWatch).not.toHaveProperty("watchosCount");
  });

  test("the all-images read stays Android and iOS and does not read watches", async () => {
    deviceUtils.setDeviceImages("android", []);

    const result = JSON.parse((await handler().getAllDeviceImages()).text ?? "{}") as Record<
      string,
      unknown
    >;

    expect(result).not.toHaveProperty("watchosCount");
    expect(Object.keys(result.catalogObservations as object)).toEqual(["android", "ios"]);
    expect(watchSimctl.listingCalls).toBe(0);
  });

  test("serves the watchos platform template", async () => {
    watchSimctl.listing = { devices: { [WATCH_RUNTIME_ID]: [watchDevice()] } };

    const content = await handler().getDeviceImagesByPlatform({ platform: "watchos" });
    const body = JSON.parse(content.text ?? "{}") as { watchosCount?: number };

    expect(content.uri).toBe("automobile:devices/images/watchos");
    expect(body.watchosCount).toBe(1);
  });

  test("names watchos among the valid platforms", async () => {
    const content = await handler().getDeviceImagesByPlatform({ platform: "invalid" });

    expect(JSON.parse(content.text ?? "{}")).toEqual({
      error: "Invalid platform: invalid. Must be 'android', 'ios', 'watchos' or 'tvos'.",
    });
  });

  test("a failed watch listing is an incomplete inventory, not an empty one", async () => {
    watchSimctl.listingError = new Error("simctl list timed out");

    const result = await handler().getDeviceImagesForPlatforms(["watchos"]);

    expect(result.images).toEqual([]);
    expect(result.configuredInventory).toMatchObject({
      complete: false,
      observations: {
        watchos: {
          complete: false,
          error: {
            code: "failed",
            message: "watchOS configured-device inventory failed: simctl list timed out",
          },
        },
      },
    });
  });

  test("a failed watch catalog read marks the catalog incomplete", async () => {
    watchSimctl.catalogError = new Error("malformed simctl runtimes JSON");

    const result = await handler().getDeviceImagesForPlatforms(["watchos"]);

    expect(result.catalogComplete).toBe(false);
    expect(result.catalogObservations.watchos).toEqual({
      catalogComplete: false,
      error: {
        code: "failed",
        message: "watchOS provisioning catalog failed: malformed simctl runtimes JSON",
      },
    });
  });
});
