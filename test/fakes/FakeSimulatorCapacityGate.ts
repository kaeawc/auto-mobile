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
    _options: CapacityWaitOptions,
  ): Promise<CapacityWaitResult> {
    this.requests.push(request);
    this.timer.advanceTime(this.queuedWaitMs);
    return { decision: this.decision, waitedMs: this.queuedWaitMs, timedOut: this.timesOut };
  }
}
