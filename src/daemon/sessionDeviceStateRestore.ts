import type {
  IosAppNetworkRule,
  IosAppNetworkRuleCommandContext,
} from "../features/networkFilter/IosAppNetworkRuleClient";
import type { BootedDevice } from "../models";
import type { BackoffPolicy } from "../utils/Backoff";
import type { KeepAwakeRestoreReport } from "../utils/KeepScreenAwakeManager";
import { logger } from "../utils/logger";
import { raceWithDeadline } from "../utils/raceWithDeadline";
import {
  DeviceStateRestoreQueue,
  type AbandonedRestoreSpec,
  type BoundedRetrySpec,
  type PendingRestore,
  type RestoreAttemptOutcome,
  type RestoreKindSpec,
} from "./deviceStateRestoreQueue";
import type { IosAppNetworkRuleRestorer } from "./iosAppNetworkLease";
import { KeepAwakeRestoreError } from "./KeepAwakeRestoreError";
import { type PendingRestorationSteps, QueuedDeviceStateRestore } from "./queuedDeviceStateRestore";
import {
  type BiometricRestoreTarget,
  type KeepScreenAwakeRestoreTarget,
  type NetworkConditionRestoreTarget,
  type SessionDeviceStateRestoreHost,
  type SessionDeviceStateRestoreOptions,
} from "./sessionDeviceStateRestoreContracts";
import {
  BIOMETRIC_ENROLLMENT_RESTORE_TIMEOUT_MS,
  KEEP_SCREEN_AWAKE_RESTORE_TIMEOUT_MS,
  NETWORK_CONDITION_RESTORE_RETRY_DELAY_MS,
  NETWORK_CONDITION_RESTORE_TIMEOUT_MS,
  SESSION_RELEASE_TEARDOWN_CAP_MS,
  type BiometricEnrollmentRestorer,
  type KeepScreenAwakeRestorer,
  type NetworkConditionRestorer,
  type ReleaseTeardownStage,
  type RotationSessionState,
  type ScreenReaderSessionState,
  type Session,
  type SessionReleaseOperation,
  type SessionReleaseOptions,
} from "./sessionManager";
import { SessionNetworkConditionLifecycle } from "./sessionNetworkConditionLifecycle";
import { SessionReleaseTeardown } from "./sessionReleaseTeardown";
export {
  type BiometricRestoreTarget,
  type IosAppNetworkRuleSessionState,
  type KeepScreenAwakeRestoreTarget,
  type NetworkConditionRestoreTarget,
  type SessionDeviceStateRestoreHost,
  type SessionDeviceStateRestoreOptions,
} from "./sessionDeviceStateRestoreContracts";

/**
 * A failed keep-awake restore leaves a physical device that never sleeps, so — like the network
 * restorer — it is retried inside the pending cleanup, then handed to health recovery (#11145).
 */
const KEEP_SCREEN_AWAKE_RESTORE_RETRY_ATTEMPTS = 2;

const KEEP_SCREEN_AWAKE_RESTORE_RETRY_DELAY_MS = 250;

/**
 * A failed restore leaves the simulator holding session-modified enrollment, so
 * the device must not return to the idle pool on the strength of one attempt.
 * Retries run inside the pending-cleanup promise, which keeps the device
 * quarantined until they settle.
 */
const BIOMETRIC_ENROLLMENT_RESTORE_RETRY_ATTEMPTS = 2;

const BIOMETRIC_ENROLLMENT_RESTORE_RETRY_DELAY_MS = 250;

/**
 * A failed network restore leaves the emulator holding session-modified shaping,
 * so — like the biometric restorer — the device must not return to the idle pool
 * on one attempt. Retries run inside the pending-cleanup promise, keeping the
 * device quarantined until they settle (issue #6012 review, was deferred #6085).
 */
const NETWORK_CONDITION_RESTORE_RETRY_ATTEMPTS = 2;

/** Coordinates per-family restoration and bounded session release teardown. */
export class SessionDeviceStateRestore {
  private readonly queued: QueuedDeviceStateRestore;

