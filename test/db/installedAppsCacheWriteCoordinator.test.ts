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
});
