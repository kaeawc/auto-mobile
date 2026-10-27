import { logger } from "../../utils/logger";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import { type Timer } from "../../utils/SystemTimer";
import { requestAcquisitionReceipt } from "../acquisitionReceipt";
import { DeviceCleanupQuarantine } from "../deviceCleanupQuarantine";
import {} from "../deviceStateRestoreQueue";
import { isTerminalReleaseReason } from "../releaseReasons";
import { getSessionHeartbeatCheckIntervalMs } from "../wire/sessionLivenessWindows";
import {
  Session,
  SESSION_RELEASE_TEARDOWN_CAP_MS,
  SESSION_SETUP_DRAIN_TIMEOUT_MS,
} from "../sessionManager";
import { type SessionRowWriter } from "../sessionRowWriter";
import type { SupersededRowReasserts } from "../supersededRowReasserts";
import { type SessionLifecycleSlots } from "./internalContracts";

export interface SessionBookkeepingHost {
  canStartSessionSetup(session: Session): boolean;
  readonly sessionSetupPromises: Set<{ session: Session; promise: Promise<void> }>;
  clearSessionSetup(tracked: { session: Session; promise: Promise<void> }): void;
  readonly sessionSlots: SessionLifecycleSlots;
  readonly sessions: Map<string, Session>;
  readonly rowWriter: SessionRowWriter;
  retryPendingTerminalReleasesNow(): Promise<void>[];
  readonly superseded: SupersededRowReasserts<Session>;
  settleReleaseDrain(releases: ReadonlyArray<Promise<unknown>>): Promise<true>;
  readonly timer: Timer;
  sessionNow(): number;
  readonly deviceCleanupQuarantine: DeviceCleanupQuarantine;
  getPendingDeviceCleanup(deviceId: string, ownGate?: Promise<void>): Promise<void> | null;
  getSessionForDevice(deviceId: string): string | null;
}

export class SessionBookkeeping {
  constructor(private readonly host: SessionBookkeepingHost) {}

  /**
   * Track setup that can modify device state after a session has been assigned.
   * Release waits for this work so restoration sees the final cached state.
   */

  trackSessionSetup(session: Session, createSetup: () => Promise<void>): Promise<void> {
    if (!this.host.canStartSessionSetup(session)) {
      return Promise.resolve();
    }

    let resolveSetup!: () => void;
    let rejectSetup!: (error: unknown) => void;
    const setup = new Promise<void>((resolve, reject) => {
      resolveSetup = resolve;
      rejectSetup = reject;
    });
    const tracked = { session, promise: setup };
    this.host.sessionSetupPromises.add(tracked);
    try {
      void createSetup().then(resolveSetup, rejectSetup);
    } catch (error) {
      logger.warn(`Session setup factory failed for ${session.sessionId}: ${error}`);
      rejectSetup(error);
    }
    void setup.then(
      () => this.host.clearSessionSetup(tracked),
      () => this.host.clearSessionSetup(tracked),
    );
    return setup;
  }

  canStartSessionSetup(session: Session): boolean {
    return (
      !this.host.sessionSlots.isReleasing(session) &&
      this.host.sessionSlots.getRebind(session.sessionId)?.session !== session &&
      this.host.sessions.get(session.sessionId) === session
    );
  }

  /** Wait a bounded amount of time for active and caller-started release work. */

  async drainReleasePromises(
    timeoutMs: number,
    additionalReleases: ReadonlyArray<Promise<unknown>> = [],
  ): Promise<boolean> {
    // Shutdown's drain (#11058): writes that fail from here on are retried at once and tracked.
    this.host.rowWriter.beginReleaseDrain();
    const releases = [
      ...Array.from(this.host.sessionSlots.activeReleases, (release) => release.promise),
      ...this.host.rowWriter.pendingDrainWrites(),
      // Shutdown does not wait out a retry's backoff: write every unconfirmed terminal row now,
      // before the database closes (#10959).
      ...this.host.retryPendingTerminalReleasesNow(),
      // Nor a live row's owed rewrite: left terminal, the next daemon would not rehydrate it.
      ...this.host.superseded.retryAllNow(),
      ...additionalReleases,
    ];
    try {
      if (releases.length === 0) {
        return true;
      }
      const deadline = new Error("Release drain timed out");
      try {
        return await raceWithDeadline(this.host.settleReleaseDrain(releases), {
          timer: this.host.timer,
          timeoutMs,
          label: "Release drain",
          timeoutError: () => deadline,
        });
      } catch (error) {
        if (error === deadline) {
          return false;
        }
        throw error;
      }
    } finally {
      this.host.rowWriter.clearPendingNonTerminalReleases();
      this.host.superseded.clearRowsUnderPendingRelease();
    }
  }

