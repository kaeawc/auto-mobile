import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AndroidAvdProvenanceCache } from "../../src/utils/AndroidAvdProvenanceCache";
import { FakeAvdManager } from "../fakes/FakeAvdManager";
import { FakeTimer } from "../fakes/FakeTimer";

describe("AndroidAvdProvenanceCache", () => {
  beforeEach(() => {
    AndroidAvdProvenanceCache.resetForTests();
  });

  afterEach(() => {
    AndroidAvdProvenanceCache.resetForTests();
  });

  test("shares one slow provenance lookup across concurrent readers", async () => {
    const timer = new FakeTimer();
    const avdManager = new FakeAvdManager();
    avdManager.setListDeviceImagesResponse([{ name: "Pixel_9", path: "/tmp/Pixel_9.avd" }]);
    avdManager.setListDeviceImagesDelay(timer, 100);
    const cache = AndroidAvdProvenanceCache.getInstance();

    const first = cache.getByName(avdManager, timer);
    const second = cache.getByName(avdManager, timer);

    expect(avdManager.getListDeviceImagesCalls()).toHaveLength(1);
    timer.advanceTime(100);
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult).toBe(secondResult);
    expect(firstResult.get("Pixel_9")).toEqual({ name: "Pixel_9", path: "/tmp/Pixel_9.avd" });
  });

  test("fetches again after invalidation", async () => {
    const timer = new FakeTimer();
    const avdManager = new FakeAvdManager();
    avdManager.setListDeviceImagesResponse([{ name: "Pixel_9" }]);
    const cache = AndroidAvdProvenanceCache.getInstance();

    await cache.getByName(avdManager, timer);
    cache.invalidate();
    await cache.getByName(avdManager, timer);

    expect(avdManager.getListDeviceImagesCalls()).toHaveLength(2);
  });
});
