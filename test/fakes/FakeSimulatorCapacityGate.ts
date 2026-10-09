import type {
  CapacityDecision,
  CapacityWaitOptions,
  CapacityWaitResult,
  SimulatorCapacityGate,
} from "../../src/features/iosSimFleet/CapacityGate";
import type { WarmDeviceRequest } from "../../src/features/iosSimFleet/capacityPolicy";
import type { Timer } from "../../src/utils/SystemTimer";

/** Scripted gate: returns queued decisions (advancing the timer) before the final decision. */
export class FakeSimulatorCapacityGate implements SimulatorCapacityGate {
  requests: Array<WarmDeviceRequest | undefined> = [];
  waitOptions: CapacityWaitOptions[] = [];
  /** Admissions handed out by `waitForCapacity` and not yet released. */
  admitted = 0;
  queuedWaitMs = 0;
  constructor(
    private readonly timer: Pick<Timer, "now"> & { advanceTime(ms: number): void },
    private decision: CapacityDecision,
    private readonly timesOut = false,
  ) {}

  async evaluateBoot(request?: WarmDeviceRequest): Promise<CapacityDecision> {
    this.requests.push(request);
    return this.decision;
  }

  async waitForCapacity(
    request: WarmDeviceRequest | undefined,
    options: CapacityWaitOptions,
  ): Promise<CapacityWaitResult> {
    this.requests.push(request);
    this.waitOptions.push(options);
    this.timer.advanceTime(this.queuedWaitMs);
    const result = {
      decision: this.decision,
      waitedMs: this.queuedWaitMs,
      timedOut: this.timesOut,
    };
    if (this.decision.outcome === "queue") {
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
