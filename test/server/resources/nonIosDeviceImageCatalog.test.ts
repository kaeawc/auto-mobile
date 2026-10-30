import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { FakeDeviceUtils } from "../../fakes/FakeDeviceUtils";
import { FakeAvdManager } from "../../fakes/FakeAvdManager";
import { FakeSimctl } from "../../fakes/FakeSimctl";
import { WATCH_RUNTIME } from "../../fakes/FakeWatchSimctl";
import { TVOS_RUNTIME, XROS_RUNTIME } from "../../fakes/nonIosAppleSimulators";
import {
  createDeviceImageResourcesHandler,
  resetAndroidDeviceImageResourceCache,
} from "../../../src/server/deviceImageResources";
import type {
  AppleDeviceRuntime,
  AppleDeviceType,
} from "../../../src/utils/ios-cmdline-tools/SimCtlSupport";
import { AndroidAvdProvenanceCache } from "../../../src/utils/AndroidAvdProvenanceCache";
import { snapshotPlatformDeviceManagerFactory } from "../../helpers/platformDeviceManagerSnapshot";

// The iOS provisioning catalog offers only iOS runtimes and iPhone/iPad models. Apple TV and Vision
// Pro models from a real Xcode 26.6 device-type capture are never iOS images (#15885).

const fixtures = join(import.meta.dir, "../../fixtures/ios-devicetype-order");
const capturedRuntimes = (
  JSON.parse(readFileSync(join(fixtures, "xcode-26.6-runtimes.json"), "utf8")) as {
    runtimes: AppleDeviceRuntime[];
  }
).runtimes;
const capturedDeviceTypes = (
  JSON.parse(readFileSync(join(fixtures, "xcode-26.6-devicetypes.json"), "utf8")) as {
    devicetypes: AppleDeviceType[];
  }
).devicetypes;
const iphoneAndIpadTypes = capturedDeviceTypes.filter(
  (type) => type.productFamily === "iPhone" || type.productFamily === "iPad",
);

describe("iOS device image catalog excludes Apple TV and Vision Pro", () => {
  let restoreFactory: (() => void) | undefined;
  let deviceUtils: FakeDeviceUtils;
  let simctl: FakeSimctl;

  beforeEach(() => {
    restoreFactory = snapshotPlatformDeviceManagerFactory();
    AndroidAvdProvenanceCache.resetForTests();
    resetAndroidDeviceImageResourceCache();
    deviceUtils = new FakeDeviceUtils();
    deviceUtils.setDeviceImages("ios", []);
    simctl = new FakeSimctl();
  });

  afterEach(() => {
    restoreFactory?.();
    resetAndroidDeviceImageResourceCache();
    AndroidAvdProvenanceCache.resetForTests();
  });

  async function iosCatalog() {
    const handler = createDeviceImageResourcesHandler({
      deviceManager: deviceUtils,
      avdManager: new FakeAvdManager(),
      simctl,
    });
    return (await handler.getDeviceImagesForPlatforms(["ios"])).provisioningCatalog;
  }

  test("offers only iPhone and iPad models from a host with every Apple family", async () => {
    simctl.setRuntimes(capturedRuntimes);
    simctl.setDeviceTypes(capturedDeviceTypes);

    const catalog = await iosCatalog();

    expect(catalog.deviceTypes.map((type) => type.id)).toEqual(
      iphoneAndIpadTypes.map((type) => type.identifier),
    );
    expect(new Set(catalog.deviceTypes.map((type) => type.family))).toEqual(
      new Set(["iPhone", "iPad"]),
    );
  });

  test("offers only iOS runtimes when watchOS, tvOS and xrOS runtimes are installed", async () => {
    simctl.setRuntimes([...capturedRuntimes, WATCH_RUNTIME, TVOS_RUNTIME, XROS_RUNTIME]);
    simctl.setDeviceTypes(capturedDeviceTypes);

    const catalog = await iosCatalog();

    expect(catalog.runtimes.map((runtime) => runtime.id)).toEqual(
      capturedRuntimes.map((runtime) => runtime.identifier),
    );
  });

  test("an iPhone/iPad-only host gets the same catalog as before", async () => {
    simctl.setRuntimes(capturedRuntimes);
    simctl.setDeviceTypes(iphoneAndIpadTypes);
    const iosOnly = await iosCatalog();

    simctl.setRuntimes([...capturedRuntimes, TVOS_RUNTIME, XROS_RUNTIME]);
    simctl.setDeviceTypes(capturedDeviceTypes);
    const mixed = await iosCatalog();

    expect(mixed).toEqual(iosOnly);
  });
});
