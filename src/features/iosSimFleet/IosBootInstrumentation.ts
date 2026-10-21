import type { IosBootInstrumentation, IosBootRequest } from "../../models/IosBootInstrumentation";
export type { IosBootInstrumentation, IosBootRequest };
import type { BootAdmissionResult } from "../bootAdmission/BootAdmissionGate";
import { logger, type Logger } from "../../utils/logger";
import type { Timer } from "../../utils/SystemTimer";
import { deviceResourceProfileFingerprint } from "../../utils/deviceResourceDrift";
import type { SimulatorWorkloadProfile } from "../../models/DeviceResourceReconciliation";
import type { BootDurationHistory } from "./BootDurationHistory";
import { assertCapacityGranted, type SimulatorCapacityGate } from "./CapacityGate";
import {
  BootReservationScope,
  type BootReservationOptions,
  type BootSlotReservation,
} from "../../devices/bootAdmission/BootSlotReservation";

/** iOS-only override of the boot admission gate switch (#11181); see `isBootCapacityGateEnabled`. */
export { IOS_SIM_CAPACITY_GATE_ENV } from "../bootAdmission/BootAdmissionGate";

/** Fingerprint of the empty profile: boots that requested no resource overrides share one identity. */
export function bootProfileId(profile?: SimulatorWorkloadProfile): string {
  return deviceResourceProfileFingerprint(profile ?? { resources: {} });
}

export interface FleetBootInstrumentationOptions {
  history: BootDurationHistory;
  timer: Pick<Timer, "now">;
  /** Absent means boots are never refused; durations are still recorded. */
  gate?: SimulatorCapacityGate;
  logger?: Pick<Logger, "info">;
}

/**
 * Records boot-to-ready durations keyed by workload profile and, when a gate is
 * supplied, refuses a boot at once while the fleet is at its derived limit. A
 * compatible warm simulator is never a reason to refuse.
 */
export class FleetBootInstrumentation implements IosBootInstrumentation {
  constructor(private readonly options: FleetBootInstrumentationOptions) {}

  async reserveBoot(options: BootReservationOptions): Promise<BootSlotReservation> {
    return this.options.gate
      ? this.options.gate.reserveBoot(options)
      : new BootReservationScope<void>().hold(
          () => {},
          () => {},
        );
  }

  async run<T>(request: IosBootRequest, boot: (remainingMs: number) => Promise<T>): Promise<T> {
    const { history, timer, gate } = this.options;
    const profileId = bootProfileId(request.profile);
    const releaseAdmission = gate ? await this.admit(gate, request, profileId) : undefined;
    const bootStartedAtMs = timer.now();
    let result: T;
    let bootFailed = true;
    try {
      result = await boot(request.timeoutMs);
      bootFailed = false;
    } finally {
      // The admitted boot counted toward the limit until now; the fleet sample takes over.
      releaseAdmission?.(bootFailed ? { bootFailed: true } : undefined);
    }
    const finishedAtMs = timer.now();
    history.record({
      reason: request.reason ?? "create",
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
  ): Promise<BootAdmissionResult<unknown>["releaseAdmission"]> {
    const result = await gate.admitBoot(
      { runtime: request.runtime, profileId, excludeUdids: [request.udid] },
      { signal: request.signal, bootUdid: request.udid, reason: request.reason },
    );
    assertCapacityGranted(result);
    if (result.decision.outcome === "reuse-warm") {
      // Never substitute a different simulator for the one requested; just do not refuse because of it.
      (this.options.logger ?? logger).info(
        `compatible warm simulator ${result.decision.udid} is booted; booting ${request.udid} as requested`,
      );
    }
    return result.releaseAdmission;
  }
}
