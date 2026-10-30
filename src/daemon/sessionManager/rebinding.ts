import { DeviceSessionRowNotRewritableError } from "../../db/deviceSessionRepository";
import { type IosAppNetworkRule } from "../../features/networkFilter/IosAppNetworkRuleClient";
import { type Platform } from "../../models";
import { runOutsideRequestContext } from "../../utils/AbortContext";
import { type BackoffPolicy } from "../../utils/Backoff";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import { type Timer } from "../../utils/SystemTimer";
import { type DeferredRebindCleanup } from "../acquisitionReceipt";
import { type AbandonablePendingDeviceCleanup } from "../deviceCleanupQuarantine";
import type { DeviceHealthMarkers } from "../deviceHealthMarkers";
import { SessionDeviceStateRestore } from "../sessionDeviceStateRestore";
import {
  type CreateSessionOptions,
  type RebindSessionOptions,
  SESSION_CREATE_WAIT_TIMEOUT_MS,
  SESSION_RELEASE_TEARDOWN_CAP_MS,
  type Session,
} from "../sessionManager";
import { SessionSlotShadowProbe } from "../sessionSlotShadowProbe";
import { type SessionLifecycleSlots } from "./internalContracts";

export interface SessionRebindingHost {
  rejectRefusedRebind(
    existing: Session,
    rebind: { session: Session; promise: Promise<Session> },
    error: DeviceSessionRowNotRewritableError,
  ): Promise<never>;
  readonly sessions: Pick<Map<string, Session>, "get">;
  assertTerminalRebindAdmission(sessionId: string, reservationOwner: symbol | undefined): void;
  createSession(
    sessionId: string,
    assignedDevice: string,
    platform: Platform,
    options?: CreateSessionOptions,
  ): Promise<Session>;
  notifyDeviceOwnershipChange(
    deviceId: string,
    frameInvalidation?: "generation-only" | "full",
  ): void;
  readonly sessionSlots: Pick<
    SessionLifecycleSlots,
    | "getRebind"
    | "getReleaseOp"
    | "setRebind"
    | "deleteRebind"
    | "getTerminalReservation"
    | "deferredCleanups"
    | "deleteDeferredCleanup"
    | "setDeferredCleanup"
  >;
  rebindSession(
    sessionId: string,
    assignedDevice: string,
    platform: Platform,
    options?: RebindSessionOptions,
  ): Promise<Session>;
  flushDeferredRebindCleanups(filter?: { sessionId?: string; deviceId?: string }): void;
  persistAndPublishRebind(
    existing: Session,
    assignedDevice: string,
    platform: Platform,
    stableDeviceId: string | undefined,
    options: Pick<RebindSessionOptions, "deferCleanup" | "recovery">,
  ): Promise<Session>;
  readonly slotShadowProbe: SessionSlotShadowProbe<Session>;
  endSessionTerminallyReleasedInRow(session: Session): Promise<Error>;
  trackReleaseDrainWrite(write: Promise<void>): void;
  readonly deviceHealth:
    | {
        markers: DeviceHealthMarkers;
        incarnation: (deviceId: string) => number | undefined;
        canRecover: (deviceId: string) => boolean;
        backoff: BackoffPolicy;
      }
    | undefined;
  getSessionForDevice(deviceId: string): string | null;
  readonly timer: Timer;
  readonly stateRestore: Pick<
    SessionDeviceStateRestore,
    | "stopIosAppNetworkLease"
    | "startIosAppNetworkLease"
    | "restoreKeepScreenAwakeBestEffort"
    | "restoreBiometricEnrollmentBestEffort"
    | "networkConditionRestoreTarget"
    | "runUnderTeardownShield"
    | "restoreNetworkConditionBestEffort"
    | "abandonCappedRestore"
    | "getPendingClockRestoration"
    | "getPendingRotationRestoration"
    | "getPendingScreenReaderRestoration"
  >;
  trackPendingTeardownCleanup(deviceId: string, cleanups: readonly Promise<void>[]): void;
  registerPendingDeviceCleanup(
    deviceId: string,
    cleanup: Promise<unknown> /** Numeric caps are trusted; only listener descriptors are manager-capped. */,
    bound?: number | AbandonablePendingDeviceCleanup,
  ): void;
}

export class SessionRebinding {
  constructor(private readonly host: SessionRebindingHost) {}

