import { getAbortSignal } from "../../../src/utils/AbortContext";
import { createListingHandlers } from "../../../src/server/deviceToolsListing";
import {
  setDeviceToolsDependencies,
  resetDeviceToolsDependencies,
} from "../../../src/server/deviceTools";
import {
  setDeviceManager,
  setDeviceLockProbe,
  setOrientationReaderFactory,
  resetBootedDevicesResourceCache,
  getBootedDevicesForPlatforms,
} from "../../../src/server/bootedDeviceResources";
import { afterEach, describe, expect, test } from "bun:test";
import {
  createDeviceImageResourcesHandler,
  invalidateAndroidInventoryProvenanceAndCatalog,
} from "../../../src/server/deviceImageResources";
import { AndroidAvdProvenanceCache } from "../../../src/utils/AndroidAvdProvenanceCache";
import { FakeAvdManager } from "../../fakes/FakeAvdManager";
import { FakeDeviceUtils } from "../../fakes/FakeDeviceUtils";
import { FakeTimer } from "../../fakes/FakeTimer";

class SlowCatalog extends FakeAvdManager {
  constructor(readonly timer: FakeTimer) {
    super();
  }
  override async listInstalledSystemImages(apiLevel?: number, signal?: AbortSignal) {
    const images = await super.listInstalledSystemImages(apiLevel, signal);
    await this.timer.sleep(10_000);
    signal?.throwIfAborted();
    return images;
  }
}

afterEach(() => {
  setDeviceManager(null);
  setDeviceLockProbe(null);
  setOrientationReaderFactory(null);
  resetBootedDevicesResourceCache();
  resetDeviceToolsDependencies();
  invalidateAndroidInventoryProvenanceAndCatalog();
  AndroidAvdProvenanceCache.resetForTests();
});

