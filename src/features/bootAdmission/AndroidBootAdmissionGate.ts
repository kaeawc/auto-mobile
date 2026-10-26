import {
  BootReservationScope,
  type BootCapacityReserver,
  type BootReservationOptions,
  type BootSlotReservation,
} from "../../devices/bootAdmission/BootSlotReservation";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
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
  sampleTimeoutError,
  type BootCapacityChecker,
  type BootCapacityReporter,
  type BootCapacitySnapshot,
  type LedgerAdmission,
  type LedgerSampleWindow,
  type RefusedCapacityDecision,
} from "./BootAdmissionGate";
import {
  ANDROID_EMULATOR_MEMORY_POLICY,
  raisePerDeviceBytes,
  estimateSettledPerDeviceBytes,
  resolveBootCapacityLimits,
  type CapacityLimits,
  type InFlightBootMemory,
} from "./capacityLimits";

import {
  HostBootAdmissionRegistryError,
  type HostBootAdmissionRegistry,
  type HostBootAdmissionRecord,
  type PublishedBootAdmission,
} from "./HostBootAdmissionRegistry";
import { errorMessage } from "../../utils/describeUnknownError";
import { ENV } from "../../config/env";

/** Env override: positive integer cap on concurrently booted Android emulators. */
export const ANDROID_MAX_BOOTED_ENV = ENV.ANDROID_MAX_BOOTED.name;

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
  /**
   * Guest RAM in bytes the named AVD resolves to (its `hardware-qemu.ini`), when known. Only
   * ever raises the per-emulator estimate used to derive the limit (#15475).
   */
  resolvedGuestBytes?: (avdName: string, signal?: AbortSignal) => Promise<number | undefined>;
}

/**
 * Refuses an Android emulator cold boot while the host already runs as many
 * emulators as its derived limit allows (#11181). Every running emulator
 * counts, including ones started outside AutoMobile. It never
 * boots, kills or reconfigures an emulator.
 */
