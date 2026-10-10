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
  constructor(
    private readonly timer: Pick<Timer, "now"> & { advanceTime(ms: number): void },
    private decision: CapacityDecision,
    private readonly timesOut = false,
  ) {}

  async evaluateBoot(request?: WarmDeviceRequest): Promise<CapacityDecision> {
    this.requests.push(request);
    return this.decision;
  }

  async admitBoot(
    request: WarmDeviceRequest | undefined,
    options: CapacityAdmitOptions,
  ): Promise<CapacityAdmission> {
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
      releaseAdmission: () => {
        if (!released) {
          released = true;
          this.admitted -= 1;
        }
      },
    };
  }
}
