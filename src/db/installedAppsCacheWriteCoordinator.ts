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
  invalidateWithoutWrite(deviceId: string): void;
  invalidate(deviceId: string, write: () => Promise<void>): Promise<void>;
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

  async commitRebuild(deviceId: string, generation: number, write: () => Promise<void>): Promise<boolean> {
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

  invalidateWithoutWrite(deviceId: string): void {
    const generation = (this.generations.get(deviceId) ?? 0) + 1;
    this.generations.set(deviceId, generation);
    // A failed stale-marker write leaves old DB rows physically fresh. Keep the
    // cache bypassed until ListInstalledApps successfully commits a replacement.
    this.dirtyGenerations.set(deviceId, generation);
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
