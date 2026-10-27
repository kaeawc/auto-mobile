import {
  BootReservationScope,
  type BootReservationOptions,
  type BootSlotReservation,
} from "../../src/devices/bootAdmission/BootSlotReservation";
import { assertCapacityGranted } from "../../src/features/iosSimFleet/CapacityGate";
import type {
  CapacityDecision,
  CapacityAdmitOptions,
  CapacityAdmission,
  SimulatorCapacityGate,
} from "../../src/features/iosSimFleet/CapacityGate";
import type { WarmDeviceRequest } from "../../src/features/iosSimFleet/capacityPolicy";
import type { Timer } from "../../src/utils/SystemTimer";

/** Scripted gate: returns the scripted decision. */
export class FakeSimulatorCapacityGate implements SimulatorCapacityGate {
  requests: Array<WarmDeviceRequest | undefined> = [];
  admitOptions: CapacityAdmitOptions[] = [];
  /** Admissions handed out by `admitBoot` and not yet released. */
  admitted = 0;
  private readonly reservations = new BootReservationScope<CapacityAdmission>();
  releaseOutcomes: Parameters<NonNullable<CapacityAdmission["releaseAdmission"]>>[0][] = [];
  constructor(
    private readonly timer: Pick<Timer, "now"> & { advanceTime(ms: number): void },
    private decision: CapacityDecision,
    private readonly timesOut = false,
  ) {}

  async evaluateBoot(request?: WarmDeviceRequest): Promise<CapacityDecision> {
    this.requests.push(request);
    return this.decision;
  }

  async reserveBoot(options: BootReservationOptions): Promise<BootSlotReservation> {
    const admission = await this.admitBoot(undefined, { signal: options.signal });
    assertCapacityGranted(admission);
    return this.reservations.hold(
      () => admission,
      () => admission.releaseAdmission?.({ bootFailed: true }),
    );
  }

  async admitBoot(
    request: WarmDeviceRequest | undefined,
    options: CapacityAdmitOptions,
  ): Promise<CapacityAdmission> {
    options.signal?.throwIfAborted();
    const reserved = this.reservations.take(options.bootUdid);
    if (reserved) {
      return reserved;
    }
    this.requests.push(request);
    this.admitOptions.push(options);
    const result = { decision: this.decision };
    if (this.decision.outcome === "refuse") {
      return result;
    }
    this.admitted += 1;
    let released = false;
    return {
      ...result,
      releaseAdmission: (outcome) => {
        this.releaseOutcomes.push(outcome);
        if (!released) {
          released = true;
          this.admitted -= 1;
        }
      },
    };
  }
}
