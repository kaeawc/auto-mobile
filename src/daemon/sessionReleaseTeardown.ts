import { ActionableError } from "../models/ActionableError";
import { runWithAbortSignal } from "../utils/AbortContext";
import { logger } from "../utils/logger";
import { raceWithDeadline } from "../utils/raceWithDeadline";
import {
  getSessionReleaseStuckDeadlineMs,
  releaseWasForced,
  SESSION_RELEASE_TEARDOWN_CAP_MS,
  type ReleaseTeardownStage,
  type SessionReleaseOperation,
  type SessionReleaseOptions,
  type Session,
} from "./sessionManager";
import type {
  SessionDeviceStateRestore,
  SessionDeviceStateRestoreHost,
  KeepScreenAwakeRestoreTarget,
  BiometricRestoreTarget,
  NetworkConditionRestoreTarget,
} from "./sessionDeviceStateRestore";

/** Only the session lifecycle operations this restore family needs. */
interface SessionReleaseTeardownHost extends Pick<
  SessionDeviceStateRestoreHost,
  | "timer"
  | "sessionNow"
  | "sessionSetupsOf"
  | "waitForSessionSetup"
  | "noteTeardownBound"
  | "abandonRestore"
> {}
interface SessionReleaseRestorers extends Pick<
  SessionDeviceStateRestore,
  | "abandonedScreenReaders"
  | "abandonedRotations"
  | "keepScreenAwakeRestoreTarget"
  | "biometricRestoreTarget"
  | "networkConditionRestoreTarget"
  | "restoreKeepScreenAwakeBestEffort"
  | "getPendingBiometricRestoration"
  | "getPendingNetworkRestoration"
  | "getPendingClockRestoration"
  | "getPendingRotationRestoration"
  | "retryAbandonedRotationAfter"
  | "getPendingScreenReaderRestoration"
  | "retryAbandonedScreenReaderAfter"
  | "restoreKeepScreenAwakeTarget"
  | "restoreBiometricEnrollment"
  | "restoreNetworkCondition"
> {}
/** Owns bounded release sequencing and teardown shields. */
export class SessionReleaseTeardown {
  constructor(
    private readonly host: SessionReleaseTeardownHost,
    private readonly restores: SessionReleaseRestorers,
  ) {}

  /**
   * Await tracked setup and start best-effort restoration for a releasing
   * session, returning the teardown that must still finish before the device
   * is handed out again.
   *
   * Teardown is cleanup that must run to completion whether or not the request
   * that triggered the release was cancelled or hit its deadline, so it never runs
   * under the caller's signal: that signal is already aborted for a cancelled plan,
   * and every adb/simctl call that resolves `signal ?? getAbortSignal()` would fail
   * before dispatch, leaving the device shaped and marked unhealthy (#10198). The
   * restores that go through the ambient signal run under a teardown-owned shield
   * bounded by {@link SESSION_RELEASE_TEARDOWN_CAP_MS}; at the cap the shield aborts
   * and whatever has not finished is recorded as abandoned. The first attempts are
   * awaited here as before; only their retries are handed back as pending cleanup.
   */
  async drainReleaseTeardown(
    sessionId: string,
    session: Session,
    operation?: SessionReleaseOperation,
    options: SessionReleaseOptions = {},
  ): Promise<readonly Promise<void>[]> {
    if (!options.deviceIdentityReplaced && !this.releaseNeedsTeardown(session)) {
      return [];
    }
    const forcedSignal = operation?.forcedAbort?.signal;
    return this.runUnderTeardownShield(async () => {
      const stages = await this.startReleaseTeardown(sessionId, session, operation, options);
      // Setup remains in flight; skipped/aborted restores must arm neither quarantine nor retries.
      return options.deviceIdentityReplaced ? stages.filter((stage) => stage.setup) : stages;
    }, forcedSignal);
  }

  /** Own the restore signal until all stages settle, bounded by the shared teardown cap. */
  async runUnderTeardownShield(
    start: () => Promise<readonly ReleaseTeardownStage[]>,
    /** Aborts the shield early: the release was forced and no longer holds the device (#11058). */
    forcedSignal?: AbortSignal,
  ): Promise<readonly Promise<void>[]> {
    const shield = new AbortController();
    if (forcedSignal) {
      if (forcedSignal.aborted) {
        shield.abort(forcedSignal.reason);
      } else {
        forcedSignal.addEventListener("abort", () => shield.abort(forcedSignal.reason), {
          once: true,
        });
      }
    }
    const startedAtMs = this.host.sessionNow();
    const capHandle = this.host.timer.setTimeout(() => {
      shield.abort(new ActionableError("Session release teardown exceeded its budget"));
    }, SESSION_RELEASE_TEARDOWN_CAP_MS);
    try {
      const stages = await runWithAbortSignal(shield.signal, start);
      const cleanups = stages.flatMap((stage) => {
        const bounded = this.boundTeardownStage(stage, startedAtMs);
        return bounded ? [bounded] : [];
      });
      void Promise.allSettled(cleanups).then(() => this.host.timer.clearTimeout(capHandle));
      return cleanups;
    } catch (error) {
      this.host.timer.clearTimeout(capHandle);
      throw error;
    }
  }

