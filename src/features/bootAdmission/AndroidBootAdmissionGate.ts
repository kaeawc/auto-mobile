import { ActionableError } from "../../models/ActionableError";
import type { BootAdmission } from "../../models/BootAdmission";
import type { Timer } from "../../utils/SystemTimer";
import { logger } from "../../utils/logger";
import { AndroidBootedDeviceDiscoveryIncompleteError } from "../../models/BootedDeviceDiscoveryIncompleteError";
import type {
  AndroidCapacitySample,
  AndroidCapacitySource,
  ProcessTableFailure,
} from "./AndroidCapacitySource";
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

import {
  HostBootAdmissionRegistryError,
  type HostBootAdmissionRegistry,
  type HostBootAdmissionRecord,
  type PublishedBootAdmission,
} from "./HostBootAdmissionRegistry";
import { errorMessage } from "../../utils/describeUnknownError";

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
  hostRegistry?: HostBootAdmissionRegistry;
  env?: NodeJS.ProcessEnv;
  retryAfterMs?: number;
}

/**
 * Refuses an Android emulator cold boot while the host already runs as many
 * emulators as its derived limit allows (#11181). Every running emulator
 * counts, including ones started outside AutoMobile. It never
 * boots, kills or reconfigures an emulator.
 */
export class AndroidBootAdmissionGate implements BootCapacityReporter, BootCapacityChecker {
  private readonly env: NodeJS.ProcessEnv;
  private readonly retryAfterMs: number;
  private readonly ledger: BootAdmissionLedger;
  private readonly hostRegistry: HostBootAdmissionRegistry | undefined;
  private readonly publications = new Map<
    PublishedBootAdmission,
    Pick<HostBootAdmissionRecord, "deviceId" | "handedOffUntilMs"> & { pendingRemoval?: boolean }
  >();
  private lastProcessTableFailure: ProcessTableFailure | undefined;
  private admissionsWithoutProcessTable = 0;
  private lastAdmissionWithoutProcessTableAtMs: number | undefined;
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
    this.hostRegistry = options.hostRegistry;
  }

  /**
   * Returns the admission that holds a slot when one more emulator fits right
   * now. Rejects at once with `BootCapacityExhaustedError` when the host is at
   * its limit (no queueing), and with the abort reason when the signal fires.
   */
  async admit(request: AndroidBootAdmissionRequest): Promise<BootAdmission> {
    const deadlineMs = this.timer.now() + request.timeoutMs;
    let admitted: LedgerAdmission | undefined;
    let published: PublishedBootAdmission | undefined;
    let peers: HostBootAdmissionRecord[] = [];
    let admissionSample: AndroidCapacitySample | undefined;
    const run = () =>
      admitBootNow<AndroidCapacitySample, AndroidAdmissionDecision>({
        timer: this.timer,
        platform: "android",
        signal: request.signal,
        sampleTimeoutMs: Math.min(request.timeoutMs, DEFAULT_SAMPLE_TIMEOUT_MS),
        label: "Android emulator capacity",
        sample: async () => {
          const sampleDeadlineMs =
            this.timer.now() + Math.min(request.timeoutMs, DEFAULT_SAMPLE_TIMEOUT_MS) - 500;
          const before = this.readPeers();
          const sample = await this.sampleKnownCount({
            signal: request.signal,
            deadlineMs: sampleDeadlineMs,
          });
          admissionSample = sample;
          peers = this.unionPeers(before, this.readPeers());
          return sample;
        },
        ledger: this.ledger,
        decide: (sample, window) => this.decide(sample, window, peers),
        admit: () => {
          admitted = this.ledger.admit();
          try {
            published = this.hostRegistry?.publish({ admittedUntilMs: deadlineMs });
            if (published) {
              this.publications.set(published, {});
            }
          } catch (error) {
            admitted.release();
            throw this.registryFailure(error);
          }
          return admitted.release;
        },
      });
    const result = await this.runWithHostLock(request, run).catch((error: unknown) => {
      // The callback may have admitted a boot before releasing the host lock failed.
      // No caller received its handle, so roll it back even for an aborted request.
      admitted?.release();
      this.removePublication(published);
      throw error;
    });
    assertBootCapacityGranted(result, "android", "emulator");
    const ledgerAdmission = admitted;
    if (!ledgerAdmission) {
      // admitBootNow returns without refusing only after calling `admit`.
      throw new ActionableError(`Boot admission for AVD '${request.avdName}' ended without a slot`);
    }
    if (admissionSample?.processTableFailure) {
      this.recordAdmissionWithoutProcessTable(request.avdName, admissionSample);
    }
    const handedOffSerials = new Set<string>();
    let released = false;
    return {
      release: () => {
        released = true;
        ledgerAdmission.release();
        this.removePublication(published);
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
        const fields = published ? this.publications.get(published) : undefined;
        if (fields) {
          fields.deviceId = deviceId ?? fields.deviceId;
          fields.handedOffUntilMs = deadlineMs;
        }
        this.updatePublication(published, () =>
          published?.update({ deviceId, processId, handedOffUntilMs: deadlineMs }),
        );
      },
    };
  }

  /** Refuses with `capacity_exhausted` when a cold boot would be refused now; admits nothing. */
  async assertCapacityAvailable(options: { signal?: AbortSignal } = {}): Promise<void> {
    const { sample, window, peers } = await this.sampleInWindow(options);
    assertBootCapacityGranted(
      { decision: this.decide(sample, window, peers) },
      "android",
      "emulator",
    );
  }

  /** Current limit, booted emulators (every running one, owned or not) and admitted boots in flight. */
  async describeCapacity(options: { signal?: AbortSignal } = {}): Promise<BootCapacitySnapshot> {
    const { sample, window, peers } = await this.sampleInWindow(options);
    const counts = this.count(sample, window, peers);
    return {
      limit: this.limitsFor(sample).maxBooted,
      booted: counts.booted,
      inFlight: counts.inFlight,
      ...this.describeProcessTable(sample),
    };
  }

  private recordAdmissionWithoutProcessTable(avdName: string, sample: AndroidCapacitySample): void {
    const failure = sample.processTableFailure!;
    this.admissionsWithoutProcessTable += 1;
    this.lastAdmissionWithoutProcessTableAtMs = this.timer.now();
    const message = `[BootAdmission] Admitted AVD '${avdName}' on adb-only count ${sample.emulatorSerials.length}: ${failure.reason}, attempts=${failure.attempts}: ${failure.detail}`;
    if (failure.reason === "unsupported-platform") {
      // Windows normally counts from adb because the platform has no ps.
      logger.debug(message);
    } else {
      logger.warn(message);
    }
  }

  private describeProcessTable(
    sample: AndroidCapacitySample,
  ): Pick<BootCapacitySnapshot, "processTable"> {
    const failure = sample.processTableFailure ?? this.lastProcessTableFailure;
    if (!failure || (!sample.processTableFailure && this.admissionsWithoutProcessTable === 0)) {
      return {};
    }
    return {
      processTable: {
        unavailable: sample.processTableFailure !== undefined,
        reason: failure.reason,
        detail: failure.detail,
        attempts: failure.attempts,
        admissionsWithoutProcessTable: this.admissionsWithoutProcessTable,
        ...(this.lastAdmissionWithoutProcessTableAtMs !== undefined
          ? { lastAdmissionWithoutProcessTableAtMs: this.lastAdmissionWithoutProcessTableAtMs }
          : {}),
      },
    };
  }

  /**
   * A sample inside a ledger window, as `admit` takes it: a boot that ends while the sample is
   * being taken still counts for it (#11465, #11537).
   */
  private async sampleInWindow(options: { signal?: AbortSignal }): Promise<{
    sample: AndroidCapacitySample;
    window: LedgerSampleWindow;
    peers: HostBootAdmissionRecord[];
  }> {
    const window = this.ledger.beginSample();
    try {
      const before = this.readPeers();
      const sample = await this.sampleKnownCount(options);
      return { sample, window, peers: this.unionPeers(before, this.readPeers()) };
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
    deadlineMs?: number;
  }): Promise<AndroidCapacitySample> {
    const sample = await this.source.sample({
      ...options,
      deadlineMs: options.deadlineMs ?? this.timer.now() + DEFAULT_SAMPLE_TIMEOUT_MS - 500,
    });
    if (sample.processTableFailure) {
      this.lastProcessTableFailure = sample.processTableFailure;
    }
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
    peers: readonly HostBootAdmissionRecord[] = [],
  ): AndroidAdmissionDecision | RefusedCapacityDecision {
    this.forgetExitedSerials(sample);
    const limits = this.limitsFor(sample);
    const bootedCount = this.count(sample, window, peers).effective;
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
   * boot (local or peer) it does not show, and the process table plus every boot this sample knows whose own
   * process is not in it. A boot is matched to a process by the pid it was handed off with (the
   * launcher the admitting daemon spawned, which becomes the qemu process or is its parent), never by
   * count: a process nobody admitted is another emulator and is added. Taking the plain process
   * count instead lost an external emulator adb had not listed whenever an admitted boot had no
   * process yet (#11564).
   *
   * The two listings are read at different moments, so the process view also adds a boot adb
   * DOES list when the table lacks its process: the table was read before the boot spawned and
   * adb after it was listed. Leaving it out counted that boot once in each view beside an
   * external emulator only the table shows, and admitted past the limit (#11588). With it the
   * count covers local and peer admissions whichever read came first. Peer records are the union
   * of reads before and after the sample, so a record removed mid-sample still holds its slot.
   *
   * Emulators nobody admitted cannot be matched that way, so for them the order of the reads
   * matters and the source fixes it: `CommandAndroidCapacitySource` reads adb first, which makes
   * the later process table show every running emulator the listing shows.
   *
   * A boot handed off without a pid, or sampled without process ids, counts twice while its
   * process runs, up to and including the decision that first sees it listed: fail closed. The
   * emulator client hands off with the pid the moment the process exists
   * (`spawnUnderBootAdmission`).
   */
  private count(
    sample: AndroidCapacitySample,
    window?: LedgerSampleWindow,
    peers: readonly HostBootAdmissionRecord[] = [],
  ): {
    booted: number;
    inFlight: number;
    effective: number;
  } {
    this.removeListedPublications(sample);
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
    const peerCounts = this.countPeers(peers, new Set(sample.emulatorSerials), listedProcessIds);
    const count = inFlight.count + peerCounts.count;
    return {
      booted: Math.max(listed, processes),
      inFlight: count,
      effective: Math.max(
        listed + count,
        processes +
          count -
          inFlight.withListedProcess -
          peerCounts.withListedProcess +
          inFlight.listedWithoutProcess +
          peerCounts.listedWithoutProcess,
      ),
    };
  }

  private async runWithHostLock<T>(
    request: AndroidBootAdmissionRequest,
    run: () => Promise<T>,
  ): Promise<T> {
    if (!this.hostRegistry) {
      return run();
    }
    let operationFailed = false;
    const operation = async (): Promise<T> => {
      try {
        return await run();
      } catch (error) {
        operationFailed = true;
        throw error;
      }
    };
    try {
      return await this.hostRegistry.withAdmissionLock(
        {
          timeoutMs: Math.min(request.timeoutMs, DEFAULT_SAMPLE_TIMEOUT_MS),
          signal: request.signal,
        },
        operation,
      );
    } catch (error) {
      if (request.signal?.aborted) {
        throw request.signal.reason;
      }
      if (operationFailed) {
        // Sampling keeps its existing error contract; registry reads/publish were mapped at source.
        throw error;
      }
      throw this.registryFailure(error);
    }
  }

  private readPeers(): HostBootAdmissionRecord[] {
    try {
      return this.hostRegistry?.readPeerAdmissions() ?? [];
    } catch (error) {
      throw this.registryFailure(error);
    }
  }

  private registryFailure(error: unknown): AndroidBootedDeviceDiscoveryIncompleteError {
    logger.warn(
      `[BootAdmission] Android host registry refused admission: ${errorMessage(error)}`,
      error,
    );
    return new AndroidBootedDeviceDiscoveryIncompleteError({
      code: error instanceof HostBootAdmissionRegistryError ? error.code : "failed",
      message: `Host boot registry: ${errorMessage(error)}`,
      retryable: true,
    });
  }

  private unionPeers(
    before: HostBootAdmissionRecord[],
    after: HostBootAdmissionRecord[],
  ): HostBootAdmissionRecord[] {
    return [...new Map([...before, ...after].map((record) => [record.id, record])).values()];
  }

  private countPeers(
    peers: readonly HostBootAdmissionRecord[],
    listed: ReadonlySet<string>,
    processIds: ReadonlySet<number>,
  ): { count: number; withListedProcess: number; listedWithoutProcess: number } {
    const active = peers.filter((record) => {
      const deadline = record.handedOffUntilMs ?? record.admittedUntilMs;
      return deadline === undefined || this.timer.now() < deadline;
    });
    const visible = (record: HostBootAdmissionRecord): boolean =>
      record.deviceId !== undefined && listed.has(record.deviceId);
    const matched = (record: HostBootAdmissionRecord): boolean =>
      record.processId !== undefined && processIds.has(record.processId);
    const unlisted = active.filter((record) => !visible(record));
    return {
      count: unlisted.length,
      withListedProcess: unlisted.filter(matched).length,
      listedWithoutProcess: active.filter((record) => visible(record) && !matched(record)).length,
    };
  }

  private updatePublication(
    publication: PublishedBootAdmission | undefined,
    write: () => void,
  ): boolean {
    if (!publication) {
      return false;
    }
    try {
      write();
      return true;
    } catch (error) {
      // Exit handlers cannot throw; the retained record conservatively holds the slot for peers.
      logger.warn(
        `[BootAdmission] Host registry update/remove failed: ${errorMessage(error)}`,
        error,
      );
      return false;
    }
  }

  private removePublication(publication: PublishedBootAdmission | undefined): void {
    if (!publication) {
      return;
    }
    const fields = this.publications.get(publication);
    if (fields) {
      fields.pendingRemoval = true;
    }
    if (this.updatePublication(publication, () => publication.remove())) {
      this.publications.delete(publication);
    }
  }

  private removeListedPublications(sample: AndroidCapacitySample): void {
    for (const [publication, fields] of this.publications) {
      const listed =
        fields.deviceId !== undefined && sample.emulatorSerials.includes(fields.deviceId);
      const expired =
        fields.handedOffUntilMs !== undefined && this.timer.now() >= fields.handedOffUntilMs;
      if (fields.pendingRemoval || listed || expired) {
        this.removePublication(publication);
      }
    }
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
