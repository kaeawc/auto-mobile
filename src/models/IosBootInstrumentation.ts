import type { SimulatorWorkloadProfile } from "./DeviceResourceReconciliation";

export interface IosBootRequest {
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
  /** Runs `boot` with the full budget once admitted and records a successful duration. */
  run<T>(request: IosBootRequest, boot: (remainingMs: number) => Promise<T>): Promise<T>;
}
