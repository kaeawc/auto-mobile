import type { CleanupReceiptOwner, CleanupReceiptRecorder } from "../sessionCleanupReceipts";
import { runWithAbortSignal } from "../../utils/AbortContext";
import { exponentialBackoff, type BackoffPolicy } from "../../utils/Backoff";
import { logger } from "../../utils/logger";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import { type Timer } from "../../utils/SystemTimer";
import type { DeviceHealthMarkers, DeviceHealthReason } from "../deviceHealthMarkers";
import {
  RECORDER_TEARDOWN_RECHECK_MS,
  RecorderTeardownRetries,
  recoverRecorderTeardowns,
} from "../recorderTeardownRecovery";
import { SessionDeviceStateRestore } from "../sessionDeviceStateRestore";
import {
  NETWORK_CONDITION_RESTORE_TIMEOUT_MS,
  releaseWasForced,
  type ReleaseCommitFence,
  type SessionReleaseOperation,
} from "../sessionManager";
import { releaseSuperseded } from "./internalContracts";

export interface DeviceRestoreHealthHost {
  readonly cleanupReceipts: Pick<
    CleanupReceiptRecorder,
    "failOwner" | "failDevice" | "trackOwner" | "trackDevice"
  >;
  getSessionForDevice(deviceId: string): string | null;
  readonly stateRestore: Pick<SessionDeviceStateRestore, "clockRestores">;
  readonly timer: Timer;
  readonly acceptingSessionCreations: boolean;
  dispatchDeviceRestore(
    deviceId: string,
    restore: (
      signal: AbortSignal,
      identitySignal: AbortSignal,
      acknowledge: () => void,
    ) => Promise<void>,
    generation?: number,
    teardownStep?: number,
    receiptOwner?: CleanupReceiptOwner,
  ): Promise<void>;
}

export class DeviceRestoreHealth {
  constructor(private readonly host: DeviceRestoreHealthHost) {}

  deviceHealth?: {
    markers: DeviceHealthMarkers;
    incarnation: (deviceId: string) => number | undefined;
    canRecover: (deviceId: string) => boolean;
    backoff: BackoffPolicy;
  };

  readonly identityReplacementFences = new Map<
    string,
    {
      releases: Set<SessionReleaseOperation>;
      settled: Promise<void>;
      resume: () => void;
    }
  >();

  readonly replacedRestoreGenerations = new Map<string, number>();

  readonly activeRestoreControllers = new Map<string, Set<AbortController>>();

  markIdentityReplacedRelease(
    release: SessionReleaseOperation,
    options = release.options,
    shouldCommit?: ReleaseCommitFence,
  ): void {
    if (!options.deviceIdentityReplaced) {
      return;
    }
    // Commands already dispatched cannot be recalled; fence every subsequent dispatch (#12063).
    release.options.deviceIdentityReplaced = true;
    const replacement = (release.identityReplacement ??= {
      deviceId: release.session.assignedDevice,
      final: false,
      commitFences: [],
      resumeStep: release.teardownStep ?? 0,
    });
    if (shouldCommit) {
      replacement.commitFences.push(shouldCommit);
    } else {
      replacement.final = true;
    }
    const { deviceId } = replacement;
    let fence = this.identityReplacementFences.get(deviceId);
    if (!fence) {
      const settled = Promise.withResolvers<void>();
      fence = { releases: new Set(), settled: settled.promise, resume: settled.resolve };
      this.identityReplacementFences.set(deviceId, fence);
    }
    fence.releases.add(release);
    for (const controller of this.activeRestoreControllers.get(deviceId) ?? []) {
      controller.abort(new Error("Device identity replaced during restoration"));
    }
  }

  finishIdentityReplacedRelease(release: SessionReleaseOperation): void {
    const deviceId = release.identityReplacement?.deviceId;
    if (deviceId === undefined) {
      return;
    }
    const fence = this.identityReplacementFences.get(deviceId);
    if (!fence || !fence.releases.delete(release) || fence.releases.size > 0) {
      return;
    }
    this.identityReplacementFences.delete(deviceId);
    fence.resume();
  }

