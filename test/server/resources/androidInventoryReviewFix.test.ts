import { afterEach, expect, test } from "bun:test";
import {
  createDeviceImageResourcesHandler,
  resetAndroidDeviceImageResourceCache,
  invalidateAndroidInventoryProvenanceAndCatalog,
} from "../../../src/server/deviceImageResources";
import { configuredImagesForBootedPlatform } from "../../../src/server/bootedDeviceResources";
import { configuredImagesForBootedDevices } from "../../../src/server/deviceTools";
import { AndroidAvdProvenanceCache } from "../../../src/utils/AndroidAvdProvenanceCache";
import { FakeAvdManager } from "../../fakes/FakeAvdManager";
import { FakeDeviceUtils } from "../../fakes/FakeDeviceUtils";
import { FakeTimer } from "../../fakes/FakeTimer";

import { createListingHandlers } from "../../../src/server/deviceToolsListing";
import {
  setDeviceToolsDependencies,
  resetDeviceToolsDependencies,
} from "../../../src/server/deviceTools";
import { MultiPlatformDeviceManager } from "../../../src/devices/deviceUtils";
import {
  AdbClient,
  resetAdbClientCaches,
} from "../../../src/utils/android-cmdline-tools/AdbClient";
import { AndroidEmulatorClient } from "../../../src/utils/android-cmdline-tools/AndroidEmulatorClient";
import { createExecResult } from "../../../src/utils/execResult";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeAvdConfigReader } from "../../fakes/FakeAvdConfigReader";

import { getStructuredField } from "../../../src/utils/toolUtils";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
afterEach(() => {
  invalidateAndroidInventoryProvenanceAndCatalog();
  AndroidAvdProvenanceCache.resetForTests();
  resetDeviceToolsDependencies();
  resetAdbClientCaches();
});

function catalogFixture(budgetMs = 40_000) {
  const timer = new FakeTimer();
  const avds = new FakeAvdManager();
  avds.setListDevicesHangs(true);
  const handler = createDeviceImageResourcesHandler({
    timer,
    avdManager: avds,
    deviceManager: new FakeDeviceUtils(),
    androidCatalogBudgetMs: budgetMs,
  });
  return { timer, avds, handler };
}

test("hot reset preserves a running catalog and allows its late stage publication", async () => {
  const timer = new FakeTimer();
  const avds = new FakeAvdManager();
  const original = avds.listDevices.bind(avds);
  avds.listDevices = async (signal) => {
    const result = await original(signal);
    await timer.sleep(5_000);
    signal?.throwIfAborted();
    return result;
  };
  const handler = createDeviceImageResourcesHandler({
    timer,
    avdManager: avds,
    deviceManager: new FakeDeviceUtils(),
  });
  const first = handler.getDeviceImagesForPlatforms(["android"]);
  await tick();
  resetAndroidDeviceImageResourceCache();
  const aborted = avds.getListDevicesCalls()[0].signal?.aborted;
  await timer.advanceTimeAsync(5_000);
  await first;
  expect(aborted).toBe(false);
  expect((await handler.getDeviceImagesForPlatforms(["android"])).catalogComplete).toBe(true);
  expect(avds.getListDevicesCalls()).toHaveLength(1);
});

test("invalidation reports supersession without claiming a 30000ms timeout", async () => {
  const { handler, avds, timer } = catalogFixture();
  const read = handler.getDeviceImagesForPlatforms(["android"]);
  await tick();
  await timer.advanceTimeAsync(7);
  invalidateAndroidInventoryProvenanceAndCatalog();
  const result = await read;
  expect(avds.getListDevicesCalls()[0].signal?.aborted).toBe(true);
  expect(result.catalogObservations.android?.error).toMatchObject({
    code: "superseded",
    retryable: true,
  });
  expect(result.catalogObservations.android?.error?.message).not.toContain("30000ms");
});

test("real background hard cap reports timeout at the actual 30000ms cap", async () => {
  const { handler, avds, timer } = catalogFixture();
  const read = handler.getDeviceImagesForPlatforms(["android"]);
  await tick();
  await timer.advanceTimeAsync(30_000);
  expect((await read).catalogObservations.android?.error).toMatchObject({
    code: "timeout",
    retryable: true,
  });
  expect(timer.now()).toBe(30_000);
  expect(avds.getListDevicesCalls()[0].signal?.aborted).toBe(true);
});

