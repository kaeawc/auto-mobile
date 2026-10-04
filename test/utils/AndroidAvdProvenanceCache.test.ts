import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { AndroidAvdProvenanceCache } from "../../src/utils/AndroidAvdProvenanceCache";
import { FakeAvdManager } from "../fakes/FakeAvdManager";
import { FakeTimer } from "../fakes/FakeTimer";

import { logger } from "../../src/utils/logger";
import { resetAndroidDeviceImageResourceCache } from "../../src/server/deviceImageResources";

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

  test("caller deadline leaves the shared lookup running and publishes its late success", async () => {
    const timer = new FakeTimer();
    const manager = new FakeAvdManager();
    manager.setListDeviceImagesResponse([{ name: "Pixel_9" }]);
    manager.setListDeviceImagesDelay(timer, 3_000);
    const cache = new AndroidAvdProvenanceCache();
    const first = cache.getByName(manager, timer);
    await timer.advanceTimeAsync(2_000);
    expect((await first).size).toBe(0);
    expect(manager.getListDeviceImagesCalls()[0].signal?.aborted).toBe(false);
    await timer.advanceTimeAsync(1_000);
    expect((await cache.getByName(manager, timer)).has("Pixel_9")).toBe(true);
    expect(manager.getListDeviceImagesCalls()).toHaveLength(1);
    cache.invalidate();
  });

  test("failed lookup cools down for five seconds and invalidation clears the cooldown", async () => {
    const timer = new FakeTimer();
    let calls = 0;
    const manager = {
      listDeviceImages: async () => {
        calls++;
        throw new Error("JVM failed");
      },
    };
    const cache = new AndroidAvdProvenanceCache();
    await cache.getByName(manager, timer);
    await cache.getByName(manager, timer);
    expect(calls).toBe(1);
    timer.advanceTime(5_000);
    await cache.getByName(manager, timer);
    expect(calls).toBe(2);
    cache.invalidate();
    await cache.getByName(manager, timer);
    expect(calls).toBe(3);
  });

  test("hard cap and invalidation abort shared children", async () => {
    const timer = new FakeTimer();
    const manager = new FakeAvdManager();
    manager.setListDeviceImagesHangs(true);
    const cache = new AndroidAvdProvenanceCache();
    const first = cache.getByName(manager, timer);
    await timer.advanceTimeAsync(2_000);
    await first;
    expect(manager.getListDeviceImagesCalls()[0].signal?.aborted).toBe(false);
    await timer.advanceTimeAsync(28_000);
    expect(manager.getListDeviceImagesCalls()[0].signal?.aborted).toBe(true);
    cache.invalidate();
    const second = cache.getByName(manager, timer);
    cache.invalidate();
    await second;
    expect(manager.getListDeviceImagesCalls()[1].signal?.aborted).toBe(true);
  });
  test("invalidation settles the old flight before a replacement fetch starts", async () => {
    const timer = new FakeTimer();
    const manager = new FakeAvdManager();
    manager.setListDeviceImagesHangs(true);
    const cache = new AndroidAvdProvenanceCache();
    const first = cache.getByName(manager, timer);
    cache.invalidate();
    const second = cache.getByName(manager, timer);
    const immediateCalls = manager.getListDeviceImagesCalls().length;
    await new Promise<void>((resolve) => setImmediate(resolve));
    const settledCalls = manager.getListDeviceImagesCalls().length;
    cache.invalidate();
    await Promise.all([first, second]);
    expect(immediateCalls).toBe(1);
    expect(settledCalls).toBe(2);
  });
  test("six hot assignments preserve one slow provenance fetch and its publication", async () => {
    const timer = new FakeTimer();
    const manager = new FakeAvdManager();
    manager.setListDeviceImagesResponse([{ name: "Pixel_9" }]);
    manager.setListDeviceImagesDelay(timer, 3_000);
    const cache = AndroidAvdProvenanceCache.getInstance();
    const pending = cache.getByName(manager, timer, 4_000);
    for (let assignment = 0; assignment < 6; assignment++) {
      resetAndroidDeviceImageResourceCache();
    }
    const aborted = manager.getListDeviceImagesCalls()[0].signal?.aborted;
    await timer.advanceTimeAsync(3_000);
    const first = await pending;
    expect(aborted).toBe(false);
    expect(first.has("Pixel_9")).toBe(true);
    expect(await cache.getByName(manager, timer)).toBe(first);
    expect(manager.getListDeviceImagesCalls()).toHaveLength(1);
  });

  test.each([false, true])(
    "six elapsed caller waits are debug only and a shared failure warns once (unrelated logs: %p)",
    async (unrelatedLogs) => {
      const timer = new FakeTimer();
      const manager = new FakeAvdManager();
      manager.setListDeviceImagesHangs(true);
      const cache = new AndroidAvdProvenanceCache();
      const warn = spyOn(logger, "warn").mockImplementation(() => {});
      const debug = spyOn(logger, "debug").mockImplementation(() => {});
      let unrelatedLog: NodeJS.Immediate | undefined;
      try {
        if (unrelatedLogs) {
          // FakeTimer yields real event-loop turns while the shared logger spies are installed.
          unrelatedLog = setImmediate(() => {
            logger.warn("unrelated");
            logger.debug("unrelated");
          });
        }
        const reads = Array.from({ length: 6 }, () => cache.getByName(manager, timer));
        await timer.advanceTimeAsync(2_000);
        await Promise.all(reads);
        if (unrelatedLogs) {
          expect(warn).toHaveBeenCalledWith("unrelated");
          expect(debug).toHaveBeenCalledWith("unrelated");
        }
        const waitWarnings = warn.mock.calls.filter(([message]) =>
          message.startsWith("Android AVD provenance lookup failed"),
        ).length;
        const waitDebugs = debug.mock.calls.filter(([message]) =>
          message.startsWith("Android AVD provenance caller wait elapsed"),
        ).length;
        await timer.advanceTimeAsync(28_000);
        expect(waitWarnings).toBe(0);
        expect(waitDebugs).toBe(6);
        expect(
          warn.mock.calls.filter(([message]) =>
            message.startsWith("Android AVD provenance lookup failed"),
          ),
        ).toHaveLength(1);
      } finally {
        if (unrelatedLog !== undefined) {
          clearImmediate(unrelatedLog);
        }
        warn.mockRestore();
        debug.mockRestore();
        cache.invalidate();
      }
    },
  );
});
