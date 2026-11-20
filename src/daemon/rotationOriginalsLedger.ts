import type { RotationRestoreState } from "../features/action/RotationSupport";

/**
 * Durable record of the rotation settings a device held before a session's first rotation write
 * (#18847). Session originals otherwise live only in memory, so a daemon crash or restart after a
 * default `rotate` would leave auto-rotate off. One record per device; the oldest one wins, since
 * it is the device's truer original.
 */
export interface RotationOriginalsLedger {
  /** Every stored record, keyed by device id. */
  loadAll(): Promise<ReadonlyMap<string, RotationRestoreState>>;
  /** Write-once: resolves false and keeps the stored record when the device already has one. */
  save(deviceId: string, state: RotationRestoreState): Promise<boolean>;
  /** Removes the device's record only when it equals `state`. */
  clear(deviceId: string, state: RotationRestoreState): Promise<void>;
  /** Removes the device's record whatever it holds; the device was removed or replaced. */
  remove(deviceId: string): Promise<void>;
}

/** Field-order independent identity of a restore state, for {@link RotationOriginalsLedger.clear}. */
export function sameRotationOriginals(a: RotationRestoreState, b: RotationRestoreState): boolean {
  return (
    a.accelerometerRotation === b.accelerometerRotation &&
    a.userRotation === b.userRotation &&
    a.deviceStateRotationLock === b.deviceStateRotationLock &&
    a.deviceStateRotationLockState === b.deviceStateRotationLockState
  );
}