  private readonly teardown: SessionReleaseTeardown;

  private readonly network: SessionNetworkConditionLifecycle;

  // Preserve the existing injected-restorer inspection seams while the queue owns execution.
  private readonly screenReaderRestorer: SessionDeviceStateRestoreOptions["screenReader"];
  private readonly screenReaderRestoreBackoff: BackoffPolicy;
  private readonly rotationRestoreBackoff: BackoffPolicy;

  readonly screenReaderRestores: QueuedDeviceStateRestore["screenReaderRestores"];

  readonly abandonedScreenReaders: QueuedDeviceStateRestore["abandonedScreenReaders"];

  readonly clockRestores: QueuedDeviceStateRestore["clockRestores"];

  readonly abandonedRotations: QueuedDeviceStateRestore["abandonedRotations"];

  readonly rotationRestores: QueuedDeviceStateRestore["rotationRestores"];

  private readonly networkConditionRestorer: (device: BootedDevice) => NetworkConditionRestorer;

  private readonly biometricEnrollmentRestorer: (
    device: BootedDevice,
  ) => BiometricEnrollmentRestorer;

  private readonly keepAwakeRestoreReports = new Map<string, KeepAwakeRestoreReport>();

  private readonly keepScreenAwakeRestorer: (device: BootedDevice) => KeepScreenAwakeRestorer;

  constructor(
    private readonly host: SessionDeviceStateRestoreHost,
    options: SessionDeviceStateRestoreOptions,
  ) {
    this.queued = new QueuedDeviceStateRestore(host, options);
    this.screenReaderRestorer = options.screenReader;
    this.screenReaderRestoreBackoff = options.screenReaderBackoff;
    this.rotationRestoreBackoff = options.rotationBackoff;
    this.keepScreenAwakeRestorer = options.keepScreenAwake;
    this.biometricEnrollmentRestorer = options.biometricEnrollment;
    this.networkConditionRestorer = options.networkCondition;
    this.teardown = new SessionReleaseTeardown(host, this);
    this.network = new SessionNetworkConditionLifecycle(host, options, {
      onExpiry: (session, clearIfOwned) =>
        this.restoreNetworkConditionOnExpiryFor(session, clearIfOwned),
    });
    this.screenReaderRestores = this.queued.screenReaderRestores;
    this.abandonedScreenReaders = this.queued.abandonedScreenReaders;
    this.clockRestores = this.queued.clockRestores;
    this.abandonedRotations = this.queued.abandonedRotations;
    this.rotationRestores = this.queued.rotationRestores;
  }