  /**
   * Settle the drain's releases, then any release write that started meanwhile: a write that
   * timed out or failed while the drain ran is tracked only after it began (#11058).
   */

  async settleReleaseDrain(releases: ReadonlyArray<Promise<unknown>>): Promise<true> {
    let pending: ReadonlyArray<Promise<unknown>> = releases;
    while (pending.length > 0) {
      const settled = new Set(pending);
      await Promise.allSettled(pending);
      pending = Array.from(this.host.rowWriter.pendingDrainWrites()).filter(
        (write) => !settled.has(write),
      );
    }
    return true;
  }

  /** Wait for a release already admitted for this session, if any. */

  async waitForSessionRelease(sessionId: string): Promise<void> {
    const pendingSessionRelease = this.host.sessionSlots.getReleaseRequest(sessionId);
    if (pendingSessionRelease) {
      await pendingSessionRelease.promise;
      return;
    }

    const release = this.host.sessionSlots.getReleaseOp(sessionId);
    if (release) {
      await release.promise;
    }
  }

  /** Wait for this session's admitted release to settle, including failure, within a bound. */

  async waitForSessionReleaseWithin(sessionId: string, timeoutMs: number): Promise<boolean> {
    const release =
      this.host.sessionSlots.getReleaseRequest(sessionId) ??
      this.host.sessionSlots.getReleaseOp(sessionId);
    if (!release) {
      return true;
    }
    const deadline = new Error("Session release wait timed out");
    try {
      return await raceWithDeadline(
        Promise.allSettled([release.promise]).then(() => true),
        {
          timer: this.host.timer,
          timeoutMs,
          label: "Session release wait",
          timeoutError: () => deadline,
        },
      );
    } catch (error) {
      if (error === deadline) {
        // A release may legitimately outlast the registration wait; the client can retry.
        logger.debug(`Timed out after ${timeoutMs}ms waiting for session ${sessionId} release`);
        return false;
      }
      throw error;
    }
  }

  clearSessionSetup(tracked: { session: Session; promise: Promise<void> }): void {
    this.host.sessionSetupPromises.delete(tracked);
  }

  async waitForSessionSetup(
    sessionId: string,
    setups: readonly Promise<void>[],
    phase: "release" | "rebind" = "release",
  ): Promise<{ pending: Promise<void> | null }> {
    const settled = Promise.allSettled(setups);
    const timeout = new Error("Session setup drain timed out");
    const result = await raceWithDeadline(settled, {
      timer: this.host.timer,
      timeoutMs: SESSION_SETUP_DRAIN_TIMEOUT_MS,
      label: "Session setup drain",
      timeoutError: () => timeout,
    }).catch((error: unknown) => {
      if (error === timeout) {
        return "timed-out" as const;
      }
      throw error;
    });
    if (result === "timed-out") {
      logger.warn(
        `Timed out after ${SESSION_SETUP_DRAIN_TIMEOUT_MS}ms waiting for session ${sessionId} setup during ${phase}`,
      );
      return { pending: settled.then(() => undefined) };
    }
    for (const setup of result) {
      if (setup.status === "rejected") {
        logger.warn(`Failed session setup for ${sessionId} before release: ${setup.reason}`);
      }
    }
    return { pending: null };
  }

  /**
   * How long a bind refused by {@link hasDeviceCleanupInProgress} should wait before retrying
   * (#10960): the remaining time of the cleanup's cap or of the in-flight release's bounded
   * forced-release worst case, or a default polling hint when nothing bounds it. An acquisition
   * cleanup counts once it quarantines the device, that is once its holder is gone (#11616).
   */

  getDeviceCleanupRetryAfterMs(deviceId: string): number {
    const now = this.host.sessionNow();
    const releaseBounds = Array.from(this.host.sessionSlots.activeReleases)
      .filter(
        (release) =>
          !release.forced && !release.commitDeclined && release.session.assignedDevice === deviceId,
      )
      .map(
        (release) =>
          (release.teardownStartsByMs ?? release.startedAtMs ?? now) +
          release.stuckDeadlineMs +
          2 * getSessionHeartbeatCheckIntervalMs() +
          SESSION_RELEASE_TEARDOWN_CAP_MS,
      );
    return this.host.deviceCleanupQuarantine.retryAfterMs(deviceId, releaseBounds);
  }

