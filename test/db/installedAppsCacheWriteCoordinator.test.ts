import { PerDeviceInstalledAppsCacheWriteCoordinator } from "../../src/db/installedAppsCacheWriteCoordinator";

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
});
