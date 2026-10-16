import { ActionableError, toActionableError } from "../models/ActionableError";
import type { BootedDevice } from "../models";
import { SCREEN_READER_RESTORE_TIMEOUT_MS } from "../features/accessibility/ScreenReaderRestore";
import type {
  IosAppNetworkRule,
  IosAppNetworkRuleCommandContext,
} from "../features/networkFilter/IosAppNetworkRuleClient";
import { MAX_NETWORK_CONDITION_TTL_SECONDS } from "../features/utility/DeviceState";
import {
  defaultDeviceClockRestoreRegistry,
  type DeviceClockRestoreRegistry,
} from "../features/utility/DeviceClock";
import type { DeviceHealthReason } from "./deviceHealthMarkers";
import type { KeepScreenAwakeState, KeepAwakeRestoreReport } from "../utils/KeepScreenAwakeManager";
import type { BackoffPolicy } from "../utils/Backoff";
import { errorMessage } from "../utils/describeUnknownError";
import { logger } from "../utils/logger";
import { raceWithDeadline } from "../utils/raceWithDeadline";
import type { Timer } from "../utils/SystemTimer";
import {
  DeviceStateRestoreQueue,
  type AbandonedRestoreSpec,
  type BoundedRetrySpec,
  type PendingRestore,
  type RestoreAttemptOutcome,
  type RestoreKindSpec,
  type RestoreQueuePolicy,
  type RestoreRun,
} from "./deviceStateRestoreQueue";
import {
  IosAppNetworkLeases,
  type IosAppNetworkLeaseOptions,
  type IosAppNetworkRuleRestorer,
} from "./iosAppNetworkLease";
import {
  CLOCK_RESTORE_TIMEOUT_MS,
  KEEP_SCREEN_AWAKE_RESTORE_TIMEOUT_MS,
  type KeepScreenAwakeRestorer,
  NETWORK_CONDITION_RESTORE_RETRY_DELAY_MS,
  NETWORK_CONDITION_RESTORE_TIMEOUT_MS,
  type ClockRestorer,
  type ClockSessionState,
  type RotationRestorer,
  type RotationSessionState,
  type ScreenReaderRestorer,
  type ScreenReaderSessionState,
  type Session,
} from "./sessionManager";
import { RotationSettingManagedError } from "../models/RotationSettingManagedError";

/**
 * Each screen-reader restore attempt is a full TalkBack/VoiceOver toggle (it can
 * fall back to a `uiautomator dump`), so unlike the settings writes above it is
 * retried a small bounded number of times, with `Backoff` delays, never forever.
 */
const SCREEN_READER_RESTORE_RETRY_ATTEMPTS = 2;

/**
 * Rotation restore retries are bounded too. A fold/unfold between the session's
 * rotation and its release can leave the recorded settings unverifiable (the
 * window manager owns the new panel's rotation), so an unbounded retry kept the
 * device quarantined forever. After the cap the device leaves quarantine.
 */
const ROTATION_RESTORE_RETRY_ATTEMPTS = 5;
/**
 * A restore the window manager owns (a foldable re-applying rotation per device state)
 * can never verify by rewriting the setting, so it ends the retry loop immediately.
 */
function isNonRetryableRotationRestoreError(error: unknown): boolean {
  if (error instanceof RotationSettingManagedError) {
    return true;
  }
  const details: unknown =
    typeof error === "object" && error !== null && "details" in error ? error.details : undefined;
  return (
    typeof details === "object" &&
    details !== null &&
    "retryable" in details &&
    details.retryable === false
  );
}
const rotationRestorePolicy: RestoreQueuePolicy = {
  kind: "rotation",
  retiredOnIncarnationBump: false,
  setupHandoff: "track-eagerly",
  removedDuringSetupMessage: "Cannot change rotation: device was removed during session setup.",
};

const clockRestorePolicy: RestoreQueuePolicy = {
  kind: "clock",
  retiredOnIncarnationBump: true,
  setupHandoff: "await-then-track",
  removedDuringSetupMessage: "Cannot change the clock: device was removed during session setup.",
};

const screenReaderRestorePolicy: RestoreQueuePolicy = {
  kind: "screen-reader",
  retiredOnIncarnationBump: false,
  setupHandoff: "track-eagerly",
  removedDuringSetupMessage:
    "Cannot change the screen reader: device was removed during session setup.",
};

/** The per-app rule a session owns on an iOS Simulator (#10264). */
export interface IosAppNetworkRuleSessionState {
  udid: string;
  bundleId: string;
  /** Fixed for this session binding; a later binding allocates a newer one. */
  ownerGeneration: number;
  /** The newest revision this session has sent for the target (apply or reset). */
  lastRevision: number;
  /** The revision the provider acknowledged as installed, while it is believed active. */
  installedRevision?: number;
}

/**
 * A failed keep-awake restore leaves a physical device that never sleeps, so — like the network
 * restorer — it is retried inside the pending cleanup, then handed to health recovery (#11145).
 */
const KEEP_SCREEN_AWAKE_RESTORE_RETRY_ATTEMPTS = 2;
const KEEP_SCREEN_AWAKE_RESTORE_RETRY_DELAY_MS = 250;

/** Preserve typed restore evidence through the existing bounded retry path. */
class KeepAwakeRestoreError extends Error {
  constructor(
    message: string,
    readonly report: KeepAwakeRestoreReport,
  ) {
    super(message);
    this.name = "KeepAwakeRestoreError";
  }
}

/** Keep-awake restore resolved before any await, like the biometric target below. */
export interface KeepScreenAwakeRestoreTarget {
  restoreGeneration?: number;
  incarnation?: number;
  sessionId: string;
  deviceId: string;
  state: KeepScreenAwakeState;
}

/** What SessionDeviceStateRestore needs from the session manager that owns it (#11795). */
export interface SessionDeviceStateRestoreHost {
  readonly timer: Timer;
  /** Run one restore under the release teardown's identity-replacement fences. */
  dispatchDeviceRestore(
    deviceId: string,
    restore: (
      signal: AbortSignal,
      identitySignal: AbortSignal,
      acknowledge: () => void,
    ) => Promise<void>,
    generation?: number,
    teardownStep?: number,
  ): Promise<void>;
  /** The device's replaced-restore generation; a changed value supersedes a captured restore. */
  restoreGeneration(deviceId: string): number;
  hasIdentityReplacementFence(deviceId: string): boolean;
  /** Track a setup so a bounded release still waits for it. */
  trackSessionSetup(session: Session, createSetup: () => Promise<void>): Promise<void>;
  /** Whether this exact incarnation is still the published session. */
  isPublished(session: Session): boolean;
  /** The pool incarnation the device's health markers are keyed by, if it has one. */
  healthIncarnation(deviceId: string): number | undefined;
  /** Whether a captured restore still targets the current incarnation and restore generation. */
  restoreIncarnationIsCurrent(target: {
    deviceId: string;
    incarnation?: number;
    restoreGeneration?: number;
  }): boolean;
  clearRestoreHealth(
    target: { deviceId: string; incarnation?: number },
    reason: DeviceHealthReason,
  ): void;
  markHealth(deviceId: string, incarnation: number, reason: DeviceHealthReason): void;
  clearHealthMarker(deviceId: string, incarnation: number, reason: DeviceHealthReason): void;
  /** Wait out a device-identity replacement fence; false when the restore was superseded. */
  waitForIdentityReplacement(deviceId: string, generation: number): Promise<boolean>;
  /** Record an exhausted restore as a health marker and start background recovery. */
  abandonRestore(
    target: { deviceId: string; incarnation?: number },
    reason: Exclude<DeviceHealthReason, "clock">,
    restore: () => Promise<void>,
    restoreTimeoutMs?: number,
  ): void;
  /** Quarantine the device until the cleanups settle. */
  trackPendingDeviceCleanup(deviceId: string, cleanups: readonly Promise<unknown>[]): void;
  /** True while `session` is live and not releasing. */
  isAdmittedForAutomation(session: Session): boolean;
  /** The clock every session timestamp is stamped and judged with. */
  sessionNow(): number;
  /**
   * The TTL elapsed for a still-published `session`: run the shared bounded
   * network restore. `clearIfOwned` drops the restore slot after a definitive
   * success. The host keeps the restore target, teardown shield and retry path.
   */
  restoreNetworkConditionOnExpiry(session: Session, clearIfOwned: () => void): void;
}

