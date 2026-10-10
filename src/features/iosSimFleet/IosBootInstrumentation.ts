import { logger } from "../../utils/logger";
import type { Timer } from "../../utils/SystemTimer";
import { deviceResourceProfileFingerprint } from "../../utils/deviceResourceDrift";
import type { SimulatorWorkloadProfile } from "../../models/DeviceResourceReconciliation";
import type { BootDurationHistory } from "./BootDurationHistory";
import { assertCapacityGranted, type SimulatorCapacityGate } from "./CapacityGate";

/** iOS-only override of the boot admission gate switch (#11181); see `isBootCapacityGateEnabled`. */
export { IOS_SIM_CAPACITY_GATE_ENV } from "../bootAdmission/BootAdmissionGate";

/** Fingerprint of the empty profile: boots that requested no resource overrides share one identity. */
export function bootProfileId(profile?: SimulatorWorkloadProfile): string {
  return deviceResourceProfileFingerprint(profile ?? { resources: {} });
}

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

export interface FleetBootInstrumentationOptions {
  history: BootDurationHistory;
  timer: Pick<Timer, "now">;
  /** Absent means boots are never refused; durations are still recorded. */
  gate?: SimulatorCapacityGate;
}

/**
 * Records boot-to-ready durations keyed by workload profile and, when a gate is
 * supplied, refuses a boot at once while the fleet is at its derived limit. A
 * compatible warm simulator is never a reason to refuse.
 */
export class FleetBootInstrumentation implements IosBootInstrumentation {
  constructor(private readonly options: FleetBootInstrumentationOptions) {}

  async run<T>(request: IosBootRequest, boot: (remainingMs: number) => Promise<T>): Promise<T> {
    const { history, timer, gate } = this.options;
    const profileId = bootProfileId(request.profile);
    const releaseAdmission = gate ? await this.admit(gate, request, profileId) : undefined;
    const bootStartedAtMs = timer.now();
    let result: T;
    try {
      result = await boot(request.timeoutMs);
    } finally {
      // The admitted boot counted toward the limit until now; the fleet sample takes over.
      releaseAdmission?.();
    }
    const finishedAtMs = timer.now();
    history.record({
      udid: request.udid,
      profileId,
      durationMs: finishedAtMs - bootStartedAtMs,
      recordedAtMs: finishedAtMs,
    });
    return result;
  }

  private async admit(
    gate: SimulatorCapacityGate,
    request: IosBootRequest,
    profileId: string,
  ): Promise<(() => void) | undefined> {
    const result = await gate.admitBoot(
      { runtime: request.runtime, profileId, excludeUdids: [request.udid] },
      { signal: request.signal, bootUdid: request.udid },
    );
    assertCapacityGranted(result);
    if (result.decision.outcome === "reuse-warm") {
      // Never substitute a different simulator for the one requested; just do not refuse because of it.
      logger.info(
        `compatible warm simulator ${result.decision.udid} is booted; booting ${request.udid} as requested`,
      );
    }
    return result.releaseAdmission;
  }
}
