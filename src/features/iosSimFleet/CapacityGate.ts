import { ActionableError } from "../../models/ActionableError";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import type { Timer } from "../../utils/SystemTimer";
import { BOOTED_STATE, type FleetCostSource } from "./FleetCostCollector";
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
  /**
   * A compatible booted simulator exists; reuse it instead of booting. From
   * `waitForCapacity` it is only returned once a new boot also fits the limit.
   */
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
  /**
   * Present when the wait admitted a boot: it counts toward the limit until
   * released, so concurrent waiters cannot all be admitted against one free
   * slot before the first boot shows up as Booted. Call once the boot ends.
   */
  releaseAdmission?: () => void;
}

export interface CapacityWaitOptions {
  signal?: AbortSignal;
  /** Absolute deadline on the gate's timer clock. */
  deadlineMs: number;
  /** UDID the admitted boot is for; counted as in flight until it reports Booted. */
  bootUdid?: string;
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
  /** Boots admitted by `waitForCapacity` and not yet released, keyed by admission token. */
  private readonly admittedBoots = new Map<symbol, string | undefined>();

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
    return this.decide(await this.refresh(), request, "substitute");
  }

  /**
   * Synchronous so a waiter can decide and record its admission without an interleaving.
   *
   * `substitute` is for a caller that uses the warm device instead of booting, so
   * a warm match wins even at capacity. `hint` is for a caller that boots its own
   * device regardless (`waitForCapacity`): there the limit is checked first and a
   * warm match is only reported once a boot fits, or it would push the fleet past
   * `maxBooted` (#11100).
   */
  private decide(
    report: FleetCostReport,
    request: WarmDeviceRequest | undefined,
    warmMatch: "substitute" | "hint",
  ): CapacityDecision {
    const warm = findWarmCompatibleDevices(report, request ?? {})[0];
    if (warm && warmMatch === "substitute") {
      return { outcome: "reuse-warm", udid: warm.udid };
    }
    const limits = this.limitsFor(report);
    const bootedCount = report.totals.bootedCount + this.inFlightBootCount(report);
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
    return warm
      ? { outcome: "reuse-warm", udid: warm.udid }
      : { outcome: "allow", limits, bootedCount };
  }

  async waitForCapacity(
    request: WarmDeviceRequest | undefined,
    options: CapacityWaitOptions,
  ): Promise<CapacityWaitResult> {
    const startedAt = this.timer.now();
    for (;;) {
      options.signal?.throwIfAborted();
      const report = await this.refreshWithin(options, startedAt);
      options.signal?.throwIfAborted();
      const decision = this.decide(report, request, "hint");
      const waitedMs = this.timer.now() - startedAt;
      if (decision.outcome !== "queue") {
        return { decision, waitedMs, timedOut: false, releaseAdmission: this.admit(options) };
      }
      if (this.timer.now() + decision.retryAfterMs > options.deadlineMs) {
        return { decision, waitedMs, timedOut: true };
      }
      await raceWithDeadline(this.timer.sleep(decision.retryAfterMs), {
        timer: this.timer,
        signal: options.signal,
        label: "Waiting for iOS simulator capacity",
      });
    }
  }

  /** A fleet sample bounded by the wait's deadline and cancellation. */
  private async refreshWithin(
    options: CapacityWaitOptions,
    startedAt: number,
  ): Promise<FleetCostReport> {
    const remainingMs = Math.floor(options.deadlineMs - this.timer.now());
    const timedOut = () =>
      new ActionableError(
        `Timed out after ${this.timer.now() - startedAt}ms collecting iOS simulator capacity.`,
      );
    if (remainingMs <= 0) {
      throw timedOut();
    }
    return await raceWithDeadline(() => this.refresh(), {
      timer: this.timer,
      timeoutMs: remainingMs,
      signal: options.signal,
      label: "Collecting iOS simulator capacity",
      timeoutError: timedOut,
    });
  }

  private admit(options: CapacityWaitOptions): () => void {
    const token = Symbol("ios-boot-admission");
    this.admittedBoots.set(token, options.bootUdid);
    return () => {
      this.admittedBoots.delete(token);
    };
  }

  /** Admitted boots that the latest sample does not already show as Booted. */
  private inFlightBootCount(report: FleetCostReport): number {
    const booted = new Set(
      report.simulators.filter((sim) => sim.state === BOOTED_STATE).map((sim) => sim.udid),
    );
    return [...this.admittedBoots.values()].filter((udid) => !udid || !booted.has(udid)).length;
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
