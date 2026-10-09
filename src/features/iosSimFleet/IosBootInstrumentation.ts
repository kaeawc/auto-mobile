import { logger } from "../../utils/logger";
import type { Timer } from "../../utils/SystemTimer";
import { deviceResourceProfileFingerprint } from "../../utils/deviceResourceDrift";
import type { SimulatorWorkloadProfile } from "../../models/DeviceResourceReconciliation";
import type { BootDurationHistory } from "./BootDurationHistory";
import { assertCapacityGranted, type SimulatorCapacityGate } from "./CapacityGate";

/** Opt-in switch for queueing simulator boots behind the fleet capacity gate. */
export const IOS_SIM_CAPACITY_GATE_ENV = "AUTOMOBILE_IOS_SIM_CAPACITY_GATE";

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
  /** Total budget for waiting on capacity plus the boot itself. */
  timeoutMs: number;
}

/** Seam the iOS boot path calls; swappable for a fake so boot tests stay hermetic. */
export interface IosBootInstrumentation {
  /** Runs `boot` with the budget left after any capacity wait and records a successful duration. */
  run<T>(request: IosBootRequest, boot: (remainingMs: number) => Promise<T>): Promise<T>;
}

export interface FleetBootInstrumentationOptions {
  history: BootDurationHistory;
  timer: Pick<Timer, "now">;
  /** Absent means boots are never queued; durations are still recorded. */
  gate?: SimulatorCapacityGate;
}

/**
 * Records boot-to-ready durations keyed by workload profile and, when a gate is
 * supplied, queues a boot only while the fleet is over its derived limit. A
 * compatible warm simulator is never a reason to queue.
 */
export class FleetBootInstrumentation implements IosBootInstrumentation {
  constructor(private readonly options: FleetBootInstrumentationOptions) {}

  async run<T>(request: IosBootRequest, boot: (remainingMs: number) => Promise<T>): Promise<T> {
    const { history, timer, gate } = this.options;
    const profileId = bootProfileId(request.profile);
    const startedAtMs = timer.now();
    if (gate) {
      await this.awaitCapacity(gate, request, profileId, startedAtMs);
    }
    const bootStartedAtMs = timer.now();
    // Only time spent queued for capacity is deducted; the unqueued path keeps the caller's budget.
    const waitedMs = gate ? bootStartedAtMs - startedAtMs : 0;
    const result = await boot(Math.max(1, request.timeoutMs - waitedMs));
    const finishedAtMs = timer.now();
    history.record({
      udid: request.udid,
      profileId,
      durationMs: finishedAtMs - bootStartedAtMs,
      recordedAtMs: finishedAtMs,
    });
    return result;
  }

  private async awaitCapacity(
    gate: SimulatorCapacityGate,
    request: IosBootRequest,
    profileId: string,
    startedAtMs: number,
  ): Promise<void> {
    const result = await gate.waitForCapacity(
      { runtime: request.runtime, profileId, excludeUdids: [request.udid] },
      { deadlineMs: startedAtMs + request.timeoutMs },
    );
    assertCapacityGranted(result);
    if (result.decision.outcome === "reuse-warm") {
      // Never substitute a different simulator for the one requested; just do not queue behind it.
      logger.info(
        `compatible warm simulator ${result.decision.udid} is booted; booting ${request.udid} as requested`,
      );
    }
  }
}
