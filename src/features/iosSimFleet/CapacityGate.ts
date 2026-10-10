import { BootedDeviceDiscoveryIncompleteError } from "../../models/BootedDeviceDiscoveryIncompleteError";
import { logger } from "../../utils/logger";
import type { Timer } from "../../utils/SystemTimer";
import {
  assertBootCapacityGranted,
  atCapacityDecision,
  BootAdmissionLedger,
  DEFAULT_ADMISSION_RETRY_AFTER_MS,
  admitBootNow,
  type BootAdmissionResult,
  type BootCapacityChecker,
  type BootCapacityReporter,
  type BootCapacitySnapshot,
  type RefusedCapacityDecision,
} from "../bootAdmission/BootAdmissionGate";
import { occupyingUdids, type FleetCostSource } from "./FleetCostCollector";
import {
  estimatePerSimulatorBytes,
  findWarmCompatibleDevices,
  IOS_SIM_MAX_BOOTED_ENV,
  isPressured,
  resolveCapacityLimits,
  type CapacityLimits,
  type WarmDeviceRequest,
} from "./capacityPolicy";
import type { FleetCostReport } from "./types";

const DEFAULT_SUSTAINED_SAMPLES = 3;

export type CapacityDecision =
  /**
   * A compatible booted simulator exists; reuse it instead of booting. From
   * `admitBoot` it is only returned once a new boot also fits the limit.
   */
  | { outcome: "reuse-warm"; udid: string }
  /** A new boot fits within capacity. */
  | { outcome: "allow"; limits: CapacityLimits; bootedCount: number }
  /** A new boot would exceed the booted-device limit; refuse it. */
  | RefusedCapacityDecision;

/** `releaseAdmission` is present when the boot was admitted; call it once the boot ends. */
export type CapacityAdmission = BootAdmissionResult<CapacityDecision>;

export interface CapacityAdmitOptions {
  signal?: AbortSignal;
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
  admitBoot(
    request: WarmDeviceRequest | undefined,
    options: CapacityAdmitOptions,
  ): Promise<CapacityAdmission>;
}

export interface CapacityGateOptions {
  env?: NodeJS.ProcessEnv;
  retryAfterMs?: number;
  /** Consecutive pressured samples before `describeCapacity` reports sustained host pressure. */
  sustainedSamples?: number;
}