test("a genuine catalog failure retains its failed code and cause", async () => {
  const timer = new FakeTimer();
  const avds = new FakeAvdManager();
  avds.listDevices = async () => {
    await timer.sleep(7);
    throw new Error("profile parse failed");
  };
  const handler = createDeviceImageResourcesHandler({
    timer,
    avdManager: avds,
    deviceManager: new FakeDeviceUtils(),
  });
  const read = handler.getDeviceImagesForPlatforms(["android"]);
  await tick();
  await timer.advanceTimeAsync(7);
  expect((await read).catalogObservations.android?.error).toMatchObject({
    code: "failed",
    message: expect.stringContaining("profile parse failed"),
  });
});

test("persistent missing cmdline-tools provenance is non-retryable on repeated listings", async () => {
  const timer = new FakeTimer();
  const avds = new FakeAvdManager();
  let calls = 0;
  avds.listDeviceImages = async () => {
    calls++;
    throw new Error("Android command line tools not found. Please install Android SDK manually.");
  };
  const manager = new FakeDeviceUtils();
  const booted = [{ name: "Pixel_9", platform: "android" as const, deviceId: "emulator-5554" }];
  manager.setBootedDevices("android", booted);
  setDeviceToolsDependencies({
    deviceManagerFactory: () => manager,
    avdManagerFactory: () => avds,
    timer,
  });
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = await createListingHandlers().listDevicesHandler({ platform: "android" });
    expect(getStructuredField(result, "enrichment")).toMatchObject({
      complete: false,
      missing: ["provenance"],
      retryable: false,
      reason: expect.stringContaining("Android command line tools not found"),
    });
  }
  expect(calls).toBe(1);
});

test("in-flight provenance is retryable and completed provenance omits enrichment", async () => {
  const timer = new FakeTimer();
  const avds = new FakeAvdManager();
  avds.setListDeviceImagesDelay(timer, 3_000);
  const manager = new FakeDeviceUtils();
  const booted = [{ name: "Pixel_9", platform: "android" as const, deviceId: "emulator-5554" }];
  const read = configuredImagesForBootedDevices(manager, avds, booted, timer);
  await tick();
  await timer.advanceTimeAsync(2_000);
  expect((await read).enrichment).toMatchObject({ retryable: true });
  await timer.advanceTimeAsync(1_000);
  expect(
    (await configuredImagesForBootedDevices(manager, avds, booted, timer)).enrichment,
  ).toBeUndefined();
});

test("configured platform fallback arms exactly one 2s deadline", async () => {
  const timer = new FakeTimer();
  const manager = new FakeDeviceUtils();
  manager.setListDeviceImagesHangs("ios", true);
  const read = configuredImagesForBootedPlatform("ios", manager, timer, undefined);
  const deadlines = timer.getPendingTimeouts().filter((ms) => ms === 2_000).length;
  await timer.advanceTimeAsync(2_000);
  await read;
  expect(deadlines).toBe(1);
});

test("inventory discovery expires at 2s with retry hints while the pool shares 5s ADB success", async () => {
  const timer = new FakeTimer();
  let calls = 0;
  const adb = new AdbClient(
    null,
    async () => {
      calls++;
      await timer.sleep(5_000);
      return createExecResult("List of devices attached\nemulator-5554\tdevice\n", "");
    },
    null,
    undefined,
    timer,
  );
  const fake = new FakeAdbExecutor();
  fake.getBootedAndroidDevices = (options) => adb.getBootedAndroidDevices(options);
  fake.setCommandResponse("emu avd name", createExecResult("Pixel_9\nOK", ""));
  const emulator = new AndroidEmulatorClient(
    async () => createExecResult("Pixel_9", ""),
    null,
    timer,
    new FakeAdbClientFactory(fake),
    new FakeAvdConfigReader(),
  );
  const manager = new MultiPlatformDeviceManager(fake, null, emulator);
  const inventory = manager.getBootedDevicesDetailed("android", {
    coalesceInventoryEnrichment: true,
  });
  const pool = adb.getBootedAndroidDevices();
  await tick();
  await timer.advanceTimeAsync(2_000);
  const incomplete = await inventory;
  expect(incomplete.succeededPlatforms.has("android")).toBe(false);
  expect(incomplete.discoveryErrors?.android).toMatchObject({
    code: "timeout",
    retryable: true,
    retryAfterMs: 1000,
  });
  await timer.advanceTimeAsync(3_000);
  expect(await pool).toHaveLength(1);
  expect(
    (
      await manager.getBootedDevicesDetailed("android", {
        coalesceInventoryEnrichment: true,
        skipAndroidNameEnrichment: true,
      })
    ).devices,
  ).toHaveLength(1);
  expect(calls).toBe(1);
});