describe("Android inventory read budgets", () => {
  test("8s booted response retains discovery and aborts unfinished enrichment without late mutation", async () => {
    const timer = new FakeTimer();
    const manager = new FakeDeviceUtils();
    manager.setBootedDevices("android", [
      { name: "Pixel_9", platform: "android", deviceId: "emulator-5554" },
    ]);
    const discover = manager.getBootedDevicesDetailed.bind(manager);
    manager.getBootedDevicesDetailed = async (platform, options) => {
      await timer.sleep(6_000);
      return discover(platform, options);
    };
    setDeviceManager(manager);
    let lockSignal: AbortSignal | undefined;
    let orientationSignal: AbortSignal | undefined;
    const lateLock = Promise.withResolvers<boolean>();
    const lateOrientation = Promise.withResolvers<"portrait">();
    setDeviceLockProbe(async () => {
      lockSignal = getAbortSignal();
      return lateLock.promise;
    });
    setOrientationReaderFactory(() => ({
      readOrientation: async (_device, signal) => {
        orientationSignal = signal;
        return lateOrientation.promise;
      },
    }));
    const pending = getBootedDevicesForPlatforms(["android"], timer);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await timer.advanceTimeAsync(8_000);
    const response = await pending;
    expect(response.devices).toHaveLength(1);
    expect(response).toMatchObject({
      enrichment: {
        complete: false,
        retryable: true,
        pending: expect.arrayContaining(["lock", "orientation"]),
      },
    });
    expect(lockSignal?.aborted).toBe(true);
    expect(orientationSignal?.aborted).toBe(true);
    const snapshot = JSON.stringify(response);
    lateLock.resolve(true);
    lateOrientation.resolve("portrait");
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(JSON.stringify(response)).toBe(snapshot);
  });

  test("listDevices flags a 2s configured-image fallback timeout and keeps known devices", async () => {
    const timer = new FakeTimer();
    const manager = new FakeDeviceUtils();
    manager.setBootedDevices("android", [
      { name: "Pixel_9", platform: "android", deviceId: "emulator-5554" },
    ]);
    manager.setListDeviceImagesHangs("android", true);
    setDeviceToolsDependencies({
      deviceManagerFactory: () => manager,
      avdManagerFactory: () => new FakeAvdManager(),
      timer,
    });
    const result = createListingHandlers().listDevicesHandler({ platform: "android" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    await timer.advanceTimeAsync(2_000);
    const response = await result;
    expect(response.structuredContent).toMatchObject({
      count: 1,
      enrichment: {
        complete: false,
        missing: ["configuredImages"],
        retryable: true,
        retryAfterMs: 1000,
      },
    });
  });

  test("9s images response is retryable and a late catalog completes the next read without new children", async () => {
    const timer = new FakeTimer();
    const manager = new FakeDeviceUtils();
    manager.setDeviceImages("android", [{ name: "Pixel_9", platform: "android" }]);
    const avds = new SlowCatalog(timer);
    const handler = createDeviceImageResourcesHandler({
      deviceManager: manager,
      avdManager: avds,
      timer,
    });
    const first = handler.getDeviceImagesForPlatforms(["android"]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await timer.advanceTimeAsync(9_000);
    const incomplete = await first;
    expect(incomplete.images).toHaveLength(1);
    expect(incomplete.catalogObservations.android?.error).toMatchObject({
      code: "timeout",
      retryable: true,
      retryAfterMs: 1_000,
      missing: ["catalog"],
    });
    expect(avds.getListInstalledSystemImagesCalls()[0].signal?.aborted).toBe(false);
    await timer.advanceTimeAsync(1_000);
    const complete = await handler.getDeviceImagesForPlatforms(["android"]);
    expect(complete.catalogComplete).toBe(true);
    expect(avds.getListInstalledSystemImagesCalls()).toHaveLength(1);
    expect(avds.getListDevicesCalls()).toHaveLength(1);
  });

  test("reset aborts background catalog children after a caller times out", async () => {
    const timer = new FakeTimer();
    const manager = new FakeDeviceUtils();
    const avds = new FakeAvdManager();
    avds.setListDevicesHangs(true);
    const handler = createDeviceImageResourcesHandler({
      deviceManager: manager,
      avdManager: avds,
      timer,
    });
    const first = handler.getDeviceImagesForPlatforms(["android"]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await timer.advanceTimeAsync(9_000);
    await first;
    expect(avds.getListDevicesCalls()[0].signal?.aborted).toBe(false);
    invalidateAndroidInventoryProvenanceAndCatalog();
    expect(avds.getListDevicesCalls()[0].signal?.aborted).toBe(true);
  });

  test("reset also aborts a pending shared provenance child", async () => {
    const timer = new FakeTimer();
    const manager = new FakeDeviceUtils();
    const avds = new FakeAvdManager();
    avds.setListDeviceImagesHangs(true);
    avds.setListDevicesHangs(true);
    const handler = createDeviceImageResourcesHandler({
      deviceManager: manager,
      avdManager: avds,
      timer,
    });
    const read = handler.getDeviceImagesForPlatforms(["android"]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await timer.advanceTimeAsync(9_000);
    await read;
    expect(avds.getListDeviceImagesCalls()[0].signal?.aborted).toBe(false);
    invalidateAndroidInventoryProvenanceAndCatalog();
    expect(avds.getListDeviceImagesCalls()[0].signal?.aborted).toBe(true);
  });

  test("30s hard cap aborts children without launching a second fetch for an expired waiter", async () => {
    const timer = new FakeTimer();
    const manager = new FakeDeviceUtils();
    const avds = new FakeAvdManager();
    avds.setListDevicesHangs(true);
    const handler = createDeviceImageResourcesHandler({
      deviceManager: manager,
      avdManager: avds,
      timer,
    });
    const first = handler.getDeviceImagesForPlatforms(["android"]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await timer.advanceTimeAsync(9_000);
    await first;
    const second = handler.getDeviceImagesForPlatforms(["android"]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await timer.advanceTimeAsync(9_000);
    await second;
    expect(avds.getListDevicesCalls()).toHaveLength(1);
    expect(avds.getListDevicesCalls()[0].signal?.aborted).toBe(false);
    await timer.advanceTimeAsync(12_000);
    expect(avds.getListDevicesCalls()[0].signal?.aborted).toBe(true);
  });
});
