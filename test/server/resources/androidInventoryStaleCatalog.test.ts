import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  ANDROID_INVENTORY_BACKGROUND_CAP_MS,
  ANDROID_INVENTORY_RETRY_AFTER_MS,
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

// The first inventory read takes SLOW_INVENTORY_MS; later reads follow `refresh`.
function slowInventory(
  timer: FakeTimer,
  refresh: "succeed" | "hang" | "fail-slowly" = "succeed",
): FakeDeviceUtils {
  const manager = new FakeDeviceUtils();
  manager.setDeviceImages("android", [{ name: "Pixel_9", platform: "android", isRunning: false }]);
  const detailed = manager.getDeviceImagesDetailed.bind(manager);
  let calls = 0;
  manager.getDeviceImagesDetailed = async (platform, options) => {
    calls += 1;
    if (calls > 1 && refresh === "hang") {
      await timer.sleep(ANDROID_INVENTORY_BACKGROUND_CAP_MS * 4);
    }
    await timer.sleep(SLOW_INVENTORY_MS);
    if (calls > 1 && refresh === "fail-slowly") {
      throw new Error("adb hung up");
    }
    return detailed(platform, options);
  };
  return manager;
}

/** Advance the fake clock past the budget for a read and return its response. */
async function readAfterBudget(
  handler: ReturnType<typeof createDeviceImageResourcesHandler>,
  timer: FakeTimer,
) {
  const read = handler.getDeviceImagesForPlatforms(["android"]);
  await settle();
  await timer.advanceTimeAsync(ANDROID_PROVISIONING_CATALOG_BUDGET_MS);
  return await read;
}

/** First read times out; its background fetch completes at 12 s; returns the clock to 31 s. */
async function completeFirstFetchThenMissStage(
  handler: ReturnType<typeof createDeviceImageResourcesHandler>,
  timer: FakeTimer,
): Promise<void> {
  await readAfterBudget(handler, timer);
  await timer.advanceTimeAsync(SLOW_INVENTORY_MS + ANDROID_INVENTORY_STAGE_TTL_MS * 4);
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

  test("a completed background inventory is served stale, with its age, after the stage window", async () => {
    const timer = new FakeTimer();
    const handler = createDeviceImageResourcesHandler({
      deviceManager: slowInventory(timer),
      avdManager: tabletProfiles(),
      timer,
    });
    await completeFirstFetchThenMissStage(handler, timer);
    const response = await readAfterBudget(handler, timer);
    expect(response.catalogComplete).toBe(true);
    expect(response.images.map((image) => image.name)).toEqual(["Pixel_9"]);
    // Completed at 12 s, served at 40 s.
    expect(response.configuredInventory).toMatchObject({
      complete: false,
      observations: {
        android: {
          complete: false,
          error: {
            code: "timeout",
            retryable: true,
            retryAfterMs: ANDROID_INVENTORY_RETRY_AFTER_MS,
            missing: ["configuredInventory"],
            ageMs: 28_000,
          },
        },
      },
    });
  });

  test("the stale inventory is not cached as a complete result", async () => {
    const timer = new FakeTimer();
    const handler = createDeviceImageResourcesHandler({
      deviceManager: slowInventory(timer, "hang"),
      avdManager: tabletProfiles(),
      timer,
    });
    await completeFirstFetchThenMissStage(handler, timer);
    await readAfterBudget(handler, timer);
    let resolved = false;
    const next = handler.getDeviceImagesForPlatforms(["android"]).then((response) => {
      resolved = true;
      return response;
    });
    await settle();
    expect(resolved).toBe(false);
    await timer.advanceTimeAsync(ANDROID_PROVISIONING_CATALOG_BUDGET_MS);
    expect((await next).configuredInventory).toMatchObject({ complete: false });
  });

  test("a refresh that hits the hard cap stops the kept inventory being served", async () => {
    const timer = new FakeTimer();
    const handler = createDeviceImageResourcesHandler({
      deviceManager: slowInventory(timer, "hang"),
      avdManager: tabletProfiles(),
      timer,
    });
    await completeFirstFetchThenMissStage(handler, timer);
    // The refresh starts at 31 s and is capped at 61 s.
    await readAfterBudget(handler, timer);
    await timer.advanceTimeAsync(ANDROID_INVENTORY_BACKGROUND_CAP_MS);
    await settle();
    const response = await readAfterBudget(handler, timer);
    expect(response.images).toHaveLength(0);
    expect(response.configuredInventory.observations.android).toMatchObject({
      complete: false,
      error: { code: "timeout", retryable: true, retryAfterMs: ANDROID_INVENTORY_RETRY_AFTER_MS },
    });
    expect(response.configuredInventory.observations.android?.error?.ageMs).toBeUndefined();
  });

  test("a refresh that fails after the read budget stops the kept inventory being served", async () => {
    const timer = new FakeTimer();
    const handler = createDeviceImageResourcesHandler({
      deviceManager: slowInventory(timer, "fail-slowly"),
      avdManager: tabletProfiles(),
      timer,
    });
    await completeFirstFetchThenMissStage(handler, timer);
    // The refresh starts at 31 s and fails at 43 s; the next read comes after its stage.
    await readAfterBudget(handler, timer);
    await timer.advanceTimeAsync(SLOW_INVENTORY_MS);
    await settle();
    const response = await readAfterBudget(handler, timer);
    expect(response.images).toHaveLength(0);
    expect(response.configuredInventory.observations.android).toMatchObject({ complete: false });
    expect(response.configuredInventory.observations.android?.error?.ageMs).toBeUndefined();
  });

  test("a fresh catalog from the running refresh wins over the kept result's catalog", async () => {
    const timer = new FakeTimer();
    const avds = tabletProfiles();
    const handler = createDeviceImageResourcesHandler({
      deviceManager: slowInventory(timer),
      avdManager: avds,
      timer,
    });
    await completeFirstFetchThenMissStage(handler, timer);
    avds.setListDevicesResponse([{ id: "pixel_fold", name: "Pixel Fold", oem: "Google" }]);
    const response = await readAfterBudget(handler, timer);
    expect(response.configuredInventory).toMatchObject({ complete: false });
    expect(response.provisioningCatalog.profiles.map((profile) => profile.id)).toEqual([
      "pixel_fold",
    ]);
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