  /** A declined join revokes only its replacement mark, never the ordinary release itself. */
  revokeSupersededIdentityReplacement(operation?: SessionReleaseOperation): boolean {
    const replacement = operation?.identityReplacement;
    if (
      !operation ||
      releaseWasForced(operation) ||
      !replacement ||
      replacement.final ||
      !replacement.commitFences.every(releaseSuperseded)
    ) {
      return false;
    }
    this.finishIdentityReplacedRelease(operation);
    delete operation.options.deviceIdentityReplaced;
    operation.teardownResumeStep = replacement.resumeStep;
    delete operation.identityReplacement;
    return true;
  }

  async waitForIdentityReplacement(deviceId: string, generation: number): Promise<boolean> {
    let fence = this.identityReplacementFences.get(deviceId);
    while (fence) {
      await fence.settled;
      fence = this.identityReplacementFences.get(deviceId);
    }
    return (this.replacedRestoreGenerations.get(deviceId) ?? 0) === generation;
  }

  private readonly recorderTeardownRetries = new Map<
    string,
    {
      deviceId: string;
      incarnation: number;
      reason: "recording-teardown" | "app-cleanup";
      retries: RecorderTeardownRetries;
    }
  >();

  private readonly recorderTeardownRechecks = new Map<string, NodeJS.Timeout>();

  private readonly healthRecoveries = new Map<string, Promise<void>>();

  private readonly healthRecoveryDeadlines = new Map<string, number | undefined>();

  /** Whether a background recovery for this marker is still running, and its remaining bound (#12112). */
  getDeviceHealthRecovery(
    deviceId: string,
    incarnation: number,
    reason: DeviceHealthReason,
  ): { recovering: boolean; retryAfterMs?: number } {
    this.pruneRecorderTeardownRetries();
    if (this.deviceHealth?.incarnation(deviceId) !== incarnation) {
      return { recovering: false };
    }
    // Clock restoration owns a separate pending registry and retries without a bounded batch.
    if (reason === "clock") {
      return {
        recovering: [
          ...(this.host.stateRestore.clockRestores.targets.get(deviceId)?.values() ?? []),
        ].some((target) => !target.removed),
      };
    }
    const key = `${deviceId}#${incarnation}:${reason}`;
    if (!this.healthRecoveries.has(key) && !this.recorderTeardownRechecks.has(key)) {
      return { recovering: false };
    }
    const deadline = this.healthRecoveryDeadlines.get(key);
    return {
      recovering: true,
      ...(deadline !== undefined &&
      (this.recorderTeardownRechecks.has(key) ||
        (!this.identityReplacementFences.has(deviceId) && this.deviceHealth.canRecover(deviceId)))
        ? { retryAfterMs: Math.max(1, Math.ceil(deadline - this.host.timer.now())) }
        : {}),
    };
  }

  /** Optional pool wiring, preserving existing positional constructors. */
  setDeviceHealthMarkers(
    markers: DeviceHealthMarkers,
    incarnation: (deviceId: string) => number | undefined,
    canRecover: (deviceId: string) => boolean,
    backoff: BackoffPolicy = exponentialBackoff({ initialDelayMs: 1000 }),
  ): void {
    this.deviceHealth = { markers, incarnation, canRecover, backoff };
  }

  /**
   * A plan's app cleanup did not complete on this device. Marks it unhealthy so it cannot
   * be allocated dirty, and retries `retry` on the bounded health-recovery budget once the
   * device is idle; keyed retries compose and the marker clears when every owed retry resolves.
   * `retry` must run under its
   * own abort signal: the recovery inherits this call's (possibly aborted) ambient one.
   * `retryTimeoutMs` is the caller's real budget for one retry: a cleanup (`pm clear`,
   * simctl container removal, a physical-iOS reinstall) legitimately takes far longer than
   * the 1 s a settings restore gets, and a deadline shorter than the retry ends all retries
   * with the marker kept even though the retry would have succeeded.
   */
  markDeviceNeedsAppCleanup(
    deviceId: string,
    retry: () => Promise<void>,
    retryTimeoutMs: number,
    retryKey?: string,
    sessionId?: string,
  ): void {
    this.markDeviceNeedsKeyedRecovery(
      deviceId,
      retry,
      retryTimeoutMs,
      retryKey,
      "app-cleanup",
      sessionId ?? this.host.getSessionForDevice(deviceId) ?? undefined,
    );
  }

  /** Recorder teardown was unconfirmed; quarantine synchronously before release settles. */
  markDeviceNeedsRecorderTeardown(
    deviceId: string,
    retry: () => Promise<void>,
    retryTimeoutMs: number,
    retryKey?: string,
    sessionId?: string,
  ): () => void {
    return this.markDeviceNeedsKeyedRecovery(
      deviceId,
      retry,
      retryTimeoutMs,
      retryKey,
      "recording-teardown",
      sessionId ?? this.host.getSessionForDevice(deviceId) ?? undefined,
    );
  }

