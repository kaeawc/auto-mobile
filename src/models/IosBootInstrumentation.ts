import type { SimulatorWorkloadProfile } from "./DeviceResourceReconciliation";

export interface BootSlotReservation {
  run<T>(operation: () => Promise<T>): Promise<T>;
  /**
   * After verified deletion, rebind the local slot and best-effort clear the old peer identity.
   * Registry-clear failures must not throw or abort replacement: retain the slot for boot.
   * A stale peer record keeps the old id until hand-off and may undercount if its serial is reused.
   */
  markReplacedDeviceGone(): void;
  /** Idempotent. Releases an unconsumed slot; the boot owns a consumed slot. */
  release(): void;
}

export interface BootReservationOptions {
  reason?: BootAdmissionReason;
  replacingDeviceId?: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface BootCapacityReserver {
  reserveBoot(options: BootReservationOptions): Promise<BootSlotReservation>;
}

export type BootAdmissionReason = "reset" | "create" | "restart";

export interface IosBootRequest {
  reason?: BootAdmissionReason;
  udid: string;
  /** Simctl runtime identifier of the simulator being booted, when known. */
  runtime?: string;
  /** Resource profile the boot is for; omitted means no overrides were requested. */
  profile?: SimulatorWorkloadProfile;
  /** Budget for the boot itself; a platform at capacity is refused before it starts. */
  timeoutMs: number;
  /** Cancels the capacity check (the boot path's ambient request signal). */
  signal?: AbortSignal;
}

/** Seam the iOS boot path calls; swappable for a fake so boot tests stay hermetic. */
export interface IosBootInstrumentation {
  reserveBoot?: BootCapacityReserver["reserveBoot"];
  /** Runs `boot` with the full budget once admitted and records a successful duration. */
  run<T>(request: IosBootRequest, boot: (remainingMs: number) => Promise<T>): Promise<T>;
}