  /** Release owns the device until both bounded teardown and any overflow work settle. */

  hasDeviceCleanupInProgress(deviceId: string): boolean {
    const receipt = requestAcquisitionReceipt();
    const ownGate =
      receipt?.rebound?.fromDeviceId === deviceId && receipt.deferredRebindCleanup?.retained
        ? receipt.deferredRebindCleanup?.settled
        : undefined;
    return (
      this.host.getPendingDeviceCleanup(deviceId, ownGate) !== null ||
      (this.host.deviceCleanupQuarantine.hasAcquisitionWork(deviceId) &&
        this.host.getSessionForDevice(deviceId) === null) ||
      Array.from(this.host.sessionSlots.activeReleases).some(
        (release) => !release.forced && release.session.assignedDevice === deviceId,
      )
    );
  }

  /**
   * The idle releases this manager started itself (the idle sweep, a lazy expiry) that still hold
   * their device (#11481). No caller awaits them and they are not reaps of the heartbeat monitor,
   * so the monitor reads them here to hold them to its stuck deadline (#10963). A forced release
   * no longer holds its device and is not listed, so it is forced exactly once.
   */

  getIdleReleasesInProgress(): { sessionId: string; startedAtMs: number }[] {
    return Array.from(this.host.sessionSlots.activeReleases)
      .filter((release) => release.expiryOrigin !== undefined && !release.forced)
      .map((release) => ({
        sessionId: release.session.sessionId,
        startedAtMs: release.startedAtMs ?? this.host.sessionNow(),
      }));
  }

  /**
   * The releases in progress that carry a non-terminal reason (a `device-restart:` handoff, a
   * `plan-auto-release`) and still hold their device (#11554). Heartbeats for a releasing session
   * are refused, so the heartbeat monitor must not count the time since `startedAtMs` as its
   * owner's silence; it still holds each one to its stuck deadline (#10963). A release a later
   * joiner upgraded to a terminal reason, an idle release (see {@link getIdleReleasesInProgress})
   * and a forced release are not listed.
   */

  getNonTerminalReleasesInProgress(): {
    sessionId: string;
    startedAtMs: number;
    session: Session;
  }[] {
    return Array.from(this.host.sessionSlots.releaseOps.values())
      .filter(
        (release) =>
          this.host.sessionSlots.hasActiveRelease(release) &&
          !release.forced &&
          release.expiryOrigin === undefined &&
          !isTerminalReleaseReason(release.reason.value),
      )
      .map((release) => ({
        sessionId: release.session.sessionId,
        startedAtMs: release.startedAtMs ?? this.host.sessionNow(),
        session: release.session,
      }));
  }

  /**
   * Terminal releases without an idle expiry origin that still hold their device. Together with
   * the idle and non-terminal lists, this lets the heartbeat monitor enforce the advertised
   * cleanup bound for every release, even when no monitor reap ever joins it.
   */

  getTerminalReleasesInProgress(): { sessionId: string; startedAtMs: number }[] {
    return Array.from(this.host.sessionSlots.activeReleases)
      .filter(
        (release) =>
          !release.forced &&
          !release.commitDeclined &&
          release.expiryOrigin === undefined &&
          isTerminalReleaseReason(release.reason.value),
      )
      .map((release) => ({
        sessionId: release.session.sessionId,
        startedAtMs: release.startedAtMs ?? this.host.sessionNow(),
      }));
  }

  /**
   * Whether the release of `sessionId` that started at `startedAtMs` (session clock) is still
   * running and still holds its device, whatever reason it carries now (#11554). The heartbeat
   * monitor asks this of a release it tracks once that release leaves the lists above: one a
   * joiner upgraded to a terminal reason is still the same wedged release and stays held to its
   * stuck deadline, while one that settled or was forced is over.
   */

  isReleaseInProgress(sessionId: string, startedAtMs: number): boolean {
    return Array.from(this.host.sessionSlots.activeReleases).some(
      (release) =>
        !release.forced &&
        release.session.sessionId === sessionId &&
        release.startedAtMs === startedAtMs,
    );
  }

  /** The unforced release's absolute stuck deadline on the session clock, if still in flight. */

  getReleaseStuckAtMs(sessionId: string): number | undefined {
    const release = Array.from(this.host.sessionSlots.activeReleases).find(
      (release) =>
        !release.forced && !release.commitDeclined && release.session.sessionId === sessionId,
    );
    return release
      ? (release.teardownStartsByMs ?? release.startedAtMs ?? this.host.sessionNow()) +
          release.stuckDeadlineMs
      : undefined;
  }
}