  private markDeviceNeedsKeyedRecovery(
    deviceId: string,
    retry: () => Promise<void>,
    retryTimeoutMs: number,
    retryKey: string | undefined,
    reason: "recording-teardown" | "app-cleanup",
    sessionId?: string,
  ): () => void {
    // Entry points capture the current owner once, including active sessions before plan release.
    // Truly unowned startup work must never attach to a later owner during recovery.
    const target = { deviceId, sessionId };
    this.host.cleanupReceipts.failOwner(target, `restoration_abandoned:${reason}`);
    if (sessionId === undefined) {
      // Release callbacks can run after unmapping; retain their releasing receipt evidence.
      this.host.cleanupReceipts.failDevice(deviceId, `restoration_abandoned:${reason}`);
    }
    this.pruneRecorderTeardownRetries();
    const health = this.deviceHealth;
    const incarnation = health?.incarnation(deviceId);
    if (!health || incarnation === undefined) {
      logger.warn(
        `${reason === "recording-teardown" ? "Recorder teardown" : "App cleanup"} on ${deviceId} has no pool incarnation; cannot key health marker`,
      );
      return () => {};
    }
    const recoveryTarget = { ...target, incarnation };
    const key = `${deviceId}#${incarnation}:${reason}`;
    const retries =
      this.recorderTeardownRetries.get(key)?.retries ?? new RecorderTeardownRetries(reason);
    this.recorderTeardownRetries.set(key, { ...recoveryTarget, reason, retries });
    const remove = retries.add(retry, retryTimeoutMs, retryKey);
    const recheck = this.recorderTeardownRechecks.get(key);
    if (recheck !== undefined) {
      this.host.timer.clearTimeout(recheck);
      this.recorderTeardownRechecks.delete(key);
    }
    health.markers.mark(deviceId, incarnation, reason);
    this.healthRecoveryDeadlines.set(key, undefined);
    if (!this.healthRecoveries.has(key)) {
      this.startRecorderTeardownRecovery(recoveryTarget, retries, reason);
    } else {
      this.host.cleanupReceipts.trackOwner(target, this.healthRecoveries.get(key)!);
    }
    if (sessionId === undefined) {
      this.host.cleanupReceipts.trackDevice(deviceId, this.healthRecoveries.get(key)!);
    }
    return () => {
      remove();
      if (retries.empty && this.recorderTeardownRetries.get(key)?.retries === retries) {
        this.clearRestoreHealth(recoveryTarget, reason);
        this.pruneRecorderTeardownRetries();
        this.healthRecoveries.delete(key);
        this.healthRecoveryDeadlines.delete(key);
      }
    };
  }