  runClockMutationExclusive<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    return this.queued.runClockMutationExclusive(sessionId, fn);
  }

  runRotationMutationExclusive<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    return this.queued.runRotationMutationExclusive(sessionId, fn);
  }

  runScreenReaderMutationExclusive<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    return this.queued.runScreenReaderMutationExclusive(sessionId, fn);
  }

  forgetFencedRestore<State, Target extends { state: State }>(
    pending: Map<string, Map<State, Target>>,
    deviceId: string,
    target: Target,
  ): void {
    return this.queued.forgetFencedRestore(pending, deviceId, target);
  }

  getPendingRestoration<K extends "clock" | "rotation" | "screenReader">(
    queue: DeviceStateRestoreQueue<NonNullable<Session["cacheData"][K]> & object>,
    slot: K,
    session: Session,
    pendingSetups: Promise<void> | null,
    steps: PendingRestorationSteps<K>,
  ): { pending: Promise<void> | null } | Promise<{ pending: Promise<void> | null }> {
    return this.queued.getPendingRestoration(queue, slot, session, pendingSetups, steps);
  }

  startRestoration<S extends object>(
    spec: RestoreKindSpec<S>,
    deviceId: string,
    target: PendingRestore<S>,
  ): Promise<{ pending: Promise<void> | null }> {
    return this.queued.startRestoration(spec, deviceId, target);
  }

  retryRestoreBounded<S extends object>(
    spec: BoundedRetrySpec<S>,
    deviceId: string,
    target: PendingRestore<S>,
    restoration: Promise<RestoreAttemptOutcome>,
    restore: () => Promise<void>,
  ): Promise<void> {
    return this.queued.retryRestoreBounded(spec, deviceId, target, restoration, restore);
  }

  forgetAbandonedRestore<S>(memory: Map<string, S>, deviceId: string, state: S): void {
    return this.queued.forgetAbandonedRestore(memory, deviceId, state);
  }

  retryAbandonedAfter(own: Promise<void> | null, retry: () => Promise<void>): Promise<void> {
    return this.queued.retryAbandonedAfter(own, retry);
  }

  retryAbandonedRestore<S extends object>(
    spec: AbandonedRestoreSpec<S>,
    deviceId: string,
  ): Promise<void> {
    return this.queued.retryAbandonedRestore(spec, deviceId);
  }

  trackRestoreSetup<K extends "clock" | "rotation" | "screenReader">(
    queue: DeviceStateRestoreQueue<NonNullable<Session["cacheData"][K]> & object>,
    slot: K,
    session: Session,
    createSetup: (assertCurrentDevice: () => void) => Promise<void>,
    startRestore: () => Promise<{ pending: Promise<void> | null }>,
  ): Promise<void> {
    return this.queued.trackRestoreSetup(queue, slot, session, createSetup, startRestore);
  }

  getPendingScreenReaderRestoration(
    session: Session,
    pendingSetups: Promise<void> | null,
  ): Promise<{ pending: Promise<void> | null }> {
    return this.queued.getPendingScreenReaderRestoration(session, pendingSetups);
  }

  retryAbandonedScreenReaderAfter(deviceId: string, own: Promise<void> | null): Promise<void> {
    return this.queued.retryAbandonedScreenReaderAfter(deviceId, own);
  }

  retryAbandonedScreenReaderRestore(deviceId: string): Promise<void> {
    return this.queued.retryAbandonedScreenReaderRestore(deviceId);
  }

  private abandonScreenReaderRestore(
    deviceId: string,
    target: PendingRestore<ScreenReaderSessionState>,
  ): void {
    this.queued.abandonScreenReaderRestore(deviceId, target);
  }

  trackScreenReaderSessionSetup(
    session: Session,
    createSetup: (assertCurrentDevice: () => void) => Promise<void>,
  ): Promise<void> {
    return this.queued.trackScreenReaderSessionSetup(session, createSetup);
  }

  getPendingRotationRestoration(
    session: Session,
    pendingSetups: Promise<void> | null,
  ): Promise<{ pending: Promise<void> | null }> {
    return this.queued.getPendingRotationRestoration(session, pendingSetups);
  }

  retryAbandonedRotationAfter(deviceId: string, own: Promise<void> | null): Promise<void> {
    return this.queued.retryAbandonedRotationAfter(deviceId, own);
  }

  retryAbandonedRotationRestore(deviceId: string): Promise<void> {
    return this.queued.retryAbandonedRotationRestore(deviceId);
  }

  private abandonRotationRestore(
    deviceId: string,
    target: PendingRestore<RotationSessionState>,
    lastError: unknown,
    when: string,
  ): void {
    this.queued.abandonRotationRestore(deviceId, target, lastError, when);
  }

  trackRotationSessionSetup(
    session: Session,
    createSetup: (assertCurrentDevice: () => void) => Promise<void>,
  ): Promise<void> {
    return this.queued.trackRotationSessionSetup(session, createSetup);
  }

  getPendingClockRestoration(
    session: Session,
    pendingSetups: Promise<void> | null,
  ): Promise<{ pending: Promise<void> | null }> {
    return this.queued.getPendingClockRestoration(session, pendingSetups);
  }

  trackClockSessionSetup(session: Session, createSetup: () => Promise<void>): Promise<void> {
    return this.queued.trackClockSessionSetup(session, createSetup);
  }

  drainReleaseTeardown(
    sessionId: string,
    session: Session,
    operation?: SessionReleaseOperation,
    options: SessionReleaseOptions = {},
  ): Promise<readonly Promise<void>[]> {
    return this.teardown.drainReleaseTeardown(sessionId, session, operation, options);
  }

  runUnderTeardownShield(
    start: () => Promise<readonly ReleaseTeardownStage[]>,
    /** Aborts the shield early: the release was forced and no longer holds the device (#11058). */
    forcedSignal?: AbortSignal,
  ): Promise<readonly Promise<void>[]> {
    return this.teardown.runUnderTeardownShield(start, forcedSignal);
  }

  abandonCappedRestore(
    target:
      | KeepScreenAwakeRestoreTarget
      | BiometricRestoreTarget
      | NetworkConditionRestoreTarget
      | null,
    reason: "keep-screen-awake" | "biometric-enrollment" | "network-condition",
  ): void {
    return this.teardown.abandonCappedRestore(target, reason);
  }

  get iosAppNetworkRuleRestorer(): IosAppNetworkRuleRestorer {
    return this.network.iosAppNetworkRuleRestorer;
  }

  beginIosAppNetworkRule(
    session: Session,
    target: { udid: string; bundleId: string },
  ): IosAppNetworkRuleCommandContext {
    return this.network.beginIosAppNetworkRule(session, target);
  }

  prepareIosAppNetworkReset(
    session: Session,
    target: { udid: string; bundleId: string },
  ): IosAppNetworkRuleCommandContext {
    return this.network.prepareIosAppNetworkReset(session, target);
  }

  confirmIosAppNetworkRule(session: Session, rule: IosAppNetworkRule): void {
    return this.network.confirmIosAppNetworkRule(session, rule);
  }

  finishIosAppNetworkReset(session: Session, rule: IosAppNetworkRule): void {
    return this.network.finishIosAppNetworkReset(session, rule);
  }

  activeIosAppNetworkLease(sessionId: string): IosAppNetworkRule | undefined {
    return this.network.activeIosAppNetworkLease(sessionId);
  }

  stopIosAppNetworkLease(sessionId: string): void {
    return this.network.stopIosAppNetworkLease(sessionId);
  }

  startIosAppNetworkLease(
    sessionId: string,
    rule: IosAppNetworkRule,
    isCurrent: () => boolean,
  ): void {
    return this.network.startIosAppNetworkLease(sessionId, rule, isCurrent);
  }

  scheduleNetworkConditionExpiry(
    session: Session,
    expiresInSeconds: number,
    generation?: number,
  ): void {
    return this.network.scheduleNetworkConditionExpiry(session, expiresInSeconds, generation);
  }

  peekNetworkConditionExpiry(
    sessionId: string,
  ): { deadlineMs: number; generation: number } | undefined {
    return this.network.peekNetworkConditionExpiry(sessionId);
  }

  rearmNetworkConditionExpiry(
    session: Session,
    snapshot: { deadlineMs: number; generation: number },
  ): void {
    return this.network.rearmNetworkConditionExpiry(session, snapshot);
  }

  cancelNetworkConditionExpiry(sessionId: string): void {
    return this.network.cancelNetworkConditionExpiry(sessionId);
  }

  bumpNetworkConditionGeneration(sessionId: string): number {
    return this.network.bumpNetworkConditionGeneration(sessionId);
  }

  runNetworkConditionMutationExclusive<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    return this.network.runNetworkConditionMutationExclusive(sessionId, fn);
  }

  forgetSession(sessionId: string): void {
    return this.network.forgetSession(sessionId);
  }

  stopAll(): void {
    return this.network.stopAll();
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

  /**
   * Snapshot of what a restore must write, taken before any await. A rebind
   * reassigns `session.assignedDevice` while retries are still outstanding, so
   * resolving the device lazily from the session would aim them at the new
   * simulator and leave the old one dirty.
   */
  biometricRestoreTarget(session: Session): BiometricRestoreTarget | null {
    const state = session.cacheData.biometricEnrollment;
    // Keyed on the cache alone, not session.platform. The slot is only ever
    // written by the iOS Simulator biometric path, so its presence is the
    // authoritative evidence that a simulator needs restoring — whereas
    // session.platform carries whatever the caller declared to setActiveDevice
    // and can disagree with the device actually bound.
    if (!state) {
      return null;
    }
    return {
      sessionId: session.sessionId,
      deviceId: session.assignedDevice,
      incarnation: this.host.healthIncarnation(session.assignedDevice),
      restoreGeneration: this.host.restoreGeneration(session.assignedDevice),
      enrollment: state.initialEnrollment,
    };
  }

  async restoreBiometricEnrollment(target: BiometricRestoreTarget): Promise<void> {
    const device: BootedDevice = {
      name: target.deviceId,
      platform: "ios",
      deviceId: target.deviceId,
    };
    if (!this.host.restoreIncarnationIsCurrent(target)) {
      return;
    }
    await this.host.dispatchDeviceRestore(
      target.deviceId,
      (_signal, _identitySignal, acknowledge) =>
        this.biometricEnrollmentRestorer(device).restore(target.enrollment).then(acknowledge),
      target.restoreGeneration,
      2,
    );
    this.host.clearRestoreHealth(target, "biometric-enrollment");
  }

  async restoreBiometricEnrollmentBestEffort(
    session: Session,
  ): Promise<{ pending: Promise<void> | null }> {
    const target = this.biometricRestoreTarget(session);
    if (!target) {
      return { pending: null };
    }
    const restoration = this.restoreBiometricEnrollment(target).then(
      () => ({ outcome: "restored" as const }),
      (error) => ({ outcome: "failed" as const, error }),
    );
    const timeout = new Error("Biometric restore timed out");
    const result = await raceWithDeadline(restoration, {
      timer: this.host.timer,
      timeoutMs: BIOMETRIC_ENROLLMENT_RESTORE_TIMEOUT_MS,
      label: "Biometric restore",
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
        `Failed to restore biometric enrollment for session ${session.sessionId}: ${result.error}`,
      );
      // Quarantine the device until the retries below settle; a prompt
      // rejection otherwise returns a dirty simulator straight to the pool.
      return { pending: this.retryBiometricEnrollmentRestore(target, result.error) };
    }
    if (result.outcome === "timed-out") {
      logger.warn(
        `Timed out after ${BIOMETRIC_ENROLLMENT_RESTORE_TIMEOUT_MS}ms restoring biometric enrollment for session ${session.sessionId}`,
      );
      return { pending: this.settleBiometricEnrollmentRestore(target, restoration) };
    }
    return { pending: null };
  }

  /** A slow restore can still fail; retry before the device leaves quarantine. */
  private async settleBiometricEnrollmentRestore(
    target: BiometricRestoreTarget,
    restoration: Promise<{ outcome: "restored" } | { outcome: "failed"; error: unknown }>,
  ): Promise<void> {
    const result = await restoration;
    if (result.outcome === "restored") {
      return;
    }
    logger.warn(
      `Failed to restore biometric enrollment for session ${target.sessionId}: ${result.error}`,
    );
    await this.retryBiometricEnrollmentRestore(target, result.error);
  }

  private async retryBiometricEnrollmentRestore(
    target: BiometricRestoreTarget,
    initialError: unknown,
  ): Promise<void> {
    let lastError = initialError;
    for (let attempt = 1; attempt <= BIOMETRIC_ENROLLMENT_RESTORE_RETRY_ATTEMPTS; attempt++) {
      await this.host.timer.sleep(BIOMETRIC_ENROLLMENT_RESTORE_RETRY_DELAY_MS);
      if (!this.host.restoreIncarnationIsCurrent(target)) {
        return;
      }
      try {
        await this.restoreBiometricEnrollment(target);
        logger.info(
          `Restored biometric enrollment for session ${target.sessionId} on retry ${attempt}`,
        );
        return;
      } catch (error) {
        // Teardown is best-effort: keep retrying, then report the last failure.
        lastError = error;
        logger.debug(
          `Retry ${attempt} restoring biometric enrollment for session ${target.sessionId} failed: ${error}`,
        );
      }
    }
    logger.warn(
      `Gave up restoring biometric enrollment for session ${target.sessionId} after ` +
        `${BIOMETRIC_ENROLLMENT_RESTORE_RETRY_ATTEMPTS} retries; device ${target.deviceId} ` +
        `may hold session-modified enrollment: ${lastError}`,
    );
    this.host.abandonRestore(target, "biometric-enrollment", () =>
      this.restoreBiometricEnrollment(target),
    );
  }

  /**
   * A timed-out setup can still write simulator state. Defer its restoration
   * until that write settles so an old command cannot overwrite the restore.
   */
  private restoreBiometricEnrollmentAfterSetups(
    session: Session,
    pendingSetups: Promise<void>,
  ): Promise<void> {
    return pendingSetups.then(async () => {
      const pendingRestoration = (await this.restoreBiometricEnrollmentBestEffort(session)).pending;
      await pendingRestoration;
    });
  }

  /**
   * Returned wrapped, never bare: `return somePromise` inside an async function
   * adopts that promise, which would make the caller await the very cleanup it
   * is trying to hand off and stall the release.
   */
  async getPendingBiometricRestoration(
    session: Session,
    pendingSetups: Promise<void> | null,
  ): Promise<{ pending: Promise<void> | null }> {
    if (pendingSetups && session.cacheData.biometricEnrollment) {
      return { pending: this.restoreBiometricEnrollmentAfterSetups(session, pendingSetups) };
    }
    return { pending: (await this.restoreBiometricEnrollmentBestEffort(session)).pending };
  }

  /**
   * A timed-out tracked network mutation can still issue `network delay/speed`
   * commands. Defer the restore until that setup settles, so a `none` restore
   * cannot land mid-mutation and then be re-shaped by a late command (issue #6012
   * review P1). Mirrors `restoreBiometricEnrollmentAfterSetups`.
   */
  private restoreNetworkConditionAfterSetups(
    session: Session,
    pendingSetups: Promise<void>,
  ): Promise<void> {
    return pendingSetups.then(async () => {
      const pendingRestoration = (await this.restoreNetworkConditionBestEffort(session)).pending;
      await pendingRestoration;
    });
  }

  /**
   * Returned wrapped, never bare (see `getPendingBiometricRestoration`): sequence
   * the network restore after any still-draining setup so it never restores
   * `none` while a tracked mutation may still shape the device.
   */
  async getPendingNetworkRestoration(
    session: Session,
    pendingSetups: Promise<void> | null,
  ): Promise<{ pending: Promise<void> | null }> {
    if (pendingSetups && session.cacheData.networkCondition) {
      return { pending: this.restoreNetworkConditionAfterSetups(session, pendingSetups) };
    }
    return { pending: (await this.restoreNetworkConditionBestEffort(session)).pending };
  }

  /**
   * Snapshot of the network restore, taken before any await. Like the biometric
   * target, a rebind reassigns `session.assignedDevice` while a restore is in
   * flight, so the device is captured up front rather than read lazily.
   */
  networkConditionRestoreTarget(session: Session): NetworkConditionRestoreTarget | null {
    const state = session.cacheData.networkCondition;
    // Keyed on the cache alone: the slot is only written by the Android emulator
    // network path or the iOS Simulator per-app path (`iosAppRule`), so its
    // presence is the authoritative evidence a device needs restoring —
    // independent of whatever platform the caller declared.
    if (!state) {
      return null;
    }
    const ios = state.iosAppRule;
    return {
      sessionId: session.sessionId,
      deviceId: session.assignedDevice,
      incarnation: this.host.healthIncarnation(session.assignedDevice),
      restoreGeneration: this.host.restoreGeneration(session.assignedDevice),
      profile: state.initialProfile,
      // Each capture allocates a fresh reset revision, newer than every apply
      // this session sent, so a late apply cannot outlive the restore.
      ...(ios
        ? {
            iosAppRule: {
              udid: ios.udid,
              bundleId: ios.bundleId,
              owner: session.sessionId,
              ownerGeneration: ios.ownerGeneration,
              revision: ++ios.lastRevision,
            },
          }
        : {}),
    };
  }

  async restoreNetworkCondition(target: NetworkConditionRestoreTarget): Promise<void> {
    if (target.iosAppRule) {
      if (!this.host.restoreIncarnationIsCurrent(target)) {
        return;
      }
      await this.iosAppNetworkRuleRestorer.reset(target.iosAppRule);
      this.host.clearRestoreHealth(target, "network-condition");
      return;
    }
    const device: BootedDevice = {
      name: target.deviceId,
      platform: "android",
      deviceId: target.deviceId,
    };
    if (!this.host.restoreIncarnationIsCurrent(target)) {
      return;
    }
    await this.host.dispatchDeviceRestore(
      target.deviceId,
      (_signal, _identitySignal, acknowledge) =>
        this.networkConditionRestorer(device).restore(target.profile).then(acknowledge),
      target.restoreGeneration,
      3,
    );
    this.host.clearRestoreHealth(target, "network-condition");
  }

  /**
   * Best-effort network-condition restore, bounded by a timeout so a wedged
   * emulator console cannot stall release. A timeout hands the still-running
   * restore back as pending cleanup, keeping the device quarantined until it
   * settles (issue #6012).
   */
  async restoreNetworkConditionBestEffort(
    session: Session,
  ): Promise<{ pending: Promise<void> | null }> {
    const target = this.networkConditionRestoreTarget(session);
    if (!target) {
      return { pending: null };
    }
    const restoration = this.restoreNetworkCondition(target).then(
      () => ({ outcome: "restored" as const }),
      (error) => ({ outcome: "failed" as const, error }),
    );
    const timeout = new Error("Network condition restore timed out");
    const result = await raceWithDeadline(restoration, {
      timer: this.host.timer,
      timeoutMs: NETWORK_CONDITION_RESTORE_TIMEOUT_MS,
      label: "Network condition restore",
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
        `Failed to restore network condition for session ${session.sessionId}; device ` +
          `${target.deviceId} may hold session-modified shaping: ${result.error}`,
      );
      // Quarantine the device until the retries below settle; a prompt
      // rejection otherwise returns a shaped emulator straight to the pool.
      return { pending: this.retryNetworkConditionRestore(target, result.error) };
    }
    if (result.outcome === "timed-out") {
      logger.warn(
        `Timed out after ${NETWORK_CONDITION_RESTORE_TIMEOUT_MS}ms restoring network condition ` +
          `for session ${session.sessionId}`,
      );
      return { pending: this.settleNetworkConditionRestore(target, restoration) };
    }
    return { pending: null };
  }

  /** A slow restore can still fail; retry before the device leaves quarantine. */
  private async settleNetworkConditionRestore(
    target: NetworkConditionRestoreTarget,
    restoration: Promise<{ outcome: "restored" } | { outcome: "failed"; error: unknown }>,
  ): Promise<void> {
    const result = await restoration;
    if (result.outcome === "restored") {
      return;
    }
    logger.warn(
      `Failed to restore network condition for session ${target.sessionId}: ${result.error}`,
    );
    await this.retryNetworkConditionRestore(target, result.error);
  }

  private async retryNetworkConditionRestore(
    target: NetworkConditionRestoreTarget,
    initialError: unknown,
  ): Promise<void> {
    await this.retryNetworkConditionRestoreUntilSuccess(target, initialError);
  }

  /**
   * Bounded restore retries after an initial failure. Returns `true` if any retry
   * succeeded, `false` once the attempts are exhausted. The boolean lets the TTL
   * path decide whether it may release restoration ownership (clear the slot),
   * while the release path (which discards the session anyway) ignores it.
   */
  private async retryNetworkConditionRestoreUntilSuccess(
    target: NetworkConditionRestoreTarget,
    initialError: unknown,
  ): Promise<boolean> {
    let lastError = initialError;
    for (let attempt = 1; attempt <= NETWORK_CONDITION_RESTORE_RETRY_ATTEMPTS; attempt++) {
      await this.host.timer.sleep(NETWORK_CONDITION_RESTORE_RETRY_DELAY_MS);
      if (!this.host.restoreIncarnationIsCurrent(target)) {
        return false;
      }
      try {
        await this.restoreNetworkCondition(target);
        logger.info(
          `Restored network condition for session ${target.sessionId} on retry ${attempt}`,
        );
        return true;
      } catch (error) {
        // Teardown is best-effort: keep retrying, then report the last failure.
        lastError = error;
        logger.debug(
          `Retry ${attempt} restoring network condition for session ${target.sessionId} failed: ${error}`,
        );
      }
    }
    logger.warn(
      `Gave up restoring network condition for session ${target.sessionId} after ` +
        `${NETWORK_CONDITION_RESTORE_RETRY_ATTEMPTS} retries; device ${target.deviceId} ` +
        `may hold session-modified shaping: ${lastError}`,
    );
    this.host.abandonRestore(target, "network-condition", () =>
      this.restoreNetworkCondition(target),
    );
    return false;
  }

  /**
   * Reset the device on TTL expiry, then bounded-retry on failure — the same
   * machinery `restoreNetworkConditionBestEffort` uses on release. The restore slot
   * is cleared only after a definitive success, so ownership (and quarantine) is
   * retained until the device is actually clean.
   */
  /**
   * TTL elapsed for a still-published `session`: reset the device to `none` via the
   * SAME bounded restore/retry the session-release path uses, and RETAIN restoration
   * ownership — keep the restore slot and the device quarantined — until the reset
   * actually SUCCEEDS (issue #6085 review). A transient emulator-console rejection
   * therefore does not end quarantine and hand a still-shaped device back to the
   * pool: it retries, and if every attempt is exhausted the slot is left in place so
   * a later release still retries. Only on success does `clearIfOwned` clear the
   * slot, so a subsequent release cannot double-restore.
   */
  restoreNetworkConditionOnExpiryFor(session: Session, clearIfOwned: () => void): void {
    const sessionId = session.sessionId;
    const target = this.networkConditionRestoreTarget(session);
    if (!target) {
      // Slot already cleared by a prior restore: nothing to do, no double-restore.
      return;
    }
    logger.info(
      `Network condition TTL elapsed for session ${sessionId}; resetting device ${target.deviceId} to none`,
    );
    this.host.registerPendingDeviceCleanup(
      target.deviceId,
      this.runUnderTeardownShield(async () => [
        {
          pending: this.restoreNetworkConditionOnExpiry(session, target, clearIfOwned),
          abandon: () => this.abandonCappedRestore(target, "network-condition"),
        },
      ]).then(async (cleanups) => {
        await Promise.all(cleanups);
      }),
      SESSION_RELEASE_TEARDOWN_CAP_MS,
    );
  }

  async restoreNetworkConditionOnExpiry(
    session: Session,
    target: NetworkConditionRestoreTarget,
    clearIfOwned: () => void,
  ): Promise<void> {
    try {
      await this.restoreNetworkCondition(target);
      clearIfOwned();
      return;
    } catch (error) {
      logger.warn(
        `Failed to reset network condition on TTL expiry for session ${session.sessionId}; ` +
          `device ${target.deviceId} may hold session-modified shaping, retrying: ${error}`,
      );
      const succeeded = await this.retryNetworkConditionRestoreUntilSuccess(target, error);
      if (succeeded) {
        clearIfOwned();
      }
      // On exhaustion the slot is intentionally retained so a later release retries.
    }
  }
}
