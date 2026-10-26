import type { FleetCostReport } from "../iosSimFleet/types";
import type { FleetCostSource } from "../iosSimFleet/FleetCostCollector";
import type { Timer } from "../../utils/SystemTimer";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
/**
 * Mean CPU (percent of one core) below which a template counts as quiet. A steady background
 * service such as pairedsyncd holds a booted simulator at about 10% (a 1-20% sawtooth) for
 * minutes and never stops, so a 5% instantaneous threshold made an idle host fail the build
 * (#15294).
 */
export const TEMPLATE_CPU_THRESHOLD_PERCENT = 15;
/** CPU is judged as the mean over this trailing window, so short-lived processes do not reset it. */
export const TEMPLATE_CPU_MEAN_WINDOW_MS = 60_000;
export const TEMPLATE_QUIET_WINDOW_MS = 120_000;
export const TEMPLATE_MAX_WAIT_MS = 900_000;
export interface SettleOptions {
  quietWindowMs: number;
  cpuThresholdPercent: number;
  maxWaitMs: number;
  /** Trailing window the CPU mean is taken over; absent or 0 judges each sample on its own. */
  cpuMeanWindowMs?: number;
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
    let samples: CpuSample[] = [];
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
      const cpu = measuredCpu(report, udid);
      const now = this.timer.now();
      // An unmeasured sample breaks the series: the window restarts rather than bridging a gap.
      samples =
        cpu === undefined
          ? []
          : [...samples, { atMs: now, cpu }].filter(
              (sample) => now - sample.atMs <= (options.cpuMeanWindowMs ?? 0),
            );
      const quiet = cpu !== undefined && meanCpu(samples) < options.cpuThresholdPercent;
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

interface CpuSample {
  atMs: number;
  cpu: number;
}

function meanCpu(samples: readonly CpuSample[]): number {
  return samples.reduce((sum, sample) => sum + sample.cpu, 0) / samples.length;
}

function measuredCpu(report: FleetCostReport, udid: string): number | undefined {
  const sim = report.simulators.find((entry) => entry.udid === udid);
  if (sim?.state !== "Booted" || sim.quality !== "measured") {
    return undefined;
  }
  const cpu = sim.process?.cpuPercent;
  return cpu !== undefined && Number.isFinite(cpu) ? cpu : undefined;
}