  async rebindSession(
    sessionId: string,
    assignedDevice: string,
    platform: Platform,
    options: RebindSessionOptions = {},
  ): Promise<Session> {
    const existing = this.host.sessions.get(sessionId);
    this.host.assertTerminalRebindAdmission(sessionId, options.terminalReleaseReservationOwner);
    if (!existing) {
      return await this.host.createSession(sessionId, assignedDevice, platform, {
        stableDeviceId: options.stableDeviceId,
        signal: options.signal,
      });
    }
    if (existing.assignedDevice === assignedDevice && !options.force) {
      // Generation only: this no-op rebind retains the same serial, connection and incarnation.
      this.host.notifyDeviceOwnershipChange(assignedDevice);
      return existing;
    }

    const pendingRebind = this.host.sessionSlots.getRebind(sessionId);
    if (pendingRebind) {
      await pendingRebind.promise;
      return await this.host.rebindSession(sessionId, assignedDevice, platform, options);
    }

    const inFlightRelease = this.host.sessionSlots.getReleaseOp(sessionId);
    if (inFlightRelease?.session === existing) {
      await inFlightRelease.promise;
      throw new Error(`Cannot rebind released session ${sessionId}.`);
    }

    this.host.flushDeferredRebindCleanups({ sessionId });
    const promise = this.host.persistAndPublishRebind(
      existing,
      assignedDevice,
      platform,
      options.stableDeviceId ?? existing.stableDeviceId,
      { deferCleanup: options.deferCleanup, recovery: options.recovery === true },
    );
    const rebind = { session: existing, promise };
    this.host.sessionSlots.setRebind(sessionId, rebind);
    this.host.slotShadowProbe.check(sessionId, "rebind-start");
    try {
      return await promise;
    } catch (error) {
      if (!(error instanceof DeviceSessionRowNotRewritableError)) {
        throw error;
      }
      return await this.host.rejectRefusedRebind(existing, rebind, error);
    } finally {
      if (this.host.sessionSlots.getRebind(sessionId) === rebind) {
        this.host.sessionSlots.deleteRebind(sessionId);
        this.host.slotShadowProbe.check(sessionId, "rebind-end");
      }
    }
  }

  /** Rebind the exact reserved session during its owner-controlled recovery handoff. */
  async rebindSessionForTerminalReleaseRecovery(
    session: Session,
    assignedDevice: string,
    platform: Platform,
  ): Promise<Session> {
    const reservation = this.host.sessionSlots.getTerminalReservation(session.sessionId);
    if (reservation?.session !== session) {
      throw new Error(`Session ${session.sessionId} has no matching terminal release reservation.`);
    }
    return await this.host.rebindSession(session.sessionId, assignedDevice, platform, {
      force: true,
      recovery: true,
      terminalReleaseReservationOwner: reservation.owner,
    });
  }

  /** Flush only matching receipts; release, a later rebind and shutdown all commit once. */
  flushDeferredRebindCleanups(filter: { sessionId?: string; deviceId?: string } = {}): void {
    for (const [cleanup, owner] of this.host.sessionSlots.deferredCleanups) {
      if (
        (filter.sessionId === undefined || filter.sessionId === owner.sessionId) &&
        (filter.deviceId === undefined || filter.deviceId === owner.deviceId)
      ) {
        cleanup.commit();
      }
    }
  }