export interface SessionDeviceStateRestoreOptions {
  keepScreenAwake: (device: BootedDevice) => KeepScreenAwakeRestorer;
  screenReader: (device: BootedDevice) => ScreenReaderRestorer;
  screenReaderBackoff: BackoffPolicy;
  rotation: (device: BootedDevice) => RotationRestorer;
  rotationBackoff: BackoffPolicy;
  clock: (device: BootedDevice) => ClockRestorer;
  /** The registry that serializes clock restores per device; defaults to the process-wide one. */
  clockRegistry?: DeviceClockRestoreRegistry;
  /** Injected iOS per-app rule restorer; else `defaultIosAppNetworkRuleRestorer()`. */
  iosAppNetworkRuleRestorer?: IosAppNetworkRuleRestorer;
  defaultIosAppNetworkRuleRestorer: () => IosAppNetworkRuleRestorer;
  iosLease: IosAppNetworkLeaseOptions;
}

/** Serialize mutations of one session's device state, in call order. */
export function runDeviceStateMutationExclusive<T>(
  queues: Map<string, Promise<unknown>>,
  sessionId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = queues.get(sessionId) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(fn);
  queues.set(sessionId, next);
  return next.finally(() => {
    if (queues.get(sessionId) === next) {
      queues.delete(sessionId);
    }
  });
}

/**
 * Restoring a session's recorded device state when it releases. The generic restore machinery
 * (start, bounded retry, abandoned retry, setup tracking) lives here with the screen-reader family,
 * the network-condition TTL and the iOS per-app network rule lease; the other families still live
 * in SessionManager and call into it. Code is moved verbatim: the ordering invariants live in the
 * comments next to it and in SessionManager's release path (#11795).
 */
export class SessionDeviceStateRestore {
  private readonly keepAwakeRestoreReports = new Map<string, KeepAwakeRestoreReport>();
  private readonly keepScreenAwakeRestorer: (device: BootedDevice) => KeepScreenAwakeRestorer;
  readonly screenReaderRestores = new DeviceStateRestoreQueue<ScreenReaderSessionState>(
    screenReaderRestorePolicy,
    (deviceId) => {
      this.abandonedScreenReaders.delete(deviceId);
    },
  );
  /** Screen-reader state a device still holds after the bounded retries gave up (#10159). */
  readonly abandonedScreenReaders = new Map<string, ScreenReaderSessionState>();
  private readonly abandonedScreenReaderRetries = new Map<string, Promise<void>>();
  private readonly screenReaderMutationQueues = new Map<string, Promise<unknown>>();
  private readonly screenReaderRestorer: (device: BootedDevice) => ScreenReaderRestorer;
  private readonly screenReaderRestoreBackoff: BackoffPolicy;
  private readonly clockMutationQueues = new Map<string, Promise<unknown>>();
  readonly clockRestores = new DeviceStateRestoreQueue<ClockSessionState>(
    clockRestorePolicy,
    (deviceId) => {
      const incarnation = this.host.healthIncarnation(deviceId);
      if (incarnation !== undefined) {
        this.host.clearHealthMarker(deviceId, incarnation, "clock");
      }
      this.clockRegistry.retire(deviceId);
    },
  );
  private readonly clockRestorer: (device: BootedDevice) => ClockRestorer;
  private readonly clockRegistry: DeviceClockRestoreRegistry;
  private readonly rotationMutationQueues = new Map<string, Promise<unknown>>();
  /** Rotation settings a device still holds after release cleanup gave up on them (#10714). */
  readonly abandonedRotations = new Map<string, RotationSessionState>();
  private readonly abandonedRotationRetries = new Map<string, Promise<void>>();
  readonly rotationRestores = new DeviceStateRestoreQueue<RotationSessionState>(
    rotationRestorePolicy,
    (deviceId) => {
      this.abandonedRotations.delete(deviceId);
    },
  );
  private readonly rotationRestoreBackoff: BackoffPolicy;
  private readonly rotationRestorer: (device: BootedDevice) => RotationRestorer;
  private injectedIosAppNetworkRuleRestorer?: IosAppNetworkRuleRestorer;
  private readonly defaultIosAppNetworkRuleRestorer: () => IosAppNetworkRuleRestorer;
  /**
   * Active per-condition network TTLs (issue #6085 item 2), keyed by session id.
   * When a session degrades the network with an `expiresInSeconds`, a timer resets
   * the profile to `none` when it elapses — independent of session lifetime. The
   * timer is cancelled on release/rebind (whichever restore runs first wins) and
   * clears the restore slot when it fires, so it can never fire against a freed
   * device or double-restore.
   */
  private readonly networkConditionExpiryTimers: Map<
    string,
    { handle: NodeJS.Timeout; session: Session; deadlineMs: number; generation: number }
  > = new Map();
  /**
   * Monotonic per-session network-condition generation (issue #6177). Bumped by
   * {@link bumpNetworkConditionGeneration} on every apply/reset mutation, and
   * captured into a TTL expiry's closure when it is scheduled. A stale expiry
   * (condition A) that is still awaiting its restore when a newer condition
   * (B) is applied sees, on completion, that the session's generation has moved
   * on — so it can detect it was superseded and must not clear B's restore slot.
   */
  private readonly networkConditionGeneration: Map<string, number> = new Map();
  /**
   * Per-session tail of the promise chain serializing
   * {@link runNetworkConditionMutationExclusive} critical sections (issue #6178
   * PR #6183 review, structural fix). The generation guard alone cannot
   * preserve a displaced expiry: a later generation only proves a mutation was
   * ATTEMPTED, not that it succeeded, so two overlapping FAILURES (B then C)
   * could each see nothing to restore while a timed degrade's (A's) original
   * deadline is lost between them. Serializing the whole apply/reset + TTL
   * arm/cancel/re-arm sequence per session removes the race family outright —
   * see {@link runNetworkConditionMutationExclusive}.
   */
  private readonly networkConditionMutationQueues: Map<string, Promise<unknown>> = new Map();
  /** Renews each session's installed iOS per-app rule (#10264). */
  private readonly iosAppNetworkLeases: IosAppNetworkLeases;
  /** Last owner generation handed out; see {@link allocateIosOwnerGeneration}. */
  private lastIosOwnerGeneration = 0;

  constructor(
    private readonly host: SessionDeviceStateRestoreHost,
    options: SessionDeviceStateRestoreOptions,
  ) {
    this.keepScreenAwakeRestorer = options.keepScreenAwake;
    this.screenReaderRestorer = options.screenReader;
    this.screenReaderRestoreBackoff = options.screenReaderBackoff;
    this.rotationRestorer = options.rotation;
    this.rotationRestoreBackoff = options.rotationBackoff;
    this.clockRestorer = options.clock;
    this.clockRegistry = options.clockRegistry ?? defaultDeviceClockRestoreRegistry;
    this.injectedIosAppNetworkRuleRestorer = options.iosAppNetworkRuleRestorer;
    this.defaultIosAppNetworkRuleRestorer = options.defaultIosAppNetworkRuleRestorer;
    this.iosAppNetworkLeases = new IosAppNetworkLeases(
      this.host.timer,
      () => this.iosAppNetworkRuleRestorer,
      options.iosLease,
    );
  }

  private readonly screenReaderKind: RestoreKindSpec<ScreenReaderSessionState> = {
    queue: this.screenReaderRestores,
    name: "Screen reader",
    timeoutMs: SCREEN_READER_RESTORE_TIMEOUT_MS,
    mapStartError: (error) => toActionableError(error, "Screen reader restoration failed"),
    prepare: (deviceId, target) => this.prepareScreenReaderRestore(deviceId, target),
  };
  private readonly screenReaderRetry: BoundedRetrySpec<ScreenReaderSessionState> = {
    attempts: SCREEN_READER_RESTORE_RETRY_ATTEMPTS,
    delayForAttempt: (attempt) => this.screenReaderRestoreBackoff.delayForAttempt(attempt),
    isNonRetryable: () => false,
    logFirstFailure: (deviceId, error) =>
      logger.warn(`Failed to restore screen reader on ${deviceId}`, error),
    logRetryFailure: (deviceId, attempt, error) =>
      logger.warn(
        `Screen reader restore retry ${attempt}/${SCREEN_READER_RESTORE_RETRY_ATTEMPTS} failed on ${deviceId}`,
        error,
      ),
    abandon: (deviceId, target) => this.abandonScreenReaderRestore(deviceId, target),
  };
  private readonly abandonedScreenReaderRestore: AbandonedRestoreSpec<ScreenReaderSessionState> = {
    memory: this.abandonedScreenReaders,
    inFlight: this.abandonedScreenReaderRetries,
    timeoutMs: SCREEN_READER_RESTORE_TIMEOUT_MS,
    label: "Screen reader restoration",
    restore: (deviceId, state, signal) =>
      this.screenReaderRestorer({
        name: deviceId,
        deviceId,
        platform: state.platform,
      }).restore(state, signal),
    restored: (deviceId, state) => {
      this.forgetAbandonedRestore(this.abandonedScreenReaders, deviceId, state);
      logger.info(`Restored the screen reader on ${deviceId} on its next natural attempt`);
    },
    failed: (deviceId, state, error) =>
      logger.warn(
        `Screen reader on ${deviceId} is still not restored to ${state.previousEnabled ? "enabled" : "disabled"}`,
        error,
      ),
  };