  /** A release with nothing to restore skips the shield and cap timer entirely. */
  private releaseNeedsTeardown(session: Session): boolean {
    const {
      keepScreenAwake,
      biometricEnrollment,
      networkCondition,
      clock,
      rotation,
      screenReader,
    } = session.cacheData;
    return (
      keepScreenAwake?.applied === true ||
      Boolean(biometricEnrollment || networkCondition || clock || rotation || screenReader) ||
      this.restores.abandonedScreenReaders.has(session.assignedDevice) ||
      this.restores.abandonedRotations.has(session.assignedDevice) ||
      this.host.sessionSetupsOf(session).length > 0
    );
  }

  /**
   * Settle a capped stage at the teardown cap so the device stops being quarantined,
   * recording the restore it left undone. Stages without `abandon` (setup, screen
   * reader, clock, rotation) keep their own budgets and run to their own end.
   */
  private boundTeardownStage(
    stage: ReleaseTeardownStage,
    startedAtMs: number,
  ): Promise<void> | null {
    const { pending, abandon } = stage;
    if (!pending || !abandon) {
      return pending;
    }
    let settled = false;
    const tracked = pending.finally(() => {
      settled = true;
    });
    const capError = new Error("Session release teardown cap reached");
    const bounded = raceWithDeadline(tracked, {
      timer: this.host.timer,
      timeoutMs: Math.max(
        0,
        SESSION_RELEASE_TEARDOWN_CAP_MS - (this.host.sessionNow() - startedAtMs),
      ),
      label: "Session release teardown",
      timeoutError: () => capError,
      onTimeout: () => {
        if (!settled) {
          abandon();
        }
      },
    }).catch((error: unknown) => {
      // Reaching the cap is the recorded outcome (`abandon` ran), not a failure to surface.
      if (error !== capError) {
        throw error;
      }
    });
    this.host.noteTeardownBound(bounded, startedAtMs + SESSION_RELEASE_TEARDOWN_CAP_MS);
    return bounded;
  }

  private async startReleaseTeardown(
    sessionId: string,
    session: Session,
    operation?: SessionReleaseOperation,
    options: SessionReleaseOptions = {},
  ): Promise<readonly ReleaseTeardownStage[]> {
    // Captured before any await: a rebind reassigns `session.assignedDevice`.
    const deviceId = session.assignedDevice;
    const keepScreenAwakeTarget = this.restores.keepScreenAwakeRestoreTarget(session);
    const biometricTarget = this.restores.biometricRestoreTarget(session);
    const networkTarget = this.restores.networkConditionRestoreTarget(session);
    const setups = this.host.sessionSetupsOf(session);
    if (options.deviceIdentityReplaced) {
      return await this.startReplacedDeviceTeardown(sessionId, setups);
    }
    // A forced release (#11058) stops before its next restore: the device may already belong to
    // the next owner. Whatever it started is aborted through `forcedAbort` and handed back as is.
    const forced = () => releaseWasForced(operation) || options.deviceIdentityReplaced === true;
    // The clock, rotation and screen-reader restorers carry their own budgets and abandon
    // mechanisms and are not bound to the teardown cap, so they must not inherit its shield
    // either; the toggles they drive resolve the ambient signal themselves (#10159). They do run
    // under the release's forced signal, which only a forced release aborts (#11058).
    const forcedSignal = operation?.forcedAbort?.signal;
    const ownBudget = <T>(start: () => Promise<T>) => runWithAbortSignal(forcedSignal, start);
    let pendingSetups: Promise<void> | null = null;
    const steps: Array<() => Promise<ReleaseTeardownStage>> = [
      async () => {
        pendingSetups =
          setups.length > 0
            ? (await this.host.waitForSessionSetup(sessionId, setups)).pending
            : null;
        if (operation) {
          operation.stuckDeadlineMs = Math.max(
            operation.stuckDeadlineMs,
            getSessionReleaseStuckDeadlineMs(session.cacheData),
          );
        }
        return { pending: pendingSetups, setup: true };
      },
      async () => ({
        pending: (await this.restores.restoreKeepScreenAwakeBestEffort(session, forced)).pending,
        // A forced release (#11058) may already have handed the device to its next owner.
        abandon: () =>
          forced()
            ? logger.warn(
                `Gave up restoring keep-awake state on ${deviceId} after a forced release; ` +
                  `the screen may stay awake`,
              )
            : this.abandonCappedRestore(keepScreenAwakeTarget, "keep-screen-awake"),
      }),
      async () => ({
        pending: session.cacheData.biometricEnrollment
          ? (await this.restores.getPendingBiometricRestoration(session, pendingSetups)).pending
          : null,
        abandon: () => this.abandonCappedRestore(biometricTarget, "biometric-enrollment"),
      }),
      async () => ({
        pending: session.cacheData.networkCondition
          ? (await this.restores.getPendingNetworkRestoration(session, pendingSetups)).pending
          : null,
        abandon: () => this.abandonCappedRestore(networkTarget, "network-condition"),
      }),
      async () => ({
        pending: session.cacheData.clock
          ? (
              await ownBudget(() =>
                this.restores.getPendingClockRestoration(session, pendingSetups),
              )
            ).pending
          : null,
      }),
      async () => {
        // Snapshot before this release's own restore can record a fresh abandon: that one
        // waits for the next start or release instead of an immediate repeat attempt.
        const hadAbandonedRotation = this.restores.abandonedRotations.has(session.assignedDevice);
        const own = session.cacheData.rotation
          ? (
              await ownBudget(() =>
                this.restores.getPendingRotationRestoration(session, pendingSetups),
              )
            ).pending
          : null;
        return {
          pending:
            hadAbandonedRotation && !forced()
              ? ownBudget(() =>
                  this.restores.retryAbandonedRotationAfter(session.assignedDevice, own),
                )
              : own,
        };
      },
      async () => {
        const own = session.cacheData.screenReader
          ? (
              await ownBudget(() =>
                this.restores.getPendingScreenReaderRestoration(session, pendingSetups),
              )
            ).pending
          : null;
        return {
          pending:
            this.restores.abandonedScreenReaders.has(session.assignedDevice) && !forced()
              ? ownBudget(() =>
                  this.restores.retryAbandonedScreenReaderAfter(session.assignedDevice, own),
                )
              : own,
        };
      },
    ];
    return await this.runReleaseTeardownSteps(steps, operation, forced);
  }

