import type { DeviceSession } from "../../db/types";
import { type Platform } from "../../models";
import { isAndroidEmulatorSerial } from "../../utils/androidSerial";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import { type Timer } from "../../utils/SystemTimer";
import {
  type RehydrationDeviceReservation,
  type RehydrationSummary,
  SESSION_REHYDRATION_CONCURRENCY,
  SESSION_REHYDRATION_DEADLINE_MS,
  type Session,
  type SessionDeviceAssigner,
} from "../sessionManager";
import { RecoveredTerminalReleaseIntents } from "../sessionManager/recoveredTerminalReleaseIntents";
import {
  type RehydrationRowOutcome,
  type SessionLifecycleSlots,
  type PersistedSessionRecovery,
  type SharedSessionAssignment,
  persistedStableDeviceId,
} from "./internalContracts";

export interface SessionRehydrationHost {
  readonly sessions: Pick<Map<string, Session>, "has">;
  readonly sessionSlots: Pick<
    SessionLifecycleSlots,
    "hasAssignment" | "getAssignment" | "deleteAssignment" | "deleteShared" | "setAssignment"
  >;
  newSharedAssignment(sessionId: string): SharedSessionAssignment;
  recoverPersistedSession(
    sessionId: string,
    devicePool: SessionDeviceAssigner,
    platform: Platform | undefined,
    recovery: PersistedSessionRecovery & { listed?: DeviceSession },
  ): Promise<Session>;
  waitForSharedAssignment(
    sessionId: string,
    assignment: Promise<Session>,
    requestDeadlineMs?: number,
    signal?: AbortSignal,
  ): Promise<Session>;
  sessionNow(): number;
  applyRecoveredTerminalReleaseIntents(deadlineAt?: number): Promise<string[]>;
  listRecoverableSessionsBeforeDeadline(
    deadlineAt: number,
    summary: RehydrationSummary,
  ): Promise<DeviceSession[]>;
  readonly recoveredIntents: RecoveredTerminalReleaseIntents;
  rehydratePersistedRow(
    persisted: DeviceSession,
    devicePool: SessionDeviceAssigner,
    signal?: AbortSignal,
  ): Promise<RehydrationRowOutcome>;
  readonly timer: Timer;
  isRecoverablePersistedSession(persisted: DeviceSession | undefined): boolean;
  readonly lateRehydrationListener: ((rehydrated: readonly string[]) => Promise<void>) | undefined;
}

export class SessionRehydration {
  constructor(private readonly host: SessionRehydrationHost) {}

  /** Pending follow-up sweep of rows the startup rehydration deadline skipped (#11114). */
  rehydrationFollowUpTimer: NodeJS.Timeout | null = null;

  rehydrationSkipReason(sessionId: string): string | undefined {
    if (this.host.sessions.has(sessionId)) {
      return "already-live";
    }
    if (this.host.sessionSlots.hasAssignment(sessionId)) {
      return "already-pending";
    }
    return undefined;
  }

  registerRehydrationRecovery(
    sessionId: string,
    devicePool: SessionDeviceAssigner,
    persisted: DeviceSession,
    signal?: AbortSignal,
  ): Promise<Session> {
    const shared = this.host.newSharedAssignment(sessionId);
    const recoveryPromise = this.host
      .recoverPersistedSession(sessionId, devicePool, persisted.platform, {
        listed: persisted,
        initialOwnership: "awaiting-owner",
        shared,
      })
      .finally(() => {
        shared.recoveryWait.resolve(undefined);
        if (this.host.sessionSlots.getAssignment(sessionId) === recoveryPromise) {
          this.host.sessionSlots.deleteAssignment(sessionId);
          this.host.sessionSlots.deleteShared(sessionId);
        }
      });
    this.host.sessionSlots.setAssignment(sessionId, recoveryPromise);
    return this.host.waitForSharedAssignment(sessionId, recoveryPromise, undefined, signal);
  }