  deferRebindOverrides(
    oldView: Session,
    resumeRetainedState: () => void,
    lease: IosAppNetworkRule | undefined,
  ): DeferredRebindCleanup {
    const gate = Promise.withResolvers<void>();
    let state: "deferred" | "started" | "cancelled" | "rebound" = "deferred";
    let resolved = false;
    const capMs = SESSION_CREATE_WAIT_TIMEOUT_MS + SESSION_RELEASE_TEARDOWN_CAP_MS;
    const incarnation = this.host.deviceHealth?.incarnation(oldView.assignedDevice);
    const mayRestore = () => {
      const holder = this.host.getSessionForDevice(oldView.assignedDevice);
      return (
        (holder === null || holder === oldView.sessionId) &&
        (incarnation === undefined ||
          this.host.deviceHealth?.incarnation(oldView.assignedDevice) === incarnation)
      );
    };
    const leaseKey = `rebind:${oldView.sessionId}:${oldView.assignedDevice}`;
    const finish = () => {
      this.host.timer.clearTimeout(bound);
      this.host.stateRestore.stopIosAppNetworkLease(leaseKey);
      this.host.sessionSlots.deleteDeferredCleanup(cleanup);
    };
    const settle = () => {
      if (resolved) {
        return;
      }
      resolved = true;
      finish();
      this.host.timer.clearTimeout(deadline);
      gate.resolve();
    };
    const start = (failedUndo = false) => {
      if (resolved || (state !== "deferred" && !(failedUndo && state === "cancelled"))) {
        return;
      }
      state = "started";
      finish();
      // Quarantine was registered before publication. Check ownership again before any write;
      // a forcibly replaced holder must never receive this session's restores.
      if (!mayRestore()) {
        logger.warn(
          `Not restoring rebound device ${oldView.assignedDevice}: runtime changed or reassigned`,
        );
        settle();
        return;
      }
      const run = Promise.resolve()
        .then(() =>
          runOutsideRequestContext(async () => {
            const pending = await this.restoreRebindOverrides(oldView, mayRestore);
            this.host.trackPendingTeardownCleanup(oldView.assignedDevice, pending);
            await Promise.allSettled(pending);
          }),
        )
        .catch((error: unknown) => {
          logger.warn(
            `Deferred rebind cleanup failed on ${oldView.assignedDevice}: ${errorMessage(error)}`,
            error,
          );
        });
      this.host.registerPendingDeviceCleanup(oldView.assignedDevice, run);
      settle();
    };
    const cleanup: DeferredRebindCleanup = {
      settled: gate.promise,
      get retained() {
        return state === "cancelled";
      },
      commit: () => start(),
      cancel: () => {
        if (state === "started" || state === "rebound") {
          return false;
        }
        if (state === "deferred") {
          state = "cancelled";
          finish();
        }
        return true;
      },
      finish: (outcome) => {
        if (resolved) {
          return;
        }
        if (state === "cancelled") {
          if (outcome === "rebound") {
            state = "rebound";
            settle();
          } else {
            // Only failed undo may restart cancelled restores, using the same old-device view.
            start(true);
          }
        } else if (state === "deferred") {
          cleanup.commit();
        }
      },
      resumeRetainedState: () => {
        if (state === "cancelled") {
          resumeRetainedState();
        }
      },
    };
    // Start deferred restores at the creation wait; cancellation only clears this soft timer.
    // At the hard deadline an unfinished undo hands quarantine to the restores, too.
    const bound = this.host.timer.setTimeout(cleanup.commit, SESSION_CREATE_WAIT_TIMEOUT_MS);
    bound.unref?.();
    const deadline = this.host.timer.setTimeout(() => {
      if (state === "cancelled") {
        logger.warn(
          `Deferred rebind cleanup deadline on ${oldView.assignedDevice} after ${capMs}ms: undo did not finish in time`,
        );
        start(true);
      } else {
        start();
      }
    }, capMs);
    deadline.unref?.();
    this.host.sessionSlots.setDeferredCleanup(cleanup, {
      sessionId: oldView.sessionId,
      deviceId: oldView.assignedDevice,
    });
    if (lease) {
      this.host.stateRestore.startIosAppNetworkLease(
        leaseKey,
        lease,
        () =>
          state === "deferred" && this.host.getSessionForDevice(oldView.assignedDevice) === null,
      );
    }
    this.host.registerPendingDeviceCleanup(oldView.assignedDevice, gate.promise, capMs);
    return cleanup;
  }

  /** One restore sequence shared by inline rebinds and receipt-owned deferred cleanup. */
  async restoreRebindOverrides(
    existing: Session,
    mayRestore: () => boolean = () => true,
  ): Promise<Promise<void>[]> {
    const restores: Array<() => Promise<{ pending: Promise<void> | null }>> = [
      () => this.host.stateRestore.restoreKeepScreenAwakeBestEffort(existing),
      () => this.host.stateRestore.restoreBiometricEnrollmentBestEffort(existing),
      async () => {
        const networkTarget = this.host.stateRestore.networkConditionRestoreTarget(existing);
        if (!networkTarget) {
          return { pending: null };
        }
        const pending = await this.host.stateRestore.runUnderTeardownShield(async () => [
          {
            ...(await this.host.stateRestore.restoreNetworkConditionBestEffort(existing)),
            abandon: () =>
              this.host.stateRestore.abandonCappedRestore(networkTarget, "network-condition"),
          },
        ]);
        return { pending: pending[0] ?? null };
      },
      () => this.host.stateRestore.getPendingClockRestoration(existing, null),
      () => this.host.stateRestore.getPendingRotationRestoration(existing, null),
      () => this.host.stateRestore.getPendingScreenReaderRestoration(existing, null),
    ];
    const pending: Promise<void>[] = [];
    for (const restore of restores) {
      // A shutdown or forced handoff can retire A during an earlier awaited write. Do not
      // capture subsequent targets from a replacement runtime or another session's holder.
      if (!mayRestore()) {
        break;
      }
      const result = await restore();
      if (result.pending) {
        pending.push(result.pending);
      }
    }
    return pending;
  }

  /**
   * Rebinding keeps only session-level routing cache. Hierarchy, rendered
   * observation, and keep-awake state belong to the old physical device.
   */
  createReboundSession(
    session: Session,
    assignedDevice: string,
    platform: Platform,
    stableDeviceId: string | undefined,
    recovery = false,
  ): Session {
    return {
      ...session,
      mutationRecorder: undefined,
      assignedDevice,
      ...(recovery && assignedDevice !== session.assignedDevice
        ? {
            deviceGeneration: (session.deviceGeneration ?? 0) + 1,
            previousDeviceId: session.assignedDevice,
          }
        : {}),
      stableDeviceId,
      platform,
      cacheData:
        session.cacheData.deviceLabels === undefined
          ? {}
          : { deviceLabels: session.cacheData.deviceLabels },
    };
  }
}
