/** Missing observations required to confirm absence without intervening presence. */
export const MISSING_DEVICE_MISS_THRESHOLD = 3;

export type MissingDeviceObservation = "present" | "missing" | "source-unavailable";

/**
 * The device pool's view of the shared miss streak (#11808): refresh and
 * assignment liveness record observations and reset a device's streak, and
 * never see the counts the disconnect monitor keeps.
 */
export interface DeviceLossMissPort {
  observe(
    deviceId: string,
    observation: MissingDeviceObservation,
  ): { misses: number; confirmedGone: boolean };
  reset(deviceId: string): void;
}

/**
 * Single owner of the per-device miss streak shared by the disconnect monitor
 * and the pool's refresh, so both count one streak (#11808).
 */
export class DeviceLossMisses implements DeviceLossMissPort {
  private readonly missesByDevice = new Map<string, number>();

  get size(): number {
    return this.missesByDevice.size;
  }

  get(deviceId: string): number | undefined {
    return this.missesByDevice.get(deviceId);
  }

  has(deviceId: string): boolean {
    return this.missesByDevice.has(deviceId);
  }

  deviceIds(): IterableIterator<string> {
    return this.missesByDevice.keys();
  }

  set(deviceId: string, misses: number): void {
    this.missesByDevice.set(deviceId, misses);
  }

  reset(deviceId: string): void {
    this.missesByDevice.delete(deviceId);
  }

  /** A failed source supplies no evidence either way: hold until presence or another miss. */
  observe(
    deviceId: string,
    observation: MissingDeviceObservation,
  ): { misses: number; confirmedGone: boolean } {
    if (observation === "source-unavailable") {
      return { misses: this.missesByDevice.get(deviceId) ?? 0, confirmedGone: false };
    }
    if (observation === "present") {
      this.missesByDevice.delete(deviceId);
      return { misses: 0, confirmedGone: false };
    }
    const misses = Math.min(
      (this.missesByDevice.get(deviceId) ?? 0) + 1,
      MISSING_DEVICE_MISS_THRESHOLD,
    );
    this.missesByDevice.set(deviceId, misses);
    return { misses, confirmedGone: misses >= MISSING_DEVICE_MISS_THRESHOLD };
  }
}