  async rehydratePersistedSessions(
    devicePool: SessionDeviceAssigner,
    options: { deadlineMs?: number; concurrency?: number; signal?: AbortSignal } = {},
  ): Promise<RehydrationSummary> {
    const deadlineMs = options.deadlineMs ?? SESSION_REHYDRATION_DEADLINE_MS;
    const concurrency = Math.max(1, options.concurrency ?? SESSION_REHYDRATION_CONCURRENCY);
    const deadlineAt = this.host.sessionNow() + deadlineMs;
    const summary: RehydrationSummary = {
      rehydrated: [],
      terminalized: [],
      skipped: [],
      timedOut: false,
    };
    // Terminalize what a previous daemon released but never persisted before reviving anything.
    await this.host.applyRecoveredTerminalReleaseIntents(deadlineAt);
    const rows = (await this.host.listRecoverableSessionsBeforeDeadline(deadlineAt, summary)).map(
      (persisted) => this.host.recoveredIntents.withRecoveredTerminalRelease(persisted),
    );
    await this.reserveDevicesForRehydration(rows, devicePool, deadlineAt);
    // Rows recover concurrently, so one slow row (an unresolved emulator waiting out its restart
    // grace) no longer holds every later row past the deadline (#11114).
    const outcomes: Array<RehydrationRowOutcome | undefined> = [];
    let nextIndex = 0;
    let deadlineReached = false;
    const worker = async (): Promise<void> => {
      while (!deadlineReached && nextIndex < rows.length) {
        const index = nextIndex++;
        const outcome = await this.host.rehydratePersistedRow(
          rows[index],
          devicePool,
          options.signal,
        );
        // However the row ended, its device is no longer held for it: a recovered session holds
        // the device itself, and a failed row gives it back at once (#11294).
        this.releaseRehydrationReservation(rows[index].session_uuid, devicePool);
        if (deadlineReached) {
          this.logLateRehydrationOutcome(rows[index].session_uuid, outcome);
        } else {
          outcomes[index] = outcome;
        }
      }
    };
    if (this.host.sessionNow() < deadlineAt && rows.length > 0) {
      const deadlineWon = Symbol("startup-deadline");
      const workers = Promise.all(
        Array.from({ length: Math.min(concurrency, rows.length) }, worker),
      );
      const result = await raceWithDeadline(workers, {
        timer: this.host.timer,
        timeoutMs: Math.max(0, deadlineAt - this.host.sessionNow()),
        label: "Session rehydration",
        timeoutError: () => deadlineWon,
      }).catch((error: unknown) => {
        if (error !== deadlineWon) {
          throw error;
        }
        return deadlineWon;
      });
      deadlineReached = result === deadlineWon;
    } else {
      deadlineReached = rows.length > 0;
    }
    // Rows the deadline kept from starting are recovered by a follow-up sweep, not abandoned.
    const unstarted = rows.slice(nextIndex);
    nextIndex = rows.length;
    // They no longer hold their devices: the deadline passed without them starting (#11294).
    for (const persisted of unstarted) {
      this.releaseRehydrationReservation(persisted.session_uuid, devicePool);
    }
    for (const [index, persisted] of rows.entries()) {
      this.recordRehydrationOutcome(summary, persisted, outcomes[index]);
    }
    if (deadlineReached && !summary.timedOut) {
      summary.timedOut = true;
      const skippedCount = summary.skipped.filter(
        ({ reason }) => reason === "startup-deadline",
      ).length;
      logger.warn(
        `[SessionManager] Startup rehydration deadline reached; skipped ${skippedCount} rows due to startup-deadline`,
      );
    }
    this.scheduleRehydrationFollowUp(unstarted, devicePool, concurrency);
    logger.info(
      `[SessionManager] Rehydration: ${summary.rehydrated.length} rehydrated, ` +
        `${summary.terminalized.length} terminalized, ${summary.skipped.length} skipped`,
    );
    return summary;
  }

  /**
   * Reserve every row's device before any row starts recovering (#11294): rows recover a few at
   * a time, and an allocation arriving meanwhile must not take a device a later row is about to
   * recover onto. A row with no durable device identity reserves nothing; its recovery reports
   * that. Bounded by the startup deadline, and never fatal: rows then recover unreserved.
   */
  async reserveDevicesForRehydration(
    persistedSessions: readonly DeviceSession[],
    devicePool: SessionDeviceAssigner,
    deadlineAt: number,
  ): Promise<void> {
    const reserve = devicePool.reserveDevicesForRehydration?.bind(devicePool);
    const rows = persistedSessions.flatMap((persisted): RehydrationDeviceReservation[] => {
      const stableDeviceId = persistedStableDeviceId(persisted);
      if (
        stableDeviceId === undefined ||
        !this.host.isRecoverablePersistedSession(persisted) ||
        this.rehydrationSkipReason(persisted.session_uuid) !== undefined
      ) {
        return [];
      }
      return [
        {
          sessionId: persisted.session_uuid,
          target: {
            platform: persisted.platform,
            stableDeviceId,
            deviceId: persisted.device_id,
            ...(persisted.platform === "android"
              ? { androidEmulator: isAndroidEmulatorSerial(persisted.device_id) }
              : {}),
          },
        },
      ];
    });
    if (!reserve || rows.length === 0 || this.host.sessionNow() >= deadlineAt) {
      return;
    }
    const reservation = reserve(rows);
    try {
      await raceWithDeadline(reservation, {
        timer: this.host.timer,
        timeoutMs: Math.max(0, deadlineAt - this.host.sessionNow()),
        label: "Session rehydration device reservation",
      });
    } catch (error) {
      logger.warn(
        `[SessionManager] Could not reserve devices for rehydration: ${errorMessage(error)}`,
        error,
      );
      // A reservation that lands after the deadline must not outlive the rows it was made for.
      const releaseAll = (): void => {
        for (const row of rows) {
          devicePool.releaseRehydrationReservation?.(row.sessionId);
        }
      };
      releaseAll();
      void reservation.then(releaseAll, () => undefined);
    }
  }