export class AndroidBootAdmissionGate
  implements BootCapacityReporter, BootCapacityChecker, BootCapacityReserver
{
  private readonly env: NodeJS.ProcessEnv;
  private readonly retryAfterMs: number;
  private readonly resolvedGuestBytes: AndroidBootAdmissionGateOptions["resolvedGuestBytes"];
  private readonly ledger: BootAdmissionLedger;
  private readonly reservations = new BootReservationScope<BootAdmission>();
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
    this.resolvedGuestBytes = options.resolvedGuestBytes;
    this.ledger = new BootAdmissionLedger(timer);
    this.hostRegistry = options.hostRegistry;
  }

  /**
   * Returns the admission that holds a slot when one more emulator fits right
   * now. Rejects at once with `BootCapacityExhaustedError` when the host is at
   * its limit (no queueing), and with the abort reason when the signal fires.
   */
  async admit(request: AndroidBootAdmissionRequest): Promise<BootAdmission> {
    request.signal?.throwIfAborted();
    return this.reservations.take() ?? (await this.admitNew(request)).admission;
  }

  async reserveBoot(options: BootReservationOptions): Promise<BootSlotReservation> {
    const reserved = await this.admitNew(
      { ...options, avdName: "binding replacement" },
      options.replacingDeviceId,
    );
    return this.reservations.hold(
      () => {
        reserved.bind();
        return reserved.admission;
      },
      reserved.admission.release,
      reserved.markReplacedDeviceGone,
    );
  }

  private async admitNew(
    request: AndroidBootAdmissionRequest,
    replacingDeviceId?: string,
  ): Promise<{ admission: BootAdmission; bind: () => void; markReplacedDeviceGone: () => void }> {
    const deadlineMs = this.timer.now() + request.timeoutMs;
    // No extra await without a resolver: tests pin the gate's microtask interleavings.
    const candidateBytes = this.resolvedGuestBytes
      ? await this.candidateGuestBytes(request)
      : undefined;
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
        decide: (sample, window) =>
          this.decide(sample, window, peers, replacingDeviceId, candidateBytes),
        admit: () => {
          admitted = this.ledger.admit(replacingDeviceId, replacingDeviceId !== undefined);
          try {
            published = this.hostRegistry?.publish({
              admittedUntilMs: deadlineMs,
              ...(replacingDeviceId !== undefined
                ? { deviceId: replacingDeviceId, replacement: true }
                : {}),
            });
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
    const admission: BootAdmission = {
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
          published?.update({
            deviceId,
            processId,
            handedOffUntilMs: deadlineMs,
            ...(replacingDeviceId !== undefined ? { replacement: false } : {}),
          }),
        );
      },
    };
    return {
      admission,
      markReplacedDeviceGone: () => {
        ledgerAdmission.bind();
        // The local slot is already rebound. A failed peer update must not abort replacement
        // after verified deletion; keep the reservation held through the boot.
        try {
          published?.clearDeviceId();
        } catch (error) {
          logger.warn(
            `[BootAdmission] Failed to clear replaced device '${replacingDeviceId}' from the host registry; continuing replacement with the reservation held. The stale record keeps the replaced device id until boot hand-off; peers may undercount only if that serial is reused: ${errorMessage(error)}`,
            error,
          );
        }
      },
      bind: () => ledgerAdmission.bind(),
    };
  }

  /** Refuses with `capacity_exhausted` when a cold boot would be refused now; admits nothing. */
  async assertCapacityAvailable(options: { signal?: AbortSignal } = {}): Promise<void> {
    options.signal?.throwIfAborted();
    if (this.reservations.hasPending()) {
      return;
    }
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
      limit: counts.limits.maxBooted,
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
    options.signal?.throwIfAborted();
    const window = this.ledger.beginSample();
    const controller = new AbortController();
    const signal = options.signal
      ? AbortSignal.any([options.signal, controller.signal])
      : controller.signal;
    try {
      const before = this.readPeers();
      const sample = await raceWithDeadline(() => this.sampleKnownCount({ signal }), {
        timer: this.timer,
        timeoutMs: DEFAULT_SAMPLE_TIMEOUT_MS,
        signal: options.signal,
        label: "Collecting Android emulator capacity",
        timeoutError: () =>
          sampleTimeoutError("android", DEFAULT_SAMPLE_TIMEOUT_MS, "Android emulator capacity"),
        onTimeout: () => controller.abort(),
      });
      options.signal?.throwIfAborted();
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
    replacingDeviceId?: string,
    candidateBytes?: number,
  ): AndroidAdmissionDecision | RefusedCapacityDecision {
    this.forgetExitedSerials(sample);
    const { limits, effective: bootedCount } = this.count(sample, window, peers, candidateBytes);
    const credit =
      replacingDeviceId !== undefined && sample.emulatorSerials.includes(replacingDeviceId) ? 1 : 0;
    if (bootedCount - credit < limits.maxBooted) {
      return { outcome: "allow", limits, bootedCount };
    }
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
   * `inFlight` is the larger adb/process load (`reported`) minus `booted`.
   * It is never negative: unseenBoots >= 0, so reported >= listed and reported >= processes.
   * `booted + inFlight` equals `effective` whenever no listed boot lacks a process.
   * The report omits `listedWithoutProcess`:
   * that fail-closed safety margin is decision-only, deliberately not reported as a boot in flight.
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
   *
   * Sizing uses this exact in-flight view once, before the mutating ledger can end entries.
   * Local and active peer boots absent from adb exclude every RSS row matching their pid or
   * parent pid, and are charged the 4 GiB default (or the larger settled average). A handed-off
   * boot with unknown pid, or a table without ids, drops the smallest remaining rows while
   * keeping the largest; if every remaining row could be booting, the default is the floor.
   * Known pids absent from the table and boots not handed off drop nothing. A boot stops being
   * in flight when listed, released or past its hand-off deadline; entries ended during an
   * older sample still count exactly as the ledger retains them. No settling timer is added.
   */
  private count(
    sample: AndroidCapacitySample,
    window?: LedgerSampleWindow,
    peers: readonly HostBootAdmissionRecord[] = [],
    candidateBytes?: number,
  ): {
    booted: number;
    inFlight: number;
    effective: number;
    limits: CapacityLimits;
  } {
    this.removeListedPublications(sample);
    const listed = sample.emulatorSerials.length;
    const processes = sample.emulatorProcessRssBytes?.length ?? 0;
    const listedProcessIds = new Set(
      (sample.emulatorProcessIds ?? []).flatMap((ids) => [ids.pid, ids.ppid]),
    );
    const inFlight = this.ledger.inFlightView(
      new Set(sample.emulatorSerials),
      undefined,
      window,
      listedProcessIds,
    );
    const peerCounts = this.countPeers(peers, new Set(sample.emulatorSerials), listedProcessIds);
    const count = inFlight.count + peerCounts.count;
    const booted = Math.max(listed, processes);
    const unseenBoots = count - inFlight.withListedProcess - peerCounts.withListedProcess;
    const reported = Math.max(listed + count, processes + unseenBoots);
    const effective = Math.max(
      listed + count,
      processes + unseenBoots + inFlight.listedWithoutProcess + peerCounts.listedWithoutProcess,
    );
    const limits = this.limitsFor(sample, [...inFlight.boots, ...peerCounts.boots], candidateBytes);
    return { booted, inFlight: reported - booted, effective, limits };
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
  ): {
    count: number;
    boots: readonly InFlightBootMemory[];
    withListedProcess: number;
    listedWithoutProcess: number;
  } {
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
      boots: unlisted.map((record) => ({
        processId: record.processId,
        handedOff: record.handedOffUntilMs !== undefined,
      })),
      withListedProcess: unlisted.filter(matched).length,
      listedWithoutProcess: active.filter(
        (record) => visible(record) && !matched(record) && !record.replacement,
      ).length,
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

  /** The AVD's resolved guest RAM, or undefined when unknown; a failed read never blocks a boot. */
  private async candidateGuestBytes(
    request: AndroidBootAdmissionRequest,
  ): Promise<number | undefined> {
    if (!this.resolvedGuestBytes) {
      return undefined;
    }
    try {
      return await this.resolvedGuestBytes(request.avdName, request.signal);
    } catch (error) {
      // The estimate falls back to the measured or default value; reading is best effort.
      logger.warn(
        `[BootAdmission] Could not read resolved RAM for '${request.avdName}': ${errorMessage(error)}`,
        error,
      );
      return undefined;
    }
  }

  /** All admission and reporting callers size from the boots returned by their single count. */
  private limitsFor(
    sample: AndroidCapacitySample,
    inFlight: readonly InFlightBootMemory[],
    candidateBytes?: number,
  ): CapacityLimits {
    const limits = resolveBootCapacityLimits(
      this.env,
      ANDROID_MAX_BOOTED_ENV,
      sample.host,
      raisePerDeviceBytes(
        estimateSettledPerDeviceBytes(
          sample.emulatorProcessRssBytes?.map((rssBytes, index) => ({
            rssBytes,
            ...sample.emulatorProcessIds?.[index],
          })),
          inFlight,
          ANDROID_EMULATOR_MEMORY_POLICY,
        ),
        candidateBytes,
        ANDROID_EMULATOR_MEMORY_POLICY,
      ),
    );
    if (limits.warning && limits.warning !== this.warnedLimit) {
      this.warnedLimit = limits.warning;
      logger.warn(`[BootAdmission] ${limits.warning}`);
    }
    return limits;
  }
}