  private readonly rotationKind: RestoreKindSpec<RotationSessionState> = {
    queue: this.rotationRestores,
    name: "Rotation",
    timeoutMs: NETWORK_CONDITION_RESTORE_TIMEOUT_MS,
    mapStartError: (error) => toActionableError(error, "Rotation restoration failed"),
    prepare: (deviceId, target) => this.prepareRotationRestore(deviceId, target),
  };
  private readonly rotationRetry: BoundedRetrySpec<RotationSessionState> = {
    attempts: ROTATION_RESTORE_RETRY_ATTEMPTS,
    delayForAttempt: (attempt) => this.rotationRestoreBackoff.delayForAttempt(attempt),
    isNonRetryable: isNonRetryableRotationRestoreError,
    logFirstFailure: (deviceId, error) =>
      logger.warn(`Failed to restore rotation on ${deviceId}: ${errorMessage(error)}`),
    logRetryFailure: (deviceId, attempt, error) =>
      logger.warn(
        `Rotation restore retry ${attempt}/${ROTATION_RESTORE_RETRY_ATTEMPTS} failed on ${deviceId}; ` +
          `device remains quarantined: ${errorMessage(error)}`,
      ),
    abandon: (deviceId, target, lastError, when) =>
      this.abandonRotationRestore(deviceId, target, lastError, when),
  };
  private readonly abandonedRotationRestore: AbandonedRestoreSpec<RotationSessionState> = {
    memory: this.abandonedRotations,
    inFlight: this.abandonedRotationRetries,
    timeoutMs: NETWORK_CONDITION_RESTORE_TIMEOUT_MS,
    label: "Abandoned rotation restoration",
    restore: (deviceId, state, signal) =>
      this.rotationRestorer({ name: deviceId, deviceId, platform: "android" }).restore(
        state,
        signal,
      ),
    restored: (deviceId, state) => {
      this.forgetAbandonedRestore(this.abandonedRotations, deviceId, state);
      logger.info(`Restored rotation settings on ${deviceId} on its next natural attempt`);
    },
    failed: (deviceId, state, error) => {
      if (isNonRetryableRotationRestoreError(error)) {
        this.forgetAbandonedRestore(this.abandonedRotations, deviceId, state);
        logger.warn(
          `Rotation settings on ${deviceId} cannot be restored (window manager owns rotation); ` +
            `dropping the abandoned restore: ${errorMessage(error)}`,
        );
        return;
      }
      logger.warn(
        `Rotation settings on ${deviceId} are still not restored; ` +
          `will try again at the next session start or release: ${errorMessage(error)}`,
      );
    },
  };
  private readonly clockKind: RestoreKindSpec<ClockSessionState> = {
    queue: this.clockRestores,
    name: "Clock",
    timeoutMs: CLOCK_RESTORE_TIMEOUT_MS,
    mapStartError: (error) => error,
    prepare: (deviceId, target) => this.prepareClockRestore(deviceId, target),
  };
  runClockMutationExclusive<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    return runDeviceStateMutationExclusive(this.clockMutationQueues, sessionId, fn);
  }

  runRotationMutationExclusive<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    return runDeviceStateMutationExclusive(this.rotationMutationQueues, sessionId, fn);
  }

  runScreenReaderMutationExclusive<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    return runDeviceStateMutationExclusive(this.screenReaderMutationQueues, sessionId, fn);
  }

  /** Remove only this aborted attempt, preserving its saved baseline if the handoff is superseded. */
  forgetFencedRestore<State, Target extends { state: State }>(
    pending: Map<string, Map<State, Target>>,
    deviceId: string,
    target: Target,
  ): void {
    const targets = pending.get(deviceId);
    if (targets?.get(target.state) !== target) {
      return;
    }
    targets.delete(target.state);
    if (targets.size === 0) {
      pending.delete(deviceId);
    }
  }

  /**
   * Sequence a restore after any still-draining setup and deduplicate it by baseline object. A
   * device removed while setups drain drops the baseline instead of restoring (#11794).
   */
  getPendingRestoration<K extends "clock" | "rotation" | "screenReader">(
    queue: DeviceStateRestoreQueue<NonNullable<Session["cacheData"][K]> & object>,
    slot: K,
    session: Session,
    pendingSetups: Promise<void> | null,
    start: (
      deviceId: string,
      target: PendingRestore<NonNullable<Session["cacheData"][K]> & object>,
    ) => Promise<{ pending: Promise<void> | null }>,
    again: (
      session: Session,
      pendingSetups: Promise<void> | null,
    ) => Promise<{ pending: Promise<void> | null }>,
  ): { pending: Promise<void> | null } | Promise<{ pending: Promise<void> | null }> {
    // Deliberately not async: the per-kind async wrappers return this as the original bodies did,
    // so release and rebind keep their exact microtask turn counts.
    const deviceId = session.assignedDevice;
    if (pendingSetups) {
      const generation = queue.generation(deviceId);
      return {
        pending: pendingSetups.then(async () => {
          if (queue.generation(deviceId) !== generation) {
            delete session.cacheData[slot];
            return;
          }
          const result = await again(session, null);
          await result.pending;
        }),
      };
    }
    const state = session.cacheData[slot] as
      | (NonNullable<Session["cacheData"][K]> & object)
      | undefined;
    if (!state) {
      return { pending: null };
    }
    return queue.join(
      deviceId,
      state,
      () => {
        if (session.cacheData[slot] === state) {
          delete session.cacheData[slot];
        }
      },
      (target) => start(deviceId, target),
    );
  }

  /**
   * The shared start of a restoration: one dispatch bounded by the kind's timeout, then, if it did
   * not restore, quarantine and the kind's retry loop (#11794). Not wrapped further, so the turn
   * counts the release shield suites pin are the ones each kind's copy had.
   */
  async startRestoration<S extends object>(
    spec: RestoreKindSpec<S>,
    deviceId: string,
    target: PendingRestore<S>,
  ): Promise<{ pending: Promise<void> | null }> {
    const run = spec.prepare(deviceId, target);
    const restoration = run.restore().then(
      () => ({ outcome: "restored" as const }),
      (error: unknown) => ({ outcome: "failed" as const, error }),
    );
    const timeout = new Error(`${spec.name} restoration timed out`);
    const result = await raceWithDeadline(restoration, {
      timer: this.host.timer,
      timeoutMs: spec.timeoutMs,
      label: `${spec.name} restoration`,
      timeoutError: () => timeout,
    }).catch((error: unknown) => {
      if (error === timeout) {
        return { outcome: "timed-out" as const };
      }
      throw spec.mapStartError(error);
    });
    if (result.outcome === "restored") {
      return { pending: null };
    }
    if (this.host.hasIdentityReplacementFence(deviceId)) {
      // An upgraded release starts no retries; supersede leaves the baseline for a later release.
      this.forgetFencedRestore(spec.queue.targets, deviceId, target);
      return { pending: null };
    }
    run.quarantined(result.outcome, result.outcome === "failed" ? result.error : timeout);
    const noun = spec.name.toLowerCase();
    const pending = raceWithDeadline(run.retry(restoration), {
      timer: this.host.timer,
      signal: target.controller.signal,
      label: `Pending ${noun} restoration`,
    }).catch((error: unknown) => {
      if (!target.removed) {
        throw toActionableError(error, `${spec.name} restoration failed`);
      }
      // Proven removal retires ownership; no restoration may reach a replacement.
      logger.debug(`Retired ${noun} restoration on removed device ${deviceId}`);
    });
    return { pending };
  }

  /** Retry a failed restore with bounded backoff, then abandon it (rotation, screen reader). */
  async retryRestoreBounded<S extends object>(
    spec: BoundedRetrySpec<S>,
    deviceId: string,
    target: PendingRestore<S>,
    restoration: Promise<RestoreAttemptOutcome>,
    restore: () => Promise<void>,
  ): Promise<void> {
    const result = await restoration;
    if (result.outcome === "restored") {
      return;
    }
    spec.logFirstFailure(deviceId, result.error);
    if (spec.isNonRetryable(result.error)) {
      spec.abandon(deviceId, target, result.error, "without retrying");
      return;
    }
    let lastError: unknown = result.error;
    for (let attempt = 1; attempt <= spec.attempts; attempt++) {
      await this.host.timer.sleep(spec.delayForAttempt(attempt));
      if (target.removed) {
        return;
      }
      try {
        await restore();
        return;
      } catch (error) {
        if (spec.isNonRetryable(error)) {
          spec.abandon(deviceId, target, error, `after ${attempt} retries`);
          return;
        }
        lastError = error;
        spec.logRetryFailure(deviceId, attempt, error);
      }
    }
    spec.abandon(deviceId, target, lastError, `after ${spec.attempts} retries`);
  }

  forgetAbandonedRestore<S>(memory: Map<string, S>, deviceId: string, state: S): void {
    if (memory.get(deviceId) === state) {
      memory.delete(deviceId);
    }
  }

  /** The older, truer baseline wins, so it runs after the session's own restoration settles. */
  async retryAbandonedAfter(own: Promise<void> | null, retry: () => Promise<void>): Promise<void> {
    try {
      await own;
    } finally {
      await retry();
    }
  }

  /**
   * One bounded attempt at a baseline an earlier release gave up on, awaited before the device is
   * handed to a new session; never on a timer. Either way the device proceeds.
   */
  retryAbandonedRestore<S extends object>(
    spec: AbandonedRestoreSpec<S>,
    deviceId: string,
  ): Promise<void> {
    const state = spec.memory.get(deviceId);
    if (!state) {
      return Promise.resolve();
    }
    const inFlight = spec.inFlight.get(deviceId);
    if (inFlight) {
      return inFlight;
    }
    const controller = new AbortController();
    const generation = this.host.restoreGeneration(deviceId);
    const attempt = (async () => {
      try {
        await raceWithDeadline(
          this.host.dispatchDeviceRestore(
            deviceId,
            (signal) => spec.restore(deviceId, state, AbortSignal.any([signal, controller.signal])),
            generation,
          ),
          { timer: this.host.timer, timeoutMs: spec.timeoutMs, label: spec.label },
        );
        spec.restored(deviceId, state);
      } catch (error) {
        controller.abort();
        spec.failed(deviceId, state, error);
      }
    })().finally(() => {
      if (spec.inFlight.get(deviceId) === attempt) {
        spec.inFlight.delete(deviceId);
      }
    });
    spec.inFlight.set(deviceId, attempt);
    return attempt;
  }

  /**
   * Track a setup that records a restore baseline. If the device was removed meanwhile the baseline
   * is dropped; if the setup outlives a bounded release, its restore is handed to device
   * quarantine so the request can settle (#11794). The queue's policy picks how.
   */
  trackRestoreSetup<K extends "clock" | "rotation" | "screenReader">(
    queue: DeviceStateRestoreQueue<NonNullable<Session["cacheData"][K]> & object>,
    slot: K,
    session: Session,
    createSetup: (assertCurrentDevice: () => void) => Promise<void>,
    startRestore: () => Promise<{ pending: Promise<void> | null }>,
  ): Promise<void> {
    const deviceId = session.assignedDevice;
    const generation = queue.generation(deviceId);
    const outlivedRelease = () =>
      !this.host.isPublished(session) && Boolean(session.cacheData[slot]);
    return this.host.trackSessionSetup(session, async () => {
      try {
        await createSetup(() => {
          if (queue.generation(deviceId) !== generation) {
            throw new ActionableError(queue.policy.removedDuringSetupMessage);
          }
        });
      } finally {
        if (queue.generation(deviceId) !== generation) {
          delete session.cacheData[slot];
        } else if (outlivedRelease() && queue.policy.setupHandoff === "await-then-track") {
          // Baseline capture can finish after bounded release. Hand unbounded
          // retries to device quarantine so the setup/tool request can settle.
          const restoration = await startRestore();
          if (restoration.pending) {
            this.host.trackPendingDeviceCleanup(deviceId, [restoration.pending]);
          }
        } else if (outlivedRelease()) {
          // The setup still holds the device mutex here. Publish quarantine before
          // setup settles, then let restoration acquire that mutex after return.
          const restoration = startRestore().then(async ({ pending }) => {
            await pending;
          });
          this.host.trackPendingDeviceCleanup(deviceId, [restoration]);
        }
      }
    });
  }

  /** Sequence restoration after any still-draining setup; deduplicate by owned slot (#10146). */
  async getPendingScreenReaderRestoration(
    session: Session,
    pendingSetups: Promise<void> | null,
  ): Promise<{ pending: Promise<void> | null }> {
    return this.getPendingRestoration(
      this.screenReaderRestores,
      "screenReader",
      session,
      pendingSetups,
      (deviceId, target) => this.startScreenReaderRestoration(deviceId, target),
      (next, setups) => this.getPendingScreenReaderRestoration(next, setups),
    );
  }

  private startScreenReaderRestoration(
    deviceId: string,
    target: PendingRestore<ScreenReaderSessionState>,
  ): Promise<{ pending: Promise<void> | null }> {
    return this.startRestoration(this.screenReaderKind, deviceId, target);
  }

  private prepareScreenReaderRestore(
    deviceId: string,
    target: PendingRestore<ScreenReaderSessionState>,
  ): RestoreRun {
    const device: BootedDevice = { name: deviceId, deviceId, platform: target.state.platform };
    const generation = this.host.restoreGeneration(deviceId);
    const restore = () =>
      this.host.dispatchDeviceRestore(
        deviceId,
        async (fenceSignal, identitySignal, acknowledge) => {
          const dispatchSignal = AbortSignal.any([target.controller.signal, fenceSignal]);
          target.controller.signal.throwIfAborted();
          identitySignal.throwIfAborted();
          await this.screenReaderRestorer(device).restore(target.state, dispatchSignal);
          acknowledge();
          target.controller.signal.throwIfAborted();
          target.clear();
          this.forgetFencedRestore(this.screenReaderRestores.targets, deviceId, target);
        },
        generation,
        6,
      );
    return {
      restore,
      quarantined: (outcome, error) =>
        logger.warn(`Screen reader restore ${outcome}; quarantining ${device.deviceId}`, error),
      retry: (restoration) =>
        this.retryRestoreBounded(
          this.screenReaderRetry,
          device.deviceId,
          target,
          restoration,
          restore,
        ),
    };
  }

  private abandonScreenReaderRestore(
    deviceId: string,
    target: PendingRestore<ScreenReaderSessionState>,
  ): void {
    if (target.removed) {
      return;
    }
    const { platform, previousEnabled } = target.state;
    logger.warn(
      `Gave up restoring the screen reader on ${deviceId} after ` +
        `${SCREEN_READER_RESTORE_RETRY_ATTEMPTS} retries; ${platform === "ios" ? "VoiceOver" : "TalkBack"} ` +
        `should be ${previousEnabled ? "enabled" : "disabled"} but was not confirmed. ` +
        `Will try once more at the next session start or release on this device.`,
    );
    this.abandonedScreenReaders.set(deviceId, target.state);
    target.clear();
    this.forgetFencedRestore(this.screenReaderRestores.targets, deviceId, target);
  }

  retryAbandonedScreenReaderAfter(deviceId: string, own: Promise<void> | null): Promise<void> {
    return this.retryAbandonedAfter(own, () => this.retryAbandonedScreenReaderRestore(deviceId));
  }

  /** One bounded attempt at a state an earlier release gave up on; never on a timer. */
  retryAbandonedScreenReaderRestore(deviceId: string): Promise<void> {
    return this.retryAbandonedRestore(this.abandonedScreenReaderRestore, deviceId);
  }

  /** Tracked setup retains this exact session even after a bounded release times out (#10146). */
  trackScreenReaderSessionSetup(
    session: Session,
    createSetup: (assertCurrentDevice: () => void) => Promise<void>,
  ): Promise<void> {
    return this.trackRestoreSetup(
      this.screenReaderRestores,
      "screenReader",
      session,
      createSetup,
      () => this.getPendingScreenReaderRestoration(session, null),
    );
  }

  /** The injected iOS per-app rule restorer, else one over the installed controller. */
  get iosAppNetworkRuleRestorer(): IosAppNetworkRuleRestorer {
    this.injectedIosAppNetworkRuleRestorer ??= this.defaultIosAppNetworkRuleRestorer();
    return this.injectedIosAppNetworkRuleRestorer;
  }

  /**
   * Owner generations must increase across daemon restarts, because the
   * provider keeps tombstones of released generations in memory. Seeding from
   * the host clock (milliseconds) and never repeating a value keeps a new
   * daemon's generations above an earlier daemon's.
   */
  private allocateIosOwnerGeneration(): number {
    this.lastIosOwnerGeneration = Math.max(
      this.lastIosOwnerGeneration + 1,
      Math.floor(this.host.sessionNow()),
    );
    return this.lastIosOwnerGeneration;
  }

  /**
   * Publish this session's iOS per-app rule slot before an `apply` (#10264), so
   * release, rebind and TTL expiry can remove it even if the apply is in flight.
   * One app per session: a different app must be reset first.
   */
  beginIosAppNetworkRule(
    session: Session,
    target: { udid: string; bundleId: string },
  ): IosAppNetworkRuleCommandContext {
    const state = session.cacheData.networkCondition;
    const existing = state?.iosAppRule;
    if (existing && (existing.udid !== target.udid || existing.bundleId !== target.bundleId)) {
      throw new ActionableError(
        `Session ${session.sessionId} already holds an offline rule for ${existing.bundleId}; ` +
          `reset it with networkCondition { profile: "none", appId: "${existing.bundleId}" } first.`,
      );
    }
    const rule: IosAppNetworkRuleSessionState = existing ?? {
      udid: target.udid,
      bundleId: target.bundleId,
      ownerGeneration: this.allocateIosOwnerGeneration(),
      lastRevision: 0,
    };
    if (!existing) {
      session.cacheData.networkCondition = { initialProfile: "none", iosAppRule: rule };
    }
    return this.iosRuleContext(session, rule, ++rule.lastRevision);
  }

  /**
   * Ownership for an explicit `reset` of `target`. A session that holds no rule
   * for it still sends a reset (under a fresh generation it never stores): the
   * provider then answers `reset` when no rule exists, or refuses to clear
   * another session's rule.
   */
  prepareIosAppNetworkReset(
    session: Session,
    target: { udid: string; bundleId: string },
  ): IosAppNetworkRuleCommandContext {
    const existing = session.cacheData.networkCondition?.iosAppRule;
    if (existing && existing.udid === target.udid && existing.bundleId === target.bundleId) {
      return this.iosRuleContext(session, existing, ++existing.lastRevision);
    }
    const transient: IosAppNetworkRuleSessionState = {
      udid: target.udid,
      bundleId: target.bundleId,
      ownerGeneration: this.allocateIosOwnerGeneration(),
      lastRevision: 1,
    };
    return this.iosRuleContext(session, transient, transient.lastRevision);
  }

  private iosRuleContext(
    session: Session,
    state: IosAppNetworkRuleSessionState,
    revision: number,
  ): IosAppNetworkRuleCommandContext {
    return {
      rule: {
        udid: state.udid,
        bundleId: state.bundleId,
        owner: session.sessionId,
        ownerGeneration: state.ownerGeneration,
        revision,
      },
      nextRevision: () => ++state.lastRevision,
    };
  }

  /**
   * The provider acknowledged `rule` as installed: record it and renew its lease
   * while this exact session still owns this exact revision.
   */
  confirmIosAppNetworkRule(session: Session, rule: IosAppNetworkRule): void {
    const state = session.cacheData.networkCondition?.iosAppRule;
    if (
      !this.host.isPublished(session) ||
      !state ||
      state.ownerGeneration !== rule.ownerGeneration
    ) {
      return;
    }
    state.installedRevision = rule.revision;
    this.iosAppNetworkLeases.start(session.sessionId, rule, () => {
      const current = session.cacheData.networkCondition?.iosAppRule;
      return (
        this.host.isAdmittedForAutomation(session) &&
        current === state &&
        current.installedRevision === rule.revision
      );
    });
  }

  /**
   * The session reset its rule (or the provider said it no longer holds one):
   * stop renewing and drop the slot, so release does not reset it again.
   */
  finishIosAppNetworkReset(session: Session, rule: IosAppNetworkRule): void {
    if (!this.host.isPublished(session)) {
      return;
    }
    const state = session.cacheData.networkCondition?.iosAppRule;
    if (!state || state.ownerGeneration !== rule.ownerGeneration) {
      return;
    }
    this.iosAppNetworkLeases.stop(session.sessionId);
    delete session.cacheData.networkCondition;
  }

  /** The iOS rule whose lease this session is renewing, if any (diagnostics and tests). */
  activeIosAppNetworkLease(sessionId: string): IosAppNetworkRule | undefined {
    return this.iosAppNetworkLeases.active(sessionId);
  }

  /** Stop renewing `sessionId`'s iOS rule lease (release/rebind remove the rule themselves). */
  stopIosAppNetworkLease(sessionId: string): void {
    this.iosAppNetworkLeases.stop(sessionId);
  }

  /** Start renewing an already-confirmed rule (rebind republishes the lease). */
  startIosAppNetworkLease(
    sessionId: string,
    rule: IosAppNetworkRule,
    isCurrent: () => boolean,
  ): void {
    this.iosAppNetworkLeases.start(sessionId, rule, isCurrent);
  }

  /**
   * Arm a standalone per-condition network TTL (issue #6085 item 2): when it
   * elapses, the device is reset to `none` independent of session lifetime.
   * Re-scheduling (a re-applied condition) cancels the prior timer first, so only
   * the latest TTL is armed. A non-positive TTL arms nothing (and still clears any
   * prior timer), matching the "TTL-only / neutral request applies nothing" rule.
   *
   * Keyed by session id but IDENTITY-GUARDED by the captured `Session` instance
   * (issue #6085 review): the caller passes the exact session it just mutated, and
   * the timer fires against that instance only — so a stale schedule from a
   * timed-out setup cannot arm or fire a TTL against a same-UUID REPLACEMENT
   * session. The TTL is clamped to `MAX_NETWORK_CONDITION_TTL_SECONDS` so the
   * millisecond product cannot overflow `setTimeout`'s signed 32-bit delay (item 4).
   *
   * `generation` MUST be the value the caller's own `bumpNetworkConditionGeneration`
   * call returned for the mutation this TTL belongs to (issue #6181 review) — NOT
   * re-read from the session's current generation here. Two mutations (B, C) can
   * bump the shared counter before either reaches this call (B under `await
   * trackSessionSetup`, C right behind it), so reading "current" at schedule time
   * can tag B's timer with C's generation. Comparing against a per-call, per-mutation
   * value closes that window: a timer only ever matches the generation it actually
   * belongs to. Callers that don't track their own generation (tests, and any
   * caller predating this parameter) may omit it, falling back to the session's
   * current generation at schedule time — safe as long as no concurrent mutation is
   * in flight for that call.
   */
  scheduleNetworkConditionExpiry(
    session: Session,
    expiresInSeconds: number,
    generation?: number,
  ): void {
    const sessionId = session.sessionId;
    this.cancelNetworkConditionExpiry(sessionId);
    if (!(expiresInSeconds > 0)) {
      return;
    }
    // A stale schedule (e.g. a setup that finished after this session was released
    // and replaced) must not arm a timer against the replacement — bail unless the
    // captured instance is still the live session.
    if (!this.host.isPublished(session)) {
      return;
    }
    const effectiveSeconds = Math.min(expiresInSeconds, MAX_NETWORK_CONDITION_TTL_SECONDS);
    if (effectiveSeconds < expiresInSeconds) {
      logger.warn(
        `networkCondition TTL of ${expiresInSeconds}s exceeds the ${MAX_NETWORK_CONDITION_TTL_SECONDS}s ` +
          `setTimeout limit for session ${sessionId}; clamping to ${effectiveSeconds}s`,
      );
    }
    // Capture the OWNING mutation's generation into the closure (issue #6177,
    // hardened #6181): if a newer condition supersedes it before this timer's
    // awaited restore settles, the generation check in clearNetworkConditionIfOwned
    // detects the mismatch and skips clearing the newer condition's restore slot.
    const effectiveGeneration = generation ?? this.currentNetworkConditionGeneration(sessionId);
    this.armNetworkConditionExpiryAt(
      session,
      this.host.sessionNow() + effectiveSeconds * 1000,
      effectiveGeneration,
    );
  }

  /**
   * Arm the timer for an absolute deadline and a fixed generation, shared by
   * {@link scheduleNetworkConditionExpiry} (a fresh TTL) and
   * {@link rearmNetworkConditionExpiry} (restoring a snapshot taken by
   * {@link peekNetworkConditionExpiry}). Identity-guarded like its callers: a
   * session that was replaced under the same id since the deadline was captured
   * is not armed against.
   */
  private armNetworkConditionExpiryAt(
    session: Session,
    deadlineMs: number,
    generation: number,
  ): void {
    const sessionId = session.sessionId;
    if (!this.host.isPublished(session)) {
      return;
    }
    const remainingMs = Math.max(0, deadlineMs - this.host.sessionNow());
    const handle = this.host.timer.setTimeout(() => {
      this.handleNetworkConditionExpiry(session, generation);
    }, remainingMs);
    this.networkConditionExpiryTimers.set(sessionId, { handle, session, deadlineMs, generation });
  }

  /**
   * Snapshot a pending network-condition TTL without disturbing it (issue
   * #6178 item 1). `runSessionNetworkMutation` calls this before cancelling the
   * timer to run its own mutation race-free (issue #6085 review), then re-arms
   * the snapshot via {@link rearmNetworkConditionExpiry} if that mutation does
   * not confirm success — so a manual reset whose emulator command fails does
   * not permanently drop the deadline a prior timed degrade promised.
   */
  peekNetworkConditionExpiry(
    sessionId: string,
  ): { deadlineMs: number; generation: number } | undefined {
    const entry = this.networkConditionExpiryTimers.get(sessionId);
    return entry ? { deadlineMs: entry.deadlineMs, generation: entry.generation } : undefined;
  }

  /**
   * Re-arm a TTL previously captured via {@link peekNetworkConditionExpiry},
   * preserving its original deadline and generation exactly (issue #6178 item
   * 1). A deadline already in the past fires on the next tick rather than
   * being dropped, matching a TTL that elapsed while the failed mutation ran.
   *
   * Generation-guarded (issue #6178 PR #6183 review, P1): the caller's own
   * mutation attempt already bumped the counter to `snapshot.generation`
   * before it ran, so an UNCHANGED current generation means nothing else has
   * mutated since. But three overlapping requests on one session (A's timed
   * degrade, B's slow failing re-apply, C's later successful re-apply) can
   * settle out of order — B's failure must not blindly re-arm A's deadline
   * once C has already bumped the counter again and established its own
   * state (its own fresh TTL, live in the timer map, or a deliberate "no
   * TTL"). Skipping whenever the generation has moved on avoids both
   * resurrecting a deadline C already retired AND clobbering C's live timer
   * handle without cancelling it.
   *
   * Also refuses to re-arm a releasing/released session (issue #6178 PR #6183
   * review, P2): `releaseSessionInternal` cancels any pending TTL BEFORE
   * awaiting the tracked mutation that may still be in flight. If that
   * mutation then throws (or otherwise triggers a re-arm) while release is
   * still draining, blindly re-arming here would undo release's cancellation
   * — either running a stale timer concurrently with release's own
   * restoration, or pinning a released session's timer-map entry for up to
   * `MAX_NETWORK_CONDITION_TTL_SECONDS` (~24.8 days). Release's cancellation
   * must be the last word, so a releasing/no-longer-current session is never
   * re-armed.
   */
  rearmNetworkConditionExpiry(
    session: Session,
    snapshot: { deadlineMs: number; generation: number },
  ): void {
    const sessionId = session.sessionId;
    if (this.currentNetworkConditionGeneration(sessionId) !== snapshot.generation) {
      logger.debug(
        `Skipping network-condition TTL re-arm for session ${sessionId}: generation ` +
          `${snapshot.generation} has been superseded by a later mutation`,
      );
      return;
    }
    if (!this.host.isAdmittedForAutomation(session)) {
      logger.debug(
        `Skipping network-condition TTL re-arm for session ${sessionId}: session is releasing ` +
          `or no longer live`,
      );
      return;
    }
    this.armNetworkConditionExpiryAt(session, snapshot.deadlineMs, snapshot.generation);
  }

  /**
   * Cancel a pending network TTL. Called on release, rebind, and any subsequent
   * network mutation (a manual reset, or a re-apply BEFORE it re-arms) so the
   * release-restore and the TTL can never both fire. A no-op when no timer is armed.
   */
  cancelNetworkConditionExpiry(sessionId: string): void {
    const entry = this.networkConditionExpiryTimers.get(sessionId);
    if (entry !== undefined) {
      this.host.timer.clearTimeout(entry.handle);
      this.networkConditionExpiryTimers.delete(sessionId);
    }
  }

  /**
   * TTL elapsed: the host resets the device to `none` via the SAME bounded
   * restore/retry the session-release path uses, and RETAINS restoration
   * ownership — keeps the restore slot and the device quarantined — until the
   * reset actually SUCCEEDS (issue #6085 review); only then does
   * {@link clearNetworkConditionIfOwned} drop the slot.
   *
   * Identity-guarded on the captured `Session`: a fire against a same-UUID
   * REPLACEMENT session (or an already-released one) is a no-op, so it never acts
   * on a freed or replaced device.
   */
  private handleNetworkConditionExpiry(session: Session, expectedGeneration: number): void {
    const sessionId = session.sessionId;
    const entry = this.networkConditionExpiryTimers.get(sessionId);
    if (entry && entry.session === session) {
      this.networkConditionExpiryTimers.delete(sessionId);
    }
    // Read the raw session map rather than getSession(), so a timer fire cannot
    // trigger a lazy-expiry release as a side effect. A missing or replaced
    // session was already released — its release-restore handled connectivity.
    if (!this.host.isPublished(session)) {
      return;
    }
    this.host.restoreNetworkConditionOnExpiry(session, () =>
      this.clearNetworkConditionIfOwned(session, expectedGeneration),
    );
  }

  /**
   * Drop the network restore slot once a reset has satisfied it (issue #6085),
   * but ONLY while the captured session is still the live one — a same-UUID
   * replacement must keep its own freshly-published slot — AND only while the
   * session's network-condition generation still matches the one this expiry was
   * scheduled against (issue #6177). A stale expiry (condition A) that settles
   * after a newer condition (B) has been applied must not delete B's restore
   * slot: the generation mismatch is the signal that A has been superseded.
   */
  private clearNetworkConditionIfOwned(session: Session, expectedGeneration: number): void {
    if (!this.host.isPublished(session)) {
      return;
    }
    if (this.currentNetworkConditionGeneration(session.sessionId) !== expectedGeneration) {
      logger.debug(
        `Network condition TTL expiry for session ${session.sessionId} settled after a newer ` +
          `condition superseded it; leaving that condition's restore binding in place`,
      );
      return;
    }
    if (session.cacheData.networkCondition) {
      delete session.cacheData.networkCondition;
      this.iosAppNetworkLeases.stop(session.sessionId);
    }
  }

  /**
   * Bump the per-session network-condition generation (issue #6177). Called on
   * every apply/reset mutation, BEFORE the mutation runs, so a TTL scheduled for
   * the condition being replaced can never observe the generation it captures as
   * still current. Returns the new generation for the caller to arm a TTL with.
   */
  bumpNetworkConditionGeneration(sessionId: string): number {
    const next = (this.networkConditionGeneration.get(sessionId) ?? 0) + 1;
    this.networkConditionGeneration.set(sessionId, next);
    return next;
  }

  /**
   * Run `fn` as the next link in a per-session promise-chain mutex, so that
   * `runSessionNetworkMutation`'s ENTIRE critical section — generation bump,
   * TTL snapshot/cancel, the mutation itself, and its TTL re-arm/schedule
   * decision — never overlaps another same-session networkCondition mutation
   * (issue #6178 PR #6183 review). This is the structural fix for a family of
   * races the generation guard alone could not close: a later generation only
   * proves a mutation was ATTEMPTED, not that it succeeded, so two overlapping
   * FAILURES could each observe nothing to restore while a displaced TTL is
   * lost between them. With this lock, a later mutation's snapshot always sees
   * the FULLY SETTLED state (including any prior mutation's own re-arm) of the
   * one before it — the whole interleaving family becomes impossible, not just
   * the specific cases already patched.
   *
   * Scoped narrowly and reentrancy-safe by construction: keyed per session id
   * (never blocks a different session's mutations, or unrelated session work
   * like release/rebind — those act on the timer/session maps directly), and
   * `fn` is the caller's entire body, so nothing outside this one critical
   * section is ever held across an await. `.catch(() => undefined)` on the
   * chain tail ensures one mutation's rejection cannot wedge the queue for the
   * next; the `finally` drops the map entry once nothing is queued behind it,
   * so a dead session leaves no residue.
   */
  runNetworkConditionMutationExclusive<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    return runDeviceStateMutationExclusive(this.networkConditionMutationQueues, sessionId, fn);
  }

  private currentNetworkConditionGeneration(sessionId: string): number {
    return this.networkConditionGeneration.get(sessionId) ?? 0;
  }

  /** The session ended: drop its generation and mutation queue (no residue). */
  forgetSession(sessionId: string): void {
    this.networkConditionGeneration.delete(sessionId);
    this.networkConditionMutationQueues.delete(sessionId);
  }

  /** Cancel every armed TTL and stop every iOS lease so a stopped manager leaves no timer. */
  stopAll(): void {
    for (const entry of this.networkConditionExpiryTimers.values()) {
      this.host.timer.clearTimeout(entry.handle);
    }
    this.networkConditionExpiryTimers.clear();
    this.iosAppNetworkLeases.stopAll();
  }

  /** Sequence restoration after any still-draining setup; deduplicate by owned slot. */
  async getPendingRotationRestoration(
    session: Session,
    pendingSetups: Promise<void> | null,
  ): Promise<{ pending: Promise<void> | null }> {
    return this.getPendingRestoration(
      this.rotationRestores,
      "rotation",
      session,
      pendingSetups,
      (deviceId, target) => this.startRotationRestoration(deviceId, target),
      (next, setups) => this.getPendingRotationRestoration(next, setups),
    );
  }

  private startRotationRestoration(
    deviceId: string,
    target: PendingRestore<RotationSessionState>,
  ): Promise<{ pending: Promise<void> | null }> {
    return this.startRestoration(this.rotationKind, deviceId, target);
  }

  private prepareRotationRestore(
    deviceId: string,
    target: PendingRestore<RotationSessionState>,
  ): RestoreRun {
    const device: BootedDevice = { name: deviceId, deviceId, platform: "android" };
    const generation = this.host.restoreGeneration(deviceId);
    const restore = () =>
      this.host.dispatchDeviceRestore(
        deviceId,
        async (fenceSignal, identitySignal, acknowledge) => {
          const dispatchSignal = AbortSignal.any([target.controller.signal, fenceSignal]);
          target.controller.signal.throwIfAborted();
          identitySignal.throwIfAborted();
          await this.rotationRestorer(device).restore(target.state, dispatchSignal);
          acknowledge();
          target.controller.signal.throwIfAborted();
          target.clear();
          this.forgetFencedRestore(this.rotationRestores.targets, deviceId, target);
        },
        generation,
        5,
      );
    return {
      restore,
      quarantined: (outcome, error) =>
        logger.warn(
          `Rotation restore ${outcome}; quarantining ${device.deviceId}: ${errorMessage(error)}`,
        ),
      retry: (restoration) =>
        this.retryRestoreBounded(this.rotationRetry, device.deviceId, target, restoration, restore),
    };
  }

  /** Release the device from quarantine once the bounded rotation retries are spent. */
  private abandonRotationRestore(
    deviceId: string,
    target: PendingRestore<RotationSessionState>,
    lastError: unknown,
    when: string,
  ): void {
    if (target.removed) {
      return;
    }
    const { userRotation, accelerometerRotation, deviceStateRotationLock } = target.state;
    const lock =
      deviceStateRotationLock === undefined
        ? ""
        : `, device_state_rotation_lock=${deviceStateRotationLock}`;
    logger.warn(
      `Gave up restoring rotation settings on ${deviceId} ${when} ` +
        `(user_rotation=${userRotation ?? "unchanged"}, accelerometer_rotation=${accelerometerRotation ?? "unchanged"}${lock} ` +
        `not confirmed: ${errorMessage(lastError)}); releasing the device from cleanup. ` +
        `A fold or display change during the session can make the recorded settings unverifiable. ` +
        `Will try once more at the next session start or release on this device.`,
    );
    // An older abandoned baseline is the truer original; keep it over a newer session's.
    if (!this.abandonedRotations.has(deviceId)) {
      this.abandonedRotations.set(deviceId, target.state);
    }
    target.clear();
    this.forgetFencedRestore(this.rotationRestores.targets, deviceId, target);
  }

  retryAbandonedRotationAfter(deviceId: string, own: Promise<void> | null): Promise<void> {
    return this.retryAbandonedAfter(own, () => this.retryAbandonedRotationRestore(deviceId));
  }

  /**
   * A transient failure keeps the record for the next start or release. A window-manager-managed
   * outcome is definitively unrecoverable, so the record is dropped.
   */
  retryAbandonedRotationRestore(deviceId: string): Promise<void> {
    return this.retryAbandonedRestore(this.abandonedRotationRestore, deviceId);
  }

  trackRotationSessionSetup(
    session: Session,
    createSetup: (assertCurrentDevice: () => void) => Promise<void>,
  ): Promise<void> {
    return this.trackRestoreSetup(this.rotationRestores, "rotation", session, createSetup, () =>
      this.getPendingRotationRestoration(session, null),
    );
  }

  /** Use the same setup drain and pending device cleanup as network restoration. */
  async getPendingClockRestoration(
    session: Session,
    pendingSetups: Promise<void> | null,
  ): Promise<{ pending: Promise<void> | null }> {
    return this.getPendingRestoration(
      this.clockRestores,
      "clock",
      session,
      pendingSetups,
      (deviceId, target) => this.startClockRestoration(deviceId, target),
      (next, setups) => this.getPendingClockRestoration(next, setups),
    );
  }

  private startClockRestoration(
    deviceId: string,
    target: PendingRestore<ClockSessionState>,
  ): Promise<{ pending: Promise<void> | null }> {
    return this.startRestoration(this.clockKind, deviceId, target);
  }

  private prepareClockRestore(
    deviceId: string,
    target: PendingRestore<ClockSessionState>,
  ): RestoreRun {
    const healthTarget = { deviceId, incarnation: this.host.healthIncarnation(deviceId) };
    const device: BootedDevice = { name: deviceId, deviceId, platform: "android" };
    const signal = this.clockRegistry.signal(deviceId);
    const generation = this.host.restoreGeneration(deviceId);
    const restore = () =>
      this.host.dispatchDeviceRestore(
        deviceId,
        (fenceSignal, identitySignal, acknowledge) =>
          this.clockRegistry.runExclusive(
            deviceId,
            async () => {
              target.controller.signal.throwIfAborted();
              if (!this.host.restoreIncarnationIsCurrent(healthTarget)) {
                return;
              }
              const dispatchSignal = AbortSignal.any([target.controller.signal, fenceSignal]);
              identitySignal.throwIfAborted();
              await this.clockRestorer(device).restore(target.state, dispatchSignal);
              acknowledge();
              target.controller.signal.throwIfAborted();
              this.clockRegistry.restored(deviceId, target.state);
              target.clear();
              this.forgetFencedRestore(this.clockRestores.targets, deviceId, target);
              if (!this.clockRestores.targets.has(deviceId)) {
                this.host.clearRestoreHealth(healthTarget, "clock");
              }
            },
            undefined,
            signal,
          ),
        generation,
        4,
      );
    return {
      restore,
      quarantined: (outcome) => {
        logger.warn(`Clock restore ${outcome}; quarantining ${device.deviceId}`);
        if (healthTarget.incarnation === undefined) {
          logger.warn(
            `Failed to restore state on ${deviceId} (clock); no health marker could be keyed because the device has no pool incarnation`,
          );
        }
        if (
          healthTarget.incarnation !== undefined &&
          this.host.restoreIncarnationIsCurrent(healthTarget) &&
          !target.removed &&
          this.clockRestores.targets.get(deviceId)?.has(target.state)
        ) {
          this.host.markHealth(deviceId, healthTarget.incarnation, "clock");
        }
      },
      retry: (restoration) => this.retryClockRestore(device.deviceId, target, restoration, restore),
    };
  }

  /** Same setup drain, deadline, retry delay and pool quarantine as network restoration.
   * Clock ownership remains pending beyond the network path's bounded retry batch.
   */
  private async retryClockRestore(
    deviceId: string,
    target: PendingRestore<ClockSessionState>,
    restoration: Promise<{ outcome: "restored" } | { outcome: "failed"; error: unknown }>,
    restore: () => Promise<void>,
  ): Promise<void> {
    const result = await restoration;
    if (result.outcome === "restored") {
      return;
    }
    logger.warn(`Failed to restore clock on ${deviceId}`, result.error);
    while (!target.removed) {
      await this.host.timer.sleep(NETWORK_CONDITION_RESTORE_RETRY_DELAY_MS);
      if (target.removed) {
        return;
      }
      try {
        await restore();
        return;
      } catch (error) {
        logger.warn(`Clock restore retry failed on ${deviceId}; device remains quarantined`, error);
      }
    }
  }

  /** Tracked setup retains this exact session even after a bounded release times out. */
  trackClockSessionSetup(session: Session, createSetup: () => Promise<void>): Promise<void> {
    return this.trackRestoreSetup(
      this.clockRestores,
      "clock",
      session,
      () => createSetup(),
      () => this.getPendingClockRestoration(session, null),
    );
  }

  async restoreKeepScreenAwakeBestEffort(
    session: Session,
    forced: () => boolean = () => false,
  ): Promise<{ pending: Promise<void> | null }> {
    const target = this.keepScreenAwakeRestoreTarget(session);
    if (!target) {
      return { pending: null };
    }
    const restoration = this.restoreKeepScreenAwakeTarget(target).then(
      () => ({ outcome: "restored" as const }),
      (error: unknown) => ({ outcome: "failed" as const, error }),
    );
    const timeout = new Error("Keep-awake restore timed out");
    const result = await raceWithDeadline(restoration, {
      timer: this.host.timer,
      timeoutMs: KEEP_SCREEN_AWAKE_RESTORE_TIMEOUT_MS,
      label: "Keep-awake restore",
      timeoutError: () => timeout,
    }).catch((error: unknown) => {
      if (error === timeout) {
        return { outcome: "timed-out" as const };
      }
      throw error;
    });
    if (this.host.hasIdentityReplacementFence(target.deviceId)) {
      return { pending: null };
    }
    if (result.outcome === "failed") {
      logger.warn(
        `Failed to restore keep-awake state for session ${session.sessionId}: ${result.error}`,
      );
      // Quarantine the device until the retries settle, as the network restore does (#11145).
      return { pending: this.retryKeepScreenAwakeRestore(target, result.error, forced) };
    }
    if (result.outcome === "timed-out") {
      logger.warn(
        `Timed out after ${KEEP_SCREEN_AWAKE_RESTORE_TIMEOUT_MS}ms restoring keep-awake state for session ${session.sessionId}`,
      );
      return {
        pending: restoration.then((settled) =>
          settled.outcome === "failed"
            ? this.retryKeepScreenAwakeRestore(target, settled.error, forced)
            : undefined,
        ),
      };
    }
    return { pending: null };
  }

  keepScreenAwakeRestoreTarget(session: Session): KeepScreenAwakeRestoreTarget | null {
    const state = session.cacheData.keepScreenAwake;
    if (session.platform !== "android" || !state?.applied) {
      return null;
    }
    return {
      sessionId: session.sessionId,
      deviceId: session.assignedDevice,
      incarnation: this.host.healthIncarnation(session.assignedDevice),
      restoreGeneration: this.host.restoreGeneration(session.assignedDevice),
      state,
    };
  }

  /** A new incarnation of the session id starts with no stale restore report. */
  forgetKeepAwakeRestoreReport(sessionId: string): void {
    this.keepAwakeRestoreReports.delete(sessionId);
  }

  getKeepAwakeRestoreReport(sessionId: string): KeepAwakeRestoreReport | undefined {
    return this.keepAwakeRestoreReports.get(sessionId);
  }

  private recordKeepAwakeRestoreReport(sessionId: string, report: KeepAwakeRestoreReport): void {
    this.keepAwakeRestoreReports.delete(sessionId);
    this.keepAwakeRestoreReports.set(sessionId, report);
    if (this.keepAwakeRestoreReports.size > 64) {
      const oldest = this.keepAwakeRestoreReports.keys().next().value;
      if (oldest !== undefined) {
        this.keepAwakeRestoreReports.delete(oldest);
      }
    }
  }

  async restoreKeepScreenAwakeTarget(target: KeepScreenAwakeRestoreTarget): Promise<void> {
    if (!this.host.restoreIncarnationIsCurrent(target)) {
      return;
    }
    const device: BootedDevice = {
      name: target.deviceId,
      platform: "android",
      deviceId: target.deviceId,
    };
    await this.host.dispatchDeviceRestore(
      target.deviceId,
      (_signal, _identitySignal, acknowledge) =>
        this.keepScreenAwakeRestorer(device)
          .restore(target.state)
          .then((outcome) => {
            acknowledge();
            if (outcome.status === "failed") {
              const error = new KeepAwakeRestoreError(
                outcome.failures.map(({ setting, error }) => `${setting}: ${error}`).join("; ") +
                  (outcome.baselineSettings?.length
                    ? `; baseline applied: ${outcome.baselineSettings.map(({ setting, value }) => `${setting}=${value}`).join(", ")}`
                    : ""),
                {
                  status: "failed",
                  settings: [...outcome.failures, ...(outcome.baselineSettings ?? [])],
                },
              );
              this.recordKeepAwakeRestoreReport(target.sessionId, error.report);
              throw error;
            }
            this.keepAwakeRestoreReports.delete(target.sessionId);
            if (outcome.status === "restored_to_baseline") {
              this.recordKeepAwakeRestoreReport(target.sessionId, {
                status: outcome.status,
                settings: [...outcome.settings],
              });
              logger.warn(
                `Keep-awake baseline applied for session ${target.sessionId}, device ${target.deviceId}: ${outcome.settings.map(({ setting, value }) => `${setting}=${value}`).join(", ")}`,
              );
            }
          }),
      target.restoreGeneration,
      1,
    );
    this.host.clearRestoreHealth(target, "keep-screen-awake");
  }

  /** Bounded retries after a failed keep-awake restore, then background health recovery. */
  private async retryKeepScreenAwakeRestore(
    target: KeepScreenAwakeRestoreTarget,
    initialError: unknown,
    forced: () => boolean,
  ): Promise<void> {
    let lastError = initialError;
    for (let attempt = 1; attempt <= KEEP_SCREEN_AWAKE_RESTORE_RETRY_ATTEMPTS; attempt++) {
      if (
        !(await this.host.waitForIdentityReplacement(
          target.deviceId,
          target.restoreGeneration ?? 0,
        ))
      ) {
        return;
      }
      if (forced()) {
        // The device may belong to the next owner: never retry against it (#11058).
        logger.warn(
          `Not retrying the keep-awake restore for session ${target.sessionId} after a forced release: ${lastError}`,
        );
        return;
      }
      await this.host.timer.sleep(KEEP_SCREEN_AWAKE_RESTORE_RETRY_DELAY_MS);
      if (
        !(await this.host.waitForIdentityReplacement(
          target.deviceId,
          target.restoreGeneration ?? 0,
        ))
      ) {
        return;
      }
      if (forced() || !this.host.restoreIncarnationIsCurrent(target)) {
        return;
      }
      try {
        await this.restoreKeepScreenAwakeTarget(target);
        return;
      } catch (error) {
        // Bounded: keep retrying, then hand the last failure to health recovery.
        lastError = error;
        logger.debug(
          `Retry ${attempt} restoring keep-awake state for session ${target.sessionId} failed: ${error}`,
        );
      }
    }
    logger.warn(
      `Gave up restoring keep-awake state for session ${target.sessionId} after ` +
        `${KEEP_SCREEN_AWAKE_RESTORE_RETRY_ATTEMPTS} retries; device ${target.deviceId} ` +
        `may stay awake: ${lastError}`,
    );
    this.host.abandonRestore(target, "keep-screen-awake", () =>
      this.restoreKeepScreenAwakeTarget(target),
    );
  }
}