  private startRecorderTeardownRecovery(
    target: { deviceId: string; incarnation: number; sessionId?: string },
    retries: RecorderTeardownRetries,
    reason: "recording-teardown" | "app-cleanup",
  ): void {
    const { deviceId, incarnation } = target;
    const health = this.deviceHealth!;
    const key = `${deviceId}#${incarnation}:${reason}`;
    let completedRevision: number | undefined;
    const generation = this.replacedRestoreGenerations.get(deviceId) ?? 0;
    const recovery = runWithAbortSignal(undefined, () =>
      recoverRecorderTeardowns(retries, {
        reason,
        timer: this.host.timer,
        delays: [1, 2, 3].map((attempt) => health.backoff.delayForAttempt(attempt)),
        isCurrent: async () =>
          (await this.waitForIdentityReplacement(deviceId, generation)) &&
          this.restoreIncarnationIsCurrent(target) &&
          this.recorderTeardownRetries.get(key)?.retries === retries &&
          !!health.markers.get(deviceId, incarnation, reason),
        canRecover: () => health.canRecover(deviceId),
        acceptingSessions: () => this.host.acceptingSessionCreations,
        dispatch: (work) => this.host.dispatchDeviceRestore(deviceId, work, generation),
        publishDeadline: (deadline) => this.healthRecoveryDeadlines.set(key, deadline),
        clear: () => this.clearRestoreHealth(target, reason),
        drop: () => {
          if (this.recorderTeardownRetries.get(key)?.retries === retries) {
            this.recorderTeardownRetries.delete(key);
          }
        },
      }),
    ).then((revision) => {
      completedRevision = revision;
    });
    // Owner-less startup recovery must never attach to a later session on this device.
    this.host.cleanupReceipts.trackOwner(target, recovery);
    this.healthRecoveries.set(key, recovery);
    void recovery
      .catch((error: unknown) => {
        logger.warn(
          `${reason === "recording-teardown" ? "Recorder teardown" : "App cleanup"} recovery failed on ${deviceId}`,
          error,
        );
      })
      .finally(() => {
        if (this.healthRecoveries.get(key) === recovery) {
          this.healthRecoveries.delete(key);
          this.healthRecoveryDeadlines.delete(key);
          this.pruneRecorderTeardownRetries();
          const pending = this.recorderTeardownRetries.get(key);
          // A mark can arrive after the loop ended but before this promise's finalizer.
          if (
            completedRevision !== undefined &&
            pending &&
            (pending.retries !== retries || pending.retries.revision !== completedRevision)
          ) {
            this.startRecorderTeardownRecovery(target, pending.retries, reason);
          } else if (
            pending &&
            reason === "recording-teardown" &&
            !retries.empty &&
            !retries.recheckUsed &&
            this.host.acceptingSessionCreations
          ) {
            retries.recheckUsed = true;
            this.healthRecoveryDeadlines.set(
              key,
              this.host.timer.now() + RECORDER_TEARDOWN_RECHECK_MS,
            );
            const handle = this.host.timer.setTimeout(() => {
              this.recorderTeardownRechecks.delete(key);
              this.healthRecoveryDeadlines.delete(key);
              this.pruneRecorderTeardownRetries();
              if (
                this.host.acceptingSessionCreations &&
                this.recorderTeardownRetries.get(key)?.retries === retries &&
                !retries.empty
              ) {
                this.startRecorderTeardownRecovery(target, retries, reason);
              }
            }, RECORDER_TEARDOWN_RECHECK_MS);
            (handle as { unref?: () => void }).unref?.();
            this.recorderTeardownRechecks.set(key, handle);
          }
        }
      });
  }

  private pruneRecorderTeardownRetries(): void {
    for (const [key, entry] of this.recorderTeardownRetries) {
      if (
        !this.restoreIncarnationIsCurrent(entry) ||
        !this.deviceHealth?.markers.get(entry.deviceId, entry.incarnation, entry.reason)
      ) {
        this.recorderTeardownRetries.delete(key);
        const recheck = this.recorderTeardownRechecks.get(key);
        if (recheck !== undefined) {
          this.host.timer.clearTimeout(recheck);
          this.recorderTeardownRechecks.delete(key);
          this.healthRecoveryDeadlines.delete(key);
        }
      }
    }
  }

  restoreIncarnationIsCurrent(target: {
    deviceId: string;
    incarnation?: number;
    restoreGeneration?: number;
  }): boolean {
    return (
      (target.restoreGeneration === undefined ||
        (this.replacedRestoreGenerations.get(target.deviceId) ?? 0) === target.restoreGeneration) &&
      (target.incarnation === undefined ||
        this.deviceHealth?.incarnation(target.deviceId) === target.incarnation)
    );
  }

  clearRestoreHealth(
    target: { deviceId: string; incarnation?: number },
    reason: DeviceHealthReason,
  ): void {
    if (target.incarnation !== undefined && this.restoreIncarnationIsCurrent(target)) {
      this.deviceHealth?.markers.clear(target.deviceId, target.incarnation, reason);
    }
  }

