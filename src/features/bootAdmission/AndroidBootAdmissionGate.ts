import { ActionableError } from "../../models/ActionableError";
import type { BootAdmission } from "../../models/BootAdmission";
import type { Timer } from "../../utils/SystemTimer";
import { logger } from "../../utils/logger";
import { AndroidBootedDeviceDiscoveryIncompleteError } from "../../models/BootedDeviceDiscoveryIncompleteError";
import type { AndroidCapacitySample, AndroidCapacitySource } from "./AndroidCapacitySource";
import {
  assertBootCapacityGranted,
  atCapacityDecision,
  BootAdmissionLedger,
  DEFAULT_ADMISSION_RETRY_AFTER_MS,
  admitBootNow,
  DEFAULT_SAMPLE_TIMEOUT_MS,
  type BootCapacityChecker,
  type BootCapacityReporter,
  type BootCapacitySnapshot,
  type LedgerAdmission,
  type LedgerSampleWindow,
  type RefusedCapacityDecision,
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
  /** Boot budget: bounds the capacity sample and the hand-off window. */
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
 * Refuses an Android emulator cold boot while the host already runs as many
 * emulators as its derived limit allows (#11181). Every running emulator
 * counts, including ones started outside AutoMobile. Read-only: it never
 * boots, kills or reconfigures an emulator.
 */
export class AndroidBootAdmissionGate implements BootCapacityReporter, BootCapacityChecker {
  private readonly env: NodeJS.ProcessEnv;
  private readonly retryAfterMs: number;
  private readonly ledger: BootAdmissionLedger;
  private warnedLimit: string | undefined;
  /** Serials of emulators this process launched through an admission. */
  private readonly startedSerials = new Set<string>();
  /** Started serials adb has listed at least once: only these can be seen exiting. */
  private readonly listedStartedSerials = new Set<string>();

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
   * Returns the admission that holds a slot when one more emulator fits right
   * now. Rejects at once with `BootCapacityExhaustedError` when the host is at
   * its limit (no queueing), and with the abort reason when the signal fires.
   */
  async admit(request: AndroidBootAdmissionRequest): Promise<BootAdmission> {
    const deadlineMs = this.timer.now() + request.timeoutMs;
    let admitted: LedgerAdmission | undefined;
    const result = await admitBootNow<AndroidCapacitySample, AndroidAdmissionDecision>({
      timer: this.timer,
      platform: "android",
      signal: request.signal,
      sampleTimeoutMs: Math.min(request.timeoutMs, DEFAULT_SAMPLE_TIMEOUT_MS),
      label: "Android emulator capacity",
      sample: () => this.sampleKnownCount({ signal: request.signal }),
      ledger: this.ledger,
      decide: (sample, window) => this.decide(sample, window),
      admit: () => {
        admitted = this.ledger.admit();
        return admitted.release;
      },
    });
    assertBootCapacityGranted(result, "android", "emulator");
    const ledgerAdmission = admitted;
    if (!ledgerAdmission) {
      // admitBootNow returns without refusing only after calling `admit`.
      throw new ActionableError(`Boot admission for AVD '${request.avdName}' ended without a slot`);
    }
    const handedOffSerials = new Set<string>();
    let released = false;
    return {
      release: () => {
        released = true;
        ledgerAdmission.release();
        // A boot that ended before adb ever listed it never held its serial: an emulator
        // started elsewhere that takes the serial later is not ours.
        for (const serial of handedOffSerials) {
          if (!this.listedStartedSerials.has(serial)) {
            this.startedSerials.delete(serial);
          }
        }
        handedOffSerials.clear();
      },
      handOff: (deviceId, processId) => {
        if (released) {
          return;
        }
        if (deviceId !== undefined) {
          this.startedSerials.add(deviceId);
          handedOffSerials.add(deviceId);
        }
        ledgerAdmission.handOff(deviceId, deadlineMs, processId);
      },
    };
  }

  /** Refuses with `capacity_exhausted` when a cold boot would be refused now; admits nothing. */
  async assertCapacityAvailable(options: { signal?: AbortSignal } = {}): Promise<void> {
    const { sample, window } = await this.sampleInWindow(options);
    assertBootCapacityGranted({ decision: this.decide(sample, window) }, "android", "emulator");
  }

  /** Current limit, booted emulators (every running one, owned or not) and admitted boots in flight. */
  async describeCapacity(options: { signal?: AbortSignal } = {}): Promise<BootCapacitySnapshot> {
    const { sample, window } = await this.sampleInWindow(options);
    const counts = this.count(sample, window);
    return {
      limit: this.limitsFor(sample).maxBooted,
      booted: counts.booted,
      inFlight: counts.inFlight,
    };
  }

  /**
   * A sample inside a ledger window, as `admit` takes it: a boot that ends while the sample is
   * being taken still counts for it (#11465, #11537).
   */
  private async sampleInWindow(options: {
    signal?: AbortSignal;
  }): Promise<{ sample: AndroidCapacitySample; window: LedgerSampleWindow }> {
    const window = this.ledger.beginSample();
    try {
      return { sample: await this.sampleKnownCount(options), window };
    } finally {
      window.close();
    }
  }

  /**
   * One sample whose booted count is known. With the adb listing failed and no process count
   * (e.g. Windows has no `ps`), zero emulators is a guess: refuse with retryable
   * `discovery_incomplete` rather than fail open past the limit (#11236).
   */
  private async sampleKnownCount(options: {
    signal?: AbortSignal;
  }): Promise<AndroidCapacitySample> {
    const sample = await this.source.sample(options);
    if (sample.errors.length === 0) {
      return sample;
    }
    const detail = sample.errors.join("; ");
    if (sample.serialListingFailed && sample.emulatorProcessRssBytes === undefined) {
      logger.warn(`[BootAdmission] Android emulator count unknown; refusing to boot: ${detail}`);
      throw new AndroidBootedDeviceDiscoveryIncompleteError({
        code: "failed",
        message: `emulator count unknown (${detail})`,
        retryable: true,
      });
    }
    // The other source still counts emulators; the failing one was logged where it failed.
    logger.debug(`[BootAdmission] Android capacity sample partially failed: ${detail}`);
    return sample;
  }

  /** Synchronous so the waiter decides and records its admission without an interleaving. */
  private decide(
    sample: AndroidCapacitySample,
    window?: LedgerSampleWindow,
  ): AndroidAdmissionDecision | RefusedCapacityDecision {
    this.forgetExitedSerials(sample);
    const limits = this.limitsFor(sample);
    const bootedCount = this.count(sample, window).effective;
    return (
      atCapacityDecision(bootedCount, limits, this.retryAfterMs, {
        noun: "emulator",
        envName: ANDROID_MAX_BOOTED_ENV,
        externalDevices: sample.emulatorSerials.filter(
          (serial) => !this.startedSerials.has(serial),
        ),
      }) ?? { outcome: "allow", limits, bootedCount }
    );
  }

  /**
   * Forget a started serial once its emulator has been listed and then disappears, so a later
   * external emulator reusing the serial is not named as ours. Skipped when the listing failed.
   */
  private forgetExitedSerials(sample: AndroidCapacitySample): void {
    if (sample.serialListingFailed) {
      return;
    }
    const listed = new Set(sample.emulatorSerials);
    for (const serial of this.startedSerials) {
      if (listed.has(serial)) {
        this.listedStartedSerials.add(serial);
      } else if (this.listedStartedSerials.delete(serial)) {
        this.startedSerials.delete(serial);
      }
    }
  }

  /**
   * `booted` is the larger of the adb listing (any adb state) and the qemu
   * process count: a booting emulator has a process before adb lists it at all.
   *
   * `effective` is the larger of two views of the same load: the adb listing plus every admitted
   * boot it does not show, and the process table plus every boot this sample knows whose own
   * process is not in it. A boot is matched to a process by the pid it was handed off with (the
   * launcher this daemon spawned, which becomes the qemu process or is its parent), never by
   * count: a process nobody admitted is another emulator and is added. Taking the plain process
   * count instead lost an external emulator adb had not listed whenever an admitted boot had no
   * process yet (#11564).
   *
   * The two listings are read at different moments, in no fixed order, so the process view also
   * adds a boot adb DOES list when the table lacks its process: the table was read before the
   * boot spawned and adb after it was listed. Leaving it out counted that boot once in each view
   * beside an external emulator only the table shows, and admitted past the limit (#11588). With
   * it, each view is at least the emulators it could see plus every boot it could not, whichever
   * read came first, so neither read has to wait for the other and no re-read is needed.
   *
   * A boot handed off without a pid, or sampled without process ids, counts twice while its
   * process runs, up to and including the decision that first sees it listed: fail closed. The
   * emulator client hands off with the pid the moment the process exists
   * (`spawnUnderBootAdmission`).
   */
  private count(
    sample: AndroidCapacitySample,
    window?: LedgerSampleWindow,
  ): {
    booted: number;
    inFlight: number;
    effective: number;
  } {
    const listed = sample.emulatorSerials.length;
    const processes = sample.emulatorProcessRssBytes?.length ?? 0;
    const listedProcessIds = new Set(
      (sample.emulatorProcessIds ?? []).flatMap((ids) => [ids.pid, ids.ppid]),
    );
    const inFlight = this.ledger.inFlight(
      new Set(sample.emulatorSerials),
      undefined,
      window,
      listedProcessIds,
    );
    return {
      booted: Math.max(listed, processes),
      inFlight: inFlight.count,
      effective: Math.max(
        listed + inFlight.count,
        processes + (inFlight.count - inFlight.withListedProcess) + inFlight.listedWithoutProcess,
      ),
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
