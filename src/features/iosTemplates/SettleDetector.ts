import type { FleetCostReport } from "../iosSimFleet/types";
import type { FleetCostSource } from "../iosSimFleet/FleetCostCollector";
import type { Timer } from "../../utils/SystemTimer";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
export const TEMPLATE_CPU_THRESHOLD_PERCENT = 5;
export const TEMPLATE_QUIET_WINDOW_MS = 120_000;
export const TEMPLATE_MAX_WAIT_MS = 900_000;
export interface SettleOptions {
  quietWindowMs: number;
  cpuThresholdPercent: number;
  maxWaitMs: number;
  signal?: AbortSignal;
}
export interface SettleDetector {
  waitUntilSettled(udid: string, options: SettleOptions): Promise<void>;
}
export class FleetSettleDetector implements SettleDetector {
  constructor(
    private readonly source: Pick<FleetCostSource, "collectFresh">,
    private readonly timer: Timer,
    private readonly pollMs = 5_000,
  ) {}
  async waitUntilSettled(udid: string, options: SettleOptions): Promise<void> {
    const deadlineMs = this.timer.now() + options.maxWaitMs;
    let quietSince: number | undefined;
    while (this.timer.now() <= deadlineMs) {
      options.signal?.throwIfAborted();
      const remaining = deadlineMs - this.timer.now();
      if (remaining <= 0) {
        break;
      }
      const report = await raceWithDeadline(
        () => this.source.collectFresh({ signal: options.signal, deadlineMs }),
        {
          timer: this.timer,
          timeoutMs: remaining,
          signal: options.signal,
          label: "Template settle collection",
        },
      );
      const quiet = isQuiet(report, udid, options.cpuThresholdPercent);
      quietSince = quiet ? (quietSince ?? this.timer.now()) : undefined;
      if (quietSince !== undefined && this.timer.now() - quietSince >= options.quietWindowMs) {
        return;
      }
      const remainingMs = deadlineMs - this.timer.now();
      if (remainingMs <= 0) {
        break;
      }
      await raceWithDeadline(this.timer.sleep(Math.min(this.pollMs, remainingMs)), {
        timer: this.timer,
        signal: options.signal,
        label: "Template settle poll",
      });
    }
    throw new Error(`Simulator ${udid} did not settle before the deadline`);
  }
}

function isQuiet(report: FleetCostReport, udid: string, threshold: number): boolean {
  const sim = report.simulators.find((entry) => entry.udid === udid);
  if (sim?.state !== "Booted" || sim.quality !== "measured") {
    return false;
  }
  const cpu = sim.process?.cpuPercent;
  return cpu !== undefined && Number.isFinite(cpu) && cpu < threshold;
}