  /**
   * Release cleanup settles first: this bounded recovery is deliberately NOT
   * pendingDeviceCleanup. Idle-but-marked devices cannot be allocated. Never
   * restore against a live owner (including a TTL's owner) or a replacement.
   */
  abandonRestore(
    target: { sessionId: string; deviceId: string; incarnation?: number },
    reason: Exclude<DeviceHealthReason, "clock">,
    restore: () => Promise<void>,
    restoreTimeoutMs: number = NETWORK_CONDITION_RESTORE_TIMEOUT_MS,
  ): void {
    this.host.cleanupReceipts.failOwner(target, `restoration_abandoned:${reason}`);
    const health = this.deviceHealth;
    if (target.incarnation === undefined) {
      logger.warn(
        `Gave up restoring state on ${target.deviceId} (${reason}); no health marker could be keyed because the device has no pool incarnation`,
      );
      return;
    }
    if (!health || !this.restoreIncarnationIsCurrent(target)) {
      return;
    }
    const marker = health.markers.mark(target.deviceId, target.incarnation, reason);
    const key = `${target.deviceId}#${target.incarnation}:${reason}`;
    if (this.healthRecoveries.has(key)) {
      return;
    }
    // Own context, never the caller's: this is started from a release that may be
    // running under an aborted request signal or an expired teardown shield, and a
    // recovery attempt that inherited it would fail before reaching the device (#10198).
    const generation = this.replacedRestoreGenerations.get(target.deviceId) ?? 0;
    // The existing backoff policies are deterministic; sample each delay once for both
    // scheduling and the bound, and re-use that attempt's delay on skipped ticks (#12112).
    const delays = [1, 2, 3].map((attempt) => health.backoff.delayForAttempt(attempt));
    const remainingBudget = (attempt: number, sleeping: boolean) =>
      delays
        .slice(attempt - 1)
        .reduce(
          (total, delay, index) =>
            total + restoreTimeoutMs * (attempt + index) + (index > 0 || sleeping ? delay : 0),
          0,
        );
    const recovery = runWithAbortSignal(undefined, async () => {
      for (let attempt = 1; attempt <= 3;) {
        this.healthRecoveryDeadlines.set(
          key,
          this.host.timer.now() + remainingBudget(attempt, true),
        );
        await this.host.timer.sleep(delays[attempt - 1]!);
        if (
          !(await this.waitForIdentityReplacement(target.deviceId, generation)) ||
          !this.restoreIncarnationIsCurrent(target)
        ) {
          return;
        }
        // A different unresolved reason may also exist; only clear our own.
        // Release or a successful TTL restore may already have satisfied this one.
        if (!health.markers.get(target.deviceId, target.incarnation!, reason)) {
          return;
        }
        if (!health.canRecover(target.deviceId)) {
          if (!this.host.acceptingSessionCreations) {
            return;
          }
          continue;
        }
        const timeout = new Error("Device health recovery timed out");
        // Async wrapper: a synchronous throw from `restore` becomes this attempt's rejection.
        const inFlight = this.host.dispatchDeviceRestore(target.deviceId, restore, generation);
        this.healthRecoveryDeadlines.set(
          key,
          this.host.timer.now() + remainingBudget(attempt, false),
        );
        try {
          // Later attempts get a scaled deadline: a device slow enough to miss the
          // first one is likely to need longer, not to fail outright (#11145).
          await raceWithDeadline(inFlight, {
            timer: this.host.timer,
            timeoutMs: restoreTimeoutMs * attempt,
            label: "Device health recovery",
            timeoutError: () => timeout,
          });
          this.clearRestoreHealth(target, reason);
          return;
        } catch (error) {
          logger.warn(
            `Device health recovery ${attempt} failed on ${target.deviceId} (${marker.reason})`,
            error,
          );
          // A timed-out command may still be running. Never issue an overlapping
          // retry: the marker stays while it runs, so no new session can race it.
          // Await it instead of giving up, so one slow command does not quarantine
          // the device until a kill/restart (#11145).
          if (error === timeout) {
            this.healthRecoveryDeadlines.set(key, undefined);
          }
          if (error === timeout && (await this.inFlightRestoreSucceeded(inFlight, target))) {
            this.clearRestoreHealth(target, reason);
            return;
          }
        }
        // Only the dispatch above consumes an attempt; a busy/cleanup tick re-arms it.
        attempt++;
      }
    });
    this.host.cleanupReceipts.trackOwner(target, recovery);
    this.healthRecoveries.set(key, recovery);
    void recovery
      .catch((error: unknown) => {
        logger.warn(`Device health recovery failed on ${target.deviceId}`, error);
      })
      .finally(() => {
        if (this.healthRecoveries.get(key) === recovery) {
          this.healthRecoveries.delete(key);
          this.healthRecoveryDeadlines.delete(key);
        }
      });
  }

  /** Settles a timed-out recovery command; true when it eventually completed. */
  private async inFlightRestoreSucceeded(
    inFlight: Promise<void>,
    target: { deviceId: string },
  ): Promise<boolean> {
    try {
      await inFlight;
      return true;
    } catch (error) {
      logger.warn(`Timed-out device health recovery failed late on ${target.deviceId}`, error);
      return false;
    }
  }
}
