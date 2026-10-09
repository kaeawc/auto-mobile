import { ActionableError } from "../../models/ActionableError";
import type { Timer } from "../../utils/SystemTimer";
import type { FleetCostSource } from "./FleetCostCollector";
import {
  estimatePerSimulatorBytes,
  findWarmCompatibleDevices,
  IOS_SIM_MAX_BOOTED_ENV,
  isPressured,
  resolveCapacityLimits,
  type CapacityLimits,
  type WarmDeviceRequest,
} from "./capacityPolicy";
import type { FleetCostReport, HostResources } from "./types";

const DEFAULT_RETRY_AFTER_MS = 5_000;
const DEFAULT_SUSTAINED_SAMPLES = 3;

export type CapacityDecision =
  /** A compatible booted simulator exists; reuse it instead of booting. */
  | { outcome: "reuse-warm"; udid: string }
  /** A new boot fits within capacity. */
  | { outcome: "allow"; limits: CapacityLimits; bootedCount: number }
  /** A new boot would exceed capacity or add to sustained host pressure; wait and re-ask. */
  | {
      outcome: "queue";
      reason: "at-capacity" | "sustained-pressure";
      limits: CapacityLimits;
      bootedCount: number;
      retryAfterMs: number;
      message: string;
    };

export interface CapacityWaitResult {
  decision: CapacityDecision;
  waitedMs: number;
  timedOut: boolean;
}

export interface CapacityWaitOptions {
  signal?: AbortSignal;
  /** Absolute deadline on the gate's timer clock. */
  deadlineMs: number;
}

/**
 * The small interface callers (e.g. the simulator preparation lifecycle) use to
 * ask whether an AutoMobile-owned simulator may be booted now. Read-only: it
 * never boots, shuts down or reconfigures anything.
 */
export interface SimulatorCapacityGate {
  evaluateBoot(request?: WarmDeviceRequest): Promise<CapacityDecision>;
  waitForCapacity(
    request: WarmDeviceRequest | undefined,
    options: CapacityWaitOptions,
  ): Promise<CapacityWaitResult>;
}

export interface CapacityGateOptions {
  env?: NodeJS.ProcessEnv;
  retryAfterMs?: number;
  /** Consecutive pressured samples before new boots are queued. */
  sustainedSamples?: number;
}

export class IosSimCapacityGate implements SimulatorCapacityGate {
  private readonly env: NodeJS.ProcessEnv;
  private readonly retryAfterMs: number;
  private readonly sustainedSamples: number;
  private pressuredStreak = 0;
  private latestReport: FleetCostReport | undefined;

  constructor(
    private readonly fleet: FleetCostSource,
    private readonly timer: Timer,
    options: CapacityGateOptions = {},
  ) {
    this.env = options.env ?? process.env;
    this.retryAfterMs = options.retryAfterMs ?? DEFAULT_RETRY_AFTER_MS;
    this.sustainedSamples = options.sustainedSamples ?? DEFAULT_SUSTAINED_SAMPLES;
  }

  /** Collect a fresh report and fold it into the pressure history. Used by the monitor too. */
  async refresh(): Promise<FleetCostReport> {
    const report = await this.fleet.collect();
    if (report !== this.latestReport) {
      // Single-flight collection can hand the same report to several callers; count it once.
      this.latestReport = report;
      this.pressuredStreak = isPressured(report.host) ? this.pressuredStreak + 1 : 0;
    }
    return report;
  }

  async evaluateBoot(request: WarmDeviceRequest = {}): Promise<CapacityDecision> {
    const report = await this.refresh();
    const warm = findWarmCompatibleDevices(report, request)[0];
    if (warm) {
      return { outcome: "reuse-warm", udid: warm.udid };
    }
    const limits = this.limitsFor(report);
    const bootedCount = report.totals.bootedCount;
    const queued = this.queueReason(report.host, bootedCount, limits);
    if (queued) {
      return {
        outcome: "queue",
        reason: queued.reason,
        limits,
        bootedCount,
        retryAfterMs: this.retryAfterMs,
        message: queued.message,
      };
    }
    return { outcome: "allow", limits, bootedCount };
  }

  async waitForCapacity(
    request: WarmDeviceRequest | undefined,
    options: CapacityWaitOptions,
  ): Promise<CapacityWaitResult> {
    const startedAt = this.timer.now();
    for (;;) {
      options.signal?.throwIfAborted();
      const decision = await this.evaluateBoot(request);
      const waitedMs = this.timer.now() - startedAt;
      if (decision.outcome !== "queue") {
        return { decision, waitedMs, timedOut: false };
      }
      if (this.timer.now() + decision.retryAfterMs > options.deadlineMs) {
        return { decision, waitedMs, timedOut: true };
      }
      await this.timer.sleep(decision.retryAfterMs);
    }
  }

  private limitsFor(report: FleetCostReport): CapacityLimits {
    if (!report.host) {
      // Without host numbers we cannot derive a limit; fall back to a single concurrent boot.
      return resolveCapacityLimits(this.env, { totalMemoryBytes: 0, cpuCount: 0 });
    }
    return resolveCapacityLimits(this.env, report.host, estimatePerSimulatorBytes(report));
  }

  private queueReason(
    host: HostResources | undefined,
    bootedCount: number,
    limits: CapacityLimits,
  ): { reason: "at-capacity" | "sustained-pressure"; message: string } | undefined {
    if (bootedCount >= limits.maxBooted) {
      return {
        reason: "at-capacity",
        message: `${bootedCount} simulator(s) booted; limit is ${limits.maxBooted} (${limits.source}). Shut one down or raise the limit with ${IOS_SIM_MAX_BOOTED_ENV}.`,
      };
    }
    if (bootedCount > 0 && this.pressuredStreak >= this.sustainedSamples) {
      return {
        reason: "sustained-pressure",
        message: `Host has been under memory/CPU pressure for ${this.pressuredStreak} consecutive samples (memory pressure: ${host?.memoryPressure ?? "unknown"}); deferring another boot.`,
      };
    }
    return undefined;
  }
}

/** Throws an actionable error when a wait ended without capacity. */
export function assertCapacityGranted(result: CapacityWaitResult): void {
  if (result.timedOut && result.decision.outcome === "queue") {
    throw new ActionableError(
      `Timed out after ${result.waitedMs}ms waiting for simulator capacity: ${result.decision.message}`,
    );
  }
}
