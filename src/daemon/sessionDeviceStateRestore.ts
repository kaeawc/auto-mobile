import { ActionableError, toActionableError } from "../models/ActionableError";
import type { BootedDevice } from "../models";
import { SCREEN_READER_RESTORE_TIMEOUT_MS } from "../features/accessibility/ScreenReaderRestore";
import type { BackoffPolicy } from "../utils/Backoff";
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
import type { ScreenReaderRestorer, ScreenReaderSessionState, Session } from "./sessionManager";

/**
 * Each screen-reader restore attempt is a full TalkBack/VoiceOver toggle (it can
 * fall back to a `uiautomator dump`), so unlike the settings writes above it is
 * retried a small bounded number of times, with `Backoff` delays, never forever.
 */
const SCREEN_READER_RESTORE_RETRY_ATTEMPTS = 2;

const screenReaderRestorePolicy: RestoreQueuePolicy = {
  kind: "screen-reader",
  retiredOnIncarnationBump: false,
  setupHandoff: "track-eagerly",
  removedDuringSetupMessage:
    "Cannot change the screen reader: device was removed during session setup.",
};

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
  /** Quarantine the device until the cleanups settle. */
  trackPendingDeviceCleanup(deviceId: string, cleanups: readonly Promise<unknown>[]): void;
}

export interface SessionDeviceStateRestoreOptions {
  screenReader: (device: BootedDevice) => ScreenReaderRestorer;
  screenReaderBackoff: BackoffPolicy;
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
 * (start, bounded retry, abandoned retry, setup tracking) lives here with the screen-reader family;
 * the other families still live in SessionManager and call into it. Code is moved verbatim: the
 * ordering invariants live in the comments next to it (#11795).
 */
export class SessionDeviceStateRestore {
  readonly screenReaderRestores = new DeviceStateRestoreQueue<ScreenReaderSessionState>(
    screenReaderRestorePolicy,
  );
  /** Screen-reader state a device still holds after the bounded retries gave up (#10159). */
  readonly abandonedScreenReaders = new Map<string, ScreenReaderSessionState>();
  private readonly abandonedScreenReaderRetries = new Map<string, Promise<void>>();
  private readonly screenReaderMutationQueues = new Map<string, Promise<unknown>>();
  private readonly screenReaderRestorer: (device: BootedDevice) => ScreenReaderRestorer;
  private readonly screenReaderRestoreBackoff: BackoffPolicy;

  constructor(
    private readonly host: SessionDeviceStateRestoreHost,
    options: SessionDeviceStateRestoreOptions,
  ) {
    this.screenReaderRestorer = options.screenReader;
    this.screenReaderRestoreBackoff = options.screenReaderBackoff;
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

  /** Removal retires in-memory ownership; no retries may target a replacement device. */
  retireScreenReaderRestoration(deviceId: string): void {
    this.screenReaderRestores.retire(deviceId);
    this.abandonedScreenReaders.delete(deviceId);
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
}
