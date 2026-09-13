import type { EmulatorConsoleBusyRegistry } from "../../src/utils/android-cmdline-tools/EmulatorConsoleBusyRegistry";

/** Deterministic test double for emulator console-exclusive operation state. */
export class FakeEmulatorConsoleBusyRegistry implements EmulatorConsoleBusyRegistry {
  private readonly busyDeviceIds = new Set<string>();
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
    return this.busyDeviceIds.has(deviceId);
  }

  getGeneration(deviceId: string): number {
    return this.generations.get(deviceId) ?? 0;
  }

  getExclusiveDeviceIds(): string[] {
    return [...this.exclusiveDeviceIds];
  }

  async runExclusive<T>(deviceId: string, task: () => Promise<T>): Promise<T> {
    this.exclusiveDeviceIds.push(deviceId);
    this.setBusy(deviceId, true);
    this.generations.set(deviceId, this.getGeneration(deviceId) + 1);
    try {
      return await task();
    } finally {
      this.setBusy(deviceId, false);
      this.generations.set(deviceId, this.getGeneration(deviceId) + 1);
    }
  }
}
