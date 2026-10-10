import { ActionableError } from "../../models/ActionableError";
import type { BootAdmission } from "../../models/BootAdmission";
import type { Timer } from "../../utils/SystemTimer";
import { logger } from "../../utils/logger";
import type { AndroidCapacitySample, AndroidCapacitySource } from "./AndroidCapacitySource";
import {
  assertBootCapacityGranted,
  atCapacityDecision,
  BootAdmissionLedger,
  DEFAULT_ADMISSION_RETRY_AFTER_MS,
  waitForBootAdmission,
  type BootCapacityReporter,
  type BootCapacitySnapshot,
  type LedgerAdmission,
  type QueuedCapacityDecision,
} from "./BootAdmissionGate";
import {
  ANDROID_EMULATOR_MEMORY_POLICY,
  estimatePerDeviceBytes,
  resolveBootCapacityLimits,
  type CapacityLimits,
} from "./capacityLimits";

/** Env override: positive integer cap on concurrently booted Android emulators. */
export const ANDROID_MAX_BOOTED_ENV = "AUTOMOBILE_ANDROID_MAX_BOOTED";

export interface AndroidBootAdmissionRequest {
  /** Boot budget: the wait fails with `capacity_exhausted` when no slot frees within it. */
  timeoutMs: number;
  signal?: AbortSignal;
  /** The AVD being booted, for logs. */
  avdName: string;
}

type AndroidAdmissionDecision = { outcome: "allow"; limits: CapacityLimits; bootedCount: number };

export interface AndroidBootAdmissionGateOptions {
  env?: NodeJS.ProcessEnv;
  retryAfterMs?: number;
}

/**
 * Queues an Android emulator cold boot while the host already runs as many
 * emulators as its derived limit allows (#11181). Every running emulator
 * counts, including ones started outside AutoMobile. Read-only: it never
 * boots, kills or reconfigures an emulator.
 */
export class AndroidBootAdmissionGate implements BootCapacityReporter {
  private readonly env: NodeJS.ProcessEnv;
  private readonly retryAfterMs: number;
  private readonly ledger: BootAdmissionLedger;
  private warnedLimit: string | undefined;
  /** Serials of emulators this process launched through an admission. */
  private readonly startedSerials = new Set<string>();

  constructor(
    private readonly source: AndroidCapacitySource,
    private readonly timer: Timer,
    options: AndroidBootAdmissionGateOptions = {},
  ) {
    this.env = options.env ?? process.env;
    this.retryAfterMs = options.retryAfterMs ?? DEFAULT_ADMISSION_RETRY_AFTER_MS;
    this.ledger = new BootAdmissionLedger(timer);
  }

  /**
   * Waits until one more emulator fits, then returns the admission that holds
   * the slot. Rejects with `BootCapacityExhaustedError` when the deadline would
   * pass first, and with the abort reason when the signal fires.
   */
  async admit(request: AndroidBootAdmissionRequest): Promise<BootAdmission> {
    const deadlineMs = this.timer.now() + request.timeoutMs;
    let admitted: LedgerAdmission | undefined;
    const result = await waitForBootAdmission<AndroidCapacitySample, AndroidAdmissionDecision>({
      timer: this.timer,
      deadlineMs,
      signal: request.signal,
      label: "Android emulator capacity",
      sample: () => this.source.sample({ signal: request.signal }),
      decide: (sample) => this.decide(sample),
      admit: () => {
        admitted = this.ledger.admit();
        return admitted.release;
      },
    });
    assertBootCapacityGranted(result, "android", "emulator");
    if (result.waitedMs > 0) {
      logger.info(
        `[BootAdmission] admitted cold boot of AVD '${request.avdName}' after waiting ${result.waitedMs}ms for capacity`,
      );
    }
    const ledgerAdmission = admitted;
    if (!ledgerAdmission) {
      // waitForBootAdmission returns without timing out only after calling `admit`.
      throw new ActionableError(`Boot admission for AVD '${request.avdName}' ended without a slot`);
    }
    return {
      release: ledgerAdmission.release,
      handOff: (deviceId) => {
        if (deviceId !== undefined) {
          this.startedSerials.add(deviceId);
        }
        ledgerAdmission.handOff(deviceId, deadlineMs);
      },
    };
  }

  /** Current limit, booted emulators (every running one, owned or not) and admitted boots in flight. */
  async describeCapacity(options: { signal?: AbortSignal } = {}): Promise<BootCapacitySnapshot> {
    const sample = await this.source.sample(options);
    const counts = this.count(sample);
    return {
      limit: this.limitsFor(sample).maxBooted,
      booted: counts.booted,
      inFlight: counts.inFlight,
    };
  }

  /** Synchronous so the waiter decides and records its admission without an interleaving. */
  private decide(sample: AndroidCapacitySample): AndroidAdmissionDecision | QueuedCapacityDecision {
    const limits = this.limitsFor(sample);
    const bootedCount = this.count(sample).effective;
    return (
      atCapacityDecision(bootedCount, limits, this.retryAfterMs, {
        noun: "emulator",
        envName: ANDROID_MAX_BOOTED_ENV,
        externalDevices: sample.emulatorSerials.filter((serial) => !this.startedSerials.has(serial)),
      }) ?? { outcome: "allow", limits, bootedCount }
    );
  }

  /**
   * `booted` is the larger of the adb listing and the qemu process count: a
   * booting emulator has a process before adb lists it as `device`.
   * `effective` adds admitted boots adb does not list yet, but never counts
   * one twice when its qemu process is already in the process count.
   */
  private count(sample: AndroidCapacitySample): {
    booted: number;
    inFlight: number;
    effective: number;
  } {
    const listed = sample.emulatorSerials.length;
    const processes = sample.emulatorProcessRssBytes?.length ?? 0;
    const inFlight = this.ledger.inFlightCount(new Set(sample.emulatorSerials));
    return {
      booted: Math.max(listed, processes),
      inFlight,
      effective: Math.max(listed + inFlight, processes),
    };
  }

  private limitsFor(sample: AndroidCapacitySample): CapacityLimits {
    const limits = resolveBootCapacityLimits(
      this.env,
      ANDROID_MAX_BOOTED_ENV,
      sample.host,
      estimatePerDeviceBytes(sample.emulatorProcessRssBytes ?? [], ANDROID_EMULATOR_MEMORY_POLICY),
    );
    if (limits.warning && limits.warning !== this.warnedLimit) {
      this.warnedLimit = limits.warning;
      logger.warn(`[BootAdmission] ${limits.warning}`);
    }
    return limits;
  }
}
