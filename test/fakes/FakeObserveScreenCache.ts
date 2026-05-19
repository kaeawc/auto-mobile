import type { ObserveScreenCache } from "../../src/features/observe/interfaces/ObserveScreenCache";

/**
 * Fake ObserveScreenCache that records every clearForDevice call.
 * Lets tests assert cache invalidation without touching the real
 * process-wide stores backing RealObserveScreen.clearCache.
 */
export class FakeObserveScreenCache implements ObserveScreenCache {
  private readonly clearedDevices: string[] = [];

  clearForDevice(deviceId: string): void {
    this.clearedDevices.push(deviceId);
  }

  getClearedDevices(): string[] {
    return [...this.clearedDevices];
  }

  wasClearedFor(deviceId: string): boolean {
    return this.clearedDevices.includes(deviceId);
  }

  reset(): void {
    this.clearedDevices.length = 0;
  }
}
