/**
 * Tracks daemon-owned emulator console operations that prevent a concurrent
 * `emu avd name` probe from answering. The marker is process-local: a console
 * is shared only by work running in this daemon process.
 */
export interface EmulatorConsoleBusyRegistry {
  /** Whether this daemon currently owns a console-exclusive operation for the serial. */
  isBusy(deviceId: string): boolean;
  /** Changes whenever a daemon-owned console-exclusive operation starts or settles. */
  getGeneration(deviceId: string): number;
  /** Keep the serial marked busy until `task` settles, including failures. */
  runExclusive<T>(deviceId: string, task: () => Promise<T>): Promise<T>;
}

/** In-memory, reference-counted implementation for concurrent console operations. */
export class InMemoryEmulatorConsoleBusyRegistry implements EmulatorConsoleBusyRegistry {
  private readonly busyCounts = new Map<string, number>();
  private readonly generations = new Map<string, number>();

  isBusy(deviceId: string): boolean {
    return (this.busyCounts.get(deviceId) ?? 0) > 0;
  }

  getGeneration(deviceId: string): number {
    return this.generations.get(deviceId) ?? 0;
  }

  async runExclusive<T>(deviceId: string, task: () => Promise<T>): Promise<T> {
    this.busyCounts.set(deviceId, (this.busyCounts.get(deviceId) ?? 0) + 1);
    this.generations.set(deviceId, this.getGeneration(deviceId) + 1);
    try {
      return await task();
    } finally {
      const remaining = (this.busyCounts.get(deviceId) ?? 1) - 1;
      if (remaining > 0) {
        this.busyCounts.set(deviceId, remaining);
      } else {
        this.busyCounts.delete(deviceId);
      }
      this.generations.set(deviceId, this.getGeneration(deviceId) + 1);
    }
  }
}

/** Shared by the daemon's snapshot actions and the pool's discovery funnel. */
export const defaultEmulatorConsoleBusyRegistry = new InMemoryEmulatorConsoleBusyRegistry();
