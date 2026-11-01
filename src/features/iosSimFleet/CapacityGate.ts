import {
  BootReservationScope,
  type BootCapacityReserver,
  type BootReservationOptions,
  type BootSlotReservation,
  type BootAdmissionReason,
} from "../../devices/bootAdmission/BootSlotReservation";
import { BootedDeviceDiscoveryIncompleteError } from "../../models/BootedDeviceDiscoveryIncompleteError";
import { logger } from "../../utils/logger";
import { defaultRandom, type Random } from "../../utils/Random";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import type { Timer } from "../../utils/SystemTimer";
import {
  assertBootCapacityGranted,
  atCapacityDecision,
  BootAdmissionLedger,
  DEFAULT_ADMISSION_RETRY_AFTER_MS,
  DEFAULT_SAMPLE_TIMEOUT_MS,
  admitBootNow,
  type BootAdmissionResult,
  type BootCapacityChecker,
  type BootCapacityReporter,
  type BootCapacitySnapshot,
  type LedgerSampleWindow,
  type LedgerAdmission,
  type RefusedCapacityDecision,
} from "../bootAdmission/BootAdmissionGate";
import { occupyingUdids, type FleetCostSource } from "./FleetCostCollector";
import {
  estimatePerSimulatorBytes,
  findWarmCompatibleDevices,
  IOS_SIM_MAX_BOOTED_ENV,
  isPressured,
  resolveCapacityLimits,
  type IosCapacityLimits,
  type CapacityLimits,
  type WarmDeviceRequest,
} from "./capacityPolicy";
import { BootConcurrencyGate, type BootConcurrencyPool } from "./BootConcurrencyGate";
import type { FleetCostReport } from "./types";

const DEFAULT_SUSTAINED_SAMPLES = 3;

export type CapacityDecision =
  /**
   * A compatible booted simulator exists; reuse it instead of booting. From
   * `admitBoot` it is only returned once a new boot also fits the limit.
   */
  | { outcome: "reuse-warm"; udid: string }
  /** A new boot fits within capacity. */
  | { outcome: "allow"; limits: IosCapacityLimits; bootedCount: number }
  /** A new boot would exceed the booted-device limit; refuse it. */
  | RefusedCapacityDecision;

/** `releaseAdmission` is present when the boot was admitted; call it once the boot ends. */
export type CapacityAdmission = BootAdmissionResult<CapacityDecision>;

export interface CapacityAdmitOptions {
  reason?: BootAdmissionReason;
  signal?: AbortSignal;
  /** UDID the admitted boot is for; counted as in flight until it reports Booted. */
  bootUdid?: string;
}

/**
 * The small interface callers (e.g. the simulator preparation lifecycle) use to
 * ask whether an AutoMobile-owned simulator may be booted now. Read-only: it
 * never boots, shuts down or reconfigures anything.
 */
export interface SimulatorCapacityGate extends BootCapacityReserver {
  evaluateBoot(request?: WarmDeviceRequest): Promise<CapacityDecision>;
  admitBoot(
    request: WarmDeviceRequest | undefined,
    options: CapacityAdmitOptions,
  ): Promise<CapacityAdmission>;
}

/** Read-only ownership view; refresh is lazy and decisions use its synchronous snapshot. */
export interface IosSimulatorOwnershipReader {
  refresh(): Promise<void>;
  isAutoMobileOwned(udid: string): boolean;
}

type OwnershipFleetReport = FleetCostReport & { ownershipReadFailed?: boolean };

export interface CapacityGateOptions {
  ownership?: IosSimulatorOwnershipReader;
  bootGate?: BootConcurrencyPool;
  env?: NodeJS.ProcessEnv;
  retryAfterMs?: number;
  /** Consecutive pressured samples before `describeCapacity` reports sustained host pressure. */
  sustainedSamples?: number;
  /** The ledger of admitted boots; injectable so a test can watch its sample windows. */
  ledger?: BootAdmissionLedger;
  /** Jitters the retry hint of a timed-out sample so concurrent callers do not retry in lock-step. */
  random?: Random;
}

const CAPACITY_LABEL = "iOS simulator capacity";