export class IosSimCapacityGate
  implements SimulatorCapacityGate, BootCapacityReporter, BootCapacityChecker
{
  private readonly env: NodeJS.ProcessEnv;
  private readonly retryAfterMs: number;
  private readonly sustainedSamples: number;
  private pressuredStreak = 0;
  private warnedLimit: string | undefined;
  private warnedHostUnreadable = false;
  private latestReport: FleetCostReport | undefined;
  /** UDIDs this process admitted a boot for; any other occupying simulator is external. */
  private readonly startedUdids = new Set<string>();
  /** Started UDIDs a sample has shown occupying a slot: only these can be seen leaving. */
  private readonly seenStartedUdids = new Set<string>();
  /** Boots admitted by `admitBoot` and not yet released. */
  private readonly admittedBoots: BootAdmissionLedger;

  constructor(
    private readonly fleet: FleetCostSource,
    private readonly timer: Timer,
    options: CapacityGateOptions = {},
  ) {
    this.env = options.env ?? process.env;
    this.retryAfterMs = options.retryAfterMs ?? DEFAULT_ADMISSION_RETRY_AFTER_MS;
    this.sustainedSamples = options.sustainedSamples ?? DEFAULT_SUSTAINED_SAMPLES;
    this.admittedBoots = new BootAdmissionLedger(timer);
  }

  /** Collect a fresh report and fold it into the pressure history. Used by the monitor too. */
  async refresh(): Promise<FleetCostReport> {
    const report = await this.fleet.collect();
    this.foldIntoPressureHistory(report);
    return report;
  }

  private foldIntoPressureHistory(report: FleetCostReport): void {
    if (report !== this.latestReport) {
      // Single-flight collection can hand the same report to several callers; count it once.
      this.latestReport = report;
      this.pressuredStreak = isPressured(report.host) ? this.pressuredStreak + 1 : 0;
    }
  }

  async evaluateBoot(request: WarmDeviceRequest = {}): Promise<CapacityDecision> {
    return this.decide(await this.refresh(), request, "substitute");
  }

  /**
   * Synchronous so a waiter can decide and record its admission without an interleaving.
   *
   * `substitute` is for a caller that uses the warm device instead of booting, so
   * a warm match wins even at capacity. `hint` is for a caller that boots its own
   * device regardless (`admitBoot`): there the limit is checked first and a
   * warm match is only reported once a boot fits, or it would push the fleet past
   * `maxBooted` (#11100).
   */
  private decide(
    report: FleetCostReport,
    request: WarmDeviceRequest | undefined,
    warmMatch: "substitute" | "hint",
    bootUdid?: string,
  ): CapacityDecision {
    this.assertCountKnown(report);
    const warm = findWarmCompatibleDevices(report, request ?? {})[0];
    if (warm && warmMatch === "substitute") {
      return { outcome: "reuse-warm", udid: warm.udid };
    }
    const limits = this.limitsFor(report);
    // The boot's own target (already Booting or Booted) needs no new slot.
    const occupied = occupyingUdids(report, bootUdid);
    this.forgetExitedStarted(report);
    const bootedCount = occupied.length + this.inFlightBootCount(report);
    const refused = atCapacityDecision(bootedCount, limits, this.retryAfterMs, {
      noun: "simulator",
      envName: IOS_SIM_MAX_BOOTED_ENV,
      externalDevices: occupied.filter((udid) => !this.startedUdids.has(udid)),
    });
    // Owner decision (#11209): host pressure is reported, never a reason to refuse a boot.
    if (refused) {
      return refused;
    }
    return warm
      ? { outcome: "reuse-warm", udid: warm.udid }
      : { outcome: "allow", limits, bootedCount };
  }

  async admitBoot(
    request: WarmDeviceRequest | undefined,
    options: CapacityAdmitOptions,
  ): Promise<CapacityAdmission> {
    return await admitBootNow<FleetCostReport, CapacityDecision>({
      timer: this.timer,
      signal: options.signal,
      label: "iOS simulator capacity",
      sample: () => this.refresh(),
      decide: (report) => this.decide(report, request, "hint", options.bootUdid),
      admit: () => {
        if (options.bootUdid) {
          this.startedUdids.add(options.bootUdid);
        }
        return this.admittedBoots.admit(options.bootUdid).release;
      },
    });
  }

  /**
   * Refuses with `capacity_exhausted` when booting a simulator would be refused now; admits nothing.
   * A warm simulator is not a substitute here: the caller boots its own device.
   */
  async assertCapacityAvailable(): Promise<void> {
    // A capacity check is not a boot decision: it must not advance the sustained-pressure streak.
    const report = await this.fleet.collect();
    assertCapacityGranted({ decision: this.decide(report, undefined, "hint") });
  }

  /** Current limit, booted simulators (every Booted one, owned or not) and admitted boots in flight. */
  async describeCapacity(): Promise<BootCapacitySnapshot> {
    // A listing is not a boot decision: reading must not advance the sustained-pressure streak.
    const report = await this.fleet.collect();
    this.assertCountKnown(report);
    return {
      limit: this.limitsFor(report).maxBooted,
      booted: occupyingUdids(report).length,
      inFlight: this.inFlightBootCount(report),
      hostPressure: {
        sustained: this.pressuredStreak >= this.sustainedSamples,
        consecutiveSamples: this.pressuredStreak,
        memoryPressure: report.host?.memoryPressure ?? "unknown",
      },
    };
  }

  /**
   * With `simctl list` failed the booted count is unknown; zero would admit past the limit.
   * Refuse with retryable `discovery_incomplete`, as the Android gate does (#11280).
   */
  private assertCountKnown(report: FleetCostReport): void {
    if (!report.inventoryFailed) {
      return;
    }
    const detail = report.errors.join("; ") || "simctl list failed";
    logger.warn(`[BootAdmission] iOS simulator count unknown; refusing to boot: ${detail}`);
    throw new BootedDeviceDiscoveryIncompleteError("ios", {
      code: "failed",
      message: `simulator count unknown (${detail})`,
      retryable: true,
    });
  }

  /**
   * Forget a started UDID once a sample showed it occupying a slot and then not, so a later
   * external boot of the same simulator is not named as ours.
   */
  private forgetExitedStarted(report: FleetCostReport): void {
    const occupied = new Set(occupyingUdids(report));
    for (const udid of this.startedUdids) {
      if (occupied.has(udid)) {
        this.seenStartedUdids.add(udid);
      } else if (this.seenStartedUdids.delete(udid)) {
        this.startedUdids.delete(udid);
      }
    }
  }

  /** Admitted boots that the latest sample does not already show as occupying a slot. */
  private inFlightBootCount(report: FleetCostReport): number {
    return this.admittedBoots.inFlightCount(new Set(occupyingUdids(report)));
  }

  private limitsFor(report: FleetCostReport): CapacityLimits {
    if (!report.host) {
      // Without host numbers we cannot derive a limit; fall back to a single concurrent boot.
      // A failed `ps` no longer lands here: its snapshot still carries the os totals (#11389).
      if (!this.warnedHostUnreadable) {
        this.warnedHostUnreadable = true;
        logger.warn("[BootAdmission] host resources unreadable; limiting simulator boots to 1");
      }
      return this.warnOnUnusableLimit(
        resolveCapacityLimits(this.env, { totalMemoryBytes: 0, cpuCount: 0 }),
      );
    }
    return this.warnOnUnusableLimit(
      resolveCapacityLimits(this.env, report.host, estimatePerSimulatorBytes(report)),
    );
  }

  /** Log an unusable `AUTOMOBILE_IOS_SIM_MAX_BOOTED` once per distinct warning, as Android does. */
  private warnOnUnusableLimit(limits: CapacityLimits): CapacityLimits {
    if (limits.warning && limits.warning !== this.warnedLimit) {
      this.warnedLimit = limits.warning;
      logger.warn(`[BootAdmission] ${limits.warning}`);
    }
    return limits;
  }
}

/**
 * Throws the typed retryable `capacity_exhausted` error
 * (`BootCapacityExhaustedError`) when a wait ended without capacity.
 */
export function assertCapacityGranted(result: CapacityAdmission): void {
  assertBootCapacityGranted(result, "ios", "simulator");
}
