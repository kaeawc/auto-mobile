import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  ANDROID_INVENTORY_STAGE_TTL_MS,
  ANDROID_PROVISIONING_CATALOG_BUDGET_MS,
  createDeviceImageResourcesHandler,
  invalidateAndroidInventoryProvenanceAndCatalog,
} from "../../../src/server/deviceImageResources";
import { AndroidAvdProvenanceCache } from "../../../src/utils/AndroidAvdProvenanceCache";
import { FakeAvdManager } from "../../fakes/FakeAvdManager";
import { FakeDeviceUtils } from "../../fakes/FakeDeviceUtils";
import { FakeTimer } from "../../fakes/FakeTimer";

// A configured-device inventory slower than the per-read budget but under the background cap.
const SLOW_INVENTORY_MS = 12_000;

function slowInventory(timer: FakeTimer): FakeDeviceUtils {
  const manager = new FakeDeviceUtils();
  manager.setDeviceImages("android", [{ name: "Pixel_9", platform: "android", isRunning: false }]);
  const detailed = manager.getDeviceImagesDetailed.bind(manager);
  manager.getDeviceImagesDetailed = async (platform, options) => {
    await timer.sleep(SLOW_INVENTORY_MS);
    return detailed(platform, options);
  };
  return manager;
}

function tabletProfiles(): FakeAvdManager {
  const avds = new FakeAvdManager();
  avds.setListDevicesResponse([{ id: "pixel_tablet", name: "Pixel Tablet", oem: "Google" }]);
  return avds;
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function resetInventoryState(): void {
  invalidateAndroidInventoryProvenanceAndCatalog();
  AndroidAvdProvenanceCache.resetForTests();
}

beforeEach(resetInventoryState);
afterEach(resetInventoryState);

// #19437: a slow configured-device inventory must not keep the catalog incomplete forever.
describe("Android device-image catalog with a slow configured inventory", () => {
  test("the creatable-profile catalog does not wait on the configured-device inventory", async () => {
    const timer = new FakeTimer();
    const handler = createDeviceImageResourcesHandler({
      deviceManager: slowInventory(timer),
      avdManager: tabletProfiles(),
      timer,
    });
    const read = handler.getDeviceImagesForPlatforms(["android"]);
    await settle();
    await timer.advanceTimeAsync(ANDROID_PROVISIONING_CATALOG_BUDGET_MS);
    const response = await read;
    expect(response.catalogComplete).toBe(true);
    expect(response.provisioningCatalog.profiles.map((profile) => profile.id)).toEqual([
      "pixel_tablet",
    ]);
    expect(response.configuredInventory).toMatchObject({ complete: false });
  });

  test("a completed background inventory is served to a reader that arrives after the stage window", async () => {
    const timer = new FakeTimer();
    const manager = slowInventory(timer);
    const handler = createDeviceImageResourcesHandler({
      deviceManager: manager,
      avdManager: tabletProfiles(),
      timer,
    });
    const first = handler.getDeviceImagesForPlatforms(["android"]);
    await settle();
    await timer.advanceTimeAsync(ANDROID_PROVISIONING_CATALOG_BUDGET_MS);
    expect((await first).images).toHaveLength(0);
    // The background fetch completes at 12 s; the next read comes long after the stage expired.
    await timer.advanceTimeAsync(SLOW_INVENTORY_MS + ANDROID_INVENTORY_STAGE_TTL_MS * 4);
    const later = handler.getDeviceImagesForPlatforms(["android"]);
    await settle();
    await timer.advanceTimeAsync(ANDROID_PROVISIONING_CATALOG_BUDGET_MS);
    const response = await later;
    expect(response.catalogComplete).toBe(true);
    expect(response.configuredInventory).toMatchObject({ complete: true });
    expect(response.images.map((image) => image.name)).toEqual(["Pixel_9"]);
  });

  test("lifecycle invalidation drops the last complete inventory", async () => {
    const timer = new FakeTimer();
    const handler = createDeviceImageResourcesHandler({
      deviceManager: slowInventory(timer),
      avdManager: tabletProfiles(),
      timer,
    });
    const first = handler.getDeviceImagesForPlatforms(["android"]);
    await settle();
    await timer.advanceTimeAsync(ANDROID_PROVISIONING_CATALOG_BUDGET_MS);
    await first;
    await timer.advanceTimeAsync(SLOW_INVENTORY_MS);
    invalidateAndroidInventoryProvenanceAndCatalog();
    const later = handler.getDeviceImagesForPlatforms(["android"]);
    await settle();
    await timer.advanceTimeAsync(ANDROID_PROVISIONING_CATALOG_BUDGET_MS);
    const response = await later;
    expect(response.images).toHaveLength(0);
    expect(response.configuredInventory).toMatchObject({ complete: false });
  });
});
