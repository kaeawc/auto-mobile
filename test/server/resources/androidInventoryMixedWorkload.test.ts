import { afterEach, beforeAll, expect, test } from "bun:test";
import { MultiPlatformDeviceManager } from "../../../src/devices/deviceUtils";
import { createListingHandlers } from "../../../src/server/deviceToolsListing";
import {
  setDeviceToolsDependencies,
  resetDeviceToolsDependencies,
} from "../../../src/server/deviceTools";
import {
  setDeviceManager,
  setDeviceLockProbe,
  setServiceStatusProbe,
  resetBootedDevicesResourceCache,
  getBootedDevicesForPlatforms,
} from "../../../src/server/bootedDeviceResources";
import {
  createDeviceImageResourcesHandler,
  resetAndroidDeviceImageResourceCache,
} from "../../../src/server/deviceImageResources";
import { AndroidAvdProvenanceCache } from "../../../src/utils/AndroidAvdProvenanceCache";
import { resetAdbClientCaches } from "../../../src/utils/android-cmdline-tools/AdbClient";
import { FakeAvdManager } from "../../fakes/FakeAvdManager";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeAndroidInventoryLoad } from "../../fakes/FakeAndroidInventoryLoad";

// This is a sequential three-read bound; each response is also below a 15s client deadline.
const MIXED_INVENTORY_SEQUENCE_BOUND_MS = 25_000;
class DelayedCatalog extends FakeAvdManager {
  constructor(
    readonly timer: FakeTimer,
    readonly slow: boolean,
  ) {
    super();
  }
  override async listInstalledSystemImages(apiLevel?: number, signal?: AbortSignal) {
    const result = await super.listInstalledSystemImages(apiLevel, signal);
    if (this.slow) {
      await this.timer.sleep(10_000);
    }
    signal?.throwIfAborted();
    return result;
  }
}
function fixture(slow = false) {
  const timer = new FakeTimer();
  const load = new FakeAndroidInventoryLoad(timer);
  const manager = new MultiPlatformDeviceManager(load.adb(null), null, load.emulator());
  const avds = new DelayedCatalog(timer, slow);
  avds.setListDeviceImagesResponse(load.images.map((image) => ({ name: image.name })));
  setDeviceManager(manager);
  setDeviceToolsDependencies({
    deviceManagerFactory: () => manager,
    avdManagerFactory: () => avds,
    timer,
  });
  const listing = createListingHandlers();
  const images = createDeviceImageResourcesHandler({
    deviceManager: manager,
    avdManager: avds,
    timer,
  });
  const sequence = async () => {
    const durations: number[] = [];
    let start = timer.now();
    const tool = await listing.listDevicesHandler({ platform: "android" });
    durations.push(timer.now() - start);
    start = timer.now();
    const booted = await getBootedDevicesForPlatforms(["android"], timer);
    durations.push(timer.now() - start);
    start = timer.now();
    const configured = await images.getDeviceImagesForPlatforms(["android"]);
    durations.push(timer.now() - start);
    return { tool, booted, configured, durations };
  };
  return { timer, load, avds, sequence };
}
function resetInventoryState(): void {
  setDeviceManager(null);
  setDeviceLockProbe(null);
  setServiceStatusProbe(null);
  resetDeviceToolsDependencies();
  resetBootedDevicesResourceCache();
  resetAndroidDeviceImageResourceCache();
  AndroidAvdProvenanceCache.resetForTests();
  resetAdbClientCaches();
}
// One idle inventory sequence pays the process's first-use module and JIT warm-up for the
// listing, booted-device and image handlers, which is not what these tests measure.
beforeAll(async () => {
  try {
    const { timer, sequence } = fixture();
    await timer.resolvePromise(sequence(), 1);
  } finally {
    resetInventoryState();
  }
});
afterEach(resetInventoryState);

test("five busy emulators retain inventory with retryable responses within the 25000ms sequence bound", async () => {
  const { timer, load, sequence } = fixture(true);
  const sessions = load.devices.map((device, index) =>
    load
      .adb(device)
      .executeCommand(
        index % 2 ? "shell screenrecord /fake/capture" : "exec-out screencap -p",
        60_000,
        undefined,
        true,
      ),
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  setDeviceLockProbe(async (device) => {
    await load.adb(device).executeCommand("shell fake-lock", 30_000, undefined, true);
    return false;
  });
  setServiceStatusProbe(async (device) => {
    await load.adb(device).executeCommand("shell fake-service", 30_000, undefined, true);
    return undefined;
  });
  const start = timer.now();
  const result = await timer.resolvePromise(sequence(), 100);
  console.info(
    `Mixed inventory sequence: ${timer.now() - start} FakeTimer ms; reads: ${result.durations.join(", ")} ms; bound: ${MIXED_INVENTORY_SEQUENCE_BOUND_MS} ms`,
  );
  expect(timer.now() - start).toBeLessThanOrEqual(MIXED_INVENTORY_SEQUENCE_BOUND_MS);
  expect(result.durations.every((duration) => duration < 15_000)).toBe(true);
  expect(result.tool.structuredContent).toMatchObject({
    count: 5,
    enrichment: { retryable: true },
  });
  expect(result.booted.devices).toHaveLength(5);
  expect(result.booted.enrichment).toMatchObject({ complete: false, retryable: true });
  expect(result.configured.images).toHaveLength(5);
  expect(result.configured.catalogObservations.android?.error).toMatchObject({
    code: "timeout",
    retryable: true,
  });
  await timer.resolvePromise(Promise.all(sessions), 100);
});

test("four concurrent full sequences execute each inventory enrichment command exactly once per freshness window", async () => {
  const { timer, load, avds, sequence } = fixture();
  const results = await timer.resolvePromise(Promise.all(Array.from({ length: 4 }, sequence)), 1);
  expect(
    results.every(
      (result) => result.booted.devices.length === 5 && result.configured.images.length === 5,
    ),
  ).toBe(true);
  for (const device of load.devices) {
    for (const command of [
      "emu avd name",
      "shell dumpsys SurfaceFlinger --display-id",
      "shell dumpsys display",
      "shell cmd device_state print-states",
    ]) {
      expect(load.count(device.deviceId, command)).toBe(1);
    }
  }
  expect(load.count("host", "emulator -list-avds")).toBe(1);
  expect(avds.getListDeviceImagesCalls()).toHaveLength(1);
  expect(avds.getListInstalledSystemImagesCalls()).toHaveLength(1);
  expect(avds.getListDevicesCalls()).toHaveLength(1);
});

test("the configured-image overlay probes AVD names without ABI, model or display commands", async () => {
  const timer = new FakeTimer();
  const load = new FakeAndroidInventoryLoad(timer);
  load.devices.push({
    name: "USB handset",
    platform: "android",
    deviceId: "physical-usb",
    observedAt: 1,
  });
  const manager = new MultiPlatformDeviceManager(load.adb(null), null, load.emulator());
  const discovery = await timer.resolvePromise(
    manager.getDeviceImagesDetailed("android", { coalesceInventoryEnrichment: true }),
    1,
  );
  expect(discovery.devices).toHaveLength(5);
  for (const device of load.devices) {
    expect(load.count(device.deviceId, "shell getprop ro.product.cpu.abi")).toBe(0);
    expect(load.count(device.deviceId, "shell getprop ro.product.model")).toBe(0);
    expect(load.count(device.deviceId, "shell dumpsys display")).toBe(0);
  }
});