  /**
   * Give up a row's reservation (#11294). A row its owner is recovering on demand right now keeps
   * the device until that recovery settles; it is the same row, so the reservation exempts it.
   */
  releaseRehydrationReservation(sessionId: string, devicePool: SessionDeviceAssigner): void {
    const release = (): void => devicePool.releaseRehydrationReservation?.(sessionId);
    const pending = this.host.sessionSlots.getAssignment(sessionId);
    if (pending) {
      void pending.then(release, release);
    } else {
      release();
    }
  }

  private recordRehydrationOutcome(
    summary: RehydrationSummary,
    persisted: DeviceSession,
    outcome: RehydrationRowOutcome | undefined,
  ): void {
    const sessionUuid = persisted.session_uuid;
    if (outcome?.kind === "rehydrated") {
      summary.rehydrated.push(sessionUuid);
    } else if (outcome?.kind === "terminalized") {
      summary.terminalized.push({ sessionUuid, reason: outcome.reason });
    } else if (outcome) {
      summary.skipped.push({ sessionUuid, reason: outcome.reason });
    } else if (!this.host.isRecoverablePersistedSession(persisted)) {
      summary.skipped.push({ sessionUuid, reason: "not-recoverable" });
    } else if (this.host.sessions.has(sessionUuid)) {
      summary.skipped.push({ sessionUuid, reason: "already-live" });
    } else {
      // Still recovering, or left to the follow-up sweep.
      summary.skipped.push({ sessionUuid, reason: "startup-deadline" });
    }
  }

  private logLateRehydrationOutcome(sessionId: string, outcome: RehydrationRowOutcome): void {
    logger.info(
      `[SessionManager] Rehydration of ${sessionId} finished after the startup deadline: ` +
        `${outcome.kind}${outcome.kind === "rehydrated" ? "" : ` (${outcome.reason})`}`,
    );
    if (outcome.kind !== "rehydrated" || !this.host.lateRehydrationListener) {
      return;
    }
    this.host.lateRehydrationListener([sessionId]).catch((error: unknown) => {
      logger.warn(
        `[SessionManager] Late rehydration hook failed for ${sessionId}: ${errorMessage(error)}`,
        error,
      );
    });
  }

  /**
   * Recover the rows the startup deadline kept from starting (#11114). A row its owner already
   * recovered on reconnect is skipped as already live or pending.
   */
  private scheduleRehydrationFollowUp(
    rows: DeviceSession[],
    devicePool: SessionDeviceAssigner,
    concurrency: number,
  ): void {
    const pending = rows.filter(
      (persisted) =>
        this.host.isRecoverablePersistedSession(persisted) &&
        !this.host.sessions.has(persisted.session_uuid),
    );
    if (pending.length === 0) {
      return;
    }
    if (this.rehydrationFollowUpTimer) {
      this.host.timer.clearTimeout(this.rehydrationFollowUpTimer);
    }
    this.rehydrationFollowUpTimer = this.host.timer.setTimeout(() => {
      this.rehydrationFollowUpTimer = null;
      void this.runRehydrationFollowUp(pending, devicePool, concurrency);
    }, 0);
  }

  private async runRehydrationFollowUp(
    rows: DeviceSession[],
    devicePool: SessionDeviceAssigner,
    concurrency: number,
  ): Promise<void> {
    logger.info(`[SessionManager] Follow-up rehydration of ${rows.length} deadline-skipped rows`);
    let nextIndex = 0;
    const worker = async (): Promise<void> => {
      while (nextIndex < rows.length) {
        const persisted = rows[nextIndex++];
        this.logLateRehydrationOutcome(
          persisted.session_uuid,
          await this.host.rehydratePersistedRow(persisted, devicePool),
        );
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, rows.length) }, worker));
  }
}
