/**
 * Orders installed-app cache writes per device and fences rebuilds that began
 * before a package mutation. The shutdown barrier tracks write lifetime; this
 * coordinator preserves cache coherence between otherwise concurrent readers
 * and mutations.
 */
export interface InstalledAppsCacheWriteCoordinator {
  beginRebuild(deviceId: string): number;
  commitRebuild(deviceId: string, generation: number, write: () => Promise<void>): Promise<boolean>;
  invalidate(deviceId: string, write: () => Promise<void>): Promise<void>;
}

export class PerDeviceInstalledAppsCacheWriteCoordinator implements InstalledAppsCacheWriteCoordinator {
  private generations = new Map<string, number>();
  private tails = new Map<string, Promise<unknown>>();

  beginRebuild(deviceId: string): number {
    return this.generations.get(deviceId) ?? 0;
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
    this.generations.set(deviceId, (this.generations.get(deviceId) ?? 0) + 1);
    await this.enqueue(deviceId, write);
  }

  private async enqueue<T>(deviceId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(deviceId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(work);
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
