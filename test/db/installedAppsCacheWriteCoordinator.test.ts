import { PerDeviceInstalledAppsCacheWriteCoordinator } from "../../src/db/installedAppsCacheWriteCoordinator";
import { InMemoryDbWriteBarrier } from "../../src/db/dbWriteBarrier";

describe("PerDeviceInstalledAppsCacheWriteCoordinator", () => {
  test("does not let a rebuild started before an invalidation restore fresh rows", async () => {
    const coordinator = new PerDeviceInstalledAppsCacheWriteCoordinator();
    const deviceId = "device-1";
    const generation = coordinator.beginRebuild(deviceId);
    let releaseFirstWrite: (() => void) | undefined;
    const firstWriteStarted = new Promise<void>(resolve => {
      releaseFirstWrite = resolve;
    });
    let releaseFirstWriteCompletion: (() => void) | undefined;
    const firstWriteCompletion = new Promise<void>(resolve => {
      releaseFirstWriteCompletion = resolve;
    });
    const writes: string[] = [];

    const rebuild = coordinator.commitRebuild(deviceId, generation, async () => {
      writes.push("rebuild");
      releaseFirstWrite?.();
      await firstWriteCompletion;
    });
    await firstWriteStarted;

    const invalidation = coordinator.invalidate(deviceId, async () => {
      writes.push("invalidate");
    });
    releaseFirstWriteCompletion?.();

    await expect(rebuild).resolves.toBe(true);
    await invalidation;
    expect(writes).toEqual(["rebuild", "invalidate"]);

    coordinator.invalidateWithoutWrite(deviceId);
    const staleRebuild = coordinator.commitRebuild(deviceId, generation, async () => {
      writes.push("stale-rebuild");
    });
    await expect(staleRebuild).resolves.toBe(false);
    expect(writes).toEqual(["rebuild", "invalidate"]);
  });

  test("fences a rebuild that starts while an invalidation write is in flight", async () => {
    const coordinator = new PerDeviceInstalledAppsCacheWriteCoordinator();
    const deviceId = "device-2";
    let releaseInvalidation: (() => void) | undefined;
    const invalidationStarted = new Promise<void>(resolve => {
      releaseInvalidation = resolve;
    });
    let releaseInvalidationWrite: (() => void) | undefined;
    const invalidationWrite = new Promise<void>(resolve => {
      releaseInvalidationWrite = resolve;
    });

    const invalidation = coordinator.invalidate(deviceId, async () => {
      releaseInvalidation?.();
      await invalidationWrite;
    });
    await invalidationStarted;

    const generationDuringInvalidation = coordinator.beginRebuild(deviceId);
    const rebuild = coordinator.commitRebuild(deviceId, generationDuringInvalidation, async () => {
      throw new Error("A stale rebuild must not commit");
    });
    releaseInvalidationWrite?.();

    await invalidation;
    await expect(rebuild).resolves.toBe(false);
  });

  test("fences a rebuild that starts while a cache clear is in flight", async () => {
    const coordinator = new PerDeviceInstalledAppsCacheWriteCoordinator();
    const deviceId = "device-3";
    let releaseClear: (() => void) | undefined;
    const clearStarted = new Promise<void>(resolve => {
      releaseClear = resolve;
    });
    let finishClear: (() => void) | undefined;
    const clearFinished = new Promise<void>(resolve => {
      finishClear = resolve;
    });

    const clear = coordinator.invalidate(deviceId, async () => {
      releaseClear?.();
      await clearFinished;
    });
    await clearStarted;

    const rebuild = coordinator.commitRebuild(deviceId, coordinator.beginRebuild(deviceId), async () => {
      throw new Error("A rebuild started before a cache clear must not commit");
    });
    finishClear?.();

    await clear;
    await expect(rebuild).resolves.toBe(false);
  });

  test("registers writes queued behind another write before shutdown drains", async () => {
    const barrier = new InMemoryDbWriteBarrier();
    const coordinator = new PerDeviceInstalledAppsCacheWriteCoordinator(() => barrier);
    let releaseFirst: (() => void) | undefined;
    const firstStarted = new Promise<void>(resolve => {
      releaseFirst = resolve;
    });
    let finishFirst: (() => void) | undefined;
    const firstFinished = new Promise<void>(resolve => {
      finishFirst = resolve;
    });
    const writes: string[] = [];

    const first = coordinator.invalidate("device-4", async () => {
      writes.push("first");
      releaseFirst?.();
      await firstFinished;
    });
    await firstStarted;
    const second = coordinator.invalidate("device-4", async () => {
      writes.push("second");
    });

    expect(barrier.inFlightCount()).toBe(2);
    const drain = barrier.drain(1_000);
    finishFirst?.();

    await expect(drain).resolves.toBe(true);
    await Promise.all([first, second]);
    expect(writes).toEqual(["first", "second"]);
  });
});