  private async runReleaseTeardownSteps(
    steps: readonly (() => Promise<ReleaseTeardownStage>)[],
    operation: SessionReleaseOperation | undefined,
    forced: () => boolean,
  ): Promise<readonly ReleaseTeardownStage[]> {
    const resumeStep = operation?.teardownResumeStep ?? 0;
    // Earlier completed steps are not resent, but their outstanding cleanup still quarantines
    // an ordinary release after revocation. Setup is recaptured by step zero below.
    const stages = operation?.teardownStages?.slice(1, resumeStep) ?? [];
    for (const [index, step] of steps.entries()) {
      if (index > 0 && index < resumeStep) {
        continue;
      }
      if (operation) {
        operation.teardownStep = index;
      }
      const stage = await step();
      stages.push(stage);
      this.recordReleaseTeardownStage(operation, index, stage);
      if (forced()) {
        break;
      }
    }
    return stages;
  }

  private recordReleaseTeardownStage(
    operation: SessionReleaseOperation | undefined,
    index: number,
    stage: ReleaseTeardownStage,
  ): void {
    if (operation) {
      (operation.teardownStages ??= [])[index] = stage;
    }
  }

  /** Wait for setup without changing saved state or retries before the release's commit fence. */
  private async startReplacedDeviceTeardown(
    sessionId: string,
    setups: readonly Promise<void>[],
  ): Promise<readonly ReleaseTeardownStage[]> {
    const pending =
      setups.length > 0 ? (await this.host.waitForSessionSetup(sessionId, setups)).pending : null;
    return pending ? [{ pending, setup: true }] : [];
  }

  /** The teardown budget ran out with this restore unfinished: record it like an exhausted retry. */
  abandonCappedRestore(
    target:
      | KeepScreenAwakeRestoreTarget
      | BiometricRestoreTarget
      | NetworkConditionRestoreTarget
      | null,
    reason: "keep-screen-awake" | "biometric-enrollment" | "network-condition",
  ): void {
    if (!target) {
      return;
    }
    logger.warn(
      `Session release teardown exceeded ${SESSION_RELEASE_TEARDOWN_CAP_MS}ms before the ${reason} ` +
        `restore finished on ${target.deviceId}; the device may hold session-modified state`,
    );
    this.host.abandonRestore(target, reason, () =>
      "state" in target
        ? this.restores.restoreKeepScreenAwakeTarget(target)
        : "enrollment" in target
          ? this.restores.restoreBiometricEnrollment(target)
          : this.restores.restoreNetworkCondition(target),
    );
  }
}
