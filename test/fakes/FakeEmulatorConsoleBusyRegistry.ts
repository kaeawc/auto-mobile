import type { EmulatorConsoleBusyRegistry } from "../../src/utils/android-cmdline-tools/EmulatorConsoleBusyRegistry";

/**
 * Deterministic test double for emulator console-exclusive operation state. Overlapping
 * runExclusive calls are reference-counted like the real registry
 * (test/contracts/EmulatorConsoleBusyRegistryContract.ts); setBusy is a manual override.
 */
export class FakeEmulatorConsoleBusyRegistry implements EmulatorConsoleBusyRegistry {
  private readonly busyDeviceIds = new Set<string>();
  private readonly exclusiveCounts = new Map<string, number>();
  private readonly exclusiveDeviceIds: string[] = [];
  private readonly generations = new Map<string, number>();

  setBusy(deviceId: string, busy: boolean): void {
    if (busy) {
      this.busyDeviceIds.add(deviceId);
    } else {
      this.busyDeviceIds.delete(deviceId);
    }
  }

  isBusy(deviceId: string): boolean {
    return this.busyDeviceIds.has(deviceId) || (this.exclusiveCounts.get(deviceId) ?? 0) > 0;
  }

  getGeneration(deviceId: string): number {
    return this.generations.get(deviceId) ?? 0;
  }

  getExclusiveDeviceIds(): string[] {
    return [...this.exclusiveDeviceIds];
  }

  async runExclusive<T>(deviceId: string, task: () => Promise<T>): Promise<T> {
    this.exclusiveDeviceIds.push(deviceId);
    this.exclusiveCounts.set(deviceId, (this.exclusiveCounts.get(deviceId) ?? 0) + 1);
    this.generations.set(deviceId, this.getGeneration(deviceId) + 1);
    try {
      return await task();
    } finally {
      const remaining = (this.exclusiveCounts.get(deviceId) ?? 1) - 1;
      if (remaining > 0) {
        this.exclusiveCounts.set(deviceId, remaining);
      } else {
        this.exclusiveCounts.delete(deviceId);
      }
      this.generations.set(deviceId, this.getGeneration(deviceId) + 1);
    }
  }
}
