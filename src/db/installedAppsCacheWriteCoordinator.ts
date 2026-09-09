/**
 * Orders installed-app cache writes per device and fences rebuilds that began
 * before a package mutation. The shutdown barrier tracks write lifetime; this
 * coordinator preserves cache coherence between otherwise concurrent readers
 * and mutations.
 */
import { type DbWriteBarrier, getDbWriteBarrier } from "./dbWriteBarrier";

export interface InstalledAppsCacheWriteCoordinator {
  beginRebuild(deviceId: string): number;
  commitRebuild(deviceId: string, generation: number, write: () => Promise<void>): Promise<boolean>;
  isDirty(deviceId: string): boolean;
  markRebuilt(deviceId: string, generation: number): boolean;
  invalidateWithoutWrite(deviceId: string): number;
  invalidate(deviceId: string, write: () => Promise<void>): Promise<void>;
  /**
   * Permanently forgets a device identifier once the caller is certain it is
   * gone (e.g. after pool removal's final `invalidate()` has drained). Fences
   * out any rebuild whose captured generation predates this call, then only
   * deletes the per-device bookkeeping if nothing bumped the generation again
   * while this call was waiting on the device's write tail. Safe to call from
   * a hot path that reuses device ids: a reused id simply starts clean.
   */
  releaseDevice(deviceId: string): Promise<void>;
}

export class PerDeviceInstalledAppsCacheWriteCoordinator implements InstalledAppsCacheWriteCoordinator {
  private generations = new Map<string, number>();
  private dirtyGenerations = new Map<string, number>();
  private tails = new Map<string, Promise<unknown>>();

  constructor(private readonly getBarrier: () => DbWriteBarrier = getDbWriteBarrier) {}

  beginRebuild(deviceId: string): number {
    return this.generations.get(deviceId) ?? 0;
  }

  isDirty(deviceId: string): boolean {
    return this.dirtyGenerations.has(deviceId);
  }

  markRebuilt(deviceId: string, generation: number): boolean {
    if ((this.generations.get(deviceId) ?? 0) !== generation) {
      return false;
    }
    this.dirtyGenerations.delete(deviceId);
    return true;
  }

  async commitRebuild(
    deviceId: string,
    generation: number,
    write: () => Promise<void>,
  ): Promise<boolean> {
    return this.enqueue(deviceId, async () => {
      if ((this.generations.get(deviceId) ?? 0) !== generation) {
        return false;
      }
      await write();
      return true;
    });
  }

  async invalidate(deviceId: string, write: () => Promise<void>): Promise<void> {
    this.invalidateWithoutWrite(deviceId);
    try {
      await this.enqueue(deviceId, write);
    } finally {
      // A rebuild can begin after the first fence but before the DB stale-marker
      // commits. Bump again once that write settles so it cannot publish a
      // snapshot read from the old rows while it was in flight.
      this.invalidateWithoutWrite(deviceId);
    }
  }

  invalidateWithoutWrite(deviceId: string): number {
    const generation = (this.generations.get(deviceId) ?? 0) + 1;
    this.generations.set(deviceId, generation);
    // A failed stale-marker write leaves old DB rows physically fresh. Keep the
    // cache bypassed until ListInstalledApps successfully commits a replacement.
    this.dirtyGenerations.set(deviceId, generation);
    return generation;
  }

  async releaseDevice(deviceId: string): Promise<void> {
    // Fence: bump the generation the same way invalidate() does, so a rebuild
    // that already captured an older generation cannot later commit against
    // this device id even if it is reused before cleanup below runs.
    const fenceGeneration = this.invalidateWithoutWrite(deviceId);

    // Drain: wait behind any write already queued for this device (including
    // the final invalidate() write this call is expected to follow) before
    // treating the device as idle.
    await this.enqueue(deviceId, async () => undefined);

    // Delete only if no newer work bumped the generation again while this
    // call was waiting on the tail above (e.g. the device id was reused and
    // invalidated/rebuilt in the meantime). Leaving the entries in that case
    // keeps them for that newer generation instead of resetting it to 0.
    if (this.generations.get(deviceId) === fenceGeneration) {
      this.generations.delete(deviceId);
      this.dirtyGenerations.delete(deviceId);
    }
  }

  /**
   * Test-only diagnostic: number of device identifiers with any retained
   * bookkeeping (generation, dirty-generation, or in-flight tail). Not part
   * of the {@link InstalledAppsCacheWriteCoordinator} interface — production
   * callers have no use for it.
   */
  trackedDeviceCount(): number {
    const deviceIds = new Set<string>([
      ...this.generations.keys(),
      ...this.dirtyGenerations.keys(),
      ...this.tails.keys(),
    ]);
    return deviceIds.size;
  }

  private async enqueue<T>(deviceId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(deviceId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(work);
    // Register the whole queued lifetime before shutdown can start draining.
    // Individual DB writes may still use track() to skip after draining begins;
    // this makes a write already waiting behind a same-device predecessor
    // visible to drain.
    void this.getBarrier().trackExisting(next);
    this.tails.set(deviceId, next);
    try {
      return await next;
    } finally {
      if (this.tails.get(deviceId) === next) {
        this.tails.delete(deviceId);
      }
    }
  }
}

const sharedInstalledAppsCacheWriteCoordinator = new PerDeviceInstalledAppsCacheWriteCoordinator();

export function getInstalledAppsCacheWriteCoordinator(): InstalledAppsCacheWriteCoordinator {
  return sharedInstalledAppsCacheWriteCoordinator;
}