export class IosSimCapacityGate
  implements SimulatorCapacityGate, BootCapacityReporter, BootCapacityChecker, BootCapacityReserver
{
  private readonly optionsOwnership: IosSimulatorOwnershipReader | undefined;
  private readonly env: NodeJS.ProcessEnv;
  private readonly retryAfterMs: number;
  private readonly sustainedSamples: number;
  private readonly random: Random;
  private pressuredStreak = 0;
  private readonly bootGate: BootConcurrencyPool;
  private warnedBootConcurrency: string | undefined;
  private warnedLimit: string | undefined;
  private warnedHostUnreadable = false;
  private latestReport: FleetCostReport | undefined;
  /** UDIDs this process admitted a boot for, supplementing durable/session ownership. */
  private readonly startedUdids = new Set<string>();
  /** Started UDIDs a sample has shown occupying a slot: only these can be seen leaving. */
  private readonly seenStartedUdids = new Set<string>();
  /** Admissions and successful releases since each UDID last became ours. */
  private readonly bootsByUdid = new Map<string, { unreleased: number; succeeded: boolean }>();
  /** Boots admitted by `admitBoot` and not yet released. */
  private readonly admittedBoots: BootAdmissionLedger;
  private readonly reservations = new BootReservationScope<CapacityAdmission>();

  constructor(
    private readonly fleet: FleetCostSource,
    private readonly timer: Timer,
    options: CapacityGateOptions = {},
  ) {
    this.bootGate = options.bootGate ?? new BootConcurrencyGate();
    this.optionsOwnership = options.ownership;
    this.env = options.env ?? process.env;
    this.retryAfterMs = options.retryAfterMs ?? DEFAULT_ADMISSION_RETRY_AFTER_MS;
    this.sustainedSamples = options.sustainedSamples ?? DEFAULT_SUSTAINED_SAMPLES;
    this.random = options.random ?? defaultRandom;
    this.admittedBoots = options.ledger ?? new BootAdmissionLedger(timer);
  }

  /**
   * Collect a fresh report and fold it into the pressure history. Used by the monitor too.
   * `sampleTimeoutMs` is the caller's sample budget, starting now; it defaults to the gate's.
   */
  async refresh(
    options: { fresh?: boolean; sampleTimeoutMs?: number } = {},
  ): Promise<FleetCostReport> {
    // A fresh run ends by the same absolute deadline as the caller's sample race, across both its
    // phases, so one abandoned by a lost race cannot outlive it and stack under retries (#13801,
    // #14496).
    const report = await (options.fresh
      ? this.fleet.collectFresh({
          deadlineMs: this.timer.now() + (options.sampleTimeoutMs ?? DEFAULT_SAMPLE_TIMEOUT_MS),
        })
      : this.fleet.collect());
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

  /** Labels are best effort; the reader retains its last good snapshot when refresh fails. */
  private async refreshOwnership(report: FleetCostReport): Promise<OwnershipFleetReport> {
    try {
      await this.optionsOwnership?.refresh();
      return report;
    } catch (error) {
      logger.warn(
        "[BootAdmission] iOS ownership could not be read; using retained ownership labels",
        error,
      );
      return { ...report, ownershipReadFailed: true };
    }
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
    report: OwnershipFleetReport,
    request: WarmDeviceRequest | undefined,
    warmMatch: "substitute" | "hint",
    {
      bootUdid,
      window,
      carriesOwnSlot,
    }: { bootUdid?: string; window?: LedgerSampleWindow; carriesOwnSlot?: boolean } = {},
  ): CapacityDecision {
    this.assertCountKnown(report);
    const heldUdids = report.simulators
      .filter((sim) => this.optionsOwnership?.isAutoMobileOwned(sim.udid))
      .map((sim) => sim.udid);
    const warmRequest =
      warmMatch === "hint"
        ? { ...request, excludeUdids: [...(request?.excludeUdids ?? []), ...heldUdids] }
        : (request ?? {});
    const warm = findWarmCompatibleDevices(report, warmRequest)[0];
    if (warm && warmMatch === "substitute") {
      return { outcome: "reuse-warm", udid: warm.udid };
    }
    const limits = this.limitsFor(report, window);
    // The boot's own target (already Booting or Booted) needs no new slot.
    const occupied = occupyingUdids(report, bootUdid);
    this.forgetExitedStarted(report);
    const bootedCount = occupied.length + this.inFlightBootCount(report, bootUdid, window);
    // A replacement of an occupying target retains its slot even above the limit.
    if (carriesOwnSlot) {
      return { outcome: "allow", limits, bootedCount };
    }
    const owned = new Set([...this.startedUdids, ...heldUdids]);
    const refused = atCapacityDecision(bootedCount, this.countLimits(limits), this.retryAfterMs, {
      noun: "simulator",
      envName: IOS_SIM_MAX_BOOTED_ENV,
      externalDevices: occupied.filter((udid) => !owned.has(udid)),
      heldDevices: occupied.filter((udid) => owned.has(udid)),
      ownershipUnknown: report.ownershipReadFailed,
    });
    // Owner decision (#11209): host pressure is reported, never a reason to refuse a boot.
    if (refused) {
      return report.ownershipReadFailed
        ? {
            ...refused,
            message: `${refused.message} Ownership could not be read; labels use the last good snapshot and current in-memory ownership, so external devices may also be held by AutoMobile.`,
          }
        : refused;
    }
    return warm
      ? { outcome: "reuse-warm", udid: warm.udid }
      : { outcome: "allow", limits, bootedCount };
  }

  async admitBoot(
    request: WarmDeviceRequest | undefined,
    options: CapacityAdmitOptions,
  ): Promise<CapacityAdmission> {
    options.signal?.throwIfAborted();
    const reserved = this.reservations.take(options.bootUdid);
    if (reserved) {
      return this.withBootPermit(reserved, options);
    }
    const admission = await admitBootNow<FleetCostReport, CapacityDecision>({
      timer: this.timer,
      platform: "ios",
      signal: options.signal,
      label: CAPACITY_LABEL,
      timeoutRetryAfterMs: this.jitteredRetryAfterMs(),
      // Fresh: the listing must start after the ledger window opened (see FleetCostSource).
      sample: async () => {
        return this.refreshOwnership(await this.refresh({ fresh: true }));
      },
      ledger: this.admittedBoots,
      decide: (report, window) =>
        this.decide(report, request, "hint", { bootUdid: options.bootUdid, window }),
      admit: () => this.recordAdmission(options.bootUdid, undefined, options.reason),
    });
    return this.withBootPermit(admission, options);
  }

  private async withBootPermit(
    admission: CapacityAdmission,
    options: CapacityAdmitOptions,
  ): Promise<CapacityAdmission> {
    const release = admission.releaseAdmission;
    if (!release || admission.decision.outcome === "refuse") {
      return admission;
    }
    const status = this.bootGate.status();
    const queued = status.running >= status.limit || status.queued > 0;
    const startedAt = this.timer.now();
    if (queued) {
      logger.info(
        `[BootAdmission] iOS simulator boot queued behind ${status.running} running boots (limit ${status.limit})`,
      );
    }
    let granted = false;
    try {
      const permit = await this.bootGate.acquire(options.signal, options.bootUdid);
      granted = true;
      if (queued) {
        logger.info(
          `[BootAdmission] iOS simulator boot granted after ${this.timer.now() - startedAt}ms queued`,
        );
      }
      // Held only from admitBoot's return to boot-to-ready completion in
      // FleetBootInstrumentation.run. That window never acquires a second boot
      // permit; runner launch happens after release, so neither gate nests.
      let released = false;
      return {
        ...admission,
        releaseAdmission: (outcome) => {
          if (released) {
            return;
          }
          released = true;
          try {
            release(outcome);
          } finally {
            permit.release();
          }
        },
      };
    } finally {
      // Cancellation while queued must return the count slot as a failed boot.
      if (!granted) {
        release({ bootFailed: true });
      }
    }
  }

  async reserveBoot(options: BootReservationOptions): Promise<BootSlotReservation> {
    let admission: LedgerAdmission | undefined;
    const sampleTimeoutMs = Math.min(options.timeoutMs, DEFAULT_SAMPLE_TIMEOUT_MS);
    const result = await admitBootNow<FleetCostReport, CapacityDecision>({
      timer: this.timer,
      platform: "ios",
      signal: options.signal,
      sampleTimeoutMs,
      label: CAPACITY_LABEL,
      timeoutRetryAfterMs: this.jitteredRetryAfterMs(),
      sample: async () => {
        return this.refreshOwnership(await this.refresh({ fresh: true, sampleTimeoutMs }));
      },
      ledger: this.admittedBoots,
      decide: (report, window) =>
        this.decide(report, undefined, "hint", {
          bootUdid: options.replacingDeviceId,
          window,
          // Only a reset re-boots the same device it stopped. Binding replacement deletes the old
          // device and creates another, so it still needs capacity for the new one.
          carriesOwnSlot:
            options.reason === "reset" &&
            options.replacingDeviceId !== undefined &&
            occupyingUdids(report).includes(options.replacingDeviceId),
        }),
      admit: () => {
        admission = this.admittedBoots.admit(options.replacingDeviceId, true, options.reason);
        return admission.release;
      },
    });
    assertCapacityGranted(result);
    const held = admission!;
    let release: NonNullable<CapacityAdmission["releaseAdmission"]> = held.release;
    return this.reservations.hold(
      (udid) => {
        held.bind(udid);
        release = this.recordAdmission(udid, held);
        return { decision: result.decision, releaseAdmission: release };
      },
      () => release({ bootFailed: true }),
      () => held.bind(),
    );
  }

  private recordAdmission(
    udid?: string,
    reserved?: LedgerAdmission,
    reason?: BootAdmissionReason,
  ): NonNullable<CapacityAdmission["releaseAdmission"]> {
    const boots = udid
      ? (this.bootsByUdid.get(udid) ?? { unreleased: 0, succeeded: false })
      : undefined;
    if (udid && boots) {
      this.startedUdids.add(udid);
      boots.unreleased += 1;
      this.bootsByUdid.set(udid, boots);
    }
    const admission = reserved ?? this.admittedBoots.admit(udid, false, reason);
    let released = false;
    return (outcome) => {
      if (released) {
        return;
      }
      released = true;
      admission.release();
      // A seen-then-gone sample may already have forgotten this admission's ownership period.
      if (!udid || !boots || this.bootsByUdid.get(udid) !== boots) {
        return;
      }
      boots.unreleased -= 1;
      boots.succeeded ||= !outcome?.bootFailed;
      // Forget only when every admission failed unseen; any successful boot keeps the UDID ours.
      if (boots.unreleased === 0 && !boots.succeeded && !this.seenStartedUdids.has(udid)) {
        this.forgetStarted(udid);
      }
    };
  }

  /**
   * Refuses with `capacity_exhausted` when booting a simulator would be refused now; admits nothing.
   * A warm simulator is not a substitute here: the caller boots its own device.
   */
  async assertCapacityAvailable(options: { signal?: AbortSignal } = {}): Promise<void> {
    options.signal?.throwIfAborted();
    if (this.reservations.hasPending()) {
      return;
    }
    return this.sampleInWindow({ ...options, ownership: true }, (report, window) => {
      assertCapacityGranted({
        decision: this.decide(report, undefined, "hint", { window }),
      });
    });
  }

  /** Current limit, booted simulators (every Booted one, owned or not) and admitted boots in flight. */
  async describeCapacity(options: { signal?: AbortSignal } = {}): Promise<BootCapacitySnapshot> {
    // Sampled like the check and an admission, so a listing's capacity block and a boot decided
    // at the same instant count the same simulators (#11643).
    return this.sampleInWindow(options, (report, window) => {
      this.assertCountKnown(report);
      return {
        limit: this.limitsFor(report, window).maxBooted,
        booted: occupyingUdids(report).length,
        inFlight: this.inFlightBootCount(report, undefined, window),
        admissionsByReason: this.admittedBoots.admissionsByReason(),
        hostPressure: {
          sustained: this.pressuredStreak >= this.sustainedSamples,
          consecutiveSamples: this.pressuredStreak,
          memoryPressure: report.host?.memoryPressure ?? "unknown",
        },
      };
    });
  }

  /**
   * One listing begun inside its own ledger window, as `admitBoot` takes it: a boot that ends
   * while the listing is open, or after an earlier caller's listing began, still holds its slot
   * for this read (#11643). Judge synchronously inside the window so a boot released between
   * closing the window and an awaiting caller resuming cannot disappear from the count.
   * Bounded and cancellable like an admission's sample, so a hung
   * `simctl list` neither hangs the caller nor keeps the window (and every boot that ends in it)
   * alive: an unfinished sample is an unknown count, retryable `discovery_incomplete`, never
   * "capacity available". A read is not a boot decision, so it does not advance the
   * sustained-pressure streak.
   */
  private async sampleInWindow<T>(
    options: { signal?: AbortSignal; ownership?: boolean },
    judge: (report: OwnershipFleetReport, window: LedgerSampleWindow) => T,
  ): Promise<T> {
    options.signal?.throwIfAborted();
    const window = this.admittedBoots.beginSample();
    try {
      // The collector's run is shared with other callers, so losing the race never cancels it;
      // the whole run (listing, then host snapshot) ends by this race's own deadline, so an
      // abandoned one has ended too by the time a caller can retry (#13801, #14496).
      const deadlineMs = this.timer.now() + DEFAULT_SAMPLE_TIMEOUT_MS;
      const retryAfterMs = this.jitteredRetryAfterMs();
      const report = await raceWithDeadline(
        async () => {
          const report = await this.fleet.collectFresh({ deadlineMs });
          return options.ownership ? this.refreshOwnership(report) : report;
        },
        {
          timer: this.timer,
          timeoutMs: DEFAULT_SAMPLE_TIMEOUT_MS,
          signal: options.signal,
          label: `Collecting ${CAPACITY_LABEL}`,
          timeoutError: () =>
            new BootedDeviceDiscoveryIncompleteError(
              "ios",
              {
                code: "timeout",
                message: `timed out after ${DEFAULT_SAMPLE_TIMEOUT_MS}ms collecting ${CAPACITY_LABEL}`,
                retryable: true,
                retryAfterMs,
              },
              undefined,
              retryAfterMs,
            ),
        },
      );
      options.signal?.throwIfAborted();
      return judge(report, window);
    } finally {
      window.close();
    }
  }

  /** The refusal hint stretched by up to 100%, so callers refused together retry apart (#15307). */
  private jitteredRetryAfterMs(): number {
    return Math.round(this.retryAfterMs * (1 + this.random.next()));
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
        this.forgetStarted(udid);
      }
    }
  }

  private forgetStarted(udid: string): void {
    this.startedUdids.delete(udid);
    this.seenStartedUdids.delete(udid);
    this.bootsByUdid.delete(udid);
  }

  /**
   * Admitted boots that the latest sample does not already show as occupying a slot, except
   * `bootUdid`'s own: that target is excluded from the listing count and needs no second slot.
   */
  private inFlightBootCount(
    report: FleetCostReport,
    bootUdid?: string,
    window?: LedgerSampleWindow,
  ): number {
    return this.admittedBoots.inFlightCount(new Set(occupyingUdids(report)), bootUdid, window);
  }

  /** Keep boot-concurrency metadata out of the shared refusal wire format. */
  private countLimits({ maxBooted, source, warning }: IosCapacityLimits): CapacityLimits {
    return { maxBooted, source, ...(warning ? { warning } : {}) };
  }

  private limitsFor(report: FleetCostReport, window?: LedgerSampleWindow): IosCapacityLimits {
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
    // Sizing keeps even Booted admissions until release: a listing can see a simulator before
    // its boot finishes. Slot counting still excludes devices already visible in that listing.
    const { boots } = this.admittedBoots.inFlightView(new Set(), undefined, window);
    return this.warnOnUnusableLimit(
      resolveCapacityLimits(this.env, report.host, estimatePerSimulatorBytes(report, boots)),
    );
  }

  /** Log an unusable `AUTOMOBILE_IOS_SIM_MAX_BOOTED` once per distinct warning, as Android does. */
  private warnOnUnusableLimit(limits: IosCapacityLimits): IosCapacityLimits {
    if (limits.warning && limits.warning !== this.warnedLimit) {
      this.warnedLimit = limits.warning;
      logger.warn(`[BootAdmission] ${limits.warning}`);
    }
    if (
      limits.bootConcurrencyWarning &&
      limits.bootConcurrencyWarning !== this.warnedBootConcurrency
    ) {
      this.warnedBootConcurrency = limits.bootConcurrencyWarning;
      logger.warn(`[BootAdmission] ${limits.bootConcurrencyWarning}`);
    }
    this.bootGate.setLimit(limits.bootConcurrency);
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
